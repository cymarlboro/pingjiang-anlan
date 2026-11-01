package cn.pingjianganlan.study;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Single Activity hosting the offline asset UI in a locked-down WebView. All
 * document parsing, network calls, OCR, backups, and update work run on a background
 * executor; results return to the UI thread through NativeBridge.
 */
public final class MainActivity extends Activity implements NativeBridge.Host {
    public static final int REQUEST_PICK_IMPORT = 1001;
    public static final int REQUEST_EXPORT_BACKUP = 1002;
    public static final int REQUEST_IMPORT_BACKUP = 1003;
    public static final int REQUEST_UNKNOWN_SOURCES = 1004;
    public static final int REQUEST_INSTALL_PACKAGE = 1005;
    public static final int REQUEST_NOTIFICATIONS = 1006;
    public static final int REQUEST_EXACT_ALARM = 1007;

    private static final String TRUSTED_HOST = "appassets.androidplatform.net";
    private static final String START_URL =
        "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int MAX_HTML_INJECT_BYTES = 2 * 1024 * 1024;
    private static final String UPDATE_PREFS = "update_check";
    private static final String UPDATE_LAST_CHECK = "last_check_ms";

    private FrameLayout root;
    private WebView webView;
    private LinearLayout loadingView;
    private TextView fatalView;
    private WebViewAssetLoader assetLoader;
    private ExecutorService ioExecutor;
    private Handler mainHandler;
    private NativeStore store;
    private SecureStore secureStore;
    private ApiSettings apiSettings;
    private ApiClient apiClient;
    private DocumentImporter documentImporter;
    private UpdateManager updateManager;
    private NativeBridge bridge;
    private PendingAction pendingAction;
    private String notificationRequestId;
    private String exactAlarmRequestId;
    private volatile JSONObject pendingUpdate;
    private boolean webPageReady;
    private boolean destroyed;
    private boolean mainFrameError;

    private enum PendingType {
        PICK_IMPORT,
        EXPORT_BACKUP,
        IMPORT_BACKUP,
        UNKNOWN_SOURCES
    }

    private static final class PendingAction {
        final PendingType type;
        final String requestId;
        final String exportJson;
        final UpdateManager.PreparedUpdate update;

