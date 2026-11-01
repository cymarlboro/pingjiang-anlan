"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  AUTO_CHECK_INTERVAL_MS,
  UPDATE_PUBLIC_KEY,
  shouldAutoCheck,
  verifyWindowsManifest,
  validateInstallRequest,
  verifyDownloadedDigest,
  verifyWindowsSignature
} = require("../src/main/update-policy.cjs");
const { scriptJson } = require("../src/main/update-service.cjs");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

function windows(overrides = {}) {
  return Object.assign({
    versionCode: 5,
    versionName: "0.5.0",
    appId: "cn.pingjianganlan.study.desktop",
    installerUrl: "https://github.com/cymarlboro/pingjiang-anlan/releases/download/v0.5.0/shanyueji-0.5.0-windows-x64-setup.exe",
    sha256: "a".repeat(64),
    notes: "修复与改进"
  }, overrides);
}

function manifest(overrides = {}) {
  const value = windows(overrides);
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(value)), privateKey).toString("base64");
  return { windows: value, windowsSignature: signature };
}

test("valid Ed25519 manifest is verified before use and maps installerUrl to apkUrl", () => {
  const verified = verifyWindowsManifest(manifest(), 4, publicKey);
  assert.equal(verified.result.available, true);
  assert.equal(verified.result.apkUrl, verified.windows.installerUrl);
  assert.equal(verified.result.sha256, "a".repeat(64));
  assert.equal(verified.windows.versionCode, 5);
});

test("same or lower version is not available", () => {
  assert.equal(verifyWindowsManifest(manifest({ versionCode: 4 }), 4, publicKey).result.available, false);
  assert.equal(verifyWindowsManifest(manifest({ versionCode: 3 }), 4, publicKey).result.available, false);
});

test("placeholder public key fails closed", () => {
  assert.equal(verifyWindowsSignature(manifest(), UPDATE_PUBLIC_KEY), false);
  assert.throws(
    () => verifyWindowsManifest(manifest(), 4, UPDATE_PUBLIC_KEY),
    /签名校验失败/
  );
});

test("wrong signature, tampered notes, and non-official URLs are rejected", () => {
  const signed = manifest();
  signed.windows.notes = "tampered";
  assert.throws(() => verifyWindowsManifest(signed, 4, publicKey), /签名校验失败/);

  assert.throws(
    () => verifyWindowsManifest(manifest({ installerUrl: "http://github.com/cymarlboro/pingjiang-anlan/releases/download/v0.5.0/a.exe" }), 4, publicKey),
    /installerUrl/
  );
  assert.throws(
    () => verifyWindowsManifest(manifest({ installerUrl: "https://evil.example/cymarlboro/pingjiang-anlan/releases/download/v0.5.0/a.exe" }), 4, publicKey),
    /installerUrl/
  );
  assert.throws(
    () => verifyWindowsManifest(manifest({ appId: "cn.pingjianganlan.study" }), 4, publicKey),
    /appId/
  );
});

test("invalid digest and version code are rejected even when signed", () => {
  assert.throws(
    () => verifyWindowsManifest(manifest({ sha256: "xyz" }), 4, publicKey),
    /sha256/
  );
  assert.throws(
    () => verifyWindowsManifest(manifest({ versionCode: 0 }), 4, publicKey),
    /versionCode/
  );
  assert.throws(
    () => verifyWindowsManifest(manifest({ versionName: "" }), 4, publicKey),
    /versionName/
  );
});

test("install request must exactly match the verified manifest", () => {
  const verified = verifyWindowsManifest(manifest(), 4, publicKey).result;
  const payload = {
    versionCode: verified.versionCode,
    apkUrl: verified.apkUrl,
    sha256: verified.sha256
  };
  assert.equal(validateInstallRequest(payload, verified), verified);
  assert.throws(
    () => validateInstallRequest(Object.assign({}, payload, { sha256: "b".repeat(64) }), verified),
    /不一致/
  );
  assert.throws(
    () => validateInstallRequest(Object.assign({}, payload, { apkUrl: payload.apkUrl + "?x" }), verified),
    /不一致/
  );
  assert.throws(
    () => validateInstallRequest(payload, Object.assign({}, verified, { available: false })),
    /无效/
  );
});

test("downloaded digest mismatch is rejected", () => {
  assert.equal(verifyDownloadedDigest("A".repeat(64), "a".repeat(64)), "a".repeat(64));
  assert.throws(() => verifyDownloadedDigest("b".repeat(64), "a".repeat(64)), /SHA256/);
  assert.throws(() => verifyDownloadedDigest("short", "a".repeat(64)), /SHA256/);
});

test("startup/resume checks are throttled to six hours with clock-rollback recovery", () => {
  assert.equal(AUTO_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(shouldAutoCheck(0, 1000), true);
  assert.equal(shouldAutoCheck(1000, 1000 + AUTO_CHECK_INTERVAL_MS - 1), false);
  assert.equal(shouldAutoCheck(1000, 1000 + AUTO_CHECK_INTERVAL_MS), true);
  assert.equal(shouldAutoCheck(5000, 1000), true);
});

test("update emit script escapes line separators", () => {
  const value = scriptJson({ notes: "a\u2028b\u2029c" });
  assert.equal(value.includes("\u2028"), false);
  assert.equal(value.includes("\u2029"), false);
  assert.match(value, /\\u2028/);
  assert.match(value, /\\u2029/);
});
