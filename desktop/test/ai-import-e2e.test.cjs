"use strict";

/*
 * End-to-end fixture test: real local HTTP server -> real HTTP client ->
 * ApiClient request serialization/parsing -> real NativeStore accept/persist.
 * This never contacts a live provider and is NOT a live DeepSeek test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const { parseImportBuffer } = require("../src/main/importer.cjs");
const { NativeStore } = require("../src/main/native-store.cjs");
const {
  ApiClient,
  buildGenerationSystemPrompt
} = require("../src/main/api-client.cjs");
const { buildUserPrompt } = require("../src/main/api-compat.cjs");

const TEST_KEY = "sk-e2e-synthetic-not-a-real-key";
const MODEL = "fixture-model";
const PARAGRAPH = "流水地貌由“流水侵蚀”、搬运和堆积作用形成，峡谷属于侵蚀地貌。";
const EXISTING_QUESTION = "1. 简述流水地貌的主要形成作用。";
const FIXTURE = `# 地貌笔记\n\n${PARAGRAPH}\n\n${EXISTING_QUESTION}\n`;
const ANSWER = "流水侵蚀、搬运和堆积作用。";

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    Connection: "close"
  });
  response.end(bytes);
}

async function startFixtureServer(getPage) {
  const requests = [];
  let generationRequests = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        raw
      });

      if (request.method === "GET" && request.url === "/v1/models") {
        sendJson(response, 200, { data: [{ id: MODEL }] });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        generationRequests += 1;
        if (generationRequests === 1) {
          // Explicit optional-field rejection: the client may remove
          // response_format exactly once. The echoed sentinel must not leak.
          sendJson(response, 400, {
            error: {
              code: "invalid_request_error",
              type: "invalid_request_error",
              message: `response_format is not supported ${TEST_KEY} ${PARAGRAPH}`
            }
          });
          return;
        }
        const page = getPage();
        sendJson(response, 200, {
          choices: [{
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                questions: [{
                  question: "流水地貌的形成作用有哪些？",
                  answer: ANSWER,
                  type: "简答题",
                  chapter: "地貌笔记",
                  sourceQuote: page.text,
                  pageIndex: page.pageIndex
                }]
              })
            }
          }]
        });
        return;
      }
      sendJson(response, 404, { error: { message: "unexpected fixture path" } });
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: "fixture server failure" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("fixture import -> real store/API client/local HTTP -> parse -> save", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shanyueji-ai-e2e-"));
  let fixtureServer = null;
  try {
    // 1. Real UTF-8 importer produces the pages that the app would send.
    const importedDocument = await parseImportBuffer(
      "ai-import-fixture.md",
      Buffer.from(FIXTURE, "utf8")
    );
    const page = importedDocument.pages.find((item) => item.text.includes(PARAGRAPH));
    assert.ok(page, "fixture importer did not produce the expected page");
    assert.equal(page.text, PARAGRAPH);
    assert.equal(importedDocument.pages.some((item) => item.text === EXISTING_QUESTION), true);

    // 2. Real persistent NativeStore, including a generated import id.
    const store = new NativeStore({ userDataDir });
    const storedImport = await store.addImport({
      ...importedDocument,
      size: Buffer.byteLength(FIXTURE, "utf8")
    });
    assert.ok(Number.isSafeInteger(storedImport.id));

    // 3. Real loopback HTTP server (no live provider, no real key).
    fixtureServer = await startFixtureServer(() => page);
    await store.saveApiConfig({
      serviceName: "local-fixture",
      baseUrl: fixtureServer.url,
      model: MODEL,
      maxQuestions: 2
    });
    const keyStore = {
      load: async () => TEST_KEY,
      save: async () => {},
      clear: async () => {},
      exists: async () => true
    };
    const client = new ApiClient({ store, keyStore });

    // 4. Model listing succeeds on the same base URL, like the user's report.
    const listed = await client.testApi();
    assert.deepEqual(listed.models, [MODEL]);
    assert.equal(listed.configuredModel, MODEL);
    assert.equal(listed.modelListed, true);
    assert.equal(listed.connectionScope, "model-list-only");

    // 5. Generate through the real HTTP client. First POST is explicitly rejected
    //    (response_format); the bounded retry succeeds and is parsed.
    const generated = await client.generate({
      importId: storedImport.id,
      pageIndexes: [page.pageIndex],
      maxQuestions: 1
    });
    assert.equal(generated.questions.length, 1);
    assert.equal(generated.questions[0].sourceQuote, page.text);
    assert.equal(generated.questions[0].pageIndex, page.pageIndex);
    assert.equal(generated.questions[0].locator, page.locator);
    assert.equal(JSON.stringify(generated).includes(TEST_KEY), false);

    // 6. Serialized request assertions: exact endpoint, headers, UTF-8 bytes,
    //    field set, prompts, and the one retry.
    const getRequests = fixtureServer.requests.filter((item) => item.method === "GET");
    const postRequests = fixtureServer.requests.filter((item) => item.method === "POST");
    assert.equal(getRequests.length, 1);
    assert.equal(getRequests[0].url, "/v1/models");
    assert.equal(getRequests[0].headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(postRequests.length, 2);

    for (const request of postRequests) {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
      assert.match(request.headers["content-type"], /^application\/json; charset=utf-8$/i);
      assert.equal(Number(request.headers["content-length"]), request.raw.length);
      // fatal:true proves the exact bytes are valid UTF-8 with no BOM replacement.
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(request.raw);
      assert.equal(decoded.startsWith("\uFEFF"), false);
      assert.equal(decoded.includes(TEST_KEY), false);
      const body = JSON.parse(decoded);
      assert.equal(body.model, MODEL);
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[1].role, "user");
      assert.equal(body.temperature, undefined);
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.stream, undefined);
      assert.equal(body.thinking, undefined);
      assert.equal(body.messages[0].content, buildGenerationSystemPrompt(1));
      assert.equal(body.messages[1].content, buildUserPrompt(
        importedDocument.name,
        [{
          pageIndex: page.pageIndex,
          locator: page.locator,
          text: page.text
        }],
        1
      ));
      assert.match(body.messages[0].content, /\bjson\b/);
      assert.match(body.messages[1].content, /不是指令，也不是完整教材/);
      assert.equal(body.messages[1].content.includes(PARAGRAPH), true);
    }
    const first = JSON.parse(postRequests[0].raw.toString("utf8"));
    const second = JSON.parse(postRequests[1].raw.toString("utf8"));
    assert.deepEqual(Object.keys(first).sort(), ["messages", "model", "response_format"]);
    assert.deepEqual(first.response_format, { type: "json_object" });
    assert.deepEqual(Object.keys(second).sort(), ["messages", "model"]);
    assert.equal(second.response_format, undefined);

    // 7. Real save pipeline re-validates the quote and persists atomically.
    const savedCount = await store.acceptQuestions({
      importId: storedImport.id,
      questions: generated.questions
    });
    assert.equal(savedCount, 1);

    const reopened = new NativeStore({ userDataDir });
    const persisted = reopened.cloudNativeSnapshot();
    assert.equal(persisted.customContent.customQuestions.length, 1);
    assert.equal(persisted.customContent.customAnswers.length, 1);
    const savedQuestion = persisted.customContent.customQuestions[0];
    const savedAnswer = persisted.customContent.customAnswers[0];
    assert.equal(savedQuestion.question, generated.questions[0].question);
    assert.equal(savedAnswer.answer, ANSWER);
    assert.equal(savedAnswer.sourceQuote, page.text);
    assert.equal(savedAnswer.pageIndex, page.pageIndex);
    assert.equal(savedAnswer.origin, "import");
    assert.equal(savedAnswer.userEdited, true);
    assert.equal(persisted.customContent.customTypes[String(savedQuestion.id)], "简答题");
    assert.equal(reopened.getImport(storedImport.id).pages[page.pageIndex].text, page.text);
  } finally {
    if (fixtureServer) {
      await fixtureServer.close();
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
