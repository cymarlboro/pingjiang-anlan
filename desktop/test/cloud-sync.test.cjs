"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CloudSync,
  validateBundle,
  validateNative,
  STATE_PATH,
  COMMIT_PATH
} = require("../src/main/cloud-sync.cjs");
const {
  CloudAuth,
  PROJECT_URL,
  PUBLISHABLE_KEY
} = require("../src/main/cloud-auth.cjs");
const {
  NativeStore,
  NEW_ID_MIN,
  NEW_ID_LIMIT,
  randomNativeId
} = require("../src/main/native-store.cjs");
const { BridgeService, METHODS } = require("../src/main/bridge.cjs");
const { buildBackup, parseBackupText } = require("../src/main/backup.cjs");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const ACCESS_TOKEN = "access-secret-value";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shanyueji-cloud-sync-"));
}

function fakeSessionStore(initial) {
  let raw = initial || null;
  return {
    load: async () => (raw ? JSON.parse(raw) : null),
    save: async (value) => { raw = value; },
    clear: async () => { raw = null; },
    raw: () => raw
  };
}

function sessionFor(userId) {
  return JSON.stringify({
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh-secret-value",
    expires_at: Date.now() + 3600000,
    user_id: userId,
    email: "owner@example.com",
    needs_email_confirmation: false,
    pending_email: "",
    had_session: true
  });
}

function sampleState() {
  return {
    schemaVersion: 2,
    settings: {
      dailyTarget: 10,
      accountName: "同学",
      reminder: { enabled: false, time: "20:30" }
    },
    referenceIds: [1, 2],
    selectedIds: [1],
    answerEdits: {
      1: { text: "修订", updatedAt: "2026-01-01T00:00:00.000Z", updatedDate: "2026-01-01" }
    },
    session: null,
    history: [{
      id: 1,
      date: "2026-01-01",
      at: "2026-01-01T00:00:00.000Z",
      rating: "known",
      chapter: "第1章",
      source_id: 1
    }],
    imports: [],
    schedule: {},
    lastUpdated: "2026-01-01T00:00:00.000Z"
  };
}

function emptyNative() {
  return {
    customContent: {
      schemaVersion: 1,
      customQuestions: [],
      customSources: [],
      customTypes: {},
      customAnswers: []
    },
    imports: []
  };
}

function sampleBundle(native = emptyNative()) {
  return { schemaVersion: 1, state: sampleState(), native };
}

function bindingPath(dir) {
  return path.join(dir, "native", "cloud-sync-owner.json");
}

