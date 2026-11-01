"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ApiClient,
  CHOICE_MISSING_OPTIONS
} = require("../src/main/api-client.cjs");
const {
  MODEL_UNAVAILABLE,
  JSON_PROMPT_REJECTED,
  SAMPLING_UNSUPPORTED,
  CONTEXT_TOO_LONG,
  BALANCE_OR_RATE_LIMIT,
  BAD_REQUEST
} = require("../src/main/api-compat.cjs");

function makeDocument() {
  return {
    id: 100001,
    name: "地貌笔记.md",
    format: "md",
    pages: [
      { pageIndex: 0, locator: "第1段", text: "流水地貌由流水侵蚀、搬运和堆积作用形成。" }
    ]
  };
}

const DEFAULT_QUOTE = "流水地貌由流水侵蚀、搬运和堆积作用形成。";

function makeGeneratedQuestion(overrides = {}) {
  return {
    question: "流水地貌的形成作用有哪些？",
    answer: "侵蚀、搬运和堆积作用。",
    type: "简答题",
    chapter: "地貌",
    sourceQuote: DEFAULT_QUOTE,
    pageIndex: 0,
    ...overrides
  };
}

function generatedBody(questions) {
  return JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({ questions })
      }
    }]
  });
}

function successBody(quote = DEFAULT_QUOTE) {
  return generatedBody([makeGeneratedQuestion({ sourceQuote: quote })]);
}

function makeClient(responses, overrides = {}) {
  const calls = [];
  const document = overrides.document || makeDocument();
  const store = {
    getApiConfig: () => ({
      serviceName: "custom",
      baseUrl: "https://api.example.com/v1",
      model: overrides.model || "model-x",
      maxQuestions: 5
    }),
    getImport: () => document
  };
  const keyStore = {
    load: async () => "sk-test-key"
  };
  const client = new ApiClient({
    store,
    keyStore,
    request: async (options) => {
      calls.push(options);
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected request");
      }
      return response;
    }
  });
  return { client, calls };
}

test("generate retries once without response_format only", async () => {
  const { client, calls } = makeClient([
    { status: 400, body: "response_format is not supported" },
    { status: 200, body: successBody() }
  ]);
  const result = await client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 });
  assert.equal(calls.length, 2);
  const first = JSON.parse(calls[0].body);
  const second = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(first).sort(), ["messages", "model", "response_format"]);
  assert.deepEqual(first.response_format, { type: "json_object" });
  assert.equal(first.temperature, undefined);
  assert.equal(second.response_format, undefined);
  assert.equal(second.temperature, undefined);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].sourceQuote, "流水地貌由流水侵蚀、搬运和堆积作用形成。");
});

test("sampling/thinking rejection does not retry and returns a safe category", async () => {
  const { client, calls } = makeClient([
    { status: 400, body: "temperature is not supported for this model" }
  ]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(SAMPLING_UNSUPPORTED));
      assert.match(error.message, /HTTP 400/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("model ID failure carries status and allowlisted code, not raw provider text", async () => {
  const { client, calls } = makeClient([{
    status: 400,
    body: JSON.stringify({
      error: {
        code: "model_not_found",
        type: "invalid_request_error",
        message: "sk-live-SECRET source material"
      }
    })
  }]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(MODEL_UNAVAILABLE));
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /code=model_not_found/);
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(error.message.includes("source material"), false);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("JSON prompt rejection and context overflow are distinct safe categories", async () => {
  const json = makeClient([{
    status: 400,
    body: '{"error":{"code":"invalid_request_error",' +
      '"message":"The prompt must contain the word json to use json_object"}}'
  }]);
  await assert.rejects(
    () => json.client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(JSON_PROMPT_REJECTED));
      assert.match(error.message, /code=invalid_request_error/);
      return true;
    }
  );
  assert.equal(json.calls.length, 1);

  const context = makeClient([{
    status: 400,
    body: '{"error":{"code":"context_length_exceeded",' +
      '"message":"maximum context length exceeded"}}'
  }]);
  await assert.rejects(
    () => context.client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(CONTEXT_TOO_LONG));
      assert.match(error.message, /code=context_length_exceeded/);
      return true;
    }
  );
  assert.equal(context.calls.length, 1);
});

