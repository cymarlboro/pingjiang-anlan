"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { UserError } = require("./errors.cjs");

const MAX_CIPHERTEXT_BYTES = 256 * 1024;

/**
 * One encrypted file per secret class (API key and cloud session are different
 * instances/files). Electron safeStorage DPAPI is used asynchronously; when it
 * is unavailable every write fails closed and reads report no value. Plaintext
 * is never written, logged, backed up, or returned to the renderer.
 */
class SecureStore {
  constructor({ baseDir, fileName, safeStorage, maxPlaintextBytes = 32 * 1024 }) {
    if (!baseDir || !fileName || !safeStorage) {
      throw new Error("SecureStore requires baseDir/fileName/safeStorage");
    }
    this.directory = path.join(baseDir, "secrets");
    this.filePath = path.join(this.directory, fileName);
    this.safeStorage = safeStorage;
    this.maxPlaintextBytes = maxPlaintextBytes;
    this.queue = Promise.resolve();
  }

  async available() {
    try {
      if (typeof this.safeStorage.isAsyncEncryptionAvailable !== "function") {
        return false;
      }
      return (await this.safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  }

  async assertAvailable() {
    if (!(await this.available())) {
      throw new UserError("系统安全存储不可用，无法安全保存密钥");
    }
  }

  async encrypt(text) {
    if (typeof text !== "string" || !text) {
      throw new UserError("密钥内容为空");
    }
    if (Buffer.byteLength(text, "utf8") > this.maxPlaintextBytes) {
      throw new UserError("密钥数据过大");
    }
    await this.assertAvailable();
    let encrypted;
    try {
      encrypted = await this.safeStorage.encryptStringAsync(text);
    } catch {
      throw new UserError("密钥加密保存失败");
    }
    if (!Buffer.isBuffer(encrypted)) {
      if (encrypted && typeof encrypted === "object" && Buffer.isBuffer(encrypted.result)) {
        encrypted = encrypted.result;
      } else {
        throw new UserError("系统安全存储返回了无效结果");
      }
    }
    if (!encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) {
      throw new UserError("密钥加密结果无效");
    }
    return encrypted;
  }

  async decrypt(buffer) {
    await this.assertAvailable();
    let value;
    try {
      value = await this.safeStorage.decryptStringAsync(buffer);
    } catch {
      return { text: null, corrupt: true, shouldReEncrypt: false };
    }
    if (typeof value === "string") {
      return { text: value, corrupt: false, shouldReEncrypt: false };
    }
    if (value && value.isTemporarilyUnavailable === true) {
      throw new UserError("系统安全存储暂时不可用，请稍后重试");
    }
    if (!value || typeof value !== "object" || typeof value.result !== "string") {
      return { text: null, corrupt: true, shouldReEncrypt: false };
    }
    return {
      text: value.result,
      corrupt: false,
      shouldReEncrypt: value.shouldReEncrypt === true
    };
  }

  async writeCiphertext(buffer) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      this.directory,
      `.${path.basename(this.filePath)}-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let handle;
    try {
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.filePath);
    } catch {
      if (handle) {
        try { await handle.close(); } catch { /* best effort */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw new UserError("加密数据写入失败");
    }
  }

  save(text) {
    const run = this.queue.then(async () => {
      const encrypted = await this.encrypt(text);
      await this.writeCiphertext(encrypted);
      return true;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  load() {
    const run = this.queue.then(async () => {
      let stat;
      try {
        stat = await fs.promises.stat(this.filePath);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          return null;
        }
        throw new UserError("加密数据读取失败");
      }
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CIPHERTEXT_BYTES) {
        await this.clearFile();
        return null;
      }
      let encrypted;
      try {
        encrypted = await fs.promises.readFile(this.filePath);
      } catch {
        throw new UserError("加密数据读取失败");
      }
      const decrypted = await this.decrypt(encrypted);
      if (decrypted.text === null) {
        // A different installation/runtime or temporarily unavailable OS key can
        // fail to decrypt valid ciphertext. Never destroy the user's only copy.
        throw new UserError("系统无法解密已保存的密钥，请在原安装中重试或重新保存密钥；加密文件已保留");
      }
      if (Buffer.byteLength(decrypted.text, "utf8") > this.maxPlaintextBytes) {
        await this.clearFile();
        return null;
      }
      if (decrypted.shouldReEncrypt) {
        try {
          const rotated = await this.encrypt(decrypted.text);
          await this.writeCiphertext(rotated);
        } catch {
          // The valid plaintext is still returned; rotation can retry next load.
        }
      }
      return decrypted.text;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async has() {
    try {
      return (await this.load()) !== null;
    } catch {
      return false;
    }
  }

  /** Presence only (no decrypt); used to prevent keeping an old key across a host change. */
  async exists() {
    try {
      return (await fs.promises.stat(this.filePath)).isFile();
    } catch {
      return false;
    }
  }

  async clearFile() {
    try {
      await fs.promises.unlink(this.filePath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        // Clearing a secret must not silently succeed if the file remains.
        throw new UserError("加密数据清除失败");
      }
    }
  }

  clear() {
    const run = this.queue.then(() => this.clearFile());
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = { SecureStore, MAX_CIPHERTEXT_BYTES };
