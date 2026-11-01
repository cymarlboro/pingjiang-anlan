package cn.pingjianganlan.study;

import android.content.Context;

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
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Optional email/password Supabase Auth client for the Android app.
 *
 * <p>Security boundaries:
 * <ul>
 *   <li>Only the public project URL and public publishable key are compiled in.
 *       No server secret key is present.</li>
 *   <li>Every request is HTTPS and pinned to one exact project origin. Redirects
 *       are never followed.</li>
 *   <li>Within this Auth client, JWTs are sent only to {@code /auth/v1/user} and
 *       {@code /auth/v1/logout}. Login, signup, verification, resend, and refresh
 *       requests carry only the public apikey header. The separate sync transport
 *       has its own two-path allowlist and never reuses an Auth endpoint.</li>
 *   <li>Response bodies are bounded and are never copied into user-facing errors
 *       or logs. Errors are fixed Chinese messages.</li>
 *   <li>The sanitized status returned to JavaScript contains no access token,
 *       refresh token, password, user metadata, or client-controlled admin flag.
 *       Any future administrator authority must come from the server.</li>
 * </ul>
 *
 * <p>Network work is blocking. The owner of this object must call it from the
 * existing background executor (as {@code NativeBridge} does), never the UI thread.
 */
public final class CloudAuth {
    // Package-private so the REST transport can reuse the exact same pinned
    // project without duplicating (or drifting from) the public credentials.
    static final String PROJECT_URL = "https://rzqzvhvydmqhtcuovcco.supabase.co";
    static final String PROJECT_HOST = "rzqzvhvydmqhtcuovcco.supabase.co";
    static final String PUBLISHABLE_KEY =
        "sb_publishable_dh3MpDvuiQFvq3aY7Z_N0A_7q-_Zch_";

    private static final String TOKEN_PASSWORD_PATH = "/auth/v1/token?grant_type=password";
    private static final String TOKEN_REFRESH_PATH = "/auth/v1/token?grant_type=refresh_token";
    private static final String SIGNUP_PATH = "/auth/v1/signup";
    private static final String VERIFY_PATH = "/auth/v1/verify";
    private static final String RESEND_PATH = "/auth/v1/resend";
    private static final String USER_PATH = "/auth/v1/user";
    private static final String LOGOUT_PATH = "/auth/v1/logout?scope=local";

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final int MAX_REQUEST_BYTES = 16 * 1024;
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final int MAX_ERROR_BYTES = 4 * 1024;
    private static final int MAX_EMAIL_CHARS = 254;
    private static final int MAX_PASSWORD_CHARS = 1024;
    private static final int MAX_TOKEN_CHARS = 16 * 1024;
    private static final int MIN_OTP_DIGITS = 6;
    private static final int MAX_OTP_DIGITS = 10;
    private static final long REFRESH_SKEW_MS = 120_000L;
    private static final long DEFAULT_SESSION_MS = 3_600_000L;
    private static final long MAX_SESSION_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final Pattern EMAIL_PATTERN =
        Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final Pattern OTP_PATTERN = Pattern.compile("^[0-9]{6,10}$");

    private static final String NETWORK_ERROR = "无法连接云端，请检查网络后重试";
    private static final String SERVICE_ERROR = "云端服务暂时不可用，请稍后再试";
    private static final String RESPONSE_ERROR = "云端响应异常，请稍后重试";
    private static final String INVALID_SESSION_ERROR = "登录已失效，请重新登录";
    private static final String KEEP_SESSION_NETWORK_ERROR =
        "无法连接云端，已保留本机登录信息";
    private static final String SIGNOUT_REVOKE_ERROR =
        "已退出本机登录，但云端会话撤销未完成，请稍后重试";
    private static final boolean CONFIGURED = computeConfigured();

    private final CloudSessionStore sessionStore;