function readBinding(dir) {
  try {
    return JSON.parse(fs.readFileSync(bindingPath(dir), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeBinding(dir, ownerId) {
  fs.mkdirSync(path.join(dir, "native"), { recursive: true });
  fs.writeFileSync(bindingPath(dir), JSON.stringify({ schemaVersion: 1, ownerId }), "utf8");
}

function makeHarness(options = {}) {
  const dir = options.dir || tempDir();
  const store = new NativeStore({ userDataDir: dir });
  const sessionStore = fakeSessionStore(
    options.loggedOut ? null : sessionFor(options.userId || OWNER_A)
  );
  const calls = [];
  const mode = {
    stateStatus: 200,
    stateBody: "[]",
    commitStatus: 200,
    commitBody: JSON.stringify({ revision: 1 }),
    userStatus: 200,
    failUserNetwork: false,
    failStateNetwork: false,
    failCommitNetwork: false,
    onState: null,
    onCommit: null,
    ...options.mode
  };
  const http = async (request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/auth/v1/user") {
      if (mode.failUserNetwork) {
        throw new Error("offline");
      }
      if (mode.userStatus !== 200) {
        return { status: mode.userStatus, body: "{}" };
      }
      return {
        status: 200,
        body: JSON.stringify({ id: options.userId || OWNER_A, email: "owner@example.com" })
      };
    }
    if (url.pathname === "/auth/v1/logout") {
      return { status: 204, body: "" };
    }
    if (url.pathname === STATE_PATH) {
      if (mode.failStateNetwork) {
        throw new Error("offline");
      }
      if (mode.onState) {
        return mode.onState(request, dir);
      }
      return { status: mode.stateStatus, body: mode.stateBody };
    }
    if (url.pathname === COMMIT_PATH) {
      if (mode.failCommitNetwork) {
        throw new Error("offline");
      }
      if (mode.onCommit) {
        return mode.onCommit(request, dir);
      }
      return { status: mode.commitStatus, body: mode.commitBody };
    }
    throw new Error(`unexpected test URL ${request.url}`);
  };
  const auth = new CloudAuth({ sessionStore, http });
  const sync = new CloudSync({ store, cloudAuth: auth, userDataDir: dir, http });
  return { dir, store, sessionStore, auth, sync, calls, mode };
}

async function seedNative(store) {
  const imported = await store.addImport({
    name: "a.md",
    format: "md",
    size: 12,
    pages: [{ pageIndex: 0, locator: "第1段", text: "原文内容" }]
  });
  await store.acceptQuestions({
    importId: imported.id,
    questions: [{
      question: "题干一",
      answer: "答案一",
      type: "简答题",
      chapter: "导入资料",
      pageIndex: 0,
      sourceQuote: "原文内容"
    }]
  });
  return imported;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("bridge exposes the five cloud sync methods and delegates without exposing a token surface", async () => {
  for (const method of [
    "cloudSyncPull",
    "cloudSyncPush",
    "cloudSyncExport",
    "cloudSyncApply",
    "cloudSyncStatus"
  ]) {
    assert.equal(METHODS.has(method), true);
  }
  const calls = [];
  const bridge = new BridgeService({
    cloudSync: {
      pull: async () => {
        calls.push("pull");
        return { ownerId: OWNER_A, revision: 0, payload: null };
      },
      push: async () => {
        calls.push("push");
        return { conflict: true };
      },
      exportNative: async () => {
        calls.push("export");
        return { native: emptyNative() };
      },
      apply: async () => {
        calls.push("apply");
        return { changed: false };
      },
      status: async () => {
        calls.push("status");
        return { ownerId: OWNER_A, boundOwnerId: OWNER_A, allowed: true };
      }
    }
  });
  assert.deepEqual(await bridge.dispatch("cloudSyncPull", {}), {
    ownerId: OWNER_A,
    revision: 0,
    payload: null
  });
  assert.deepEqual(await bridge.dispatch("cloudSyncPush", { expectedRevision: 0, payload: {} }), {
    conflict: true
  });
  assert.deepEqual(await bridge.dispatch("cloudSyncExport", {}), { native: emptyNative() });
  assert.deepEqual(await bridge.dispatch("cloudSyncApply", { ownerId: OWNER_A, native: emptyNative() }), {
    changed: false
  });
  assert.deepEqual(await bridge.dispatch("cloudSyncStatus", {}), {
    ownerId: OWNER_A,
    boundOwnerId: OWNER_A,
    allowed: true
  });
  assert.deepEqual(calls, ["pull", "push", "export", "apply", "status"]);
});

test("pull verifies /user and uses the pinned REST query without binding first", async () => {
  const harness = makeHarness();
  try {
    assert.deepEqual(await harness.sync.status(), {
      ownerId: OWNER_A,
      boundOwnerId: "",
      allowed: true
    });
    const result = await harness.sync.pull();
    assert.deepEqual(result, { ownerId: OWNER_A, revision: 0, payload: null });
    // A pull alone must not lock the device to an account; the shared UI binds
    // through push only after a successful pull+merge.
    assert.equal(readBinding(harness.dir), null);

    await harness.sync.push({ expectedRevision: 0, payload: sampleBundle() });
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);

    const stateCall = harness.calls.find((call) => new URL(call.url).pathname === STATE_PATH);
    assert.ok(stateCall);
    assert.equal(stateCall.method, "GET");
    assert.equal(new URL(stateCall.url).origin, PROJECT_URL);
    assert.equal(new URL(stateCall.url).searchParams.get("select"), "revision,payload");
    assert.equal(new URL(stateCall.url).searchParams.get("owner_id"), `eq.${OWNER_A}`);
    assert.equal(stateCall.headers.apikey, PUBLISHABLE_KEY);
    assert.equal(stateCall.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(result).includes(PUBLISHABLE_KEY), false);
  } finally {
    cleanup(harness.dir);
  }
});

test("push sends CAS body and returns the server revision without exposing tokens", async () => {
  const harness = makeHarness({
    mode: {
      commitBody: JSON.stringify({ revision: 4 })
    }
  });
  try {
    const bundle = sampleBundle();
    const result = await harness.sync.push({ expectedRevision: 3, payload: bundle });
    assert.equal(result.conflict, false);
    assert.equal(result.ownerId, OWNER_A);
    assert.equal(result.revision, 4);
    assert.deepEqual(result.payload, bundle);
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(result).includes(PUBLISHABLE_KEY), false);

    const commitCall = harness.calls.find((call) => new URL(call.url).pathname === COMMIT_PATH);
    assert.ok(commitCall);
    assert.equal(commitCall.method, "POST");
    assert.equal(new URL(commitCall.url).origin, PROJECT_URL);
    assert.equal(commitCall.headers.apikey, PUBLISHABLE_KEY);
    assert.equal(commitCall.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    const body = JSON.parse(commitCall.body);
    assert.equal(body.expected_revision, 3);
    assert.deepEqual(body.new_payload, bundle);
    assert.equal(commitCall.body.includes(ACCESS_TOKEN), false);
  } finally {
    cleanup(harness.dir);
  }
});

test("CAS conflict returns only {conflict:true} and never reflects upstream text", async () => {
  const harness = makeHarness({
    mode: {
      commitStatus: 409,
      commitBody: JSON.stringify({ message: "conflict", token: "leaked-token-value" })
    }
  });
  try {
    const result = await harness.sync.push({ expectedRevision: 2, payload: sampleBundle() });
    assert.deepEqual(result, { conflict: true });
    assert.equal(JSON.stringify(result).includes("leaked-token-value"), false);
    assert.equal(JSON.stringify(result).includes("message"), false);
  } finally {
    cleanup(harness.dir);
  }
});

test("sensitive keys and local API settings are rejected before any upload", async () => {
  const harness = makeHarness();
  try {
    const cases = [];
    const settingsSecret = sampleBundle();
    settingsSecret.state.settings.apiKey = "sk-secret";
    cases.push(settingsSecret);

    const apiConfig = sampleBundle();
    apiConfig.native.apiConfig = { baseUrl: "https://api.example.com/v1" };
    cases.push(apiConfig);

    const nestedToken = sampleBundle();
    nestedToken.native.customContent.customQuestions.push({
      id: 4_000_000_000_001,
      chapter: "导入资料",
      question: "题干",
      source_id: 4_000_000_000_002,
      locator: "",
      metadata: { token: "nested-secret" }
    });
    cases.push(nestedToken);

    const roles = sampleBundle();
    roles.state.settings.roles = ["admin"];
    cases.push(roles);

    for (const bundle of cases) {
      await assert.rejects(
        () => harness.sync.push({ expectedRevision: 0, payload: bundle }),
        (error) => {
          assert.equal(error.message.includes("nested-secret"), false);
          assert.equal(error.message.includes("sk-secret"), false);
          return true;
        }
      );
    }
    assert.equal(
      harness.calls.some((call) => new URL(call.url).pathname === COMMIT_PATH),
      false
    );
    await assert.rejects(
      () => harness.sync.push({ expectedRevision: 0, payload: { schemaVersion: 1, state: sampleState(), native: emptyNative(), password: "x" } }),
      /同步包包含不支持的字段/
    );
  } finally {
    cleanup(harness.dir);
  }
});

test("key_points is allowed while credential-shaped fields are refused", () => {
  const native = emptyNative();
  native.customContent.customQuestions.push({
    id: 4_000_000_000_001,
    chapter: "导入资料",
    question: "题干",
    source_id: 4_000_000_000_002,
    locator: ""
  });
  native.customContent.customSources.push({
    id: 4_000_000_000_002,
    name: "a.md",
    format: "md"
  });
  native.customContent.customAnswers.push({
    question_id: 4_000_000_000_001,
    answer: "答案",
    key_points: ["要点一"],
    status: "draft",
    userEdited: true
  });
  native.customContent.customTypes = { "4000000000001": "简答题" };
  const validated = validateNative(native);
  assert.deepEqual(validated.customContent.customAnswers[0].key_points, ["要点一"]);

  native.customContent.customAnswers[0].references = [{ quote: "原文", password: "secret" }];
  assert.throws(() => validateNative(native), /密钥或令牌|不支持的字段/);

  const bundle = sampleBundle();
  bundle.state.history[0].token = "secret";
  assert.throws(() => validateBundle(bundle), /密钥或令牌/);
});

test("cloud export excludes apiConfig/reminder/updateConfig and includes parsed pages", async () => {
  const harness = makeHarness({ loggedOut: true });
  try {
    await harness.store.saveApiConfig({
      serviceName: "服务",
      baseUrl: "https://api.example.com/v1",
      model: "model",
      maxQuestions: 5
    });
    await harness.store.saveReminder(true, "20:30");
    await harness.store.saveUpdateManifestUrl("https://example.com/update.json");
    await seedNative(harness.store);

    const result = await harness.sync.exportNative();
    const text = JSON.stringify(result);
    assert.equal(text.includes("apiConfig"), false);
    assert.equal(text.includes("updateConfig"), false);
    assert.equal(text.includes("reminder"), false);
    assert.equal(text.includes("api.example.com"), false);
    assert.equal(text.includes("update.json"), false);
    assert.equal(Object.keys(result.native).sort().join(","), "customContent,imports");
    assert.equal(result.native.imports[0].pages[0].text, "原文内容");
    assert.equal(result.native.customContent.customAnswers[0].key_points.length, 0);
    assert.equal(typeof result.native.imports[0].id, "number");
    assert.throws(
      () => validateNative(Object.assign({}, result.native, { apiConfig: {} })),
      /不支持的字段/
    );
  } finally {
    cleanup(harness.dir);
  }
});

test("logout keeps local learning data and owner binding; later network failure returns no cached identity", async () => {
  const harness = makeHarness();
  try {
    await seedNative(harness.store);
    const before = harness.store.cloudNativeSnapshot();
    await harness.sync.push({ expectedRevision: 0, payload: sampleBundle(before) });
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);

    await harness.auth.signOut();
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);
    const loggedOut = await harness.sync.status();
    assert.deepEqual(loggedOut, {
      ownerId: "",
      boundOwnerId: OWNER_A,
      allowed: false
    });
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);

    harness.sessionStore.save(sessionFor(OWNER_A));
    harness.mode.failUserNetwork = true;
    await assert.rejects(() => harness.sync.pull(), /无法连接云端/);
    await assert.rejects(() => harness.sync.status(), /无法连接云端/);
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);

    // No state request may run after /user verification failed. The only
    // successful network operation in this test was the push, not a pull.
    const stateCalls = harness.calls.filter(
      (call) => new URL(call.url).pathname === STATE_PATH
    );
    assert.equal(stateCalls.length, 0);
  } finally {
    cleanup(harness.dir);
  }
});

