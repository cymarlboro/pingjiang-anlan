"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { UserError } = require("./errors.cjs");
const { isTrustedWebContentsUrl, isAllowedReleaseUrl } = require("./security.cjs");
const {
  MAX_MANIFEST_BYTES,
  MAX_INSTALLER_BYTES,
  shouldAutoCheck,
  verifyWindowsManifest,
  validateInstallRequest,
  verifyDownloadedDigest
} = require("./update-policy.cjs");

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

class UpdateService {
  constructor({
    store,
    requestPublicJson,
    downloadPublicFile,
    getWindow,
    shell,
    userDataDir,
    currentVersionCode,
    currentVersionName,
    publicKey
  }) {
    this.store = store;
    this.requestPublicJson = requestPublicJson;
    this.downloadPublicFile = downloadPublicFile;
    this.getWindow = getWindow;
    this.shell = shell;
    this.updatesDir = path.join(userDataDir, "updates");
    this.currentVersionCode = currentVersionCode;
    this.currentVersionName = currentVersionName;
    this.publicKey = publicKey;
    this.checking = false;
    this.pendingAvailable = null;
    this.lastAvailable = null;
  }

  getConfig() {
    return {
      manifestUrl: this.store.effectiveUpdateManifestUrl(),
      usingDefault: this.store.usingDefaultUpdateManifest()
    };
  }

  async saveConfig(manifestUrl) {
    return this.store.saveUpdateManifestUrl(manifestUrl);
  }

  wrapPolicyError(error) {
    const message = error && typeof error.message === "string" && error.message
      ? error.message
      : "更新清单校验失败";
    return new UserError(message);
  }

  async fetchVerifiedManifest() {
    const manifestUrl = this.store.effectiveUpdateManifestUrl();
    if (!manifestUrl) {
      throw new UserError("尚未设置更新发布地址");
    }
    const manifest = await this.requestPublicJson(manifestUrl, {
      maxBytes: MAX_MANIFEST_BYTES,
      timeoutMs: 30000
    });
    try {
      const verified = verifyWindowsManifest(
        manifest,
        this.currentVersionCode,
        this.publicKey
      );
      return { manifestUrl, ...verified };
    } catch (error) {
      throw this.wrapPolicyError(error);
    }
  }

  async checkUpdate({ auto = false } = {}) {
    try {
      await this.store.setLastUpdateCheckAt(Date.now());
    } catch {
      // A metadata write failure must not block a user-requested check.
    }
    const verified = await this.fetchVerifiedManifest();
    this.lastVerified = verified;
    this.lastAvailable = verified.result.available ? verified.result : null;
    return verified.result;
  }

  emitAvailable(value) {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      this.pendingAvailable = value;
      return false;
    }
    const contents = window.webContents;
    if (!contents || contents.isDestroyed() || !isTrustedWebContentsUrl(contents.getURL())) {
      this.pendingAvailable = value;
      return false;
    }
    contents.executeJavaScript(
      `if (typeof window.__nativeUpdateAvailable === "function") {` +
      `window.__nativeUpdateAvailable(${scriptJson(value)});}`,
      true
    ).catch(() => { /* renderer may have been closed */ });
    this.pendingAvailable = null;
    return true;
  }

  notifyReady() {
    // Re-emit a previously verified ready update on every trusted page load;
    // the 6h throttle may skip the network check but the banner can still show.
    if (this.lastAvailable) {
      this.emitAvailable(this.lastAvailable);
      return;
    }
    if (this.pendingAvailable) {
      this.emitAvailable(this.pendingAvailable);
    }
  }

  async autoCheck() {
    if (this.checking) {
      return null;
    }
    const meta = this.store.getMeta();
    if (!shouldAutoCheck(meta.lastUpdateCheckAt, Date.now())) {
      return null;
    }
    this.checking = true;
    try {
      const result = await this.checkUpdate({ auto: true });
      if (result.available) {
        this.emitAvailable(result);
      }
      return result;
    } catch {
      // Startup/resume checks are silent; the renderer can request a manual
      // check to see a diagnostic. No network/upstream text is surfaced here.
      return null;
    } finally {
      this.checking = false;
    }
  }

  async installUpdate(payload) {
    const verified = await this.fetchVerifiedManifest();
    if (!verified.result.available) {
      throw new UserError("更新版本不高于当前版本，无需安装");
    }
    try {
      validateInstallRequest(payload, verified.result);
    } catch (error) {
      throw this.wrapPolicyError(error);
    }
    await fs.promises.mkdir(this.updatesDir, { recursive: true });
    const target = path.join(this.updatesDir, "update-installer.exe");
    let downloaded;
    try {
      downloaded = await this.downloadPublicFile(verified.result.apkUrl, target, {
        maxBytes: MAX_INSTALLER_BYTES,
        timeoutMs: 120000,
        allowedInitialUrl: isAllowedReleaseUrl
      });
    } catch (error) {
      throw new UserError(error && error.publicMessage ? error.publicMessage : "安装包下载失败");
    }
    try {
      verifyDownloadedDigest(downloaded.sha256, verified.result.sha256);
    } catch (error) {
      try { fs.unlinkSync(target); } catch { /* best effort */ }
      throw new UserError(error.message || "安装包 SHA256 校验失败，已拒绝安装");
    }
    if (!downloaded.bytes || downloaded.bytes > MAX_INSTALLER_BYTES) {
      try { fs.unlinkSync(target); } catch { /* best effort */ }
      throw new UserError("安装包大小无效，已拒绝安装");
    }
    let launchError;
    try {
      launchError = await this.shell.openPath(target);
    } catch {
      launchError = "failed";
    }
    if (launchError) {
      throw new UserError("无法启动安装程序");
    }
    return {};
  }
}

module.exports = { UpdateService, scriptJson };
