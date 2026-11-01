"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { UserError } = require("./errors.cjs");
const { buildBackup, parseBackupText, MAX_BACKUP_BYTES } = require("./backup.cjs");

const { decodeUtf8 } = require("./text-rules.cjs");

function timestampName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function writeAtomicFile(targetPath, text) {
  const directory = path.dirname(targetPath);
  const temporary = path.join(
    directory,
    `.pingjianganlan-backup-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let handle;
  try {
    try {
      const existing = await fs.promises.lstat(targetPath);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new UserError("备份目标不是普通文件");
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        if (error instanceof UserError) {
          throw error;
        }
        throw new UserError("备份目标不可用");
      }
    }
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, targetPath);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError("备份写入失败");
  }
}

async function readBackupFile(filePath) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    throw new UserError("无法读取备份文件");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UserError("备份文件不是普通文件");
  }
  if (stat.size > MAX_BACKUP_BYTES) {
    throw new UserError("备份文件超过 20MB");
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BACKUP_BYTES) {
      throw new UserError("备份文件超过 20MB 或不是普通文件");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BACKUP_BYTES) {
      throw new UserError("备份文件超过 20MB");
    }
    let text;
    try {
      text = decodeUtf8(bytes);
    } catch {
      throw new UserError("备份文件不是有效的 UTF-8 文本");
    }
    return { bytes, text };
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError("备份文件读取失败");
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
  }
}

class BackupService {
  constructor({ dialog, getWindow, store, keyStore, onRestored }) {
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.store = store;
    this.keyStore = keyStore;
    this.onRestored = onRestored;
  }

  parentWindow() {
    const window = this.getWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  async exportBackup(payload) {
    if (!payload || typeof payload.json !== "string" || !payload.json) {
      throw new UserError("备份内容格式错误");
    }
    let state;
    try {
      state = JSON.parse(payload.json);
    } catch {
      throw new UserError("学习记录不是有效 JSON");
    }
    const { text } = buildBackup({
      state,
      native: this.store.backupNativePart(),
      versionCode: this.store.versionCode,
      versionName: this.store.versionName
    });
    const options = {
      title: "导出学习数据",
      defaultPath: `平江安澜-学习记录-${timestampName()}.json`,
      filters: [{ name: "JSON 备份", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"]
    };
    const parent = this.parentWindow();
    const result = parent
      ? await this.dialog.showSaveDialog(parent, options)
      : await this.dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      throw new UserError("已取消导出");
    }
    await writeAtomicFile(result.filePath, text);
    return {};
  }

  async importBackup() {
    const options = {
      title: "选择平江安澜备份",
      properties: ["openFile"],
      filters: [{ name: "JSON 备份", extensions: ["json"] }]
    };
    const parent = this.parentWindow();
    const result = parent
      ? await this.dialog.showOpenDialog(parent, options)
      : await this.dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      throw new UserError("已取消恢复");
    }
    const { bytes, text } = await readBackupFile(result.filePaths[0]);
    const validated = parseBackupText(text);
    await this.store.saveBackupCopy(bytes);
    const previousBase = this.store.getApiConfig().baseUrl || "";
    const restoredBase = validated.native.apiConfig
      ? validated.native.apiConfig.baseUrl || ""
      : previousBase;
    if (restoredBase !== previousBase) {
      // Never leave an old key that could be replayed to a new host. Clear
      // before replacing the study data so failure aborts with data intact.
      try {
        await this.keyStore.clear();
      } catch {
        throw new UserError("服务地址已变化，但旧密钥清除失败，未恢复任何内容");
      }
    }
    await this.store.replaceFromBackup(validated.native);
    if (typeof this.onRestored === "function") {
      try {
        await this.onRestored();
      } catch {
        // Study data is already restored; reminder rescheduling can be retried.
      }
    }
    return { state: validated.state };
  }
}

module.exports = { BackupService, writeAtomicFile, readBackupFile };
