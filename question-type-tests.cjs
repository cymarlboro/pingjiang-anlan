// Legacy published bank is a fixed regression fixture; shipping bank is tested separately.
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

global.window = global.window || {};
require(path.join(__dirname, "test-fixtures", "legacy-geography", "question-types.js"));
require(path.join(__dirname, "test-fixtures", "legacy-geography", "study-data.js"));
require(path.join(__dirname, "test-fixtures", "legacy-geography", "generated-answers.js"));

const support = require(path.join(__dirname, "preview", "question-type-support.js"));
const questions = window.STUDY_DATA.questions;
const typesMap = window.QUESTION_TYPES;
const byId = new Map(questions.map((question) => [question.id, question]));

function question(id) {
  return byId.get(id);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("加载真实 310 题与 295 条映射", () => {
  assert.equal(questions.length, 310);
  assert.equal(Object.keys(typesMap).length, 295);
  assert.equal(window.QuestionTypeSupport, support);
});

test("真实 310 题按规范题型计数", () => {
  const counts = support.getCounts(questions);
  assert.deepEqual(counts, {
    "简答题": 73,
    "名词解释": 26,
    "论述题": 1,
    "读图分析题": 23,
    "填空题": 66,
    "判断题": 44,
    "选择题": 76,
    "分类与配对题": 1
  });
  assert.equal(
    Object.values(counts).reduce((sum, count) => sum + count, 0),
    310
  );
});

test("真实映射优先并归一化选择题、读图分析题", () => {
  assert.equal(support.getType(question(58)), "选择题");
  assert.equal(support.getType(question(82)), "读图分析题");
  assert.equal(support.getType(question(93)), "简答题");
  assert.equal(support.getType(question(204)), "名词解释");
  assert.equal(support.getType(question(81)), "分类与配对题");
  assert.equal(support.getType(question(208)), "论述题");
  assert.equal(support.getType(question(93), { 93: "选择题" }), "选择题");
  assert.equal(support.normalizeType("单项选择题"), "选择题");
  assert.equal(support.normalizeType("读图与分析题"), "读图分析题");
  assert.equal(support.normalizeType("单选题"), "选择题");
});

test("映射缺失的 15 道有选项题统一为选择题", () => {
  for (let id = 1; id <= 15; id += 1) {
    const item = question(id);
    assert.ok(item.options && item.options.trim(), `第 ${id} 题应有选项`);
    assert.equal(support.getType(item), "选择题", `第 ${id} 题应为选择题`);
  }
  // 题干含“包括”、答案为 ABC，也不擅自推断为多选。
  assert.match(question(3).question, /包括/);
  assert.equal(support.getType(question(3)), "选择题");
  assert.equal(
    support.getType({ id: 9006, question: "自然地理学的性质包括（　）", options: "A. 区域性　B. 综合性" }),
    "选择题"
  );
});

test("全部真实读图题均为读图分析题，未误判为选择题", () => {
  const imageQuestionIds = [];
  for (let id = 82; id <= 92; id += 1) {
    imageQuestionIds.push(id);
  }
  for (let id = 172; id <= 183; id += 1) {
    imageQuestionIds.push(id);
  }
  assert.equal(imageQuestionIds.length, 23);
  imageQuestionIds.forEach((id) => {
    assert.equal(support.getType(question(id)), "读图分析题", `第 ${id} 题应为读图分析题`);
    assert.notEqual(support.getType(question(id)), "选择题");
  });
});

test("缺映射时读图/简答不会被误判为选择题", () => {
  assert.equal(support.getType({ id: 9001, question: "简述地貌演化的基本过程" }), "简答题");
  assert.equal(support.getType({ id: 9002, question: "读图说明该地地质构造" }), "读图分析题");
  assert.equal(
    support.getType({ id: 9003, question: "说明图中地貌的成因" }, null, { 9003: ["image"] }),
    "读图分析题"
  );
  assert.notEqual(support.getType({ id: 9004, question: "谈谈你对人地关系的理解" }), "选择题");
});

test("图片映射全局回退可用于读图判定", () => {
  window.QUESTION_IMAGES = { 9100: ["image"] };
  try {
    assert.equal(support.getType({ id: 9100, question: "说明该图所示现象" }), "读图分析题");
  } finally {
    delete window.QUESTION_IMAGES;
  }
});

test("getTypes 返回全部或实际出现的规范题型", () => {
  assert.deepEqual(support.getTypes(), support.TYPE_ORDER.slice());
  assert.deepEqual(support.getTypes(questions), [
    "简答题",
    "名词解释",
    "论述题",
    "读图分析题",
    "填空题",
    "判断题",
    "选择题",
    "分类与配对题"
  ]);
  assert.deepEqual(support.getTypes([]), []);
});

test("matchesType 支持规范名、别名、数组与全部", () => {
  assert.equal(support.matchesType(question(93), "简答题"), true);
  assert.equal(support.matchesType(question(93), "选择题"), false);
  assert.equal(support.matchesType(question(58), "选择题"), true);
  assert.equal(support.matchesType(question(58), "单项选择题"), true);
  assert.equal(support.matchesType(question(82), "读图分析题"), true);
  assert.equal(support.matchesType(question(82), "选择题"), false);
  assert.equal(support.matchesType(question(93), ["名词解释", "简答题"]), true);
  assert.equal(support.matchesType(question(208), "论述"), true);
  assert.equal(support.matchesType(question(208), "全部"), true);
  assert.equal(support.matchesType(question(208), []), true);
});

test("getHint 的短提示与自评选项", () => {
  assert.equal(support.getHint("名词解释"), "先回忆定义与关键特征");
  assert.equal(support.getHint("名词"), "先回忆定义与关键特征");
  assert.equal(support.getHint("简答题"), "按要点回忆，再对照答案");
  assert.equal(support.getHint("论述题"), "先组织论点与依据，再展开作答");
  assert.equal(support.getHint("读图分析题"), "结合原图回忆判读依据");
  assert.equal(support.getHint(question(82)), "结合原图回忆判读依据");
  assert.equal(support.getHint("选择题"), "先独立判断，再查看答案");
  assert.ok(support.getHint("填空题").length > 0);
  assert.ok(support.getHint("判断题").length > 0);
  assert.ok(support.getHint("分类与配对题").length > 0);
  assert.deepEqual(Array.from(support.SELF_ASSESS_OPTIONS), ["熟记", "遗忘"]);
  assert.match(support.SELF_ASSESS_NOTE, /自评/);
  assert.match(support.SELF_ASSESS_NOTE, /判分/);
});

test("默认前 10 题含简答、名词、论述、读图且顺序确定", () => {
  const plan = support.recommendedPlan(questions, 10);
  assert.deepEqual(plan, [93, 16, 208, 82, 29, 47, 1, 81, 94, 17]);
  assert.equal(new Set(plan).size, 10);
  const types = new Set(plan.map((id) => support.getType(question(id))));
  ["简答题", "名词解释", "论述题", "读图分析题"].forEach((type) => {
    assert.ok(types.has(type), `前 10 题应包含 ${type}`);
  });
  plan.forEach((id) => assert.ok(byId.has(id), `不应生成新题：${id}`));
});

test("每类轮流取且同题型内题号递增", () => {
  const plan = support.recommendedPlan(questions, 310);
  assert.deepEqual(plan.slice(0, 8), [93, 16, 208, 82, 29, 47, 1, 81]);
  assert.deepEqual(
    plan.slice(0, 8).map((id) => support.getType(question(id))),
    support.TYPE_ORDER.slice()
  );
  const grouped = new Map();
  plan.forEach((id) => {
    const type = support.getType(question(id));
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    grouped.get(type).push(id);
  });
  grouped.forEach((ids, type) => {
    const numeric = ids.map(Number);
    assert.deepEqual(numeric, numeric.slice().sort((left, right) => left - right), `${type} 应题号递增`);
  });
});

test("完整混合计划无重复、覆盖全部有答案候选、候选不足取实际数", () => {
  const all = support.recommendedPlan(questions, 999);
  assert.equal(all.length, 310);
  assert.equal(new Set(all).size, 310);
  assert.deepEqual(new Set(all), new Set(questions.map((item) => item.id)));
  all.forEach((id) => assert.ok(byId.has(id)));

  const subset = [question(93), question(204), question(208), question(82)];
  assert.deepEqual(support.recommendedPlan(subset, 20), [93, 204, 208, 82]);
  assert.deepEqual(support.recommendedPlan(questions, 5), [93, 16, 208, 82, 29]);
});

test("推荐结果确定，且不修改原输入", () => {
  const snapshot = JSON.stringify(questions);
  const first = support.recommendedPlan(questions, 15);
  const second = support.recommendedPlan(questions, 15);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(questions), snapshot);
});