test("mismatched owner binding refuses pull/push/apply and status reports disallowed", async () => {
  const harness = makeHarness({ userId: OWNER_B });
  try {
    writeBinding(harness.dir, OWNER_A);
    await seedNative(harness.store);
    const before = harness.store.cloudNativeSnapshot();

    await assert.rejects(() => harness.sync.pull(), /已绑定其他云端账户/);
    await assert.rejects(
      () => harness.sync.push({ expectedRevision: 0, payload: sampleBundle() }),
      /已绑定其他云端账户/
    );
    await assert.rejects(
      () => harness.sync.apply({ ownerId: OWNER_B, native: harness.store.cloudNativeSnapshot() }),
      /已绑定其他云端账户/
    );
    const status = await harness.sync.status();
    assert.deepEqual(status, {
      ownerId: OWNER_B,
      boundOwnerId: OWNER_A,
      allowed: false
    });
    assert.equal(
      harness.calls.some((call) => new URL(call.url).pathname === STATE_PATH),
      false
    );
    assert.equal(
      harness.calls.some((call) => new URL(call.url).pathname === COMMIT_PATH),
      false
    );
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
  } finally {
    cleanup(harness.dir);
  }
});

test("apply requires the verified owner id even when no binding exists", async () => {
  const harness = makeHarness({ userId: OWNER_B });
  try {
    await seedNative(harness.store);
    const before = harness.store.cloudNativeSnapshot();
    await assert.rejects(
      () => harness.sync.apply({ ownerId: OWNER_A, native: before }),
      /不一致/
    );
    assert.equal(readBinding(harness.dir), null);
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
  } finally {
    cleanup(harness.dir);
  }
});

