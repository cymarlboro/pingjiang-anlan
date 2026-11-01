#!/usr/bin/env node
/*
 * Copies the reviewed preview UI byte-for-byte into the desktop build input.
 * The desktop host never owns or edits UI files: the copied hashes are recorded
 * and verified so a fork cannot silently ship.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const sourceDir = path.resolve(desktopRoot, "..", "preview");
const buildRoot = path.resolve(desktopRoot, "build");
const targetDir = path.resolve(buildRoot, "renderer");
const manifestPath = path.resolve(buildRoot, "preview-manifest.json");

const EXPECTED_FILES = Object.freeze([
  "index.html",
  "app.css",
  "app.js",
  "study-data.js",
  "generated-answers.js",
  "question-images.js",
  "question-types.js",
  "question-type-support.js",
  "native-adapter.js",
  "memory-scheduler.js",
  "ai-settings.js",
  "cloud-account.js",
  "cloud-sync.js"
]);

function fail(message) {
  process.stderr.write(`copy-preview: ${message}\n`);
  process.exit(1);
}

function assertInside(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} escapes ${parent}`);
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
  fail("preview directory is missing");
}
assertInside(desktopRoot, targetDir, "renderer target");
assertInside(buildRoot, targetDir, "renderer target");

for (const name of EXPECTED_FILES) {
  const source = path.join(sourceDir, name);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    fail(`required preview asset is missing: ${name}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`preview asset is not a regular file: ${name}`);
  }
}

const manifest = { source: "preview", files: {} };
if (fs.existsSync(targetDir)) {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
fs.mkdirSync(targetDir, { recursive: true });

for (const name of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!name.isFile()) {
    continue;
  }
  const from = path.join(sourceDir, name.name);
  const to = path.join(targetDir, name.name);
  const bytes = fs.readFileSync(from);
  fs.writeFileSync(to, bytes, { mode: 0o644 });
  const sourceHash = sha256(bytes);
  const targetHash = sha256(fs.readFileSync(to));
  if (sourceHash !== targetHash) {
    fail(`copied bytes differ for ${name.name}`);
  }
  manifest.files[name.name] = sourceHash;
}

for (const name of EXPECTED_FILES) {
  if (!manifest.files[name]) {
    fail(`required preview asset was not copied: ${name}`);
  }
}

const index = fs.readFileSync(path.join(targetDir, "index.html"), "utf8");
for (const match of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) {
    continue;
  }
  const resolved = path.resolve(targetDir, reference);
  assertInside(targetDir, resolved, `index reference ${reference}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`index.html references a missing local asset: ${reference}`);
  }
}

fs.mkdirSync(buildRoot, { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(
  `copy-preview: copied ${Object.keys(manifest.files).length} preview assets byte-for-byte\n`
);