    public CloudAuth(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context");
        }
        sessionStore = new CloudSessionStore(context);
    }

    /**
     * Returns only sanitized account state. When the encrypted session is usable,
     * the server's {@code /user} endpoint is consulted. A token that is close to
     * expiry is refreshed first. Transient network failures keep the encrypted
     * session and add a fixed safe {@code error} field; a definitively invalid
     * session clears only the cloud auth store.
     */
    public synchronized JSONObject status() {
        JSONObject result = baseStatus();
        if (!CONFIGURED) {
            return result;
        }
        try {
            JSONObject state = sessionStore.load();
            if (state == null) {
                return result;
            }
            String accessToken = tokenValue(state.opt("access_token"));
            if (!isUsableToken(accessToken)) {
                if (state.optBoolean("needs_email_confirmation", false)) {
                    return pendingStatus(state.optString("pending_email",
                        state.optString("email", "")));
                }
                if (!accessToken.isEmpty()) {
                    sessionStore.clear();
                    return failureStatus(INVALID_SESSION_ERROR);
                }
                sessionStore.clear();
                return result;
            }

            String refreshToken = tokenValue(state.opt("refresh_token"));
            long expiresAt = state.optLong("expires_at", 0L);
            long now = System.currentTimeMillis();
            if (expiresAt <= now + REFRESH_SKEW_MS) {
                if (!isUsableToken(refreshToken)) {
                    sessionStore.clear();
                    return failureStatus(INVALID_SESSION_ERROR);
                }
                try {
                    state = refreshSession(state);
                    sessionStore.save(state);
                } catch (NetworkFailure exception) {
                    return cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
                } catch (InvalidSession exception) {
                    sessionStore.clear();
                    return failureStatus(INVALID_SESSION_ERROR);
                } catch (UserException exception) {
                    return cachedStatus(state, exception.getMessage());
                }
            }

            try {
                JSONObject user = fetchUser(tokenValue(state.opt("access_token")));
                applyServerUser(state, user);
                sessionStore.save(state);
                return statusFromState(state);
            } catch (InvalidSession exception) {
                if (!isUsableToken(refreshToken)) {
                    sessionStore.clear();
                    return failureStatus(INVALID_SESSION_ERROR);
                }
                try {
                    state = refreshSession(state);
                    sessionStore.save(state);
                    JSONObject user = fetchUser(tokenValue(state.opt("access_token")));
                    applyServerUser(state, user);
                    sessionStore.save(state);
                    return statusFromState(state);
                } catch (NetworkFailure network) {
                    return cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
                } catch (InvalidSession invalid) {
                    sessionStore.clear();
                    return failureStatus(INVALID_SESSION_ERROR);
                } catch (UserException failure) {
                    return cachedStatus(state, failure.getMessage());
                }
            } catch (NetworkFailure exception) {
                return cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
            } catch (UserException exception) {
                return cachedStatus(state, exception.getMessage());
            }
        } catch (RuntimeException exception) {
            return failureStatus("云端账户状态读取失败，请稍后重试");
        }
    }

    /**
     * Returns the current verified owner and its bearer token to package code.
     *
     * <p>This deliberately repeats the refresh + {@code /user} verification used by
     * {@link #status()} rather than trusting a cached user id. On a network failure
     * it throws instead of returning cached identity, so a failed pull/push cannot
     * silently act as a previously stored account. The returned token is never
     * exposed through the JavaScript bridge.
     */
    synchronized Authorization authorizeForSync() throws UserException {
        if (!CONFIGURED) {
            throw new UserException("云端账户尚未配置");
        }
        try {
            JSONObject state = sessionStore.load();
            if (state == null) {
                throw new UserException("请先登录云端账户");
            }
            String accessToken = tokenValue(state.opt("access_token"));
            if (!isUsableToken(accessToken)) {
                if (state.optBoolean("needs_email_confirmation", false)) {
                    throw new UserException("邮箱尚未确认，请先查收确认邮件");
                }
                sessionStore.clear();
                throw new UserException(INVALID_SESSION_ERROR);
            }
            String refreshToken = tokenValue(state.opt("refresh_token"));
            if (state.optLong("expires_at", 0L) <=
                System.currentTimeMillis() + REFRESH_SKEW_MS) {
                if (!isUsableToken(refreshToken)) {
                    sessionStore.clear();
                    throw new UserException(INVALID_SESSION_ERROR);
                }
                state = refreshSession(state);
                sessionStore.save(state);
                accessToken = tokenValue(state.opt("access_token"));
                refreshToken = tokenValue(state.opt("refresh_token"));
            }
            JSONObject user;
            try {
                user = fetchUser(accessToken);
            } catch (InvalidSession exception) {
                // Match status(): if the server rejects a token that still looks
                // valid locally, try exactly one refresh before giving up.
                if (!isUsableToken(refreshToken)) {
                    sessionStore.clear();
                    throw new UserException(INVALID_SESSION_ERROR);
                }
                state = refreshSession(state);
                sessionStore.save(state);
                accessToken = tokenValue(state.opt("access_token"));
                user = fetchUser(accessToken);
            }
            applyServerUser(state, user);
            String ownerId = state.optString("user_id", "").trim().toLowerCase(Locale.ROOT);
            if (!isUuid(ownerId)) {
                throw new UserException(RESPONSE_ERROR);
            }
            state.put("user_id", ownerId);
            sessionStore.save(state);
            String verifiedToken = tokenValue(state.opt("access_token"));
            if (!isUsableToken(verifiedToken)) {
                sessionStore.clear();
                throw new UserException(INVALID_SESSION_ERROR);
            }
            return new Authorization(ownerId, verifiedToken);
        } catch (NetworkFailure exception) {
            throw new UserException(NETWORK_ERROR);
        } catch (InvalidSession exception) {
            sessionStore.clear();
            throw new UserException(INVALID_SESSION_ERROR);
        } catch (JSONException exception) {
            throw new UserException(RESPONSE_ERROR);
        } catch (RuntimeException exception) {
            throw new UserException("云端账户状态读取失败，请稍后重试");
        }
    }

    /** Signs in with email/password and stores only the sanitized session. */
    public synchronized JSONObject signIn(JSONObject payload) throws UserException {
        if (!CONFIGURED) {
            throw new UserException("云端账户尚未配置");
        }
        Credentials credentials = readCredentials(payload, false);
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("email", credentials.email);
            requestBody.put("password", credentials.password);
            HttpResult response = request("POST", TOKEN_PASSWORD_PATH, requestBody, null);
            String code = errorCode(response.body);
            if (!isSuccess(response.status)) {
                if (isEmailNotConfirmed(response.status, code)) {
                    rememberPendingEmail(credentials.email);
                    throw new UserException(
                        "邮箱尚未确认，请查收确认邮件，或输入邮件中的验证码完成确认");
                }
                throw new UserException(signInError(response.status, code));
            }
            JSONObject state = sessionFromTokenResponse(response.body, credentials.email,
                "", "");
            if (state == null) {
                throw new UserException(RESPONSE_ERROR);
            }
            sessionStore.save(state);
            return statusFromState(state);
        } catch (NetworkFailure exception) {
            throw new UserException(NETWORK_ERROR);
        } catch (JSONException exception) {
            throw new UserException("登录请求整理失败", exception);
        }
    }

    /** Registers with email/password; does not save the password anywhere. */
    public synchronized JSONObject signUp(JSONObject payload) throws UserException {
        if (!CONFIGURED) {
            throw new UserException("云端账户尚未配置");
        }
        Credentials credentials = readCredentials(payload, true);
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("email", credentials.email);
            requestBody.put("password", credentials.password);
            HttpResult response = request("POST", SIGNUP_PATH, requestBody, null);
            String code = errorCode(response.body);
            if (!isSuccess(response.status)) {
                throw new UserException(signUpError(response.status, code));
            }
            JSONObject state = sessionFromTokenResponse(response.body, credentials.email,
                "", "");
            if (state != null) {
                sessionStore.save(state);
                return statusFromState(state);
            }
            // With email confirmation enabled Supabase returns a user but no
            // session. Persist only the pending email marker, never a password.
            JSONObject parsed = parseObject(response.body);
            JSONObject pendingUser = parsed == null ? null : parsed.optJSONObject("user");
            if (pendingUser == null) pendingUser = parsed;
            if (pendingUser == null || pendingUser.optString("id", "").isEmpty()
                || !credentials.email.equalsIgnoreCase(pendingUser.optString("email", ""))) {
                throw new UserException(RESPONSE_ERROR);
            }
            rememberPendingEmail(credentials.email);
            return pendingStatus(credentials.email);
        } catch (NetworkFailure exception) {
            throw new UserException(NETWORK_ERROR);
        } catch (JSONException exception) {
            throw new UserException("注册请求整理失败", exception);
        }
    }

    /**
     * Confirms a signup email with the numeric OTP shown by the confirmation
     * template. The server response is parsed by the same token-response logic as
     * sign-in and only saved when it contains a usable session. A pending marker
     * is never upgraded to "confirmed" on the client.
     */
    public synchronized JSONObject verifyOtp(JSONObject payload) throws UserException {
        if (!CONFIGURED) {
            throw new UserException("云端账户尚未配置");
        }
        EmailOtp input = readEmailOtp(payload);
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("email", input.email);
            requestBody.put("token", input.token);
            requestBody.put("type", "signup");
            HttpResult response = request("POST", VERIFY_PATH, requestBody, null);
            String code = errorCode(response.body);
            if (!isSuccess(response.status)) {
                throw new UserException(verifyError(response.status, code));
            }
            JSONObject state = sessionFromTokenResponse(response.body, input.email, "", "");
            if (state == null) {
                throw new UserException(RESPONSE_ERROR);
            }
            sessionStore.save(state);
            return statusFromState(state);
        } catch (NetworkFailure exception) {
            throw new UserException(NETWORK_ERROR);
        } catch (JSONException exception) {
            throw new UserException("验证请求整理失败", exception);
        }
    }

    /**
     * Resends the signup confirmation email. The encrypted session is left
     * untouched, so a resend cannot mark the account confirmed or start sync.
     */
    public synchronized JSONObject resendSignup(JSONObject payload) throws UserException {
        if (!CONFIGURED) {
            throw new UserException("云端账户尚未配置");
        }
        String email = readEmail(payload);
        JSONObject requestBody = new JSONObject();
        try {
            requestBody.put("type", "signup");
            requestBody.put("email", email);
            HttpResult response = request("POST", RESEND_PATH, requestBody, null);
            String code = errorCode(response.body);
            if (!isSuccess(response.status)) {
                throw new UserException(resendError(response.status, code));
            }
            return pendingStatus(email);
        } catch (NetworkFailure exception) {
            throw new UserException(NETWORK_ERROR);
        } catch (JSONException exception) {
            throw new UserException("确认邮件请求整理失败", exception);
        }
    }

    /**
     * Best-effort local-scope revocation. The encrypted session is cleared even
     * when the revoke request fails, and the returned status says honestly that
     * the remote session could not be revoked. No success is fabricated.
     */
    public synchronized JSONObject signOut() throws UserException {
        boolean revokeFailed = false;
        try {
            JSONObject state = sessionStore.load();
            if (state != null) {
                String accessToken = tokenValue(state.opt("access_token"));
                if (isUsableToken(accessToken)) {
                    try {
                        HttpResult response = request("POST", LOGOUT_PATH, null, accessToken);
                        if (!isSuccess(response.status) &&
                            response.status != 401 && response.status != 403) {
                            revokeFailed = true;
                        }
                    } catch (NetworkFailure | UserException exception) {
                        revokeFailed = true;
                    }
                }
            }
        } catch (RuntimeException exception) {
            // An unreadable local auth state must not prevent clearing it.
            revokeFailed = true;
        } finally {
            sessionStore.clear();
        }
        JSONObject result = baseStatus();
        if (revokeFailed) {
            put(result, "error", SIGNOUT_REVOKE_ERROR);
        }
        return result;
    }

    private JSONObject refreshSession(JSONObject oldState)
        throws NetworkFailure, InvalidSession, UserException {
        String refreshToken = tokenValue(oldState.opt("refresh_token"));
        if (!isUsableToken(refreshToken)) {
            throw new InvalidSession();
        }
        JSONObject body = new JSONObject();
        try {
            body.put("refresh_token", refreshToken);
        } catch (JSONException exception) {
            throw new UserException("刷新请求整理失败", exception);
        }
        HttpResult response = request("POST", TOKEN_REFRESH_PATH, body, null);
        if (response.status == 400 || response.status == 401 || response.status == 403) {
            throw new InvalidSession();
        }
        if (response.status == 429) {
            throw new UserException("操作过于频繁，请稍后再试");
        }
        if (!isSuccess(response.status)) {
            throw new UserException(SERVICE_ERROR);
        }
        JSONObject state = sessionFromTokenResponse(response.body,
            oldState.optString("email", ""), oldState.optString("user_id", ""),
            refreshToken);
        if (state == null) {
            throw new UserException(RESPONSE_ERROR);
        }
        return state;
    }

    private JSONObject fetchUser(String accessToken)
        throws NetworkFailure, InvalidSession, UserException {
        HttpResult response = request("GET", USER_PATH, null, accessToken);
        if (response.status == 400 || response.status == 401 || response.status == 403) {
            throw new InvalidSession();
        }
        if (response.status == 429) {
            throw new UserException("请求过于频繁，请稍后再试");
        }
        if (!isSuccess(response.status)) {
            throw new UserException(SERVICE_ERROR);
        }
        JSONObject user = parseObject(response.body);
        if (user == null) {
            throw new UserException(RESPONSE_ERROR);
        }
        String id = stringValue(user.opt("id")).trim();
        if (id.isEmpty() || id.length() > 128) {
            throw new UserException(RESPONSE_ERROR);
        }
        return user;
    }

    private HttpResult request(String method, String pathAndQuery, JSONObject body,
                               String accessToken)
        throws NetworkFailure, UserException {
        URL url = pinnedEndpoint(pathAndQuery);
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("apikey", PUBLISHABLE_KEY);
            connection.setRequestProperty("User-Agent", "PingjiangAnlan/1.0.0");
            if (accessToken != null) {
                if (!isUsableToken(accessToken)) {
                    throw new UserException(INVALID_SESSION_ERROR);
                }
                // JWT is sent only for /user and /logout.
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            }
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length == 0 || bytes.length > MAX_REQUEST_BYTES) {
                    throw new UserException("云端请求内容过大");
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
                throw new UserException("云端服务返回重定向，已拒绝跟随");
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
            throw new NetworkFailure();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static URL pinnedEndpoint(String pathAndQuery) throws UserException {
        if (!isAllowedPath(pathAndQuery)) {
            throw new UserException("云端账户请求不合法");
        }
        try {
            URL url = new URL(PROJECT_URL + pathAndQuery);
            String protocol = url.getProtocol();
            String host = url.getHost();
            int port = url.getPort();
            if (!"https".equalsIgnoreCase(protocol) ||
                !PROJECT_HOST.equalsIgnoreCase(host) ||
                (port != -1 && port != 443) ||
                url.getUserInfo() != null ||
                url.getRef() != null) {
                throw new UserException("云端账户地址不安全");
            }
            return url;
        } catch (MalformedURLException exception) {
            throw new UserException("云端账户地址无效", exception);
        }
    }

    private static boolean isAllowedPath(String pathAndQuery) {
        return TOKEN_PASSWORD_PATH.equals(pathAndQuery) ||
            TOKEN_REFRESH_PATH.equals(pathAndQuery) ||
            SIGNUP_PATH.equals(pathAndQuery) ||
            VERIFY_PATH.equals(pathAndQuery) ||
            RESEND_PATH.equals(pathAndQuery) ||
            USER_PATH.equals(pathAndQuery) ||
            LOGOUT_PATH.equals(pathAndQuery);
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
                    throw new UserException("云端响应过大");
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

    private JSONObject sessionFromTokenResponse(String body, String fallbackEmail,
                                                String fallbackUserId,
                                                String fallbackRefreshToken) {
        try {
            JSONObject root = new JSONObject(body);
            JSONObject nestedSession = root.optJSONObject("session");
            JSONObject source = nestedSession != null && hasToken(nestedSession)
                ? nestedSession : root;
            String accessToken = tokenValue(source.opt("access_token"));
            if (!isUsableToken(accessToken)) {
                return null;
            }
            String refreshToken = tokenValue(source.opt("refresh_token"));
            if (!isUsableToken(refreshToken)) {
                refreshToken = isUsableToken(fallbackRefreshToken) ? fallbackRefreshToken : "";
            }
            JSONObject user = source.optJSONObject("user");
            if (user == null) {
                user = root.optJSONObject("user");
            }
            String userId = user == null ? "" : stringValue(user.opt("id")).trim();
            if (userId.isEmpty()) {
                userId = fallbackUserId;
            }
            String email = user == null ? "" : stringValue(user.opt("email")).trim();
            if (email.isEmpty()) {
                email = fallbackEmail;
            }
            if (userId.length() > 128) {
                userId = "";
            }
            if (!isPlausibleEmail(email)) {
                email = isPlausibleEmail(fallbackEmail) ? fallbackEmail : "";
            }
            JSONObject state = new JSONObject();
            state.put("access_token", accessToken);
            state.put("refresh_token", refreshToken);
            state.put("expires_at", expiresAt(source));
            state.put("user_id", userId);
            state.put("email", email);
            state.put("needs_email_confirmation", false);
            state.put("pending_email", "");
            state.put("had_session", true);
            return state;
        } catch (JSONException | RuntimeException exception) {
            return null;
        }
    }

    private static long expiresAt(JSONObject source) {
        long now = System.currentTimeMillis();
        long value = numberAsLong(source.opt("expires_at"));
        if (value > 0) {
            if (value < 100_000_000_000L) {
                value *= 1000L; // seconds -> milliseconds
            }
            if (value > now && value <= now + MAX_SESSION_MS) {
                return value;
            }
        }
        long expiresIn = numberAsLong(source.opt("expires_in"));
        if (expiresIn <= 0 || expiresIn > MAX_SESSION_MS / 1000L) {
            expiresIn = DEFAULT_SESSION_MS / 1000L;
        }
        return now + expiresIn * 1000L;
    }

    private static long numberAsLong(Object value) {
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (Double.isFinite(number) && number >= 0 && number < Long.MAX_VALUE) {
                return (long) number;
            }
        }
        return 0L;
    }

    private static void applyServerUser(JSONObject state, JSONObject user) {
        // Copy only the two identity fields used by the UI. Roles and other
        // metadata stay on the server; they are never granted authority locally.
        String userId = stringValue(user.opt("id")).trim();
        String email = stringValue(user.opt("email")).trim();
        try {
            if (!userId.isEmpty() && userId.length() <= 128) {
                state.put("user_id", userId);
            }
            if (isPlausibleEmail(email)) {
                state.put("email", email);
            }
            state.put("needs_email_confirmation", false);
            state.put("pending_email", "");
        } catch (JSONException ignored) {
            // Existing sanitized values remain in place.
        }
    }

    private void rememberPendingEmail(String email) {
        JSONObject pending = new JSONObject();
        try {
            pending.put("access_token", "");
            pending.put("refresh_token", "");
            pending.put("expires_at", 0L);
            pending.put("user_id", "");
            pending.put("email", email);
            pending.put("needs_email_confirmation", true);
            pending.put("pending_email", email);
            pending.put("had_session", false);
            sessionStore.save(pending);
        } catch (JSONException | UserException ignored) {
            // The UI still receives the safe confirmation message from signUp or
            // signIn; failing to remember a non-secret pending email is harmless.
        }
    }

    private static String readEmail(JSONObject payload) throws UserException {
        if (payload == null) {
            throw new UserException("请求参数格式错误");
        }
        Object rawEmail = payload.opt("email");
        if (!(rawEmail instanceof String)) {
            throw new UserException("请输入邮箱");
        }
        String email = ((String) rawEmail).trim();
        if (email.isEmpty()) {
            throw new UserException("请输入邮箱");
        }
        if (email.length() > MAX_EMAIL_CHARS || !EMAIL_PATTERN.matcher(email).matches()) {
            throw new UserException("邮箱格式不正确");
        }
        return email;
    }

    private static EmailOtp readEmailOtp(JSONObject payload) throws UserException {
        String email = readEmail(payload);
        Object rawToken = payload.opt("token");
        if (!(rawToken instanceof String)) {
            throw new UserException("请输入邮件中的验证码");
        }
        String token = ((String) rawToken).trim();
        if (token.isEmpty()) {
            throw new UserException("请输入邮件中的验证码");
        }
        if (!OTP_PATTERN.matcher(token).matches()) {
            throw new UserException(
                "验证码应为 " + MIN_OTP_DIGITS + "-" + MAX_OTP_DIGITS + " 位数字");
        }
        return new EmailOtp(email, token);
    }

    private static Credentials readCredentials(JSONObject payload, boolean forSignUp)
        throws UserException {
        if (payload == null) {
            throw new UserException("请求参数格式错误");
        }
        Object rawEmail = payload.opt("email");
        Object rawPassword = payload.opt("password");
        if (!(rawEmail instanceof String)) {
            throw new UserException("邮箱格式不正确");
        }
        if (!(rawPassword instanceof String)) {
            throw new UserException("请输入密码");
        }
        String email = ((String) rawEmail).trim();
        String password = (String) rawPassword;
        if (email.isEmpty()) {
            throw new UserException("请输入邮箱");
        }
        if (email.length() > MAX_EMAIL_CHARS || !EMAIL_PATTERN.matcher(email).matches()) {
            throw new UserException("邮箱格式不正确");
        }
        if (password.isEmpty()) {
            throw new UserException("请输入密码");
        }
        if (password.length() > MAX_PASSWORD_CHARS) {
            throw new UserException("密码过长");
        }
        if (forSignUp && password.length() < 6) {
            throw new UserException("密码至少需要 6 位");
        }
        return new Credentials(email, password);
    }

    private static String signInError(int status, String code) {
        if (status == 429 || isRateLimitCode(code)) {
            return "尝试过于频繁，请稍后再试";
        }
        if (status >= 500) {
            return SERVICE_ERROR;
        }
        if (status == 400 || status == 401 || status == 403) {
            return "邮箱或密码不正确";
        }
        return "登录未完成，请稍后重试";
    }

    private static String signUpError(int status, String code) {
        if (status == 429 || isRateLimitCode(code)) {
            return "操作过于频繁，请稍后再试";
        }
        if (isAlreadyRegistered(code)) {
            return "该邮箱已注册，请直接登录";
        }
        if (code.contains("weak_password")) {
            return "密码强度不足，请使用至少 6 位密码";
        }
        if (code.contains("email_address_invalid") || code.contains("validation_failed") ||
            code.contains("invalid_email")) {
            return "邮箱格式不正确";
        }
        if (code.contains("signup_disabled")) {
            return "云端注册暂未开放";
        }
        String mailError = mailConfigurationError(status, code);
        if (!mailError.isEmpty()) {
            return mailError;
        }
        if (status >= 500) {
            // A generic Auth/DB 500 is not evidence of a mail configuration problem.
            return SERVICE_ERROR;
        }
        return "注册信息不符合要求，请检查邮箱和密码";
    }

    private static String verifyError(int status, String code) {
        if (status == 429 || isRateLimitCode(code)) {
            return "尝试过于频繁，请稍后再试";
        }
        if (code.contains("otp_expired") || code.contains("token_has_expired") ||
            code.contains("expired")) {
            return "验证码已过期，请重新发送确认邮件";
        }
        if (status == 400 || status == 401 || status == 403) {
            return "验证码无效或已过期，请重新发送确认邮件";
        }
        if (status >= 500) {
            return SERVICE_ERROR;
        }
        return "邮箱确认未完成，请稍后重试";
    }

    private static String resendError(int status, String code) {
        if (status == 429 || isRateLimitCode(code)) {
            return "发送过于频繁，请稍后再试";
        }
        if (code.contains("email_address_invalid") || code.contains("invalid_email")) {
            return "邮箱格式不正确";
        }
        String mailError = mailConfigurationError(status, code);
        if (!mailError.isEmpty()) {
            return mailError;
        }
        if (status >= 500) {
            return SERVICE_ERROR;
        }
        return "确认邮件发送未完成，请稍后重试";
    }

    /**
     * Fixed operator guidance for the two GoTrue sending failures that occur when
     * custom SMTP is disabled. Only the numeric HTTP status and an explicitly
     * allowlisted code are included; the upstream body is never reflected.
     */
    private static String mailConfigurationError(int status, String code) {
        if (code.contains("email_address_not_authorized")) {
            return "确认邮件无法发送（HTTP " + status + " / email_address_not_authorized）：" +
                "请管理员在 Supabase 配置自定义 SMTP，并检查确认邮件模板";
        }
        if (code.contains("email_send_failed")) {
            return "确认邮件发送失败（HTTP " + status + " / email_send_failed）：" +
                "请管理员检查 Supabase 自定义 SMTP 和邮件服务配置";
        }
        if (status == 500 && code.contains("unexpected_failure")) {
            return "确认邮件发送异常（HTTP 500 / unexpected_failure）：" +
                "请管理员检查 Supabase 自定义 SMTP 和邮件服务配置";
        }
        return "";
    }

    private static boolean isEmailNotConfirmed(int status, String code) {
        return (status == 400 || status == 401 || status == 403) &&
            (code.contains("email_not_confirmed") || code.contains("not_confirmed"));
    }

    private static boolean isAlreadyRegistered(String code) {
        return code.contains("user_already_exists") ||
            code.contains("email_exists") ||
            code.contains("already_registered");
    }

    private static boolean isRateLimitCode(String code) {
        return code.contains("over_request_rate_limit") ||
            code.contains("over_email_send_rate_limit") ||
            code.contains("too_many_requests") ||
            code.contains("rate_limit");
    }

    private static String errorCode(String body) {
        if (body == null || body.isEmpty()) {
            return "";
        }
        try {
            JSONObject object = new JSONObject(body);
            String[] keys = {"error_code", "error", "code", "msg", "message"};
            for (String key : keys) {
                Object value = object.opt(key);
                if (value instanceof String) {
                    String normalized = ((String) value).trim().toLowerCase(Locale.ROOT);
                    if (!normalized.isEmpty() && normalized.length() <= 200) {
                        return normalized.replace(' ', '_').replace('-', '_');
                    }
                }
            }
        } catch (JSONException ignored) {
            // The body is untrusted and is never echoed or logged.
        }
        return "";
    }

    private static JSONObject parseObject(String body) {
        if (body == null || body.isEmpty()) {
            return null;
        }
        try {
            return new JSONObject(body);
        } catch (JSONException exception) {
            return null;
        }
    }

    private static boolean isSuccess(int status) {
        return status >= 200 && status < 300;
    }

    private static boolean hasToken(JSONObject object) {
        return isUsableToken(tokenValue(object.opt("access_token")));
    }

    /**
     * Access and refresh tokens must be non-empty single-line strings. Rejecting
     * whitespace/control characters also prevents header injection.
     */
    private static boolean isUsableToken(String token) {
        if (token == null || token.isEmpty() || token.length() > MAX_TOKEN_CHARS) {
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

    private static String tokenValue(Object value) {
        return value instanceof String ? (String) value : "";
    }

    private static String stringValue(Object value) {
        return value instanceof String ? (String) value : "";
    }

    private static boolean isPlausibleEmail(String email) {
        return email != null && !email.isEmpty() && email.length() <= MAX_EMAIL_CHARS &&
            EMAIL_PATTERN.matcher(email).matches();
    }

    static boolean isUuid(String value) {
        return SyncOwner.isUuid(value);
    }

    private static JSONObject baseStatus() {
        JSONObject result = new JSONObject();
        put(result, "configured", CONFIGURED);
        put(result, "loggedIn", false);
        put(result, "userId", "");
        put(result, "email", "");
        put(result, "needsEmailConfirmation", false);
        return result;
    }

    private static JSONObject statusFromState(JSONObject state) {
        JSONObject result = baseStatus();
        String accessToken = tokenValue(state.opt("access_token"));
        if (!isUsableToken(accessToken)) {
            return result;
        }
        put(result, "loggedIn", true);
        put(result, "userId", state.optString("user_id", ""));
        put(result, "email", state.optString("email", ""));
        put(result, "needsEmailConfirmation", false);
        return result;
    }

    private static JSONObject cachedStatus(JSONObject state, String error) {
        JSONObject result = statusFromState(state);
        if (error != null && !error.isEmpty()) {
            put(result, "error", error);
        }
        return result;
    }

    private static JSONObject pendingStatus(String email) {
        JSONObject result = baseStatus();
        put(result, "email", isPlausibleEmail(email) ? email : "");
        put(result, "needsEmailConfirmation", true);
        return result;
    }

    private static JSONObject failureStatus(String error) {
        JSONObject result = baseStatus();
        if (error != null && !error.isEmpty()) {
            put(result, "error", error);
        }
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException ignored) {
            // All callers use standard JSON values; this is a defensive fallback.
        }
    }

    private static boolean computeConfigured() {
        try {
            URL url = new URL(PROJECT_URL);
            return PUBLISHABLE_KEY.startsWith("sb_publishable_") &&
                PUBLISHABLE_KEY.length() > 30 &&
                "https".equalsIgnoreCase(url.getProtocol()) &&
                PROJECT_HOST.equalsIgnoreCase(url.getHost()) &&
                (url.getPort() == -1 || url.getPort() == 443) &&
                url.getUserInfo() == null &&
                url.getQuery() == null &&
                url.getRef() == null &&
                (url.getPath() == null || url.getPath().isEmpty() || "/".equals(url.getPath()));
        } catch (MalformedURLException exception) {
            return false;
        }
    }

    private static final class EmailOtp {
        final String email;
        final String token;

        EmailOtp(String email, String token) {
            this.email = email;
            this.token = token;
        }
    }

    private static final class Credentials {
        final String email;
        final String password;

        Credentials(String email, String password) {
            this.email = email;
            this.password = password;
        }
    }

    /**
     * Package-private authorization result. It is intentionally not serializable to
     * JSON and must never be returned from {@code NativeBridge}.
     */
    static final class Authorization {
        final String ownerId;
        final String accessToken;

        Authorization(String ownerId, String accessToken) {
            this.ownerId = ownerId;
            this.accessToken = accessToken;
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

    private static final class NetworkFailure extends Exception {
        NetworkFailure() {
            super(null, null, false, false);
        }
    }

    private static final class InvalidSession extends Exception {
        InvalidSession() {
            super(null, null, false, false);
        }
    }
}
