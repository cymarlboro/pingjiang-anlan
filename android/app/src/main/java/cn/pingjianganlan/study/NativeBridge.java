package cn.pingjianganlan.study;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

/**
 * Single, non-global JavaScript bridge. Only the trusted asset page can load the
 * WebView; all methods are asynchronous except the small cached bootstrap snapshot.
 * Results are always delivered through JSONObject.quote-escaped JavaScript.
 */
public final class NativeBridge {
    public interface Host {
        boolean isAlive();

        void evaluateJavascript(String script);

        void pickImport(String requestId);

        void exportBackup(String requestId, String backupJson);

        void importBackup(String requestId);

        void installUpdate(String requestId, UpdateManager.PreparedUpdate update);

        void requestNotificationPermission(String requestId);

        void requestExactAlarmPermission(String requestId);
    }

    private static final int MAX_PAYLOAD_CHARS = 22 * 1024 * 1024;

    private final Context context;
    private final Host host;
    private final NativeStore store;
    private final ApiSettings apiSettings;
    private final CloudAuth cloudAuth;
    private final CloudSyncClient cloudSyncClient;
    private final ApiClient apiClient;
    private final DocumentImporter documentImporter;
    private final UpdateManager updateManager;
    private final ExecutorService ioExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile String bootstrapJson;
    private volatile boolean active = true;

    public NativeBridge(Context context, Host host, NativeStore store, ApiSettings apiSettings,
                        ApiClient apiClient, DocumentImporter documentImporter,
                        UpdateManager updateManager, ExecutorService ioExecutor) {
        this.context = context.getApplicationContext();
        this.host = host;
        this.store = store;
        this.apiSettings = apiSettings;
        this.cloudAuth = new CloudAuth(this.context);
        this.cloudSyncClient = new CloudSyncClient(this.cloudAuth, store);
        this.apiClient = apiClient;
        this.documentImporter = documentImporter;
        this.updateManager = updateManager;
        this.ioExecutor = ioExecutor;
    }

    /** Synchronous contract method; returns the snapshot preloaded before app.js runs. */
    @JavascriptInterface
    public String getBootstrap() {
        String value = bootstrapJson;
        if (value == null) {
            try {
                refreshBootstrap();
                value = bootstrapJson;
            } catch (UserException exception) {
                value = "{\"customQuestions\":[],\"customSources\":[],\"customTypes\":{},\"customAnswers\":[]}";
            }
        }
        return value == null ? "{}" : value;
    }

    @JavascriptInterface
    public void request(String id, String method, String payloadJson) {
        if (!active || !host.isAlive()) {
            return;
        }
        if (id == null || id.isEmpty() || id.length() > 200) {
            return;
        }
        if (method == null || method.length() > 80) {
            completeError(id, "不支持的方法");
            return;
        }
        try {
            ioExecutor.execute(() -> dispatch(id, method, payloadJson));
        } catch (RejectedExecutionException exception) {
            completeError(id, "应用正在关闭，请重试");
        }
    }

    public void refreshBootstrap() throws UserException {
        bootstrapJson = store.bootstrapJson();
    }

    public void shutdown() {
        active = false;
    }

    public void completeReminder(String id) {
        try {
            JSONObject config = store.getReminder();
            config.put("permissionGranted", ReminderScheduler.permissionGranted(context));
            config.put("channelEnabled", ReminderScheduler.channelEnabled(context));
            boolean exactAlarmAllowed = ReminderScheduler.canScheduleExactAlarms(context);
            config.put("exactAlarmAllowed", exactAlarmAllowed);
            config.put("exactAlarmPermissionRequired",
                ReminderScheduler.exactAlarmPermissionRequired(context));
            config.put("alarmMode", ReminderScheduler.scheduleMode(context) ==
                ReminderScheduler.ScheduleMode.EXACT ? "exact" : "inexact");
            completeSuccess(id, config);
        } catch (JSONException | RuntimeException exception) {
            completeError(id, "提醒设置读取失败");
        }
    }

    public void completeReminderPermission(String id) {
        completeReminder(id);
    }

    public void completeInstall(String id) {
        completeSuccess(id, new JSONObject());
    }

    public void completeBackupExport(String id) {
        completeSuccess(id, new JSONObject());
    }

