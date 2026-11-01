"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { UserError } = require("./errors.cjs");
const {
  clean,
  decodeUtf8,
  stripActiveHtml,
  containsDoctypeOrEntity,
  hasSufficientTextLayer,
  paragraphBlocks
} = require("./text-rules.cjs");
const { inspectZip, extractEntry } = require("./zip-guard.cjs");

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_PDF_PAGES = 200;
const MAX_PDF_PAGE_CHARS = 500_000;
const MAX_PDF_TOTAL_CHARS = 5_000_000;
const MAX_TEXT_BLOCKS = 5000;

const FORMATS = new Map([
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["md", "md"],
  ["markdown", "md"],
  ["html", "html"],
  ["htm", "html"],
  ["txt", "txt"],
  ["text", "txt"]
]);

function formatFromName(name) {
  const extension = path.extname(String(name || "")).slice(1).toLowerCase();
  return FORMATS.get(extension) || null;
}

function verifyMagic(buffer, format) {
  if (format === "pdf") {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new UserError("文件不是有效的 PDF");
    }
  } else if (format === "docx") {
    if (
      buffer.length < 4 ||
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      throw new UserError("文件不是有效的 DOCX");
    }
  }
}

function clipTextWithFlag(text, max) {
  const value = clean(text);
  return value.length > max
    ? { text: value.slice(0, max), truncated: true }
    : { text: value, truncated: false };
}