        PendingAction(PendingType type, String requestId, String exportJson,
                      UpdateManager.PreparedUpdate update) {
            this.type = type;
            this.requestId = requestId;
            this.exportJson = exportJson;
            this.update = update;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        buildRoot();
        mainHandler = new Handler(Looper.getMainLooper());
        ioExecutor = Executors.newFixedThreadPool(3, runnable -> {
            Thread thread = new Thread(runnable, "shanchuanji-io");
            thread.setDaemon(true);
            return thread;
        });
        ioExecutor.execute(() -> {
            try {
                store = new NativeStore(MainActivity.this);
                secureStore = new SecureStore(MainActivity.this);
                apiSettings = new ApiSettings(store, secureStore);
                apiClient = new ApiClient(apiSettings, store);
                documentImporter = new DocumentImporter(MainActivity.this, store);
                updateManager = new UpdateManager(MainActivity.this, store);
                bridge = new NativeBridge(MainActivity.this, MainActivity.this, store,
                    apiSettings, apiClient, documentImporter, updateManager, ioExecutor);
                bridge.refreshBootstrap();
                mainHandler.post(() -> {
                    if (!destroyed) {
                        setupWebView();
                        maybeCheckForUpdates();
                    }
                });
            } catch (Throwable throwable) {
                mainHandler.post(() -> showFatal("本地数据无法读取。为避免覆盖旧数据，应用没有清空任何内容。"));
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeCheckForUpdates();
    }

    private void configureWindow() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 27) {
            window.setNavigationBarColor(Color.TRANSPARENT);
        } else {
            // Android 8.0 has no light navigation-bar icons; use a deep blue bar
            // instead of placing white icons over the light background.
            window.setNavigationBarColor(0xFF173D63);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(Build.VERSION.SDK_INT >= 27);
    }

    private void buildRoot() {
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF3F8FD);
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            int left = Math.max(bars.left, cutout.left);
            int top = Math.max(bars.top, cutout.top);
            int right = Math.max(bars.right, cutout.right);
            int bottom = Math.max(Math.max(bars.bottom, cutout.bottom), ime.bottom);
            view.setPadding(left, top, right, bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);

        loadingView = new LinearLayout(this);
        loadingView.setOrientation(LinearLayout.VERTICAL);
        loadingView.setGravity(Gravity.CENTER);
        loadingView.setBackgroundColor(0xFFF3F8FD);
        ProgressBar progress = new ProgressBar(this);
        TextView label = new TextView(this);
        label.setText("平江安澜\n正在打开本地题库…");
        label.setTextColor(0xFF173D63);
        label.setTextSize(16f);
        label.setGravity(Gravity.CENTER);
        label.setLineSpacing(6f, 1f);
        loadingView.addView(progress, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelParams.topMargin = (int) (18 * getResources().getDisplayMetrics().density);
        loadingView.addView(label, labelParams);
        root.addView(loadingView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        fatalView = new TextView(this);
        fatalView.setTextColor(0xFF173D63);
        fatalView.setTextSize(16f);
        fatalView.setGravity(Gravity.CENTER);
        fatalView.setPadding(dp(24), dp(24), dp(24), dp(24));
        fatalView.setBackgroundColor(0xFFF3F8FD);
        fatalView.setVisibility(View.GONE);
        root.addView(fatalView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void setupWebView() {
        if (destroyed) {
            return;
        }
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        WebView view = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setDatabaseEnabled(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setDefaultTextEncodingName("UTF-8");
        settings.setUserAgentString(settings.getUserAgentString() + " Shanchuanji/1.0.1");
        if (Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(false);
        cookieManager.setAcceptThirdPartyCookies(view, false);
        view.setBackgroundColor(0xFFF3F8FD);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.addJavascriptInterface(bridge, "AndroidBridge");

        assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView webView, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView webView, String url, String message,
                                       JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
                return true;
            }
        });
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            // Files, backups, and updates have explicit native flows. A generic
            // WebView download must never write to external storage.
            Toast.makeText(this, "请使用应用内的保存或更新入口", Toast.LENGTH_SHORT).show();
        });

        webView = view;
        webPageReady = false;
        root.addView(view, 0, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        loadingView.setVisibility(View.VISIBLE);
        fatalView.setVisibility(View.GONE);
        mainFrameError = false;
        view.loadUrl(START_URL);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            if (uri == null) {
                return true;
            }
            if (isTrusted(uri)) {
                return false;
            }
            if (TRUSTED_HOST.equalsIgnoreCase(uri.getHost())) {
                return true;
            }
            if (request.isForMainFrame() && isBrowserUrl(uri)) {
                openExternal(uri);
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return intercept(request == null ? null : request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameError = false;
            webPageReady = false;
            if (url == null || !isTrusted(Uri.parse(url))) {
                view.stopLoading();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (url != null && isTrusted(Uri.parse(url))) {
                loadingView.setVisibility(View.GONE);
                if (!mainFrameError) {
                    fatalView.setVisibility(View.GONE);
                }
                webPageReady = true;
                deliverPendingUpdate();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    android.webkit.WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                mainFrameError = true;
                loadingView.setVisibility(View.GONE);
                showFatal("本地页面加载失败。请重新启动应用；现有学习记录没有被清空。");
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            if (request != null && request.isForMainFrame() && errorResponse != null &&
                errorResponse.getStatusCode() >= 400) {
                mainFrameError = true;
                loadingView.setVisibility(View.GONE);
                showFatal("本地页面资源缺失。请重新构建安装包；现有学习记录没有被清空。");
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                       android.net.http.SslError error) {
            handler.cancel();
            loadingView.setVisibility(View.GONE);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (destroyed) {
                return true;
            }
            destroyWebView();
            mainHandler.post(() -> {
                if (!destroyed) {
                    setupWebView();
                }
            });
            return true;
        }
    }

    private WebResourceResponse intercept(Uri uri) {
        if (uri == null) {
            return blockedResponse(400);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("https".equals(scheme) && TRUSTED_HOST.equalsIgnoreCase(uri.getHost())) {
            if (!isTrusted(uri)) {
                return blockedResponse(403);
            }
            WebResourceResponse response = assetLoader.shouldInterceptRequest(uri);
            if (response == null) {
                return blockedResponse(404);
            }
            return maybeInjectCsp(uri, response);
        }
        if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) {
            return null;
        }
        return blockedResponse(403);
    }

    private WebResourceResponse maybeInjectCsp(Uri uri, WebResourceResponse response) {
        String path = uri.getPath();
        if (path == null || !path.endsWith(".html")) {
            return response;
        }
        String encoding = response.getEncoding();
        if (encoding != null && !"utf-8".equalsIgnoreCase(encoding)) {
            return response;
        }
        InputStream input = response.getData();
        if (input == null) {
            return response;
        }
        try {
            byte[] bytes = readLimited(input, MAX_HTML_INJECT_BYTES);
            String html = new String(bytes, StandardCharsets.UTF_8);
            String csp = "<meta http-equiv=\"Content-Security-Policy\" content=\""
                + "default-src 'self' data: blob:; "
                + "script-src 'self' 'unsafe-inline'; "
                + "style-src 'self' 'unsafe-inline'; "
                + "img-src 'self' data: blob:; "
                + "font-src 'self' data:; "
                + "media-src 'self' data: blob:; "
                + "connect-src 'none'; "
                + "frame-src 'none'; "
                + "worker-src 'none'; "
                + "object-src 'none'; "
                + "base-uri 'self'; "
                + "form-action 'none'\">";
            String lower = html.toLowerCase(Locale.ROOT);
            int headEnd = lower.indexOf("</head>");
            if (headEnd >= 0) {
                html = html.substring(0, headEnd) + csp + html.substring(headEnd);
            } else {
                html = csp + html;
            }
            return new WebResourceResponse("text/html", "UTF-8",
                new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException | RuntimeException exception) {
            return blockedResponse(500);
        } catch (UserException exception) {
            return blockedResponse(500);
        }
    }

    private static boolean isTrusted(Uri uri) {
        if (uri == null) {
            return false;
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) ||
            !TRUSTED_HOST.equalsIgnoreCase(uri.getHost())) {
            return false;
        }
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            return false;
        }
        if (uri.getUserInfo() != null) {
            return false;
        }
        String path = uri.getPath();
        return path != null && path.startsWith("/assets/www/");
    }

    private static boolean isBrowserUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        return ("http".equals(scheme) || "https".equals(scheme)) &&
            uri.getHost() != null && !TRUSTED_HOST.equalsIgnoreCase(uri.getHost());
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (RuntimeException exception) {
            Toast.makeText(this, "无法打开外部链接", Toast.LENGTH_SHORT).show();
        }
    }

    private static WebResourceResponse blockedResponse(int status) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", status, "Blocked",
            headers, new ByteArrayInputStream(new byte[0]));
    }

    private static byte[] readLimited(InputStream input, int maxBytes)
        throws IOException, UserException {
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
                    throw new UserException("页面资源过大");
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    @Override
    public boolean isAlive() {
        return !destroyed && !isFinishing();
    }

    @Override
    public void evaluateJavascript(String script) {
        if (!isAlive()) {
            return;
        }
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(() -> evaluateJavascript(script));
            return;
        }
        if (webView != null) {
            webView.evaluateJavascript(script, null);
        }
    }

    @Override
    public void pickImport(String requestId) {
        if (pendingAction != null) {
            bridge.completeError(requestId, "另一个文件操作正在进行");
            return;
        }
        pendingAction = new PendingAction(PendingType.PICK_IMPORT, requestId, null, null);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/markdown",
            "text/x-markdown",
            "text/html",
            "text/plain"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        launchForResult(intent, REQUEST_PICK_IMPORT);
    }

    @Override
    public void exportBackup(String requestId, String backupJson) {
        if (pendingAction != null) {
            bridge.completeError(requestId, "另一个文件操作正在进行");
            return;
        }
        pendingAction = new PendingAction(PendingType.EXPORT_BACKUP, requestId, backupJson, null);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        String timestamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US)
            .format(new Date());
        intent.putExtra(Intent.EXTRA_TITLE, "pingjianganlan-backup-" + timestamp + ".json");
        launchForResult(intent, REQUEST_EXPORT_BACKUP);
    }

    @Override
    public void importBackup(String requestId) {
        if (pendingAction != null) {
            bridge.completeError(requestId, "另一个文件操作正在进行");
            return;
        }
        pendingAction = new PendingAction(PendingType.IMPORT_BACKUP, requestId, null, null);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "application/json", "text/json", "text/plain"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        launchForResult(intent, REQUEST_IMPORT_BACKUP);
    }

    @Override
    public void installUpdate(String requestId, UpdateManager.PreparedUpdate update) {
        if (update == null) {
            bridge.completeError(requestId, "更新包无效");
            return;
        }
        if (!updateManager.canRequestPackageInstalls()) {
            if (pendingAction != null) {
                bridge.completeError(requestId, "另一个操作正在进行");
                return;
            }
            pendingAction = new PendingAction(PendingType.UNKNOWN_SOURCES, requestId, null, update);
            try {
                startActivityForResult(updateManager.unknownSourcesSettingsIntent(),
                    REQUEST_UNKNOWN_SOURCES);
            } catch (RuntimeException exception) {
                pendingAction = null;
                bridge.completeError(requestId, "无法打开安装权限设置");
            }
            return;
        }
        launchInstallerAndComplete(requestId, update);
    }

    @Override
    public void requestNotificationPermission(String requestId) {
        if (notificationRequestId != null) {
            bridge.completeError(requestId, "通知权限请求正在进行");
            return;
        }
        if (Build.VERSION.SDK_INT < 33) {
            bridge.completeReminderPermission(requestId);
            return;
        }
        notificationRequestId = requestId;
        try {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                REQUEST_NOTIFICATIONS);
        } catch (RuntimeException exception) {
            notificationRequestId = null;
            bridge.completeReminderPermission(requestId);
        }
    }

    @Override
    public void requestExactAlarmPermission(String requestId) {
        if (Build.VERSION.SDK_INT < 31 || ReminderScheduler.canScheduleExactAlarms(this)) {
            bridge.completeReminder(requestId);
            return;
        }
        if (exactAlarmRequestId != null) {
            bridge.completeError(requestId, "精确提醒权限请求正在进行");
            return;
        }
        exactAlarmRequestId = requestId;
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + getPackageName()));
        try {
            startActivityForResult(intent, REQUEST_EXACT_ALARM);
        } catch (RuntimeException exception) {
            exactAlarmRequestId = null;
            bridge.completeError(requestId, "无法打开精确提醒权限设置");
        }
    }