test("待答题与待答占位符排除，回调认可后可加入", () => {
  const pending = { id: 9900, question: "简述自然地理系统的特征", options: "", answer: "" };
  assert.deepEqual(support.recommendedPlan([pending], 10), []);
  assert.deepEqual(support.recommendedPlan([pending], 10, () => true), [9900]);

  const placeholder = { id: 9901, question: "简述自然地理系统的特征", options: "", answer: "待答" };
  assert.deepEqual(support.recommendedPlan([placeholder], 10), []);
  assert.deepEqual(support.recommendedPlan([placeholder], 10, () => false), []);
  assert.deepEqual(support.recommendedPlan([placeholder], 10, () => "approved"), [9901]);

  const decoratedPlaceholder = {
    id: 9903,
    question: "简述自然地理系统的特征",
    options: "",
    answer: "待答（暂无）"
  };
  assert.deepEqual(support.recommendedPlan([decoratedPlaceholder], 10), []);
});

test("有答案优先于回调拒绝，生成答案可作为默认回退", () => {
  const answered = { id: 9902, question: "名词解释：克拉克值", options: "", answer: "地壳元素平均含量" };
  assert.deepEqual(support.recommendedPlan([answered], 10, () => false), [9902]);
  // 第 93 题在 study-data 中无原答案，由 GENERATED_ANSWERS 提供。
  assert.ok(!question(93).answer);
  assert.deepEqual(support.recommendedPlan([question(93)], 10), [93]);
});

test("重复题号只出现一次，非法数量返回空数组", () => {
  assert.deepEqual(support.recommendedPlan([question(93), question(93)], 10), [93]);
  assert.deepEqual(support.recommendedPlan(questions, 0), []);
  assert.deepEqual(support.recommendedPlan(questions, -1), []);
  assert.deepEqual(support.recommendedPlan(questions, Number.NaN), []);
  assert.deepEqual(support.recommendedPlan(null, 10), []);
});

let passed = 0;
let failed = 0;
tests.forEach(({ name, fn }) => {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
});

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
if (failed > 0) {
  process.exitCode = 1;
}
