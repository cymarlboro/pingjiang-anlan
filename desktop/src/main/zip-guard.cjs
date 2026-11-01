"use strict";

const zlib = require("node:zlib");
const { UserError } = require("./errors.cjs");

const MAX_ZIP_ENTRIES = 2000;
const MAX_DOCX_XML_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

function corrupt() {
  throw new UserError("DOCX 无法读取，可能已损坏");
}

function safeName(buffer) {
  const name = buffer.toString("utf8");
  if (!name || name.includes("\u0000") || name.includes("\\") || name.startsWith("/")) {
    corrupt();
  }
  if (/^[a-zA-Z]:/.test(name)) {
    corrupt();
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    corrupt();
  }
  return name;
}

/**
 * Reads the ZIP central directory before any library sees the bytes. This caps
 * entry count, total uncompressed size, compression ratio, traversal names,
 * encryption, and unsupported compression methods without extracting anything.
 */
function inspectZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    corrupt();
  }
  let eocd = -1;
  const lowerBound = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) {
    corrupt();
  }
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    throw new UserError("DOCX 不支持分卷压缩");
  }
  if (entries < 1 || entries > MAX_ZIP_ENTRIES) {
    throw new UserError("DOCX 压缩包条目过多");
  }
  if (centralOffset + centralSize > buffer.length) {
    corrupt();
  }

  const entriesByName = new Map();
  let position = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) {
      corrupt();
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.length || position + 46 + nameLength > buffer.length) {
      corrupt();
    }
    if (flags & 0x0001) {
      throw new UserError("DOCX 不支持加密压缩包");
    }
    if (method !== 0 && method !== 8) {
      throw new UserError("DOCX 使用了不支持的压缩方式");
    }
    const name = safeName(buffer.subarray(position + 46, position + 46 + nameLength));
    if (uncompressedSize > MAX_DOCX_XML_BYTES) {
      throw new UserError("DOCX 解压后内容过大");
    }
    if (
      compressedSize > 0 &&
      uncompressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new UserError("DOCX 压缩比异常，已拒绝");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_DOCX_TOTAL_BYTES) {
      throw new UserError("DOCX 解压后内容过大");
    }
    entriesByName.set(name, {
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    position = next;
  }
  if (!entriesByName.has("word/document.xml")) {
    throw new UserError("DOCX 缺少 word/document.xml");
  }
  return { entries: entriesByName, totalUncompressed };
}

/** Extracts one already-validated entry with an independent output cap. */
function extractEntry(buffer, zipInfo, name, maxBytes = MAX_DOCX_XML_BYTES) {
  const entry = zipInfo.entries.get(name);
  if (!entry) {
    throw new UserError("DOCX 缺少必要的正文");
  }
  if (entry.uncompressedSize > maxBytes) {
    throw new UserError("DOCX 的 document.xml 过大");
  }
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    corrupt();
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start > buffer.length || end > buffer.length) {
    corrupt();
  }
  const raw = buffer.subarray(start, end);
  let output;
  try {
    output = entry.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch {
    corrupt();
  }
  if (!Buffer.isBuffer(output) || output.length > maxBytes || output.length !== entry.uncompressedSize) {
    corrupt();
  }
  return output;
}

module.exports = {
  MAX_ZIP_ENTRIES,
  MAX_DOCX_XML_BYTES,
  MAX_DOCX_TOTAL_BYTES,
  inspectZip,
  extractEntry
};
