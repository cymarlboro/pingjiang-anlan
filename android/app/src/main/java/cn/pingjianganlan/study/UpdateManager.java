package cn.pingjianganlan.study;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * HTTPS update manifest, checksum, package, version, and signing-certificate checks.
 * System installer confirmation is always preserved.
 */
public final class UpdateManager {
    /** Official manifest used until the user saves a custom HTTPS URL. */
    public static final String DEFAULT_UPDATE_MANIFEST_URL =
        "https://raw.githubusercontent.com/cymarlboro/pingjiang-anlan/main/update.json";
    /** Startup/resume checks are throttled to avoid hitting the host on every resume. */
    public static final long AUTO_CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L;

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 120_000;
    private static final int MANIFEST_READ_TIMEOUT_MS = 30_000;
    private static final int MAX_MANIFEST_BYTES = 512 * 1024;
    private static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 3;
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");

    private final Context context;
    private final NativeStore store;

    public UpdateManager(Context context, NativeStore store) {
        this.context = context.getApplicationContext();
        this.store = store;
    }

    /**
     * Pure throttle policy. A missing/zero timestamp allows the first check, a clock
     * rollback allows a new check rather than suppressing updates indefinitely, and the
     * normal path waits for the full interval.
     */
    static boolean shouldAutoCheck(long lastCheckMillis, long nowMillis, long intervalMillis) {
        if (lastCheckMillis <= 0L) {
            return true;
        }
        if (nowMillis < lastCheckMillis) {
            return true;
        }
        return nowMillis - lastCheckMillis >= Math.max(1L, intervalMillis);
    }

    public JSONObject checkUpdate() throws UserException {
        String manifestUrl = store.getUpdateManifestUrl();
        if (manifestUrl.isEmpty()) {
            throw new UserException("尚未设置更新发布地址");
        }
        JSONObject manifest = fetchManifest(manifestUrl);
        long versionCode = manifestVersionCode(manifest);
        String versionName = manifestVersionName(manifest);
        String apkUrl = manifestApkUrl(manifest);
        String sha256 = manifestSha256(manifest);
        String notes = manifestNotes(manifest);
        long current = currentVersionCode();
        JSONObject result = new JSONObject();
        try {
            result.put("available", versionCode > current);
            result.put("versionCode", versionCode);
            result.put("versionName", versionName);
            result.put("notes", notes);
            result.put("apkUrl", apkUrl);
            result.put("sha256", sha256);
        } catch (JSONException exception) {
            throw new UserException("更新信息整理失败", exception);
        }
        return result;
    }

