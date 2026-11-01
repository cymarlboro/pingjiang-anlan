"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SecureStore } = require("../src/main/secure-store.cjs");

function fakeSafeStorage({ available = true, decryptShape = "object", temporary = false } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (text) => Buffer.from(`cipher:${text}`, "utf8"),
    decryptStringAsync: async (buffer) => {
      const text = buffer.toString("utf8").replace(/^cipher:/, "");
      if (temporary) {
        return { shouldReEncrypt: false, isTemporarilyUnavailable: true };
      }
      if (decryptShape === "string") {
        return text;
      }
      return { result: text, shouldReEncrypt: false };
    }
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shanyueji-secure-"));
}

test("async safeStorage result object is supported and files stay separate", async () => {
  const dir = tempDir();
  try {
    const api = new SecureStore({
      baseDir: dir,
      fileName: "api-key.bin",
      safeStorage: fakeSafeStorage()
    });
    const auth = new SecureStore({
      baseDir: dir,
      fileName: "cloud-auth.bin",
      safeStorage: fakeSafeStorage({ decryptShape: "string" })
    });
    await api.save("sk-test");
    await auth.save("session-json");
    assert.equal(await api.load(), "sk-test");
    assert.equal(await auth.load(), "session-json");
    const files = fs.readdirSync(path.join(dir, "secrets")).sort();
    assert.deepEqual(files, ["api-key.bin", "cloud-auth.bin"]);
    assert.equal(fs.readFileSync(path.join(dir, "secrets", "api-key.bin"), "utf8"), "cipher:sk-test");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unavailable encryption fails writes closed", async () => {
  const dir = tempDir();
  try {
    const store = new SecureStore({
      baseDir: dir,
      fileName: "api-key.bin",
      safeStorage: fakeSafeStorage({ available: false })
    });
    await assert.rejects(() => store.save("sk-test"), /安全存储不可用/);
    assert.equal(fs.existsSync(path.join(dir, "secrets", "api-key.bin")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("temporarily unavailable decryption is not treated as empty", async () => {
  const dir = tempDir();
  try {
    const store = new SecureStore({
      baseDir: dir,
      fileName: "api-key.bin",
      safeStorage: fakeSafeStorage({ temporary: true })
    });
    await fs.promises.mkdir(path.join(dir, "secrets"), { recursive: true });
    await fs.promises.writeFile(path.join(dir, "secrets", "api-key.bin"), "cipher:secret");
    await assert.rejects(() => store.load(), /暂时不可用/);
    assert.equal(await fs.promises.readFile(store.filePath, "utf8"), "cipher:secret");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("decryption failure preserves ciphertext for the original installation", async () => {
  const dir = tempDir();
  try {
    const storage = fakeSafeStorage();
    storage.decryptStringAsync = async () => { throw Error('different application key'); };
    const store = new SecureStore({baseDir:dir,fileName:'api-key.bin',safeStorage:storage});
    await fs.promises.mkdir(path.join(dir,'secrets'),{recursive:true});
    await fs.promises.writeFile(store.filePath,'cipher:preserve-original');
    await assert.rejects(()=>store.load(),/加密文件已保留/);
    assert.equal(await fs.promises.readFile(store.filePath,'utf8'),'cipher:preserve-original');
    assert.equal(await store.exists(),true);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