function textDocument(name, format, text, notePrefix = "") {
  let remaining = clean(text);
  let truncated = false;
  if (remaining.length > MAX_TEXT_CHARS * 2) {
    remaining = remaining.slice(0, MAX_TEXT_CHARS * 2);
    truncated = true;
  }
  const blocks = paragraphBlocks(remaining, 4000, MAX_TEXT_BLOCKS);
  if (!blocks.length) {
    throw new UserError("文件中没有可提取的正文");
  }
  let total = 0;
  const pages = [];
  for (const block of blocks) {
    if (total + block.text.length > MAX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    pages.push(block);
    total += block.text.length;
  }
  if (!pages.length) {
    throw new UserError("文件中没有可提取的正文");
  }
  if (blocks.length >= MAX_TEXT_BLOCKS) {
    truncated = true;
  }
  const noteParts = [];
  if (notePrefix.trim()) {
    noteParts.push(notePrefix.trim());
  }
  if (truncated) {
    noteParts.push(`文档较长，已截取前 ${total} 个字符；省略的文字没有发送。`);
  }
  const note = noteParts.join(" ");
  return {
    name,
    format,
    pages,
    needsOcr: false,
    truncated,
    ...(note ? { note } : {})
  };
}

async function pdfPagesFromParser(buffer) {
  let moduleValue;
  try {
    moduleValue = require("pdf-parse");
  } catch {
    throw new UserError("PDF 解析组件不可用，请重新安装应用");
  }
  let result;
  let parser = null;
  try {
    if (typeof moduleValue.PDFParse === "function") {
      parser = new moduleValue.PDFParse({ data: buffer });
      result = await parser.getText();
    } else if (typeof moduleValue === "function") {
      result = await moduleValue(buffer);
    } else if (typeof moduleValue.default === "function") {
      result = await moduleValue.default(buffer);
    } else {
      throw new UserError("PDF 解析组件不可用，请重新安装应用");
    }
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError("PDF 无法读取，可能已加密、损坏或不受支持");
  } finally {
    if (parser && typeof parser.destroy === "function") {
      try { await parser.destroy(); } catch { /* best effort */ }
    }
  }
  if (!result || typeof result !== "object") {
    throw new UserError("PDF 无法读取，可能已加密、损坏或不受支持");
  }
  if (Array.isArray(result.pages)) {
    return result.pages.map((page, index) => {
      const number = Number(page && (page.num || page.pageNumber));
      const pageNumber = Number.isInteger(number) && number > 0 ? number : index + 1;
      return { pageNumber, text: typeof page.text === "string" ? page.text : "" };
    });
  }
  if (typeof result.text === "string") {
    const chunks = result.text.split("\f");
    return chunks.map((text, index) => ({ pageNumber: index + 1, text }));
  }
  throw new UserError("PDF 无法读取，可能已加密、损坏或不受支持");
}

async function parsePdf(name, buffer) {
  const parsedPages = await pdfPagesFromParser(buffer);
  if (!parsedPages.length) {
    throw new UserError("PDF 没有可读取的页面");
  }
  let truncated = parsedPages.length > MAX_PDF_PAGES;
  const pages = [];
  let totalChars = 0;
  let scannedPages = 0;
  for (let index = 0; index < Math.min(parsedPages.length, MAX_PDF_PAGES); index += 1) {
    const source = parsedPages[index];
    const clipped = clipTextWithFlag(source.text, MAX_PDF_PAGE_CHARS);
    let text = clipped.text;
    if (clipped.truncated) {
      truncated = true;
    }
    if (totalChars >= MAX_PDF_TOTAL_CHARS) {
      text = "";
      truncated = true;
    } else if (totalChars + text.length > MAX_PDF_TOTAL_CHARS) {
      text = text.slice(0, MAX_PDF_TOTAL_CHARS - totalChars);
      truncated = true;
    }
    totalChars += text.length;
    const needsOcr = !hasSufficientTextLayer(text);
    if (needsOcr) {
      scannedPages += 1;
    }
    pages.push({
      pageIndex: index,
      locator: `第${source.pageNumber}页`,
      text,
      ...(needsOcr ? { needsOcr: true } : {})
    });
  }
  const usablePages = pages.filter((page) => hasSufficientTextLayer(page.text));
  if (!usablePages.length) {
    throw new UserError(
      "这份 PDF 没有可提取的文字层，需要 OCR；桌面版暂不支持 OCR，请改用有文字层的 PDF"
    );
  }
  const noteParts = [];
  if (truncated) {
    noteParts.push(`PDF 超过 ${MAX_PDF_PAGES} 页或单页/总文字过长，已截取可处理部分；省略的文字没有发送。`);
  }
  if (scannedPages > 0) {
    noteParts.push("部分页面没有可用的文字层；桌面版暂不支持 OCR，这些页不会发送。");
  }
  return {
    name,
    format: "pdf",
    pages,
    needsOcr: scannedPages > 0,
    truncated,
    ...(noteParts.length ? { note: noteParts.join(" ") } : {})
  };
}

function xmlHasForbiddenMarkup(xml) {
  const candidates = [
    xml.toString("latin1"),
    xml.toString("utf8"),
    xml.toString("utf16le")
  ];
  return candidates.some((value) => {
    const upper = value.slice(0, 256 * 1024).toUpperCase();
    return upper.includes("<!DOCTYPE") ||
      upper.includes("<!ENTITY") ||
      /<W?:?ALTCHUNK\b/.test(upper);
  });
}

function xmlInspectionText(xml) {
  if (
    xml.length >= 2 &&
    ((xml[0] === 0xfe && xml[1] === 0xff) || (xml[0] === 0xff && xml[1] === 0xfe))
  ) {
    return xml.toString("utf16le");
  }
  return xml.toString("utf8");
}

function docxExtractionWarnings(xml) {
  const text = xmlInspectionText(xml);
  const warnings = [];
  if (/<w:(?:drawing|pict|object)\b/i.test(text) || /<v:imagedata\b/i.test(text)) {
    warnings.push("文档包含图片或图形，图片本身不会随文字导入，请自行核对缺失的图示。");
  }
  if (/<m:oMath(?:Para)?\b/i.test(text)) {
    warnings.push("文档包含 OMML 数学公式，公式对象可能无法完整转为文字，请核对公式内容。");
  }
  if (/<w:tbl\b/i.test(text)) {
    warnings.push("表格已按单元格文字顺序提取为纯文本，行列对齐和合并单元格可能丢失。");
  }
  if (/<w:(?:br|cr)\b/i.test(text)) {
    warnings.push("文档包含手动换行或分页；纯文本提取可能合并这些换行，请核对分行位置。");
  }
  return warnings;
}

async function parseDocx(name, buffer) {
  const zipInfo = inspectZip(buffer);
  const xml = extractEntry(buffer, zipInfo, "word/document.xml");
  if (containsDoctypeOrEntity(xml) || xmlHasForbiddenMarkup(xml)) {
    throw new UserError("DOCX 包含不支持的 DOCTYPE/ENTITY 或嵌入内容，已拒绝");
  }
  let mammoth;
  try {
    mammoth = require("mammoth");
  } catch {
    throw new UserError("DOCX 解析组件不可用，请重新安装应用");
  }
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw new UserError("DOCX 正文结构无法解析");
  }
  const text = result && typeof result.value === "string" ? result.value : "";
  if (!text.trim()) {
    throw new UserError("DOCX 中没有可提取的正文");
  }
  return textDocument(name, "docx", text, docxExtractionWarnings(xml).join(" "));
}