    private void launchInstallerAndComplete(String requestId,
                                            UpdateManager.PreparedUpdate update) {
        try {
            updateManager.launchInstaller(this, update);
            bridge.completeInstall(requestId);
        } catch (UserException exception) {
            bridge.completeError(requestId, exception.getMessage());
        }
    }

    private void launchForResult(Intent intent, int requestCode) {
        PendingAction action = pendingAction;
        try {
            startActivityForResult(intent, requestCode);
        } catch (RuntimeException exception) {
            pendingAction = null;
            if (action != null) {
                bridge.completeError(action.requestId, "无法打开系统文件选择器");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_INSTALL_PACKAGE) {
            // The system installer owns the result; the bridge already reported that
            // the system confirmation screen was opened.
            return;
        }
        if (requestCode == REQUEST_EXACT_ALARM) {
            String requestId = exactAlarmRequestId;
            exactAlarmRequestId = null;
            if (requestId != null) {
                // The result code is not meaningful for this Settings screen; re-check
                // the actual permission and replace the inexact alarm when allowed.
                rescheduleReminderIfEnabled();
                bridge.completeReminder(requestId);
            }
            return;
        }
        PendingAction action = pendingAction;
        if (action == null) {
            return;
        }
        if (requestCode == REQUEST_PICK_IMPORT && action.type == PendingType.PICK_IMPORT) {
            pendingAction = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                bridge.completeError(action.requestId, "已取消选择");
                return;
            }
            final Uri uri = data.getData();
            final String requestId = action.requestId;
            ioExecutor.execute(() -> {
                try {
                    JSONObject document = documentImporter.importFromUri(uri);
                    bridge.completeImport(requestId, document);
                } catch (UserException exception) {
                    bridge.completeError(requestId, exception.getMessage());
                } catch (RuntimeException exception) {
                    bridge.completeError(requestId, "文件导入失败");
                }
            });
            return;
        }
        if (requestCode == REQUEST_EXPORT_BACKUP && action.type == PendingType.EXPORT_BACKUP) {
            pendingAction = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                bridge.completeError(action.requestId, "已取消导出");
                return;
            }
            final Uri uri = data.getData();
            final String requestId = action.requestId;
            final String json = action.exportJson;
            ioExecutor.execute(() -> {
                try {
                    writeUtf8(uri, json);
                    bridge.completeBackupExport(requestId);
                } catch (UserException exception) {
                    bridge.completeError(requestId, exception.getMessage());
                } catch (RuntimeException exception) {
                    bridge.completeError(requestId, "备份写入失败");
                }
            });
            return;
        }
        if (requestCode == REQUEST_IMPORT_BACKUP && action.type == PendingType.IMPORT_BACKUP) {
            pendingAction = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                bridge.completeError(action.requestId, "已取消恢复");
                return;
            }
            final Uri uri = data.getData();
            final String requestId = action.requestId;
            ioExecutor.execute(() -> {
                try {
                    byte[] bytes = readAllLimited(uri, NativeStore.MAX_BACKUP_BYTES);
                    String previousBaseUrl = store.getApiConfig().optString("baseUrl", "");
                    JSONObject state = store.importBackup(bytes);
                    String restoredBaseUrl = store.getApiConfig().optString("baseUrl", "");
                    if (!previousBaseUrl.equals(restoredBaseUrl)) {
                        // The backup never contains a key. If it also changes the API
                        // origin, do not keep an old key that could be sent to a new
                        // host; the user can enter it again.
                        secureStore.clear();
                    }
                    bridge.refreshBootstrap();
                    JSONObject reminder = store.getReminder();
                    if (reminder.optBoolean("enabled", false)) {
                        try {
                            ReminderScheduler.schedule(MainActivity.this,
                                reminder.optString("time", "20:30"));
                        } catch (UserException ignored) {
                            // The restored record is still valid; the user can re-save
                            // the reminder if the system rejects the alarm.
                        }
                    } else {
                        ReminderScheduler.cancel(MainActivity.this);
                    }
                    bridge.completeBackupImport(requestId, state);
                } catch (UserException exception) {
                    bridge.completeError(requestId, exception.getMessage());
                } catch (RuntimeException exception) {
                    bridge.completeError(requestId, "备份恢复失败");
                }
            });
            return;
        }
        if (requestCode == REQUEST_UNKNOWN_SOURCES && action.type == PendingType.UNKNOWN_SOURCES) {
            pendingAction = null;
            if (updateManager.canRequestPackageInstalls() && action.update != null) {
                launchInstallerAndComplete(action.requestId, action.update);
            } else {
                bridge.completeError(action.requestId, "未授予安装未知应用权限");
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) {
            return;
        }
        String requestId = notificationRequestId;
        notificationRequestId = null;
        if (requestId == null) {
            return;
        }
        try {
            JSONObject reminder = store.getReminder();
            if (reminder.optBoolean("enabled", false) &&
                ReminderScheduler.permissionGranted(this)) {
                ReminderScheduler.schedule(this, reminder.optString("time", "20:30"));
            }
        } catch (UserException | RuntimeException ignored) {
            // The bridge reports the actual permission state below.
        }
        bridge.completeReminderPermission(requestId);
    }

    /**
     * Startup/resume update check. This never blocks the UI, never sends credentials
     * (the update request has no Authorization header), and is throttled across app
     * restarts. Failures stay silent; a manual check still reports them in Settings.
     */
    private void maybeCheckForUpdates() {
        if (destroyed || mainHandler == null || store == null || updateManager == null ||
            ioExecutor == null) {
            return;
        }
        long now = System.currentTimeMillis();
        long last = getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE)
            .getLong(UPDATE_LAST_CHECK, 0L);
        if (!UpdateManager.shouldAutoCheck(last, now,
            UpdateManager.AUTO_CHECK_INTERVAL_MS)) {
            return;
        }
        getSharedPreferences(UPDATE_PREFS, MODE_PRIVATE).edit()
            .putLong(UPDATE_LAST_CHECK, now).apply();
        try {
            ioExecutor.execute(() -> {
                try {
                    JSONObject result = updateManager.checkUpdate();
                    if (result.optBoolean("available", false)) {
                        pendingUpdate = result;
                        mainHandler.post(MainActivity.this::deliverPendingUpdate);
                    }
                } catch (UserException | RuntimeException ignored) {
                    // Offline or an invalid manifest must not interrupt local study.
                }
            });
        } catch (RejectedExecutionException ignored) {
            // Activity is shutting down.
        }
    }

    private void deliverPendingUpdate() {
        if (!isAlive() || !webPageReady || pendingUpdate == null) {
            return;
        }
        String script = "if (typeof window.__nativeUpdateAvailable === 'function') {"
            + "window.__nativeUpdateAvailable(" + JsJson.objectLiteral(pendingUpdate) + ");}";
        evaluateJavascript(script);
    }

    private void rescheduleReminderIfEnabled() {
        try {
            JSONObject reminder = store.getReminder();
            if (reminder.optBoolean("enabled", false)) {
                ReminderScheduler.schedule(this, reminder.optString("time", "20:30"));
            } else {
                ReminderScheduler.cancel(this);
            }
        } catch (UserException | RuntimeException ignored) {
            // The bridge reports the actual permission state below.
        }
    }

    private void writeUtf8(Uri uri, String text) throws UserException {
        if (text == null) {
            throw new UserException("备份内容为空");
        }
        ContentResolver resolver = getContentResolver();
        OutputStream output = null;
        try {
            try {
                output = resolver.openOutputStream(uri, "wt");
            } catch (RuntimeException | IOException firstFailure) {
                output = resolver.openOutputStream(uri);
            }
            if (output == null) {
                throw new UserException("无法写入所选位置");
            }
            output.write(text.getBytes(StandardCharsets.UTF_8));
            output.flush();
        } catch (IOException exception) {
            throw new UserException("无法写入所选位置", exception);
        } finally {
            if (output != null) {
                try {
                    output.close();
                } catch (IOException ignored) {
                    // The write result is already known.
                }
            }
        }
    }

    private byte[] readAllLimited(Uri uri, int maxBytes) throws UserException {
        ContentResolver resolver = getContentResolver();
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) {
                throw new UserException("无法读取备份文件");
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                total += read;
                if (total > maxBytes) {
                    throw new UserException("备份文件超过 20MB");
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } catch (IOException exception) {
            throw new UserException("备份文件读取失败", exception);
        }
    }

    private void showFatal(String message) {
        if (loadingView != null) {
            loadingView.setVisibility(View.GONE);
        }
        if (fatalView != null) {
            fatalView.setText(message);
            fatalView.setVisibility(View.VISIBLE);
        }
    }

    private void destroyWebView() {
        if (webView == null) {
            return;
        }
        WebView victim = webView;
        webView = null;
        try {
            if (root != null) {
                root.removeView(victim);
            }
            victim.removeJavascriptInterface("AndroidBridge");
            victim.stopLoading();
            victim.loadUrl("about:blank");
            victim.destroy();
        } catch (RuntimeException ignored) {
            // Best effort during renderer failure or teardown.
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (bridge != null) {
            bridge.shutdown();
        }
        destroyWebView();
        if (ioExecutor != null) {
            try {
                ioExecutor.shutdownNow();
            } catch (RejectedExecutionException ignored) {
                // Already shutting down.
            }
        }
        if (mainHandler != null) {
            mainHandler.removeCallbacksAndMessages(null);
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
