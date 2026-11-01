"use strict";

const { fail } = require("./errors.cjs");
const { isAllowedReleaseUrl, isHttpsUrl } = require("./security.cjs");

const MAX_API_BASE = 2048;
const MAX_RESOURCE = 4096;

function hasForbiddenChars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[index])) {
      return true;
    }
  }
  return false;
}

function parseUrl(raw, label) {
  if (typeof raw !== "string") {
    fail(`${label}格式不正确`);
  }
  const value = raw.trim();
  if (!value) {
    fail(`${label}不能为空`);
  }
  if (hasForbiddenChars(value)) {
    fail(`${label}不能包含空白或控制字符`);
  }
  try {
    return { value, url: new URL(value) };
  } catch {
    fail(`${label}格式不正确`);
  }
}

function safeDecodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    fail("服务地址路径编码无效");
  }
}

function hasRelativeSegment(pathname) {
  return safeDecodePath(pathname)
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

/**
 * Compatible chat-completions base URL. HTTPS may use any real host; plain
 * HTTP is limited to localhost/127.0.0.1. Userinfo, query, fragment, relative
 * path segments, and an accidentally pasted endpoint suffix are rejected or
 * normalized exactly as the Android contract does.
 */
function normalizeApiBase(raw) {
  const { value, url } = parseUrl(raw, "服务地址");
  if (value.length > MAX_API_BASE) {
    fail("服务地址过长");
  }
  const authorityEnd = value.indexOf("/", value.indexOf("://") + 3);
  const rawPath = authorityEnd >= 0 ? value.slice(authorityEnd) : "";
  if (rawPath && hasRelativeSegment(rawPath)) {
    fail("服务地址路径不能包含相对路径");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("服务地址只允许 HTTPS；本地服务可使用 localhost/127.0.0.1 的 HTTP");
  }
  if (!url.hostname) {
    fail("服务地址缺少有效主机名");
  }
  if (url.username || url.password) {
    fail("服务地址不能包含用户名或密码");
  }
  if (url.search || url.hash) {
    fail("服务地址不能包含查询参数或片段");
  }
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") {
      fail("HTTP 仅允许 localhost 或 127.0.0.1 本地服务");
    }
  }
  if (hasRelativeSegment(url.pathname)) {
    fail("服务地址路径不能包含相对路径");
  }
  let pathname = stripTrailingSlashes(url.pathname || "");
  if (pathname.endsWith("/chat/completions")) {
    pathname = pathname.slice(0, -"/chat/completions".length);
  } else if (pathname.endsWith("/models")) {
    pathname = pathname.slice(0, -"/models".length);
  }
  pathname = stripTrailingSlashes(pathname);
  const base = `${url.protocol}//${url.host}${pathname}`;
  if (!base || base === "null" || base.length > MAX_API_BASE) {
    fail("服务地址过长或格式不正确");
  }
  return base;
}

function normalizeUpdateManifestUrl(raw) {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw !== "string") {
    fail("发布清单地址格式不正确");
  }
  const value = raw.trim();
  if (!value) {
    return "";
  }
  return requireHttpsResource(value, MAX_RESOURCE, "发布清单地址");
}

function requireHttpsResource(raw, maxLength = MAX_RESOURCE, label = "地址") {
  const { value, url } = parseUrl(raw, label);
  if (value.length > maxLength) {
    fail(`${label}过长`);
  }
  if (url.protocol !== "https:") {
    fail(`${label}必须使用 HTTPS`);
  }
  if (!url.hostname) {
    fail(`${label}缺少有效主机名`);
  }
  if (url.username || url.password) {
    fail(`${label}不能包含用户名或密码`);
  }
  if (url.hash) {
    fail(`${label}不能包含片段`);
  }
  if (url.port && url.port !== "443") {
    fail(`${label}只允许标准 HTTPS 端口`);
  }
  return value;
}

function assertUpdateInstallerUrl(raw) {
  if (!isHttpsUrl(raw) || !isAllowedReleaseUrl(raw)) {
    fail("更新地址必须来自官方 GitHub Release 的 HTTPS 下载链接");
  }
  return raw;
}

module.exports = {
  MAX_API_BASE,
  MAX_RESOURCE,
  normalizeApiBase,
  normalizeUpdateManifestUrl,
  requireHttpsResource,
  assertUpdateInstallerUrl,
  hasForbiddenChars
};
