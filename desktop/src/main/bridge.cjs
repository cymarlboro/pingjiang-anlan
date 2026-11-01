"use strict";

const { UserError } = require("./errors.cjs");
const { readImportFile } = require("./importer.cjs");

const METHODS = Object.freeze(new Set([
  "getApiConfig",
  "saveApiConfig",
  "testApi",
  "listImports",
  "pickImport",
  "getImport",
  "generate",
  "acceptQuestions",
  "getReminder",
  "saveReminder",
  "requestExactAlarmPermission",
  "exportBackup",
  "importBackup",
  "getUpdateConfig",
  "saveUpdateConfig",
  "checkUpdate",
  "installUpdate",
  "appInfo",
  "cloudAuthStatus",
  "cloudSignIn",
  "cloudSignUp",
  "cloudVerifyOtp",
  "cloudResendSignup",
  "cloudSignOut",
  "cloudSyncPull",
  "cloudSyncPush",
  "cloudSyncExport",
  "cloudSyncApply",
  "cloudSyncStatus"
]));

class BridgeService {
  constructor({
    store,
    apiClient,
    backupService,
    reminders,
    updates,
    cloudAuth,
    cloudSync,
    dialog,
    getWindow,
    appId,
    versionName,
    versionCode
  }) {
    this.store = store;
    this.apiClient = apiClient;
    this.backupService = backupService;
    this.reminders = reminders;
    this.updates = updates;
    this.cloudAuth = cloudAuth;
    this.cloudSync = cloudSync;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.appId = appId;
    this.versionName = versionName;
    this.versionCode = versionCode;
    this.fileBusy = false;
  }

  parentWindow() {
    const window = this.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  async pickImport() {
    if (this.fileBusy) {
      throw new UserError("另一个文件操作正在进行");
    }
    this.fileBusy = true;
    try {
      const options = {
        title: "选择学习资料",
        properties: ["openFile"],
        filters: [
          { name: "学习资料", extensions: ["pdf", "docx", "md", "markdown", "html", "htm", "txt"] },
          { name: "PDF", extensions: ["pdf"] },
          { name: "Word", extensions: ["docx"] },
          { name: "文本", extensions: ["md", "markdown", "html", "htm", "txt"] }
        ]
      };
      const parent = this.parentWindow();
      const result = parent
        ? await this.dialog.showOpenDialog(parent, options)
        : await this.dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        throw new UserError("已取消选择");
      }
      const document = await readImportFile(result.filePaths[0]);
      return await this.store.addImport(document);
    } finally {
      this.fileBusy = false;
    }
  }

  async exportBackup(payload) {
    if (this.fileBusy) {
      throw new UserError("另一个文件操作正在进行");
    }
    this.fileBusy = true;
    try {
      return await this.backupService.exportBackup(payload);
    } finally {
      this.fileBusy = false;
    }
  }

  async importBackup() {
    if (this.fileBusy) {
      throw new UserError("另一个文件操作正在进行");
    }
    this.fileBusy = true;
    try {
      return await this.backupService.importBackup();
    } finally {
      this.fileBusy = false;
    }
  }

  async dispatch(method, payload) {
    if (typeof method !== "string" || !METHODS.has(method)) {
      throw new UserError("不支持的方法");
    }
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
    switch (method) {
      case "appInfo":
        return {
          versionName: this.versionName,
          versionCode: this.versionCode,
          packageName: this.appId
        };
      case "getApiConfig":
        return this.apiClient.getConfig();
      case "saveApiConfig":
        return this.apiClient.saveConfig(data);
      case "testApi":
        return this.apiClient.testApi();
      case "listImports":
        return this.store.listImports();
      case "pickImport":
        return this.pickImport();
      case "getImport":
        return this.store.getImport(data.id);
      case "generate":
        return this.apiClient.generate(data);
      case "acceptQuestions": {
        const count = await this.store.acceptQuestions(data);
        return { count };
      }
      case "getReminder":
        return this.reminders.status();
      case "saveReminder":
        return this.reminders.save(data.enabled === true, data.time);
      case "requestExactAlarmPermission":
        return this.reminders.requestExactAlarmPermission();
      case "exportBackup":
        return this.exportBackup(data);
      case "importBackup":
        return this.importBackup();
      case "getUpdateConfig":
        return this.updates.getConfig();
      case "saveUpdateConfig":
        return this.updates.saveConfig(data.manifestUrl);
      case "checkUpdate":
        return this.updates.checkUpdate({ auto: false });
      case "installUpdate":
        return this.updates.installUpdate(data);
      case "cloudAuthStatus":
        return this.cloudAuth.status();
      case "cloudSignIn":
        return this.cloudAuth.signIn(data);
      case "cloudSignUp":
        return this.cloudAuth.signUp(data);
      case "cloudVerifyOtp":
        return this.cloudAuth.verifyOtp(data);
      case "cloudResendSignup":
        return this.cloudAuth.resendSignup(data);
      case "cloudSignOut":
        return this.cloudAuth.signOut();
      case "cloudSyncPull":
        return this.requireCloudSync().pull(data);
      case "cloudSyncPush":
        return this.requireCloudSync().push(data);
      case "cloudSyncExport":
        return this.requireCloudSync().exportNative(data);
      case "cloudSyncApply":
        return this.requireCloudSync().apply(data);
      case "cloudSyncStatus":
        return this.requireCloudSync().status();
      default:
        throw new UserError("不支持的方法");
    }
  }

  requireCloudSync() {
    if (!this.cloudSync) {
      throw new UserError("云端同步服务不可用");
    }
    return this.cloudSync;
  }
}

module.exports = { BridgeService, METHODS };