    /**
     * Re-reads the configured manifest, ignores the client-provided metadata except
     * as an exact match requirement, downloads over HTTPS, verifies SHA256, package
     * id, higher version, and the current signing certificate set, then returns a
     * private cache file for the system installer.
     */
    public PreparedUpdate prepareUpdate(JSONObject payload) throws UserException {
        String manifestUrl = store.getUpdateManifestUrl();
        if (manifestUrl.isEmpty()) {
            throw new UserException("尚未设置更新发布地址");
        }
        JSONObject manifest = fetchManifest(manifestUrl);
        long versionCode = manifestVersionCode(manifest);
        String versionName = manifestVersionName(manifest);
        String apkUrl = manifestApkUrl(manifest);
        String sha256 = manifestSha256(manifest);
        long current = currentVersionCode();
        if (versionCode <= current) {
            throw new UserException("更新版本不高于当前版本，无需安装");
        }
        if (payload == null) {
            throw new UserException("更新参数格式错误");
        }
        long requestedVersion = payload.optLong("versionCode", -1L);
        String requestedUrl = payload.optString("apkUrl", "");
        String requestedSha = payload.optString("sha256", "");
        if (requestedVersion != versionCode || !apkUrl.equals(requestedUrl) ||
            !sha256.equalsIgnoreCase(requestedSha)) {
            throw new UserException("更新参数与发布清单不一致，已拒绝下载");
        }

        File directory = new File(context.getCacheDir(), "updates");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new UserException("无法创建更新缓存目录");
        }
        clearPreviousDownloads(directory);
        File target = new File(directory,
            "update-" + versionCode + "-" + System.currentTimeMillis() + ".apk");
        try {
            downloadApk(apkUrl, target, sha256);
            verifyApk(target, versionCode);
            return new PreparedUpdate(target, versionCode, versionName);
        } catch (UserException exception) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            throw exception;
        }
    }

    public boolean canRequestPackageInstalls() {
        if (Build.VERSION.SDK_INT < 26) {
            return true;
        }
        return context.getPackageManager().canRequestPackageInstalls();
    }

    public Intent unknownSourcesSettingsIntent() {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        return intent;
    }

    public Intent installerIntent(PreparedUpdate update) {
        Uri uri = FileProvider.getUriForFile(context,
            context.getPackageName() + ".fileprovider", update.file);
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newUri(context.getContentResolver(), "update", uri));
        intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
        return intent;
    }

    public void launchInstaller(Activity activity, PreparedUpdate update) throws UserException {
        if (!canRequestPackageInstalls()) {
            throw new UserException("未授予安装未知应用权限");
        }
        try {
            activity.startActivityForResult(installerIntent(update),
                MainActivity.REQUEST_INSTALL_PACKAGE);
        } catch (RuntimeException exception) {
            throw new UserException("无法打开系统安装器", exception);
        }
    }

    public long currentVersionCode() {
        try {
            PackageInfo info = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) {
                return info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException exception) {
            return 0L;
        }
    }

    public String currentVersionName() {
        try {
            PackageInfo info = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "1.0" : info.versionName;
        } catch (PackageManager.NameNotFoundException exception) {
            return "1.0";
        }
    }

    private JSONObject fetchManifest(String manifestUrl) throws UserException {
        HttpURLConnection connection = null;
        String current = manifestUrl;
        try {
            for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
                validateHttps(current);
                URL url = new URL(current);
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(MANIFEST_READ_TIMEOUT_MS);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", "Shanchuanji/1.0.1");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    connection = null;
                    if (location == null || location.isEmpty() || redirect == MAX_REDIRECTS) {
                        throw new UserException("更新清单重定向无效");
                    }
                    current = new URL(url, location).toString();
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new UserException("更新清单返回 HTTP " + status);
                }
                String body = readLimited(connection.getInputStream(), MAX_MANIFEST_BYTES);
                JSONObject manifest;
                try {
                    manifest = new JSONObject(body);
                } catch (JSONException exception) {
                    throw new UserException("更新清单不是有效 JSON", exception);
                }
                return manifest;
            }
            throw new UserException("更新清单重定向过多");
        } catch (UserException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            throw new UserException("更新清单读取失败", exception);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void downloadApk(String apkUrl, File target, String expectedSha) throws UserException {
        HttpURLConnection connection = null;
        String current = apkUrl;
        try {
            for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
                validateHttps(current);
                URL url = new URL(current);
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
                connection.setRequestProperty("User-Agent", "Shanchuanji/1.0.1");
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    connection.disconnect();
                    connection = null;
                    if (location == null || location.isEmpty() || redirect == MAX_REDIRECTS) {
                        throw new UserException("安装包重定向无效");
                    }
                    current = new URL(url, location).toString();
                    continue;
                }
                if (status < 200 || status >= 300) {
                    throw new UserException("安装包下载失败（HTTP " + status + "）");
                }
                long declared = connection.getContentLengthLong();
                if (declared > MAX_APK_BYTES) {
                    throw new UserException("安装包超过 200MB");
                }
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long total = 0;
                boolean success = false;
                long downloadDeadline = System.currentTimeMillis() + 120_000L;
                try (InputStream input = connection.getInputStream();
                     OutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        if (read == 0) {
                            continue;
                        }
                        if (System.currentTimeMillis() > downloadDeadline) {
                            throw new UserException("安装包下载超时，请稍后重试");
                        }
                        total += read;
                        if (total > MAX_APK_BYTES) {
                            throw new UserException("安装包超过 200MB");
                        }
                        digest.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                    }
                    output.flush();
                    success = true;
                } finally {
                    if (!success) {
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                    }
                }
                if (total <= 0) {
                    throw new UserException("安装包为空");
                }
                String actual = toHex(digest.digest());
                if (!actual.equalsIgnoreCase(expectedSha)) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    throw new UserException("安装包 SHA256 校验失败，已拒绝安装");
                }
                return;
            }
            throw new UserException("安装包重定向过多");
        } catch (UserException exception) {
            throw exception;
        } catch (IOException | NoSuchAlgorithmException | RuntimeException exception) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            throw new UserException("安装包下载失败", exception);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void verifyApk(File apk, long expectedVersionCode) throws UserException {
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (archive == null) {
            throw new UserException("无法解析安装包");
        }
        if (!context.getPackageName().equals(archive.packageName)) {
            throw new UserException("安装包包名与当前应用不一致");
        }
        long archiveVersionCode = Build.VERSION.SDK_INT >= 28
            ? archive.getLongVersionCode() : archive.versionCode;
        if (archiveVersionCode != expectedVersionCode) {
            throw new UserException("安装包版本与更新清单不一致");
        }
        if (archiveVersionCode <= currentVersionCode()) {
            throw new UserException("安装包版本未高于当前版本");
        }
        Set<String> currentSigners = signerDigests(currentPackageInfo(flags));
        Set<String> archiveSigners = signerDigests(archive);
        if (currentSigners.isEmpty() || archiveSigners.isEmpty() ||
            !currentSigners.equals(archiveSigners)) {
            throw new UserException("安装包签名与当前应用不一致，已拒绝安装");
        }
    }

    private PackageInfo currentPackageInfo(int flags) throws UserException {
        try {
            return context.getPackageManager()
                .getPackageInfo(context.getPackageName(), flags);
        } catch (PackageManager.NameNotFoundException exception) {
            throw new UserException("无法读取当前应用签名", exception);
        }
    }

    private static Set<String> signerDigests(PackageInfo info) throws UserException {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            SigningInfo signingInfo = info.signingInfo;
            if (signingInfo == null) {
                return new HashSet<>();
            }
            signatures = signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null) {
            return new HashSet<>();
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            Set<String> result = new HashSet<>();
            for (Signature signature : signatures) {
                if (signature != null) {
                    result.add(toHex(digest.digest(signature.toByteArray())));
                }
            }
            return result;
        } catch (NoSuchAlgorithmException exception) {
            throw new UserException("设备不支持签名校验", exception);
        }
    }

    private static long manifestVersionCode(JSONObject manifest) throws UserException {
        Object raw = manifest.opt("versionCode");
        if (!(raw instanceof Number)) {
            throw new UserException("更新清单缺少有效 versionCode");
        }
        double number = ((Number) raw).doubleValue();
        if (number != Math.rint(number) || number < 1 ||
            number > NativeStore.MAX_JS_SAFE_INTEGER) {
            throw new UserException("更新清单 versionCode 无效");
        }
        return (long) number;
    }

    private static String manifestVersionName(JSONObject manifest) throws UserException {
        String value = manifest.optString("versionName", "").trim();
        if (value.isEmpty() || value.length() > 64) {
            throw new UserException("更新清单 versionName 无效");
        }
        return value;
    }

    private static String manifestApkUrl(JSONObject manifest) throws UserException {
        String value = manifest.optString("apkUrl", "").trim();
        if (value.isEmpty()) {
            throw new UserException("更新清单缺少 apkUrl");
        }
        try {
            return UrlRules.requireHttpsResource(value, 4096);
        } catch (UrlRules.InvalidUrlException exception) {
            throw new UserException(exception.getMessage(), exception);
        }
    }

    private static String manifestSha256(JSONObject manifest) throws UserException {
        String value = manifest.optString("sha256", "").trim();
        if (!SHA256.matcher(value).matches()) {
            throw new UserException("更新清单 sha256 无效");
        }
        return value.toLowerCase(Locale.ROOT);
    }

    private static String manifestNotes(JSONObject manifest) throws UserException {
        String notes = manifest.optString("notes", "");
        if (notes.length() > 4000) {
            throw new UserException("更新说明过长");
        }
        return notes;
    }

    private static void validateHttps(String url) throws UserException {
        try {
            UrlRules.requireHttpsResource(url, 4096);
        } catch (UrlRules.InvalidUrlException exception) {
            throw new UserException(exception.getMessage(), exception);
        }
    }

    private static String readLimited(InputStream input, int maxBytes)
        throws IOException, UserException {
        if (input == null) {
            throw new UserException("更新清单为空");
        }
        try (InputStream source = input) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = source.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                total += read;
                if (total > maxBytes) {
                    throw new UserException("更新清单过大");
                }
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return builder.toString();
    }

    private static void clearPreviousDownloads(File directory) {
        File[] files = directory.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.isFile() && file.getName().startsWith("update-") &&
                file.getName().endsWith(".apk")) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    public static final class PreparedUpdate {
        private final File file;
        private final long versionCode;
        private final String versionName;

        PreparedUpdate(File file, long versionCode, String versionName) {
            this.file = file;
            this.versionCode = versionCode;
            this.versionName = versionName;
        }

        public File getFile() {
            return file;
        }

        public long getVersionCode() {
            return versionCode;
        }

        public String getVersionName() {
            return versionName;
        }
    }
}
