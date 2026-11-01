"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { UserError } = require("./errors.cjs");
const { isHttpsUrl } = require("./security.cjs");

const MAX_REDIRECTS = 3;
const USER_AGENT = "PingjiangAnlan/1.0.0 Windows";

function checkedUrl(raw, { httpsOnly = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError("服务地址格式不正确");
  }
  if (url.username || url.password) {
    throw new UserError("地址不能包含用户名或密码");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UserError("地址只允许 HTTPS");
  }
  if (httpsOnly && url.protocol !== "https:") {
    throw new UserError("地址必须使用 HTTPS");
  }
  return url;
}

function requestOnce({ method = "GET", url, headers = {}, body = null, timeoutMs = 30000, maxBytes = 2 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = checkedUrl(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const requestHeaders = Object.assign({ "User-Agent": USER_AGENT }, headers);
    const payload = body === null || body === undefined ? null : Buffer.from(String(body), "utf8");
    if (payload) {
      requestHeaders["Content-Length"] = String(payload.length);
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const request = transport.request(
      parsed,
      {
        method,
        headers: requestHeaders,
        rejectUnauthorized: true
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          if (settled) {
            return;
          }
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            request.destroy();
            finish(new UserError("服务响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(null, {
            status: Number(response.statusCode) || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
        response.on("error", () => {
          finish(new UserError("网络请求失败，请检查网络与服务地址"));
        });
      }
    );

    request.setTimeout(Math.max(1, Number(timeoutMs) || 30000), () => {
      request.destroy();
      finish(new UserError("网络请求超时，请稍后重试"));
    });
    request.on("error", () => {
      finish(new UserError("网络请求失败，请检查网络与服务地址"));
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function redirectLocation(status, headers) {
  if (status < 300 || status >= 400) {
    return "";
  }
  const location = headers && headers.location;
  return typeof location === "string" ? location : "";
}

/** Follows redirects only for public, credential-free manifest reads. */
async function requestPublicJson(url, options = {}) {
  let current = checkedUrl(url, { httpsOnly: true }).href;
  const maxBytes = options.maxBytes || 512 * 1024;
  const timeoutMs = options.timeoutMs || 30000;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!isHttpsUrl(current)) {
      throw new UserError("地址必须使用 HTTPS");
    }
    const response = await requestOnce({
      method: "GET",
      url: current,
      headers: { Accept: "application/json" },
      timeoutMs,
      maxBytes
    });
    const location = redirectLocation(response.status, response.headers);
    if (location) {
      if (redirect === MAX_REDIRECTS) {
        throw new UserError("更新清单重定向过多");
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new UserError("更新清单重定向无效");
      }
      if (!isHttpsUrl(next.href)) {
        throw new UserError("更新清单重定向到了非 HTTPS 地址");
      }
      current = next.href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new UserError(`更新清单返回 HTTP ${response.status}`);
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw new UserError("更新清单不是有效 JSON");
    }
  }
  throw new UserError("更新清单重定向过多");
}

function cleanTarget(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true });
  } catch {
    // Best-effort cleanup of our own fixed download path.
  }
}

/**
 * Downloads an update installer to a fixed path with no source-derived file
 * names, no credentials, and no cookie/header forwarding across redirects.
 * The digest is computed over the exact bytes written.
 */
async function downloadPublicFile(url, targetPath, options = {}) {
  if (!isHttpsUrl(url)) {
    throw new UserError("更新地址必须使用 HTTPS");
  }
  const maxBytes = Math.max(1, Number(options.maxBytes) || 250 * 1024 * 1024);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 120000);
  const allowedInitial = typeof options.allowedInitialUrl === "function"
    ? options.allowedInitialUrl
    : (candidate) => isHttpsUrl(candidate);
  if (!allowedInitial(url)) {
    throw new UserError("更新地址不在允许的发布范围内");
  }

  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const parsed = checkedUrl(current, { httpsOnly: true });
    const result = await new Promise((resolve, reject) => {
      const request = https.request(
        parsed,
        {
          method: "GET",
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": USER_AGENT
          },
          rejectUnauthorized: true
        },
        (response) => {
          const location = redirectLocation(response.statusCode, response.headers);
          if (location) {
            response.resume();
            resolve({ redirect: location });
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            reject(new UserError(`安装包下载失败（HTTP ${response.statusCode}）`));
            return;
          }
          const declared = Number(response.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            response.destroy();
            request.destroy();
            reject(new UserError("安装包超过 250MB"));
            return;
          }
          cleanTarget(targetPath);
          const output = fs.createWriteStream(targetPath, { flags: "wx", mode: 0o600 });
          const digest = crypto.createHash("sha256");
          let total = 0;
          let settled = false;
          const fail = (error) => {
            if (settled) {
              return;
            }
            settled = true;
            response.destroy();
            request.destroy();
            output.destroy();
            cleanTarget(targetPath);
            reject(error);
          };
          response.on("data", (chunk) => {
            if (settled) {
              return;
            }
            total += chunk.length;
            if (total > maxBytes) {
              fail(new UserError("安装包超过 250MB"));
              return;
            }
            digest.update(chunk);
            if (!output.write(chunk)) {
              response.pause();
              output.once("drain", () => response.resume());
            }
          });
          response.on("error", () => fail(new UserError("安装包下载失败")));
          output.on("error", () => fail(new UserError("安装包写入失败")));
          response.on("end", () => {
            if (settled) {
              return;
            }
            output.end(() => {
              if (settled) {
                return;
              }
              if (total <= 0) {
                fail(new UserError("安装包为空"));
                return;
              }
              settled = true;
              resolve({ sha256: digest.digest("hex"), bytes: total });
            });
          });
        }
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        cleanTarget(targetPath);
        reject(new UserError("安装包下载超时，请稍后重试"));
      });
      request.on("error", () => {
        cleanTarget(targetPath);
        reject(new UserError("安装包下载失败"));
      });
      request.end();
    });

    if (result.redirect) {
      if (redirect === MAX_REDIRECTS) {
        throw new UserError("安装包重定向过多");
      }
      let next;
      try {
        next = new URL(result.redirect, current);
      } catch {
        throw new UserError("安装包重定向无效");
      }
      if (!isHttpsUrl(next.href)) {
        throw new UserError("安装包重定向到了非 HTTPS 地址");
      }
      current = next.href;
      continue;
    }
    return result;
  }
  throw new UserError("安装包重定向过多");
}

module.exports = {
  MAX_REDIRECTS,
  requestOnce,
  requestPublicJson,
  downloadPublicFile,
  redirectLocation
};