test("auth and quota failures do not retry or reveal upstream text", async () => {
  const auth = makeClient([
    { status: 401, body: "invalid api key sk-live-SECRET" }
  ]);
  await assert.rejects(
    () => auth.client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.equal(error.message.includes("SECRET"), false);
      assert.match(error.message, /API Key/);
      return true;
    }
  );
  assert.equal(auth.calls.length, 1);

  const quota = makeClient([
    { status: 429, body: "insufficient_quota sk-live-SECRET" }
  ]);
  await assert.rejects(
    () => quota.client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(BALANCE_OR_RATE_LIMIT));
      assert.equal(error.message.includes("SECRET"), false);
      return true;
    }
  );
  assert.equal(quota.calls.length, 1);
});

test("provider 500 text is redacted", async () => {
  const { client, calls } = makeClient([
    { status: 500, body: "sk-live-SECRET source material" }
  ]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(error.message.includes("source"), false);
      assert.match(error.message, /HTTP 500/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("unknown provider error code is omitted while status remains", async () => {
  const { client } = makeClient([{
    status: 400,
    body: '{"error":{"code":"sk-live-SECRET","message":"unexpected upstream failure"}}'
  }]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.ok(error.message.startsWith(BAD_REQUEST));
      assert.match(error.message, /HTTP 400/);
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(error.message.includes("code="), false);
      return true;
    }
  );
});

test("selected source is capped at 12000 characters before any request", async () => {
  const document = makeDocument();
  document.pages[0].text = "A".repeat(12001) + "流水地貌由流水侵蚀、搬运和堆积作用形成。";
  const { client, calls } = makeClient([], { document });
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    /12000/
  );
  assert.equal(calls.length, 0);
});

test("model quote must match the selected page exactly", async () => {
  const { client } = makeClient([
    { status: 200, body: successBody("原文中不存在的引用") }
  ]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    /引用未能在原文中精确匹配/
  );
});

test("model list parsing rejects invalid structures", async () => {
  const { client } = makeClient([
    { status: 200, body: JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, "m1"] }) }
  ]);
  const result = await client.testApi();
  assert.deepEqual(result.models, ["m1", "m2"]);
});

test("testApi reports configured model membership without claiming generation works", async () => {
  const listed = makeClient([
    { status: 200, body: JSON.stringify({ data: [{ id: "configured-model" }] }) }
  ], { model: "configured-model" });
  const listedResult = await listed.client.testApi();
  assert.equal(listedResult.configuredModel, "configured-model");
  assert.equal(listedResult.modelListed, true);
  assert.equal(listedResult.connectionScope, "model-list-only");
  assert.deepEqual(listed.calls.map((call) => call.method), ["GET"]);

  const absent = makeClient([
    { status: 200, body: JSON.stringify({ data: [{ id: "other-model" }] }) }
  ], { model: "deepssek-v4" });
  const absentResult = await absent.client.testApi();
  assert.equal(absentResult.configuredModel, "deepssek-v4");
  assert.equal(absentResult.modelListed, false);
  assert.deepEqual(absentResult.models, ["other-model"]);
  assert.deepEqual(absent.calls.map((call) => call.method), ["GET"]);
});

