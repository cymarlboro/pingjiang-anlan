package cn.pingjianganlan.study;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Bounded Supabase REST transport for the shared learning-state row.
 *
 * <p>This class deliberately has its own fixed path allowlist rather than reusing
 * the Auth allowlist: the bearer token can only be sent to the two sync paths on
 * the pinned project host. Redirects are never followed, response bodies are never
 * echoed or logged, and the owner id is a UUID verified by {@link CloudAuth} just
 * before each call. The access token is kept in Java memory and is never returned
 * from the JavaScript bridge.
 *
 * <p>All network work is blocking and must run on the existing background executor
 * (as {@link NativeBridge} does).
 */
public final class CloudSyncClient {
    static final int MAX_BUNDLE_BYTES = NativeStore.MAX_SYNC_BYTES;
    static final int MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

    private static final int MAX_REQUEST_BYTES = MAX_BUNDLE_BYTES + 64 * 1024;
    private static final int MAX_ERROR_BYTES = 4 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    private static final String STATE_PATH = "/rest/v1/pja_learning_state";
    private static final String STATE_QUERY_PREFIX =
        STATE_PATH + "?select=revision,payload&owner_id=eq.";
    private static final String COMMIT_PATH = "/rest/v1/rpc/pja_sync_commit";

    private static final String NETWORK_ERROR = "无法连接云端，请检查网络后重试";
    private static final String AUTH_ERROR = "登录已失效，请重新登录";
    private static final String SERVICE_ERROR = "云端同步服务暂时不可用，请稍后再试";
    private static final String NOT_READY_ERROR = "云端同步服务尚未就绪，请稍后再试";
    private static final String RESPONSE_ERROR = "云端同步响应异常，请稍后重试";
    private static final String TOO_LARGE_ERROR = "同步数据超过 16MB，请减少导入资料后再同步";
    private static final String OWNER_MISMATCH_ERROR = "云端账户与同步数据不一致，已拒绝应用";

    private final CloudAuth cloudAuth;
    private final NativeStore store;

    public CloudSyncClient(CloudAuth cloudAuth, NativeStore store) {
        if (cloudAuth == null || store == null) {
            throw new IllegalArgumentException("dependencies");
        }
        this.cloudAuth = cloudAuth;
        this.store = store;
    }

    /** Returns only sanitized owner/binding state; never a token. */
    public JSONObject status() {
        JSONObject result = new JSONObject();
        String boundOwner = store.getSyncBoundOwnerId();
        put(result, "ownerId", "");
        put(result, "boundOwnerId", boundOwner);
        put(result, "allowed", false);
        if (store.isSyncBindingCorrupt()) {
            return result;
        }
        try {
            CloudAuth.Authorization authorization = cloudAuth.authorizeForSync();
            put(result, "ownerId", authorization.ownerId);
            put(result, "allowed", boundOwner.isEmpty() ||
                boundOwner.equals(authorization.ownerId));
        } catch (UserException | RuntimeException ignored) {
            // No cached identity is used after a failed verification. The caller
            // still receives the safe binding state and allowed=false.
        }
        return result;
    }

    /** Exports only the local native content; no API settings, reminder, or secrets. */
    public JSONObject exportNative() throws UserException {
        JSONObject result = new JSONObject();
        put(result, "native", store.exportSyncNative());
        return result;
    }

    /**
     * Pulls the verified owner's row. A missing row is revision 0 with a null
     * payload. Any remote payload is validated with the same whitelist used by
     * local export before it is returned to JavaScript.
     */
    public JSONObject pull() throws UserException {
        CloudAuth.Authorization authorization = cloudAuth.authorizeForSync();
        // Check only. A failed first pull must not persist an owner binding; the
        // shared UI binds through push after its pull+merge has succeeded.
        store.assertSyncOwner(authorization.ownerId);

        String path = STATE_QUERY_PREFIX + authorization.ownerId;
        HttpResult response = request("GET", path, null, authorization.accessToken);
        int status = response.status;
        if (status == 401 || status == 403) {
            throw new UserException(AUTH_ERROR);
        }
        if (status == 400 || status == 404 || status == 406) {
            throw new UserException(NOT_READY_ERROR);
        }
        if (status == 429) {
            throw new UserException("同步请求过于频繁，请稍后再试");
        }
        if (!isSuccess(status)) {
            throw new UserException(status >= 500 ? SERVICE_ERROR : RESPONSE_ERROR);
        }

        JSONArray rows = parseArray(response.body);
        if (rows.length() > 1) {
            throw new UserException(RESPONSE_ERROR);
        }
        JSONObject result = new JSONObject();
        put(result, "ownerId", authorization.ownerId);
        if (rows.length() == 0) {
            put(result, "revision", 0L);
            put(result, "payload", JSONObject.NULL);
            return result;
        }
        JSONObject row = rows.optJSONObject(0);
        if (row == null || !row.has("revision")) {
            throw new UserException(RESPONSE_ERROR);
        }
        long revision = safeRevision(row.opt("revision"));
        JSONObject payload = null;
        if (row.has("payload") && !row.isNull("payload")) {
            payload = row.optJSONObject("payload");
            if (payload == null) {
                throw new UserException(RESPONSE_ERROR);
            }
            payload = store.validateSyncBundle(payload);
        }
        put(result, "revision", revision);
        put(result, "payload", payload == null ? JSONObject.NULL : payload);
        return result;
    }