test("first upload writes a durable owner binding before the commit request", async () => {
  const harness = makeHarness({
    mode: {
      onCommit: (request, dir) => {
        const binding = readBinding(dir);
        assert.equal(binding.ownerId, OWNER_A);
        throw new Error("offline");
      }
    }
  });
  try {
    await seedNative(harness.store);
    const before = harness.store.cloudNativeSnapshot();
    await assert.rejects(
      () => harness.sync.push({ expectedRevision: 0, payload: sampleBundle(before) }),
      /无法连接云端/
    );
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
  } finally {
    cleanup(harness.dir);
  }
});

test("new native ids are random safe integers and never collide", async () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = randomNativeId();
    assert.equal(Number.isSafeInteger(id), true);
    assert.ok(id >= NEW_ID_MIN);
    assert.ok(id < NEW_ID_LIMIT);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }

  const dir = tempDir();
  try {
    const store = new NativeStore({ userDataDir: dir });
    const first = await store.addImport({
      name: "a.md",
      format: "md",
      pages: [{ pageIndex: 0, locator: "第1段", text: "原文内容" }]
    });
    const second = await store.addImport({
      name: "b.md",
      format: "md",
      pages: [{ pageIndex: 0, locator: "第1段", text: "第二份" }]
    });
    assert.ok(first.id >= NEW_ID_MIN && first.id < NEW_ID_LIMIT);
    assert.ok(second.id >= NEW_ID_MIN && second.id < NEW_ID_LIMIT);
    assert.notEqual(first.id, second.id);
    assert.equal(store.getImport(first.id).id, first.id);

    await store.acceptQuestions({
      importId: first.id,
      questions: [
        { question: "题干甲", answer: "答案甲", type: "简答题", pageIndex: 0, sourceQuote: "原文内容" },
        { question: "题干乙", answer: "答案乙", type: "名词解释" }
      ]
    });
    const snapshot = store.cloudNativeSnapshot();
    const source = snapshot.customContent.customSources.find(
      (item) => Number(item.importId) === first.id
    );
    assert.ok(source.id >= NEW_ID_MIN && source.id < NEW_ID_LIMIT);
    const questions = snapshot.customContent.customQuestions;
    const newQuestions = questions.filter((item) => item.source_id === source.id);
    assert.equal(newQuestions.length, 2);
    assert.equal(new Set(newQuestions.map((item) => item.id)).size, 2);
    for (const question of newQuestions) {
      assert.ok(question.id >= NEW_ID_MIN && question.id < NEW_ID_LIMIT);
      assert.equal(
        snapshot.customContent.customAnswers.some(
          (answer) => answer.question_id === question.id
        ),
        true
      );
    }
  } finally {
    cleanup(dir);
  }
});

