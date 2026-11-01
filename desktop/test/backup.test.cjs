"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isSensitiveKey,
  sanitizeForExport,
  buildBackup,
  parseBackupText
} = require("../src/main/backup.cjs");
const { NativeStore } = require("../src/main/native-store.cjs");
const { BackupService } = require("../src/main/backup-service.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shanyueji-test-"));
}

function sampleState() {
  return {
    schemaVersion: 2,
    settings: {
      dailyTarget: 10,
      accountName: "同学",
      reminder: { enabled: false, time: "20:30" },
      nestedSecret: "should-not-export"
    },
    referenceIds: [1],
    selectedIds: [],
    answerEdits: { 1: { text: "修订", updatedAt: "2026-01-01T00:00:00.000Z" } },
    session: null,
    history: [],
    imports: [],
    schedule: {},
    lastUpdated: null,
    apiKey: "sk-should-not-export"
  };
}

function sampleNative() {
  return {
    customContent: {
      customQuestions: [{
        id: 1000000,
        chapter: "导入资料",
        question: "题干",
        options: "",
        answer: "",
        explanation: "",
        source_id: 900000,
        locator: "第1段"
      }],
      customSources: [{ id: 900000, name: "a.md", format: "md", importId: 100000 }],
      customTypes: { 1000000: "简答题" },
      customAnswers: [{
        question_id: 1000000,
        answer: "答案",
        key_points: ["要点"],
        status: "draft",
        sourceQuote: "原文",
        pageIndex: 0
      }]
    },
    imports: [],
    apiConfig: { serviceName: "s", baseUrl: "https://api.example.com/v1", model: "m", maxQuestions: 5 },
    reminder: { enabled: false, time: "20:30" },
    updateConfig: { manifestUrl: "", customized: false }
  };
}

test("sensitive filtering keeps key_points but drops key/token/password", () => {
  assert.equal(isSensitiveKey("apiKey"), true);
  assert.equal(isSensitiveKey("access_token"), true);
  assert.equal(isSensitiveKey("refreshToken"), true);
  assert.equal(isSensitiveKey("password"), true);
  assert.equal(isSensitiveKey("key_points"), false);

  const clean = sanitizeForExport({
    key_points: ["keep"],
    nested: { apiKey: "secret", token: "secret", password: "secret", ok: 1 }
  });
  assert.deepEqual(clean, { key_points: ["keep"], nested: { ok: 1 } });
});

test("exported backup contains state and native data without secrets", () => {
  const { text, backup } = buildBackup({
    state: sampleState(),
    native: sampleNative(),
    now: new Date("2026-01-02T03:04:05.000Z")
  });
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.app.packageName, "cn.pingjianganlan.study.desktop");
  assert.equal(text.includes("should-not-export"), false);
  assert.equal(text.includes("sk-should-not-export"), false);
  assert.equal(text.includes("apiKey"), false);
  assert.equal(text.includes("key_points"), true);
  assert.equal(backup.native.customContent.customAnswers[0].key_points[0], "要点");
  assert.equal(backup.native.customContent.customQuestions.length, 1);
});

test("import rejects any secret-bearing field and accepts the same schema", () => {
  const { backup } = buildBackup({ state: sampleState(), native: sampleNative() });
  const root = JSON.parse(JSON.stringify(backup));
  root.state.settings.api_key = "sk-secret";
  assert.throws(
    () => parseBackupText(JSON.stringify(root)),
    /密钥或令牌/
  );

  const valid = parseBackupText(JSON.stringify(backup));
  assert.equal(valid.state.settings.accountName, "同学");
  assert.equal(valid.native.customContent.customQuestions[0].id, 1000000);
});

test("restore failure keeps the original native store", async () => {
  const dir = tempDir();
  try {
    const store = new NativeStore({ userDataDir: dir });
    await store.saveApiConfig({
      serviceName: "old",
      baseUrl: "https://old.example.com/v1",
      model: "old-model",
      maxQuestions: 5
    });
    const badPath = path.join(dir, "bad.json");
    fs.writeFileSync(badPath, "{not-json", "utf8");
    const keyStore = { clear: async () => { throw new Error("should not clear"); } };
    const service = new BackupService({
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [badPath] })
      },
      getWindow: () => null,
      store,
      keyStore
    });
    await assert.rejects(() => service.importBackup(), /备份 JSON 格式错误/);
    assert.equal(store.getApiConfig().baseUrl, "https://old.example.com/v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore changing API origin clears the old key before replacing data", async () => {
  const dir = tempDir();
  try {
    const store = new NativeStore({ userDataDir: dir });
    await store.saveApiConfig({
      serviceName: "old",
      baseUrl: "https://old.example.com/v1",
      model: "old-model",
      maxQuestions: 5
    });
    const built = buildBackup({
      state: sampleState(),
      native: Object.assign(sampleNative(), {
        apiConfig: { serviceName: "new", baseUrl: "https://new.example.com/v1", model: "new", maxQuestions: 5 }
      })
    });
    const backupPath = path.join(dir, "backup.json");
    fs.writeFileSync(backupPath, built.text, "utf8");
    let cleared = 0;
    const service = new BackupService({
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [backupPath] })
      },
      getWindow: () => null,
      store,
      keyStore: {
        clear: async () => { cleared += 1; }
      }
    });
    const result = await service.importBackup();
    assert.equal(cleared, 1);
    assert.equal(store.getApiConfig().baseUrl, "https://new.example.com/v1");
    assert.equal(result.state.settings.accountName, "同学");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt native store is preserved and not silently reinterpreted", () => {
  const dir = tempDir();
  try {
    const nativeDir = path.join(dir, "native");
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "native-store.json"), "{broken", "utf8");
    const store = new NativeStore({ userDataDir: dir });
    assert.deepEqual(JSON.parse(store.bootstrapJson()), {
      customQuestions: [],
      customSources: [],
      customTypes: {},
      customAnswers: []
    });
    const recovered = fs.readdirSync(nativeDir).filter((name) => name.startsWith("native-store.recovered-"));
    assert.equal(recovered.length, 1);
    assert.equal(fs.readFileSync(path.join(nativeDir, recovered[0]), "utf8"), "{broken");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