    public void completeBackupImport(String id, JSONObject state) {
        JSONObject data = new JSONObject();
        try {
            data.put("state", state);
        } catch (JSONException exception) {
            completeError(id, "备份恢复结果整理失败");
            return;
        }
        completeSuccess(id, data);
    }

    public void completeImport(String id, JSONObject document) {
        completeSuccess(id, document);
    }

    public void completeError(String id, String message) {
        if (id == null || id.isEmpty() || id.length() > 200) {
            return;
        }
        mainHandler.post(() -> deliver(id, null, message));
    }

    public void completeSuccess(String id, JSONObject data) {
        completeSuccessInternal(id, data);
    }

    public void completeSuccess(String id, JSONArray data) {
        completeSuccessInternal(id, data);
    }

    private void completeSuccessInternal(String id, Object data) {
        mainHandler.post(() -> deliver(id, data, null));
    }

    private void dispatch(String id, String method, String payloadJson) {
        try {
            JSONObject payload = parsePayload(payloadJson);
            switch (method) {
                case "getApiConfig":
                    completeSuccess(id, apiSettings.get());
                    return;
                case "saveApiConfig":
                    completeSuccess(id, apiSettings.save(payload));
                    return;
                case "testApi":
                    completeSuccess(id, apiClient.testApi());
                    return;
                case "listImports":
                    completeSuccess(id, store.listImports());
                    return;
                case "pickImport":
                    mainHandler.post(() -> {
                        if (active && host.isAlive()) {
                            host.pickImport(id);
                        }
                    });
                    return;
                case "getImport": {
                    long importId = payload.optLong("id", -1L);
                    if (importId < 0) {
                        throw new UserException("导入资料编号无效");
                    }
                    completeSuccess(id, store.getImport(importId));
                    return;
                }
                case "generate":
                    completeSuccess(id, apiClient.generate(payload));
                    return;
                case "acceptQuestions": {
                    int count = store.acceptQuestions(payload);
                    refreshBootstrap();
                    JSONObject data = new JSONObject();
                    data.put("count", count);
                    completeSuccess(id, data);
                    return;
                }
                case "getReminder":
                    completeReminder(id);
                    return;
                case "saveReminder":
                    saveReminder(id, payload);
                    return;
                case "requestExactAlarmPermission":
                    mainHandler.post(() -> {
                        if (active && host.isAlive()) {
                            host.requestExactAlarmPermission(id);
                        } else {
                            completeError(id, "应用不在前台，无法打开系统设置");
                        }
                    });
                    return;
                case "exportBackup":
                    exportBackup(id, payload);
                    return;
                case "importBackup":
                    mainHandler.post(() -> {
                        if (active && host.isAlive()) {
                            host.importBackup(id);
                        }
                    });
                    return;
                case "cloudAuthStatus":
                    completeSuccess(id, cloudAuth.status());
                    return;
                case "cloudSignIn":
                    completeSuccess(id, cloudAuth.signIn(payload));
                    return;
                case "cloudSignUp":
                    completeSuccess(id, cloudAuth.signUp(payload));
                    return;
                case "cloudVerifyOtp":
                    completeSuccess(id, cloudAuth.verifyOtp(payload));
                    return;
                case "cloudResendSignup":
                    completeSuccess(id, cloudAuth.resendSignup(payload));
                    return;
                case "cloudSignOut":
                    completeSuccess(id, cloudAuth.signOut());
                    return;
                case "cloudSyncStatus":
                    completeSuccess(id, cloudSyncClient.status());
                    return;
                case "cloudSyncPull":
                    completeSuccess(id, cloudSyncClient.pull());
                    return;
                case "cloudSyncPush":
                    completeSuccess(id, cloudSyncClient.push(payload));
                    return;
                case "cloudSyncExport":
                    completeSuccess(id, cloudSyncClient.exportNative());
                    return;
                case "cloudSyncApply": {
                    JSONObject result = cloudSyncClient.apply(payload);
                    if (result.optBoolean("changed", false)) {
                        refreshBootstrap();
                    }
                    completeSuccess(id, result);
                    return;
                }
                case "getUpdateConfig": {
                    JSONObject data = new JSONObject();
                    data.put("manifestUrl", store.getUpdateManifestUrl());
                    data.put("usingDefault", store.isUsingDefaultUpdateManifest());
                    completeSuccess(id, data);
                    return;
                }
                case "saveUpdateConfig": {
                    String manifestUrl = payload.optString("manifestUrl", "");
                    store.saveUpdateManifestUrl(manifestUrl);
                    JSONObject data = new JSONObject();
                    data.put("manifestUrl", store.getUpdateManifestUrl());
                    data.put("usingDefault", store.isUsingDefaultUpdateManifest());
                    completeSuccess(id, data);
                    return;
                }
                case "checkUpdate":
                    completeSuccess(id, updateManager.checkUpdate());
                    return;
                case "installUpdate":
                    installUpdate(id, payload);
                    return;
                case "appInfo": {
                    JSONObject data = new JSONObject();
                    data.put("versionName", updateManager.currentVersionName());
                    data.put("versionCode", updateManager.currentVersionCode());
                    data.put("packageName", context.getPackageName());
                    completeSuccess(id, data);
                    return;
                }
                default:
                    completeError(id, "不支持的方法");
            }
        } catch (UserException exception) {
            completeError(id, exception.getMessage());
        } catch (JSONException exception) {
            completeError(id, "请求参数格式错误");
        } catch (RuntimeException exception) {
            completeError(id, "操作失败，请稍后重试");
        }
    }