test("apply refuses conflicting immutable content and preserves the local store intact", async () => {
  const harness = makeHarness();
  try {
    await seedNative(harness.store);
    await harness.sync.pull();
    const before = harness.store.cloudNativeSnapshot();

    const tampered = JSON.parse(JSON.stringify(before));
    tampered.customContent.customQuestions[0].question = "被篡改的题干";
    await assert.rejects(
      () => harness.sync.apply({ ownerId: OWNER_A, native: tampered }),
      /云端自定义内容与本地内容冲突/
    );
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);

    const tamperedImport = JSON.parse(JSON.stringify(before));
    tamperedImport.imports[0].pages[0].text = "被篡改的导入原文";
    await assert.rejects(
      () => harness.sync.apply({ ownerId: OWNER_A, native: tamperedImport }),
      /云端自定义内容与本地内容冲突/
    );
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);

    const idempotent = await harness.sync.apply({ ownerId: OWNER_A, native: before });
    assert.deepEqual(idempotent, { changed: false });
    assert.deepEqual(harness.store.cloudNativeSnapshot(), before);
  } finally {
    cleanup(harness.dir);
  }
});

test("apply merges new native content, refreshes bootstrap, and updates same-id answers deterministically", async () => {
  const harness = makeHarness();
  try {
    await seedNative(harness.store);
    await harness.sync.pull();
    const before = harness.store.cloudNativeSnapshot();
    const localQuestion = before.customContent.customQuestions[0];
    const localSource = before.customContent.customSources[0];
    const localAnswer = before.customContent.customAnswers[0];

    const incoming = JSON.parse(JSON.stringify(before));
    const newQuestionId = 4_500_000_000_001;
    const newQuestion = JSON.parse(JSON.stringify(localQuestion));
    newQuestion.id = newQuestionId;
    newQuestion.question = "云端新增题干";
    newQuestion.source_id = localSource.id;
    incoming.customContent.customQuestions.push(newQuestion);
    incoming.customContent.customTypes[String(newQuestionId)] = "简答题";
    const newAnswer = JSON.parse(JSON.stringify(localAnswer));
    newAnswer.question_id = newQuestionId;
    newAnswer.answer = "云端新增答案";
    incoming.customContent.customAnswers.push(newAnswer);

    const merged = await harness.sync.apply({ ownerId: OWNER_A, native: incoming });
    assert.deepEqual(merged, { changed: true });
    const bootstrap = JSON.parse(harness.store.bootstrapJson());
    assert.equal(
      bootstrap.customQuestions.some((question) => question.id === newQuestionId),
      true
    );

    const answerUpdate = JSON.parse(JSON.stringify(harness.store.cloudNativeSnapshot()));
    answerUpdate.customContent.customAnswers.find(
      (answer) => answer.question_id === localQuestion.id
    ).answer = "答案二";
    const updated = await harness.sync.apply({ ownerId: OWNER_A, native: answerUpdate });
    assert.deepEqual(updated, { changed: true });
    assert.equal(
      harness.store.cloudNativeSnapshot().customContent.customAnswers.find(
        (answer) => answer.question_id === localQuestion.id
      ).answer,
      "答案二"
    );

    const losingUpdate = JSON.parse(JSON.stringify(harness.store.cloudNativeSnapshot()));
    losingUpdate.customContent.customAnswers.find(
      (answer) => answer.question_id === localQuestion.id
    ).answer = "A";
    const unchanged = await harness.sync.apply({ ownerId: OWNER_A, native: losingUpdate });
    assert.deepEqual(unchanged, { changed: false });
    assert.equal(
      harness.store.cloudNativeSnapshot().customContent.customAnswers.find(
        (answer) => answer.question_id === localQuestion.id
      ).answer,
      "答案二"
    );
  } finally {
    cleanup(harness.dir);
  }
});

