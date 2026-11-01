"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell
} = require("electron");

const { APP_ID, TRUSTED_MAIN_URL, CONTENT_SECURITY_POLICY, classifyNavigation,
  senderRejectionReason, isTrustedWebContentsUrl } = require("./security.cjs");
const { publicError, UserError } = require("./errors.cjs");
const { NativeStore } = require("./native-store.cjs");
const { SecureStore } = require("./secure-store.cjs");
const { ApiClient } = require("./api-client.cjs");
const { BackupService } = require("./backup-service.cjs");
const { ReminderService } = require("./reminder-service.cjs");
const { UpdateService, scriptJson } = require("./update-service.cjs");
const { CloudAuth } = require("./cloud-auth.cjs");
const { CloudSync } = require("./cloud-sync.cjs");
const { BridgeService } = require("./bridge.cjs");
const { requestOnce, requestPublicJson, downloadPublicFile } = require("./http-request.cjs");
const { UPDATE_PUBLIC_KEY } = require("./update-policy.cjs");

const APP_VERSION_CODE = 1;
const APP_VERSION_NAME = "1.0.0";
const MAX_IPC_PAYLOAD_BYTES = 24 * 1024 * 1024;
const EMPTY_BOOTSTRAP = JSON.stringify({
  customQuestions: [],
  customSources: [],
  customTypes: {},
  customAnswers: []
});

// Stable data directory: Chromium localStorage and native JSON both live here
// across upgrades (no version segment).
app.setName("平江安澜");
app.setPath("userData", path.join(app.getPath("appData"), "PingjiangAnlan"));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: true
    }
  }
]);

const gotLock = app.requestSingleInstanceLock();
let mainWindow = null;
let store = null;
let apiKeyStore = null;
let cloudSessionStore = null;
let bridge = null;
let updates = null;
let reminders = null;
let backupService = null;
let cloudAuth = null;
let cloudSync = null;

function rendererRoot() {
  return path.join(app.getAppPath(), "build", "renderer");
}

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function securityHeaders() {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store"
  };
}

async function handleBundleRequest(request) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: securityHeaders()
    });
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Bad Request", { status: 400, headers: securityHeaders() });
  }
  if (url.protocol !== "app:" || url.hostname !== "bundle" || url.port) {
    return new Response("Not Found", { status: 404, headers: securityHeaders() });
  }
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400, headers: securityHeaders() });
  }
  if (decoded.includes("\u0000") || decoded.includes("\\")) {
    return new Response("Bad Request", { status: 400, headers: securityHeaders() });
  }
  const relativeRequest = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const resolved = path.resolve(rendererRoot(), "." + relativeRequest);
  const relative = path.relative(rendererRoot(), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return new Response("Forbidden", { status: 403, headers: securityHeaders() });
  }
  let stat;
  try {
    stat = await fs.promises.lstat(resolved);
  } catch {
    return new Response("Not Found", { status: 404, headers: securityHeaders() });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return new Response("Forbidden", { status: 403, headers: securityHeaders() });
  }
  let bytes;
  try {
    bytes = await fs.promises.readFile(resolved);
  } catch {
    return new Response("Not Found", { status: 404, headers: securityHeaders() });
  }
  return new Response(bytes, {
    status: 200,
    headers: Object.assign(securityHeaders(), {
      "Content-Type": mimeType(resolved)
    })
  });
}

function openReleaseLink(url) {
  // Navigation/window-open handlers only pass URLs already classified as the
  // known GitHub release download prefix.
  if (typeof url !== "string") {
    return;
  }
  shell.openExternal(url).catch(() => {
    // Opening the system browser may fail; never fall back to renderer nav.
  });
}

function applyContentGuards(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigation(url);
    if (decision.action === "external") {
      openReleaseLink(decision.url);
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (classifyNavigation(url).action !== "allow") {
      event.preventDefault();
    }
  });
  contents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    const decision = classifyNavigation(event.url);
    if (decision.action === "allow") {
      return;
    }
    event.preventDefault();
    if (decision.action === "external" && event.isMainFrame === true) {
      openReleaseLink(decision.url);
    }
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.on("before-input-event", (event, input) => {
    if (!app.isPackaged || input.type !== "keyDown" || typeof input.key !== "string") {
      return;
    }
    if (input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i")) {
      event.preventDefault();
    }
  });
}

function configureSession(defaultSession) {
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.on("will-download", (event) => {
    event.preventDefault();
  });
  defaultSession.webRequest.onBeforeRequest(
    {
      urls: [
        "http://*/*",
        "https://*/*",
        "ws://*/*",
        "wss://*/*",
        "file://*/*"
      ]
    },
    (_details, callback) => {
      callback({ cancel: true });
    }
  );
}

function assertTrustedIpc(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return "no-window";
  }
  return senderRejectionReason(event.senderFrame, event.sender, mainWindow.webContents);
}

function deliverResult(id, result) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed() || !isTrustedWebContentsUrl(contents.getURL())) {
    return;
  }
  let payload;
  let idJson;
  try {
    payload = scriptJson(result);
    idJson = scriptJson(id);
  } catch {
    payload = scriptJson({ ok: false, error: "操作失败，请稍后重试" });
    idJson = scriptJson(id);
  }
  if (payload === undefined) {
    payload = scriptJson({ ok: false, error: "操作失败，请稍后重试" });
  }
  const script =
    "if (typeof window.__nativeResult === 'function') {" +
    `window.__nativeResult(${idJson},${payload});}`;
  contents.executeJavaScript(script, true).catch(() => {
    // The renderer may have navigated or closed while a request was running.
  });
}

