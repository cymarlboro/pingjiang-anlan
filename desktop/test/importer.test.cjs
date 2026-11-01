"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  formatFromName,
  parseImportBuffer,
  MAX_SOURCE_BYTES,
  MAX_PDF_PAGE_CHARS
} = require("../src/main/importer.cjs");
const { stripActiveHtml, paragraphBlocks } = require("../src/main/text-rules.cjs");

const FIXTURES = path.join(__dirname, "..", "..", "test-fixtures", "import-e2e");

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function makeTextPdf(text) {
  const lines = [];
  const value = String(text);
  for (let index = 0; index < value.length; index += 1000) {
    const chunk = value.slice(index, index + 1000)
      .replace(/[\\()]/g, (character) => `\\${character}`);
    lines.push(`(${chunk}) Tj T*`);
  }
  // Tiny text on a large page keeps the whole test string inside the page box;
  // otherwise PDF.js clips off-page text and never exercises the 500k cap.
  const stream = `BT /F1 0.5 Tf 0.6 TL 10 9900 Td\n${lines.join("\n")}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(output, "latin1");
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, "latin1");
  output += "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

test("HTML import strips scripts/head and keeps visible text only", async () => {
  const html = [
    "<!doctype html><html><head><script>alert('x')</script></head>",
    "<body><h1>地貌</h1><p>流水侵蚀&nbsp;作用</p>",
    "<script>steal()</script><iframe src='https://evil.example'></iframe></body></html>"
  ].join("");
  const text = stripActiveHtml(html);
  assert.equal(text.includes("alert"), false);
  assert.equal(text.includes("steal"), false);
  assert.equal(text.includes("iframe"), false);
  assert.match(text, /地貌/);
  assert.match(text, /流水侵蚀/);

  const document = await parseImportBuffer("a.html", Buffer.from(html, "utf8"));
  assert.equal(document.format, "html");
  assert.equal(document.pages.length > 0, true);
  assert.equal(document.pages.some((page) => page.text.includes("steal")), false);
});

test("text pagination keeps stable locators and UTF-8 requirement", async () => {
  const blocks = paragraphBlocks("第一段\n\n第二段");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].locator, "第1段");
  assert.equal(blocks[1].locator, "第2段");

  const document = await parseImportBuffer("notes.md", Buffer.from("标题\n\n正文", "utf8"));
  assert.equal(document.format, "md");
  assert.equal(document.pages.length, 2);

  await assert.rejects(
    () => parseImportBuffer("bad.txt", Buffer.from([0xff, 0xfe, 0x00])),
    /UTF-8/
  );
});

test("format detection and size caps are explicit", async () => {
  assert.equal(formatFromName("a.MARKDOWN"), "md");
  assert.equal(formatFromName("a.htm"), "html");
  assert.equal(formatFromName("a.exe"), null);
  await assert.rejects(
    () => parseImportBuffer("a.exe", Buffer.from("hello")),
    /仅支持/
  );
  await assert.rejects(
    () => parseImportBuffer("a.txt", Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61)),
    /30MB/
  );
});

test("fake DOCX is rejected by the ZIP guard before any parser loads", async () => {
  const fake = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("not a real zip", "utf8")
  ]);
  await assert.rejects(
    () => parseImportBuffer("a.docx", fake),
    /DOCX/
  );
});

test("real fixtures keep source wording and punctuation across TXT/MD/HTML/PDF", async () => {
  const expected = "背斜岩层一般向上弯曲，向斜岩层一般向下弯曲；判断构造形态还应结合岩层新老关系";
  for (const name of ["geography.txt", "geography.md", "geography.html"]) {
    const document = await parseImportBuffer(name, fixture(name));
    assert.equal(document.format, name.endsWith(".md") ? "md" : name.endsWith(".html") ? "html" : "txt");
    assert.equal(
      document.pages.some((page) => page.text.includes(expected)),
      true,
      `${name} lost source text`
    );
    assert.equal(document.pages.some((page) => page.text.includes("地理解析验收")), false);
  }

  const pdf = await parseImportBuffer("geography.pdf", fixture("geography.pdf"));
  assert.equal(pdf.format, "pdf");
  assert.equal(pdf.pages.length, 1);
  assert.equal(pdf.pages[0].locator, "第1页");
  assert.equal(pdf.pages[0].needsOcr, undefined);
  assert.match(pdf.pages[0].text, /^Geography extraction fixture: weathering, erosion, deposition/);
  assert.equal(pdf.truncated, false);
});

test("structured DOCX keeps table/cell order and warns about images, equations, tables, breaks", async () => {
  const document = await parseImportBuffer(
    "geography-structure.docx",
    fixture("geography-structure.docx")
  );
  const texts = document.pages.map((page) => page.text);
  assert.equal(document.format, "docx");
  assert.equal(texts.includes("自然地理学结构验收"), true);
  assert.equal(texts.includes("河流\t下蚀侧蚀与堆积"), true);
  const tableOrder = ["地貌类型", "主要作用", "流水地貌", "侵蚀、搬运、堆积"];
  const positions = tableOrder.map((cell) => texts.indexOf(cell));
  assert.equal(positions.every((position) => position >= 0), true, "table cells missing");
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b), "table cells out of order");
  assert.equal(
    texts.indexOf("表格之后：背斜与向斜的判断要结合岩层新老关系。") > positions[3],
    true,
    "paragraph after table was reordered"
  );
  assert.match(document.note, /图片或图形/);
  assert.match(document.note, /OMML/);
  assert.match(document.note, /表格/);
  assert.match(document.note, /手动换行/);
});

test("HTML MathML/SVG text is preserved and flagged instead of silently deleted", async () => {
  const html = [
    "<html><body><p>公式与图形</p>",
    "<math><mi>x</mi><mo>=</mo><mn>1</mn></math>",
    "<svg><text>箭头方向</text></svg>",
    "<p>正文保留；标点保留。</p>",
    "<script>steal()</script></body></html>"
  ].join("");
  const stripped = stripActiveHtml(html);
  assert.match(stripped, /x/);
  assert.match(stripped, /箭头方向/);
  assert.match(stripped, /正文保留；标点保留。/);
  assert.equal(stripped.includes("steal"), false);

  const document = await parseImportBuffer("formula.html", Buffer.from(html, "utf8"));
  assert.match(document.note, /MathML/);
  assert.match(document.note, /SVG/);
});

test("PDF page text clipped at MAX_PDF_PAGE_CHARS is reported as truncated", async () => {
  const text = "A".repeat(MAX_PDF_PAGE_CHARS + 17);
  const document = await parseImportBuffer("large.pdf", makeTextPdf(text));
  assert.equal(document.truncated, true);
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].text.length, MAX_PDF_PAGE_CHARS);
  assert.match(document.note, /文字过长/);
  assert.match(document.note, /省略/);
});