test("same-id answer merge prefers userEdited consistently in both directions", async () => {
  const harness = makeHarness();
  try {
    const initial = emptyNative();
    initial.customContent.customSources.push({ id: 900001, name: "来源", format: "md" });
    initial.customContent.customQuestions.push({
      id: 1000001,
      question: "题干",
      source_id: 900001
    });
    initial.customContent.customTypes["1000001"] = "简答题";
    initial.customContent.customAnswers.push({
      question_id: 1000001,
      answer: "生成答案",
      userEdited: false
    });
    await harness.sync.apply({ ownerId: OWNER_A, native: initial });

    let snapshot = harness.store.cloudNativeSnapshot();
    assert.equal(snapshot.customContent.customAnswers[0].userEdited, false);

    const edited = JSON.parse(JSON.stringify(snapshot));
    edited.customContent.customAnswers[0].answer = "用户编辑答案";
    edited.customContent.customAnswers[0].userEdited = true;
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: edited }),
      { changed: true }
    );
    snapshot = harness.store.cloudNativeSnapshot();
    assert.equal(snapshot.customContent.customAnswers[0].answer, "用户编辑答案");
    assert.equal(snapshot.customContent.customAnswers[0].userEdited, true);

    // A lexicographically larger non-edited value must not beat an edited one.
    const generated = JSON.parse(JSON.stringify(snapshot));
    generated.customContent.customAnswers[0].answer = "zzzz-generated";
    generated.customContent.customAnswers[0].userEdited = false;
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: generated }),
      { changed: false }
    );
    snapshot = harness.store.cloudNativeSnapshot();
    assert.equal(snapshot.customContent.customAnswers[0].answer, "用户编辑答案");

    // Repeating the same apply stays converged.
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: snapshot }),
      { changed: false }
    );
  } finally {
    cleanup(harness.dir);
  }
});