    /**
     * Commits a validated bundle with compare-and-swap. The server derives the
     * owner from the authenticated JWT. A 409 is reported as a normal conflict so
     * the UI can re-pull and re-merge rather than overwrite.
     */
    public JSONObject push(JSONObject requestPayload) throws UserException {
        if (requestPayload == null) {
            throw new UserException("同步请求格式错误");
        }
        long expectedRevision = expectedRevision(requestPayload.opt("expectedRevision"));
        JSONObject bundle = requestPayload.optJSONObject("payload");
        if (bundle == null) {
            throw new UserException("同步内容格式错误");
        }
        JSONObject cleanBundle = store.validateSyncBundle(bundle);
        if (cleanBundle.toString().getBytes(StandardCharsets.UTF_8).length > MAX_BUNDLE_BYTES) {
            throw new UserException(TOO_LARGE_ERROR);
        }

        CloudAuth.Authorization authorization = cloudAuth.authorizeForSync();
        store.requireSyncOwner(authorization.ownerId);

        JSONObject body = new JSONObject();
        try {
            body.put("expected_revision", expectedRevision);
            body.put("new_payload", cleanBundle);
        } catch (JSONException exception) {
            throw new UserException("同步请求整理失败", exception);
        }

        HttpResult response = request("POST", COMMIT_PATH, body,
            authorization.accessToken);
        int status = response.status;
        if (status == 409) {
            JSONObject conflict = new JSONObject();
            put(conflict, "conflict", true);
            return conflict;
        }
        if (status == 401 || status == 403) {
            throw new UserException(AUTH_ERROR);
        }
        if (status == 400 || status == 404 || status == 406) {
            throw new UserException(NOT_READY_ERROR);
        }
        if (status == 413) {
            throw new UserException(TOO_LARGE_ERROR);
        }
        if (status == 429) {
            throw new UserException("同步请求过于频繁，请稍后再试");
        }
        if (!isSuccess(status)) {
            throw new UserException(status >= 500 ? SERVICE_ERROR : RESPONSE_ERROR);
        }

        JSONObject committed = parseCommit(response.body);
        if (committed == null || !committed.has("revision")) {
            throw new UserException(RESPONSE_ERROR);
        }
        long revision = safeRevision(committed.opt("revision"));
        JSONObject result = new JSONObject();
        put(result, "ownerId", authorization.ownerId);
        put(result, "revision", revision);
        put(result, "payload", cleanBundle);
        put(result, "conflict", false);
        return result;
    }

    /**
     * Applies remote native content only when the caller's owner id exactly matches
     * the freshly verified user and the local owner binding. The store performs a
     * single atomic merge; settings and the API key are never touched here.
     */
    public JSONObject apply(JSONObject requestPayload) throws UserException {
        if (requestPayload == null) {
            throw new UserException("同步请求格式错误");
        }
        String requestedOwner = SyncOwner.normalize(requestPayload.optString("ownerId", ""));
        JSONObject nativePart = requestPayload.optJSONObject("native");
        if (nativePart == null) {
            throw new UserException("同步内容格式错误");
        }
        // Validate before binding or touching local data.
        JSONObject cleanNative = store.validateSyncNative(nativePart);

        CloudAuth.Authorization authorization = cloudAuth.authorizeForSync();
        if (!requestedOwner.equals(authorization.ownerId)) {
            throw new UserException(OWNER_MISMATCH_ERROR);
        }
        store.requireSyncOwner(authorization.ownerId);
        boolean changed = store.applySyncNative(cleanNative);
        JSONObject result = new JSONObject();
        put(result, "changed", changed);
        return result;
    }

    static boolean isSafeRevision(Object value) {
        if (!(value instanceof Number)) {
            return false;
        }
        double number = ((Number) value).doubleValue();
        return Double.isFinite(number) && number == Math.rint(number) &&
            number >= 0 && number <= NativeStore.MAX_JS_SAFE_INTEGER;
    }

    private static long safeRevision(Object value) throws UserException {
        if (!isSafeRevision(value)) {
            throw new UserException(RESPONSE_ERROR);
        }
        return (long) ((Number) value).doubleValue();
    }

