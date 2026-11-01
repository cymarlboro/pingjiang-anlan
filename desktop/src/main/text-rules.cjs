"use strict";

const REMINDER_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clean(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let result = "";
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if (character === "\n" || character === "\t") {
      result += character;
    } else if (code === 0x0000 || code === 0xfeff) {
      // Drop NUL/BOM.
    } else if (code < 0x20 || code === 0x7f) {
      result += " ";
    } else if (code >= 0xe000 && code <= 0xf8ff) {
      result += " ";
    } else {
      result += character;
    }
  }
  return result.trim();
}

function meaningfulCount(text) {
  if (typeof text !== "string" || !text) {
    return 0;
  }
  let count = 0;
  for (const character of text) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      count += 1;
    }
  }
  return count;
}

function hasSufficientTextLayer(text) {
  return meaningfulCount(clean(text)) >= 20;
}

function isValidReminderTime(time) {
  return typeof time === "string" && REMINDER_TIME.test(time);
}

function decodeUtf8(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let value = decoder.decode(bytes);
  if (value.startsWith("\ufeff")) {
    value = value.slice(1);
  }
  return value;
}

// svg/math are deliberately NOT removed with their content: formula/graph text
// is often the only usable text in those blocks. Their tags are stripped below
// and the importer adds an explicit fidelity warning.
const BLOCK_PATTERNS = [
  [/<!--[\s\S]*?-->/g, ""],
  [/<(script|style|noscript|template|head|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ""],
  [/<![^>]*>/g, ""],
  [/<\?[^>]*\?>/g, ""]
];

const ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®"
});

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return " ";
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * HTML import is treated as hostile data: executable/head/embedded blocks are
 * removed, comments/declarations are dropped, then tags are stripped. Nothing
 * is ever parsed as XML or rendered.
 */
function stripActiveHtml(html) {
  if (typeof html !== "string") {
    return "";
  }
  let value = html;
  for (const [pattern, replacement] of BLOCK_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  value = value.replace(/<br\s*\/?>/gi, "\n");
  value = value.replace(
    /<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|blockquote|table|ul|ol|dl|dt|dd)\s*>/gi,
    "\n"
  );
  value = value.replace(/<[^>]*>/g, "");
  return decodeEntities(value);
}

function containsDoctypeOrEntity(head) {
  if (typeof head !== "string") {
    return false;
  }
  const upper = head.slice(0, 256 * 1024).toUpperCase();
  return upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY");
}

const BOUNDARIES = "。！？；.!?;\n";

function chunkText(raw, maxChars = 4000) {
  const limit = Math.max(200, Number(maxChars) || 4000);
  const result = [];
  let remaining = String(raw || "").trim();
  while (remaining) {
    if (remaining.length <= limit) {
      result.push(remaining);
      break;
    }
    let cut = limit;
    const floor = Math.max(1, Math.floor(limit / 2));
    for (let index = limit; index >= floor; index -= 1) {
      const character = remaining[index - 1];
      if (BOUNDARIES.includes(character) || /\s/.test(character)) {
        cut = index;
        break;
      }
    }
    const piece = remaining.slice(0, cut).trim();
    remaining = remaining.slice(cut).trim();
    if (piece) {
      result.push(piece);
    }
    if (result.length > 5000) {
      break;
    }
  }
  return result;
}

/**
 * Stable paragraph blocks used by MD/TXT/HTML/DOCX imports. Locators include a
 * real 1-based paragraph number and, when split, a part suffix.
 */
function paragraphBlocks(raw, maxChars = 4000, maxBlocks = 5000) {
  const text = clean(raw);
  if (!text) {
    return [];
  }
  const result = [];
  const paragraphs = text.split(/\n[\t ]*\n/);
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex].trim();
    if (!paragraph) {
      continue;
    }
    const paragraphNumber = paragraphIndex + 1;
    const chunks = chunkText(paragraph, Math.max(200, maxChars));
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (result.length >= maxBlocks) {
        return result;
      }
      const suffix = chunks.length > 1 ? `（第${chunkIndex + 1}部分）` : "";
      result.push({
        pageIndex: result.length,
        paragraphIndex: paragraphNumber,
        locator: `第${paragraphNumber}段${suffix}`,
        text: chunks[chunkIndex]
      });
    }
  }
  return result;
}

module.exports = {
  REMINDER_TIME,
  clean,
  meaningfulCount,
  hasSufficientTextLayer,
  isValidReminderTime,
  decodeUtf8,
  stripActiveHtml,
  containsDoctypeOrEntity,
  chunkText,
  paragraphBlocks
};