test("same-id custom type merge uses canonical lexicographic choice", async () => {
  const harness = makeHarness();
  try {
    const initial = emptyNative();
    initial.customContent.customSources.push({ id: 900002, name: "来源", format: "md" });
    initial.customContent.customQuestions.push({
      id: 1000002,
      question: "题干",
      source_id: 900002,
      type: "简答题"
    });
    initial.customContent.customTypes["1000002"] = "简答题";
    await harness.sync.apply({ ownerId: OWNER_A, native: initial });

    const larger = JSON.parse(JSON.stringify(harness.store.cloudNativeSnapshot()));
    larger.customContent.customTypes["1000002"] = "论述题";
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: larger }),
      { changed: true }
    );
    assert.equal(
      harness.store.cloudNativeSnapshot().customContent.customTypes["1000002"],
      "论述题"
    );

    const smaller = JSON.parse(JSON.stringify(harness.store.cloudNativeSnapshot()));
    smaller.customContent.customTypes["1000002"] = "填空题";
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: smaller }),
      { changed: false }
    );
    assert.equal(
      harness.store.cloudNativeSnapshot().customContent.customTypes["1000002"],
      "论述题"
    );

    // Aliases normalize before comparison and cannot wedge a repeated apply.
    const alias = JSON.parse(JSON.stringify(harness.store.cloudNativeSnapshot()));
    alias.customContent.customTypes["1000002"] = "论述";
    assert.deepEqual(
      await harness.sync.apply({ ownerId: OWNER_A, native: alias }),
      { changed: false }
    );
  } finally {
    cleanup(harness.dir);
  }
});