    private static long expectedRevision(Object value) throws UserException {
        if (!isSafeRevision(value)) {
            throw new UserException("同步版本号无效");
        }
        return (long) ((Number) value).doubleValue();
    }

    private HttpResult request(String method, String pathAndQuery, JSONObject body,
                               String accessToken)
        throws UserException {
        URL url = pinnedEndpoint(pathAndQuery);
        if (!isUsableToken(accessToken)) {
            throw new UserException(AUTH_ERROR);
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("apikey", CloudAuth.PUBLISHABLE_KEY);
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            connection.setRequestProperty("User-Agent", "PingjiangAnlan/1.0.0");
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length == 0 || bytes.length > MAX_REQUEST_BYTES) {
                    throw new UserException(TOO_LARGE_ERROR);
                }
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                throw new UserException(RESPONSE_ERROR);
            }
            String responseBody;
            if (status == 204 || status == 205) {
                responseBody = "";
            } else if (status >= 200 && status < 300) {
                responseBody = readLimited(connection.getInputStream(), MAX_RESPONSE_BYTES);
            } else {
                responseBody = readErrorBody(connection);
            }
            return new HttpResult(status, responseBody);
        } catch (UserException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            throw new UserException(NETWORK_ERROR);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static URL pinnedEndpoint(String pathAndQuery) throws UserException {
        if (!isAllowedPath(pathAndQuery)) {
            throw new UserException("云端同步请求不合法");
        }
        try {
            URL url = new URL(CloudAuth.PROJECT_URL + pathAndQuery);
            if (!"https".equalsIgnoreCase(url.getProtocol()) ||
                !CloudAuth.PROJECT_HOST.equalsIgnoreCase(url.getHost()) ||
                (url.getPort() != -1 && url.getPort() != 443) ||
                url.getUserInfo() != null ||
                url.getRef() != null) {
                throw new UserException("云端同步地址不安全");
            }
            return url;
        } catch (MalformedURLException exception) {
            throw new UserException("云端同步地址无效", exception);
        }
    }

    static boolean isAllowedPath(String pathAndQuery) {
        if (pathAndQuery == null) {
            return false;
        }
        if (COMMIT_PATH.equals(pathAndQuery)) {
            return true;
        }
        if (!pathAndQuery.startsWith(STATE_QUERY_PREFIX)) {
            return false;
        }
        String owner = pathAndQuery.substring(STATE_QUERY_PREFIX.length());
        return SyncOwner.isUuid(owner);
    }

    private static boolean isUsableToken(String token) {
        if (token == null || token.isEmpty() || token.length() > 16 * 1024) {
            return false;
        }
        for (int index = 0; index < token.length(); index++) {
            char character = token.charAt(index);
            if (character <= 0x20 || character == 0x7f ||
                Character.isWhitespace(character) || Character.isISOControl(character)) {
                return false;
            }
        }
        return true;
    }

    private static JSONArray parseArray(String body) throws UserException {
        if (body == null || body.isEmpty()) {
            throw new UserException(RESPONSE_ERROR);
        }
        try {
            return new JSONArray(body);
        } catch (JSONException exception) {
            throw new UserException(RESPONSE_ERROR);
        }
    }

    private static JSONObject parseCommit(String body) throws UserException {
        if (body == null || body.isEmpty()) {
            throw new UserException(RESPONSE_ERROR);
        }
        String trimmed = body.trim();
        try {
            if (trimmed.startsWith("[")) {
                JSONArray array = new JSONArray(trimmed);
                if (array.length() != 1) {
                    throw new UserException(RESPONSE_ERROR);
                }
                JSONObject row = array.optJSONObject(0);
                if (row == null) {
                    throw new UserException(RESPONSE_ERROR);
                }
                return row;
            }
            return new JSONObject(trimmed);
        } catch (JSONException exception) {
            throw new UserException(RESPONSE_ERROR);
        }
    }

    private static String readLimited(InputStream input, int maxBytes)
        throws IOException, UserException {
        if (input == null) {
            return "";
        }
        try (InputStream source = input) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8 * 1024];
            int total = 0;
            int read;
            while ((read = source.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                total += read;
                if (total > maxBytes) {
                    throw new UserException("云端同步响应过大，请稍后重试");
                }
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String readErrorBody(HttpURLConnection connection) {
        if (connection == null) {
            return "";
        }
        InputStream stream = connection.getErrorStream();
        if (stream == null) {
            return "";
        }
        try {
            return readLimited(stream, MAX_ERROR_BYTES);
        } catch (Exception exception) {
            return "";
        }
    }

    private static boolean isSuccess(int status) {
        return status >= 200 && status < 300;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException ignored) {
            // All callers use standard JSON values.
        }
    }

    private static final class HttpResult {
        final int status;
        final String body;

        HttpResult(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }
}