test("real v0.4.0 choice draft without options in question is rejected", async () => {
  const { client, calls } = makeClient([{
    status: 200,
    body: generatedBody([makeGeneratedQuestion({
      question: "中国空间站轨道高度约400公里，位于大气圈的哪一层？",
      answer: "D. 热层",
      type: "选择题"
    })])
  }]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
    (error) => {
      assert.equal(error.message, CHOICE_MISSING_OPTIONS);
      assert.equal(error.message, "选择题缺少完整选项，请减少题量或重试");
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("choice options in question accept common Chinese inline/newline labels", async () => {
  const questionStem = "中国空间站轨道高度约400公里，位于大气圈的哪一层？";
  const validQuestions = [
    `${questionStem}A. 对流层 B. 平流层 C. 中间层 D. 热层`,
    `${questionStem}\nA、对流层\nB、平流层\nC、中间层\nD、热层`,
    `${questionStem}A．对流层 B．平流层 C．中间层 D．热层`,
    `${questionStem}A) 对流层 B) 平流层 C) 中间层 D) 热层`,
    `${questionStem}A）对流层 B）平流层 C）中间层 D）热层`,
    `${questionStem}（A）对流层（B）平流层（C）中间层（D）热层`,
    `${questionStem}（A） 对流层\n（B） 平流层\n（C） 中间层\n（D） 热层`,
    `${questionStem}A.对流层B.平流层C.中间层D.热层`
  ];
  for (const question of validQuestions) {
    const { client } = makeClient([{
      status: 200,
      body: generatedBody([makeGeneratedQuestion({
        question,
        answer: "D. 热层",
        type: "选择题"
      })])
    }]);
    const result = await client.generate({
      importId: 100001,
      pageIndexes: [0],
      maxQuestions: 1
    });
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].question, question);
    assert.equal(result.questions[0].answer, "D. 热层");
    assert.equal(result.questions[0].type, "选择题");
  }
});

test("choice drafts need at least two distinct non-empty labelled options", async () => {
  const stem = "中国空间站轨道高度约400公里，位于大气圈的哪一层？";
  const invalidQuestions = [
    `${stem}A. 对流层`,
    `${stem}A. 对流层 A. 平流层`,
    `${stem}A.   B. 平流层`,
    `${stem}A. 对流层 B.`
  ];
  for (const question of invalidQuestions) {
    const { client } = makeClient([{
      status: 200,
      body: generatedBody([makeGeneratedQuestion({
        question,
        answer: "D. 热层",
        type: "选择题"
      })])
    }]);
    await assert.rejects(
      () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
      (error) => {
        assert.equal(error.message, CHOICE_MISSING_OPTIONS);
        return true;
      }
    );
  }
});

test("answer labels and body letters are not mistaken for options", async () => {
  const nonOptions = [
    "A、B 两地气温差异的主要原因是？",
    "图A和图B所示的地貌类型有何差异？",
    "维生素A. 缺乏会导致哪种疾病？",
    "答案：D. 热层"
  ];
  for (const question of nonOptions) {
    const { client } = makeClient([{
      status: 200,
      body: generatedBody([makeGeneratedQuestion({
        question,
        answer: "D. 热层",
        type: "选择题"
      })])
    }]);
    await assert.rejects(
      () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
      (error) => {
        assert.equal(error.message, CHOICE_MISSING_OPTIONS);
        return true;
      }
    );
  }
});

test("one invalid choice rejects the whole generated batch", async () => {
  const { client } = makeClient([{
    status: 200,
    body: generatedBody([
      makeGeneratedQuestion(),
      makeGeneratedQuestion({
        question: "中国空间站轨道高度约400公里，位于大气圈的哪一层？",
        answer: "D. 热层",
        type: "选择题"
      })
    ])
  }]);
  await assert.rejects(
    () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 2 }),
    (error) => {
      assert.equal(error.message, CHOICE_MISSING_OPTIONS);
      return true;
    }
  );
});

test("single/multiple choice aliases use the same option validation", async () => {
  for (const type of ["单选", "多选", "多选题"]) {
    const { client } = makeClient([{
      status: 200,
      body: generatedBody([makeGeneratedQuestion({
        question: "中国空间站轨道高度约400公里，位于大气圈的哪一层？",
        answer: "D. 热层",
        type
      })])
    }]);
    await assert.rejects(
      () => client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 }),
      (error) => {
        assert.equal(error.message, CHOICE_MISSING_OPTIONS);
        return true;
      }
    );
  }

  const { client } = makeClient([{
    status: 200,
    body: generatedBody([makeGeneratedQuestion({
      question: "中国空间站轨道高度约400公里，位于大气圈的哪一层？" +
        "A. 对流层 B. 平流层 C. 中间层 D. 热层",
      answer: "D. 热层",
      type: "多选题"
    })])
  }]);
  const result = await client.generate({
    importId: 100001,
    pageIndexes: [0],
    maxQuestions: 1
  });
  assert.equal(result.questions[0].type, "选择题");
});

test("generation prompt requires choice options to live inside question", async () => {
  const { client, calls } = makeClient([{ status: 200, body: successBody() }]);
  await client.generate({ importId: 100001, pageIndexes: [0], maxQuestions: 1 });
  const body = JSON.parse(calls[0].body);
  const systemPrompt = body.messages[0].content;
  assert.match(systemPrompt, /选项必须全部写在 question 字段内/);
  assert.match(systemPrompt, /当前没有 options 字段/);
  assert.match(systemPrompt, /至少包含 A、B 两条/);
  assert.match(systemPrompt, /原文没有选项时不得生成选择题/);
});