    private void saveReminder(String id, JSONObject payload) throws UserException, JSONException {
        boolean enabled = payload.optBoolean("enabled", false);
        String time = payload.optString("time", "");
        if (!TextRules.isValidReminderTime(time)) {
            throw new UserException("提醒时间格式应为 HH:mm");
        }
        store.saveReminder(enabled, time);
        if (enabled) {
            ReminderScheduler.schedule(context, time);
        } else {
            ReminderScheduler.cancel(context);
        }
        boolean needsPermission = enabled && Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED;
        if (needsPermission) {
            mainHandler.post(() -> {
                if (active && host.isAlive()) {
                    host.requestNotificationPermission(id);
                } else {
                    completeError(id, "应用不在前台，无法请求通知权限");
                }
            });
            return;
        }
        completeReminder(id);
    }

    private void exportBackup(String id, JSONObject payload) throws UserException, JSONException {
        Object raw = payload.opt("json");
        if (!(raw instanceof String)) {
            throw new UserException("备份内容格式错误");
        }
        String stateText = (String) raw;
        if (stateText.length() > MAX_PAYLOAD_CHARS) {
            throw new UserException("备份内容过大");
        }
        JSONObject state;
        try {
            state = new JSONObject(stateText);
        } catch (JSONException exception) {
            throw new UserException("学习记录不是有效 JSON", exception);
        }
        JSONObject backup = store.exportBackup(state, context.getPackageName(),
            updateManager.currentVersionCode(), updateManager.currentVersionName());
        String backupText = backup.toString();
        mainHandler.post(() -> {
            if (active && host.isAlive()) {
                host.exportBackup(id, backupText);
            } else {
                completeError(id, "应用不在前台，未导出备份");
            }
        });
    }

    private void installUpdate(String id, JSONObject payload) throws UserException, JSONException {
        UpdateManager.PreparedUpdate prepared = updateManager.prepareUpdate(payload);
        mainHandler.post(() -> {
            if (active && host.isAlive()) {
                host.installUpdate(id, prepared);
            } else {
                completeError(id, "应用不在前台，无法启动安装");
            }
        });
    }

    private JSONObject parsePayload(String payloadJson) throws UserException {
        if (payloadJson == null || payloadJson.trim().isEmpty()) {
            return new JSONObject();
        }
        if (payloadJson.length() > MAX_PAYLOAD_CHARS) {
            throw new UserException("请求参数过大");
        }
        try {
            return new JSONObject(payloadJson);
        } catch (JSONException exception) {
            throw new UserException("请求参数格式错误", exception);
        }
    }

    private void deliver(String id, Object data, String error) {
        if (!active || !host.isAlive()) {
            return;
        }
        try {
            JSONObject result = new JSONObject();
            result.put("ok", error == null);
            if (error == null) {
                if (data == null) {
                    result.put("data", new JSONObject());
                } else {
                    result.put("data", data);
                }
            } else {
                result.put("error", error);
            }
            String script = "if (typeof window.__nativeResult === 'function') {"
                + "window.__nativeResult(" + JsJson.quote(id) + ","
                + JsJson.objectLiteral(result) + ");}";
            host.evaluateJavascript(script);
        } catch (JSONException exception) {
            // A result containing only standard JSON values cannot normally fail here.
        }
    }
}
