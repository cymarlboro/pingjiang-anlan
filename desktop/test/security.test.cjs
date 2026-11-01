"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  TRUSTED_MAIN_URL,
  CONTENT_SECURITY_POLICY,
  isTrustedFrameUrl,
  classifyNavigation,
  isAllowedReleaseUrl,
  senderRejectionReason
} = require("../src/main/security.cjs");

test("only the exact trusted top-level URL is accepted", () => {
  assert.equal(isTrustedFrameUrl(TRUSTED_MAIN_URL, false), true);
  assert.equal(isTrustedFrameUrl(TRUSTED_MAIN_URL, true), false);
  assert.equal(isTrustedFrameUrl("app://bundle/index.html?x=1", false), false);
  assert.equal(isTrustedFrameUrl("app://bundle/other.html", false), false);
  assert.equal(isTrustedFrameUrl("https://appassets.androidplatform.net/assets/www/index.html", false), false);
});

test("sender must be the main webContents and a top-level frame", () => {
  const sender = { getURL: () => TRUSTED_MAIN_URL };
  assert.equal(senderRejectionReason({ url: TRUSTED_MAIN_URL, parent: null }, sender, sender), "");
  assert.equal(senderRejectionReason({ url: TRUSTED_MAIN_URL, parent: {} }, sender, sender), "subframe");
  assert.equal(senderRejectionReason({ url: "about:blank", parent: null }, sender, sender), "untrusted-url");
  assert.equal(
    senderRejectionReason({ url: TRUSTED_MAIN_URL, parent: null }, sender, {}),
    "wrong-webcontents"
  );
  assert.equal(senderRejectionReason(null, sender, sender), "missing-frame");
});

test("navigation only allows the bundle and known release downloads externally", () => {
  assert.deepEqual(classifyNavigation(TRUSTED_MAIN_URL), { action: "allow" });
  const release = "https://github.com/cymarlboro/pingjiang-anlan/releases/download/v0.4.0/a.exe";
  assert.equal(isAllowedReleaseUrl(release), true);
  assert.deepEqual(classifyNavigation(release), { action: "external", url: release });
  assert.deepEqual(classifyNavigation("http://github.com/cymarlboro/pingjiang-anlan/releases/download/v0.4.0/a.exe"), { action: "block" });
  assert.deepEqual(classifyNavigation("https://evil.example/cymarlboro/pingjiang-anlan/releases/download/x"), { action: "block" });
  assert.deepEqual(classifyNavigation("https://github.com/cymarlboro/other/releases/download/x"), { action: "block" });
  assert.deepEqual(classifyNavigation("https://user:pass@github.com/cymarlboro/pingjiang-anlan/releases/download/x"), { action: "block" });
  assert.deepEqual(classifyNavigation("file:///C:/Windows/System32/calc.exe"), { action: "block" });
});

test("CSP forbids renderer networking, frames, and plugins", () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /form-action 'none'/);
});

test("preload exposes only the two bridge methods", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(desktopRoot, "src/preload.cjs"), "utf8");
  assert.match(source, /contextBridge\.exposeInMainWorld\("AndroidBridge"/);
  assert.match(source, /getBootstrap\(/);
  assert.match(source, /request\(id, method, payloadJson\)/);
  assert.equal((source.match(/ipcRenderer\.(sendSync|send)\s*\(/g) || []).length, 2);
  assert.equal(/exposeInMainWorld\(\s*["']ipcRenderer/.test(source), false);
  assert.equal(/exposeInMainWorld\(\s*["'](?:fs|shell|path)["']/.test(source), false);
});
