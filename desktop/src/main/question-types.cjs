"use strict";

const CANONICAL = Object.freeze([
  "简答题",
  "名词解释",
  "论述题",
  "读图分析题",
  "填空题",
  "判断题",
  "选择题",
  "分类与配对题"
]);

const ALIASES = Object.freeze({
  简答: "简答题",
  简答题: "简答题",
  简述题: "简答题",
  名词: "名词解释",
  名词解释: "名词解释",
  论述: "论述题",
  论述题: "论述题",
  读图与分析题: "读图分析题",
  读图分析: "读图分析题",
  读图分析题: "读图分析题",
  读图题: "读图分析题",
  图题: "读图分析题",
  图表分析题: "读图分析题",
  填空: "填空题",
  填空题: "填空题",
  判断: "判断题",
  判断题: "判断题",
  选择: "选择题",
  选择题: "选择题",
  单项选择: "选择题",
  单项选择题: "选择题",
  单选题: "选择题",
  分类与配对题: "分类与配对题",
  分类题: "分类与配对题",
  配对题: "分类与配对题"
});

function normalize(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.replace(/[\s\u3000]+/g, "");
  return Object.prototype.hasOwnProperty.call(ALIASES, value) ? ALIASES[value] : null;
}

function isCanonical(type) {
  return typeof type === "string" && CANONICAL.includes(type);
}

module.exports = { CANONICAL, normalize, isCanonical };