function htmlExtractionWarnings(html) {
  const warnings = [];
  if (/<math\b/i.test(html)) {
    warnings.push("文档包含 MathML 公式；已保留可读文字，但公式结构、上下标和分式可能不完整。");
  }
  if (/<svg\b/i.test(html)) {
    warnings.push("文档包含 SVG 图形；已保留其中的文字，但图形、箭头和布局不会导入。");
  }
  if (/<img\b/i.test(html)) {
    warnings.push("文档包含图片，图片本身不会随文字导入。");
  }
  if (/<table\b/i.test(html)) {
    warnings.push("HTML 表格按单元格文字换行提取，行列对齐可能丢失。");
  }
  return warnings;
}

async function parseImportBuffer(name, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new UserError("文件为空");
  }
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new UserError("文件超过 30MB，无法导入");
  }
  const safeName = path.basename(String(name || "导入资料")).replace(/[\r\n\t\u0000]/g, " ").slice(0, 240);
  const format = formatFromName(safeName);
  if (!format) {
    throw new UserError("仅支持 PDF、DOCX、Markdown、HTML、TXT");
  }
  verifyMagic(buffer, format);
  if (format === "pdf") {
    return parsePdf(safeName, buffer);
  }
  if (format === "docx") {
    return parseDocx(safeName, buffer);
  }
  let text;
  try {
    text = decodeUtf8(buffer);
  } catch {
    throw new UserError("文本文件必须为 UTF-8 编码");
  }
  let notePrefix = "";
  if (format === "html") {
    notePrefix = htmlExtractionWarnings(text).join(" ");
    text = stripActiveHtml(text);
  }
  return textDocument(safeName, format, text, notePrefix);
}

async function readImportFile(filePath) {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    throw new UserError("无法读取所选文件");
  }
  if (stat.isSymbolicLink()) {
    throw new UserError("不支持符号链接文件");
  }
  if (!stat.isFile()) {
    throw new UserError("所选路径不是普通文件");
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new UserError("文件超过 30MB，无法导入");
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new UserError("所选路径不是普通文件");
    }
    if (opened.size > MAX_SOURCE_BYTES) {
      throw new UserError("文件超过 30MB，无法导入");
    }
    const buffer = await handle.readFile();
    if (buffer.length > MAX_SOURCE_BYTES) {
      throw new UserError("文件超过 30MB，无法导入");
    }
    return parseImportBuffer(path.basename(filePath), buffer);
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    throw new UserError("文件读取失败");
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* best effort */ }
    }
  }
}

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_TEXT_CHARS,
  MAX_PDF_PAGES,
  MAX_PDF_PAGE_CHARS,
  MAX_TEXT_BLOCKS,
  formatFromName,
  verifyMagic,
  parseImportBuffer,
  readImportFile,
  stripActiveHtml
};