test("native and backup validators share the legacy bounds and reject larger values", () => {
  const native = emptyNative();
  native.customContent.customSources.push({ id: 900003, name: "来源", format: "pdf" });
  native.customContent.customQuestions.push({
    id: 1000003,
    question: "题".repeat(20000),
    source_id: 900003,
    type: "简答"
  });
  native.customContent.customTypes["1000003"] = "简答";
  native.customContent.customAnswers.push({
    question_id: 1000003,
    answer: "答案",
    key_points: ["要点"],
    references: [{ unit_id: 66, pdf_page: 66, quote: "原文" }]
  });
  native.imports.push({
    id: 100003,
    name: "资料",
    format: "pdf",
    size: 30 * 1024 * 1024,
    note: "备".repeat(1000),
    pages: [
      { pageIndex: 0, locator: "", text: "x".repeat(600000) },
      { pageIndex: 1, locator: "第2页", text: "y".repeat(2000000) }
    ]
  });

  const clean = validateNative(native);
  assert.equal(clean.customContent.customQuestions[0].question.length, 20000);
  assert.equal(clean.customContent.customQuestions[0].type, "简答题");
  assert.equal(clean.customContent.customTypes["1000003"], "简答题");
  assert.equal(clean.imports[0].pages[0].locator, "");
  assert.equal(clean.imports[0].pages[0].text.length, 600000);
  assert.equal(clean.imports[0].note.length, 1000);

  const tooLongQuestion = JSON.parse(JSON.stringify(native));
  tooLongQuestion.customContent.customQuestions[0].question = "题".repeat(20001);
  assert.throws(() => validateNative(tooLongQuestion), /格式(错误|不正确)/);

  const tooLongLocator = JSON.parse(JSON.stringify(native));
  tooLongLocator.imports[0].pages[0].locator = "p".repeat(301);
  assert.throws(() => validateNative(tooLongLocator), /格式(错误|不正确)/);

  const tooLongNote = JSON.parse(JSON.stringify(native));
  tooLongNote.imports[0].note = "备".repeat(1001);
  assert.throws(() => validateNative(tooLongNote), /格式(错误|不正确)/);

  const nonStringPoint = JSON.parse(JSON.stringify(native));
  nonStringPoint.customContent.customAnswers[0].key_points = [1];
  assert.throws(() => validateNative(nonStringPoint), /格式(错误|不正确)/);

  const extraReference = JSON.parse(JSON.stringify(native));
  extraReference.customContent.customAnswers[0].references[0].extra = true;
  assert.throws(() => validateNative(extraReference), /不支持的字段/);

  const tooMuchText = JSON.parse(JSON.stringify(native));
  tooMuchText.imports[0].pages = [
    { pageIndex: 0, locator: "p1", text: "x".repeat(2000000) },
    { pageIndex: 1, locator: "p2", text: "y".repeat(2000000) },
    { pageIndex: 2, locator: "p3", text: "z".repeat(1000001) }
  ];
  assert.throws(() => validateNative(tooMuchText), /同步内容过大/);

  const backup = buildBackup({
    state: sampleState(),
    native: {
      customContent: native.customContent,
      imports: native.imports,
      apiConfig: null,
      reminder: null,
      updateConfig: null
    }
  });
  const parsed = parseBackupText(backup.text);
  assert.equal(parsed.native.customContent.customQuestions[0].question.length, 20000);
  assert.equal(parsed.native.imports[0].pages[0].text.length, 600000);

  const oversized = JSON.parse(JSON.stringify(native));
  oversized.imports[0].pages[0].text = "x".repeat(2000001);
  const badBackup = buildBackup({
    state: sampleState(),
    native: {
      customContent: oversized.customContent,
      imports: oversized.imports,
      apiConfig: null,
      reminder: null,
      updateConfig: null
    }
  });
  assert.throws(() => parseBackupText(badBackup.text), /格式(错误|不正确)|同步内容/);
});

test("failed first pull does not bind; push binds after a successful merge", async () => {
  const harness = makeHarness({ mode: { failStateNetwork: true } });
  try {
    await assert.rejects(() => harness.sync.pull(), /无法连接云端/);
    assert.equal(readBinding(harness.dir), null);

    harness.mode.failStateNetwork = false;
    const pulled = await harness.sync.pull();
    assert.equal(pulled.revision, 0);
    assert.equal(readBinding(harness.dir), null);

    await harness.sync.push({ expectedRevision: pulled.revision, payload: sampleBundle() });
    assert.equal(readBinding(harness.dir).ownerId, OWNER_A);
  } finally {
    cleanup(harness.dir);
  }
});

test("pull rejects redirects and response bodies over the whole-response limit", async () => {
  const harness = makeHarness({
    mode: {
      onState: () => ({ status: 302, body: "[]" })
    }
  });
  try {
    await assert.rejects(() => harness.sync.pull(), /云端响应异常/);
    assert.equal(readBinding(harness.dir), null);

    harness.mode.onState = () => ({
      status: 200,
      body: `[${" ".repeat(20 * 1024 * 1024 + 1)}]`
    });
    await assert.rejects(() => harness.sync.pull(), /同步内容过大/);
  } finally {
    cleanup(harness.dir);
  }
});

test("bundle size limit is 16 MiB", () => {
  const bundle = sampleBundle();
  const chunk = "x".repeat(2_000_000);
  bundle.native.imports.push({
    id: 4_000_000_000_003,
    name: "big.md",
    format: "md",
    createdAt: "2026-01-01T00:00:00.000Z",
    pages: Array.from({ length: 9 }, (_, pageIndex) => ({
      pageIndex,
      locator: `第${pageIndex}段`,
      text: chunk
    }))
  });
  assert.throws(() => validateBundle(bundle), /同步内容过大/);
});