function validRequestId(id) {
  return typeof id === "string" && id.length >= 1 && id.length <= 200;
}

function parsePayload(payloadJson) {
  if (payloadJson === undefined || payloadJson === null || payloadJson === "") {
    return {};
  }
  if (typeof payloadJson !== "string") {
    throw new UserError("请求参数格式错误");
  }
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_IPC_PAYLOAD_BYTES) {
    throw new UserError("请求参数过大");
  }
  let parsed;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new UserError("请求参数格式错误");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError("请求参数格式错误");
  }
  return parsed;
}

async function handleBridgeRequest(event, id, method, payloadJson) {
  if (assertTrustedIpc(event)) {
    return;
  }
  if (!validRequestId(id)) {
    return;
  }
  let payload;
  try {
    payload = parsePayload(payloadJson);
  } catch (error) {
    deliverResult(id, { ok: false, error: publicError(error) });
    return;
  }
  try {
    const data = await bridge.dispatch(method, payload);
    deliverResult(id, { ok: true, data: data === undefined ? {} : data });
  } catch (error) {
    deliverResult(id, { ok: false, error: publicError(error) });
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "平江安澜",
    backgroundColor: "#F3F8FD",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      enableWebSQL: false
    }
  });
  mainWindow = window;
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.webContents.on("did-finish-load", () => {
    if (mainWindow === window) {
      updates.notifyReady();
      updates.autoCheck();
    }
  });
  window.webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) {
      dialog.showErrorBox(
        "平江安澜无法启动",
        "界面资源加载失败。请确认已运行 npm run copy:preview 并重新安装应用。"
      );
    }
  });
  window.loadURL(TRUSTED_MAIN_URL).catch(() => {
    dialog.showErrorBox(
      "平江安澜无法启动",
      "界面资源加载失败。请确认已运行 npm run copy:preview 并重新安装应用。"
    );
  });
  return window;
}

function initServices() {
  const userDataDir = app.getPath("userData");
  store = new NativeStore({
    userDataDir,
    versionCode: APP_VERSION_CODE,
    versionName: APP_VERSION_NAME,
    appId: APP_ID
  });
  apiKeyStore = new SecureStore({
    baseDir: userDataDir,
    fileName: "api-key.bin",
    safeStorage,
    maxPlaintextBytes: 8192
  });
  cloudSessionStore = new SecureStore({
    baseDir: userDataDir,
    fileName: "cloud-auth.bin",
    safeStorage,
    maxPlaintextBytes: 32 * 1024
  });
  const apiClient = new ApiClient({ store, keyStore: apiKeyStore });
  reminders = new ReminderService({
    store,
    Notification,
    getWindow: () => mainWindow
  });
  backupService = new BackupService({
    dialog,
    getWindow: () => mainWindow,
    store,
    keyStore: apiKeyStore,
    onRestored: async () => {
      reminders.resume();
    }
  });
  updates = new UpdateService({
    store,
    requestPublicJson,
    downloadPublicFile,
    getWindow: () => mainWindow,
    shell,
    userDataDir,
    currentVersionCode: APP_VERSION_CODE,
    currentVersionName: APP_VERSION_NAME,
    publicKey: UPDATE_PUBLIC_KEY
  });
  cloudAuth = new CloudAuth({ sessionStore: cloudSessionStore });
  cloudSync = new CloudSync({
    store,
    cloudAuth,
    userDataDir,
    http: requestOnce
  });
  bridge = new BridgeService({
    store,
    apiClient,
    backupService,
    reminders,
    updates,
    cloudAuth,
    cloudSync,
    dialog,
    getWindow: () => mainWindow,
    appId: APP_ID,
    versionName: APP_VERSION_NAME,
    versionCode: APP_VERSION_CODE
  });
}

async function boot() {
  if (!gotLock) {
    app.quit();
    return;
  }
  await app.whenReady();
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  if (!fs.existsSync(path.join(rendererRoot(), "index.html"))) {
    dialog.showErrorBox(
      "平江安澜缺少界面资源",
      "未找到 build/renderer/index.html。请先运行 npm run copy:preview。"
    );
    app.quit();
    return;
  }
  configureSession(session.defaultSession);
  protocol.handle("app", handleBundleRequest);
  initServices();

  ipcMain.on("bridge:get-bootstrap", (event) => {
    try {
      if (assertTrustedIpc(event)) {
        event.returnValue = EMPTY_BOOTSTRAP;
        return;
      }
      event.returnValue = store.bootstrapJson();
    } catch {
      event.returnValue = EMPTY_BOOTSTRAP;
    }
  });

  ipcMain.on("bridge:request", (event, id, method, payloadJson) => {
    void handleBridgeRequest(event, id, method, payloadJson);
  });

  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    applyContentGuards(contents);
  });

  createMainWindow();
  reminders.start();

  powerMonitor.on("resume", () => {
    reminders.resume();
    if (updates) {
      updates.autoCheck();
    }
  });
  powerMonitor.on("unlock-screen", () => {
    reminders.resume();
  });

  app.on("activate", () => {
    if (!mainWindow) {
      createMainWindow();
    }
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (reminders) {
    reminders.stop();
  }
});

boot().catch(() => {
  try {
    dialog.showErrorBox("平江安澜无法启动", "应用初始化失败，请重新打开。");
  } catch {
    // Ignore; the app is quitting.
  }
  app.quit();
});
