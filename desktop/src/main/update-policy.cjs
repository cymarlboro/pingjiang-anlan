"use strict";

const crypto = require("node:crypto");
const { APP_ID } = require("./security.cjs");
const { isAllowedReleaseUrl } = require("./security.cjs");

const DEFAULT_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/cymarlboro/pingjiang-anlan/main/update.json";
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_VERSION_CODE = Number.MAX_SAFE_INTEGER;

// Release process must replace this placeholder with the Ed25519 public key.
// No private key is present in source; while the placeholder is unchanged the
// update path fails closed and cannot install anything.
const UPDATE_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAvFuM69DIkOT3uPOQTsQCiDaFyEJwPF7Jom/y4b4U4zM=\n-----END PUBLIC KEY-----";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function shouldAutoCheck(lastCheckMillis, nowMillis, intervalMillis = AUTO_CHECK_INTERVAL_MS) {
  const last = Number(lastCheckMillis) || 0;
  const now = Number(nowMillis) || 0;
  if (last <= 0) {
    return true;
  }
  if (now < last) {
    return true;
  }
  return now - last >= Math.max(1, Number(intervalMillis) || AUTO_CHECK_INTERVAL_MS);
}

function publicKeyObject(publicKey) {
  if (typeof publicKey !== "string" || !publicKey || publicKey === "REPLACE_WITH_RELEASE_PUBLIC_KEY") {
    return null;
  }
  try {
    if (publicKey.includes("BEGIN PUBLIC KEY")) {
      return crypto.createPublicKey(publicKey);
    }
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) {
      return null;
    }
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      raw
    ]);
    return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function verifyWindowsSignature(manifest, publicKey = UPDATE_PUBLIC_KEY) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return false;
  }
  const windows = manifest.windows;
  const signature = manifest.windowsSignature;
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) {
    return false;
  }
  if (typeof signature !== "string" || !signature) {
    return false;
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) {
    return false;
  }
  const key = publicKeyObject(publicKey);
  if (!key) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      Buffer.from(JSON.stringify(windows), "utf8"),
      key,
      signatureBytes
    );
  } catch {
    return false;
  }
}

function requiredString(value, max, message) {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(message);
  }
  return trimmed;
}

function validateWindowsManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("更新清单格式不正确");
  }
  const windows = manifest.windows;
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) {
    throw new Error("更新清单缺少 Windows 信息");
  }
  const versionCode = windows.versionCode;
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    versionCode > MAX_VERSION_CODE
  ) {
    throw new Error("更新清单 versionCode 无效");
  }
  const versionName = requiredString(windows.versionName, 64, "更新清单 versionName 无效");
  if (windows.appId !== APP_ID) {
    throw new Error("更新清单 appId 与当前桌面应用不一致");
  }
  const installerUrl = requiredString(windows.installerUrl, 4096, "更新清单缺少 installerUrl");
  if (!isAllowedReleaseUrl(installerUrl)) {
    throw new Error("更新清单 installerUrl 不在官方 HTTPS Release 范围内");
  }
  const sha256 = requiredString(windows.sha256, 64, "更新清单 sha256 无效").toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("更新清单 sha256 无效");
  }
  const notes = windows.notes === undefined ? "" : windows.notes;
  if (typeof notes !== "string" || notes.length > 4000) {
    throw new Error("更新说明过长");
  }
  return {
    appId: windows.appId,
    versionCode,
    versionName,
    installerUrl,
    sha256,
    notes
  };
}

function buildUpdateResult(windows, currentVersionCode) {
  return {
    available: windows.versionCode > Number(currentVersionCode || 0),
    versionCode: windows.versionCode,
    versionName: windows.versionName,
    notes: windows.notes,
    apkUrl: windows.installerUrl,
    sha256: windows.sha256,
    installerUrl: windows.installerUrl
  };
}

/**
 * Signature verification happens before any manifest field is used. A missing,
 * malformed, wrong, or placeholder key fails closed.
 */
function verifyWindowsManifest(manifest, currentVersionCode, publicKey = UPDATE_PUBLIC_KEY) {
  if (!verifyWindowsSignature(manifest, publicKey)) {
    throw new Error("更新清单签名校验失败，已停止更新");
  }
  const windows = validateWindowsManifest(manifest);
  return {
    windows,
    result: buildUpdateResult(windows, currentVersionCode)
  };
}

function validateInstallRequest(payload, verifiedResult) {
  if (!payload || typeof payload !== "object" || !verifiedResult || !verifiedResult.available) {
    throw new Error("更新参数无效");
  }
  if (Number(payload.versionCode) !== verifiedResult.versionCode) {
    throw new Error("更新参数与已验证清单不一致，已拒绝下载");
  }
  if (payload.apkUrl !== verifiedResult.apkUrl) {
    throw new Error("更新参数与已验证清单不一致，已拒绝下载");
  }
  if (typeof payload.sha256 !== "string" ||
      payload.sha256.toLowerCase() !== verifiedResult.sha256) {
    throw new Error("更新参数与已验证清单不一致，已拒绝下载");
  }
  return verifiedResult;
}

function verifyDownloadedDigest(actual, expected) {
  const actualText = typeof actual === "string" ? actual.toLowerCase() : "";
  const expectedText = typeof expected === "string" ? expected.toLowerCase() : "";
  if (!SHA256_PATTERN.test(actualText) || !SHA256_PATTERN.test(expectedText)) {
    throw new Error("安装包 SHA256 校验失败，已拒绝安装");
  }
  if (actualText !== expectedText) {
    throw new Error("安装包 SHA256 校验失败，已拒绝安装");
  }
  return actualText;
}

module.exports = {
  DEFAULT_UPDATE_MANIFEST_URL,
  AUTO_CHECK_INTERVAL_MS,
  MAX_INSTALLER_BYTES,
  MAX_MANIFEST_BYTES,
  UPDATE_PUBLIC_KEY,
  SHA256_PATTERN,
  shouldAutoCheck,
  publicKeyObject,
  verifyWindowsSignature,
  validateWindowsManifest,
  buildUpdateResult,
  verifyWindowsManifest,
  validateInstallRequest,
  verifyDownloadedDigest
};
