#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const failures = [];

function walk(directory) {
  const result = [];
  if (!fs.existsSync(directory)) {
    return result;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(full));
    } else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

const files = [
  ...walk(path.join(desktopRoot, "src")),
  ...walk(path.join(desktopRoot, "scripts")),
  ...walk(path.join(desktopRoot, "test"))
];

for (const file of files) {
  const checked = spawnSync(process.execPath, ["--check", file], {
    cwd: desktopRoot,
    stdio: "inherit"
  });
  if (checked.status !== 0) {
    failures.push(`syntax: ${path.relative(desktopRoot, file)}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const exactVersions = {
  electron: "45.0.0",
  "electron-builder": "26.15.3",
  "pdf-parse": "2.4.5",
  mammoth: "1.13.0"
};
for (const [name, version] of Object.entries(exactVersions)) {
  const actual = (pkg.dependencies && pkg.dependencies[name]) ||
    (pkg.devDependencies && pkg.devDependencies[name]);
  if (actual !== version) {
    failures.push(`package.json: ${name} must be pinned exactly to ${version}`);
  }
}
if (pkg.build?.appId !== "cn.pingjianganlan.study.desktop") {
  failures.push("package.json: stable appId is missing");
}
if (pkg.build?.artifactName !== "pingjianganlan-${version}-windows-x64-setup.${ext}") {
  failures.push("package.json: Windows artifact name is wrong");
}
if (pkg.build?.nsis?.deleteAppDataOnUninstall !== false) {
  failures.push("package.json: deleteAppDataOnUninstall must be false");
}
if (pkg.build?.nsis?.oneClick !== false ||
    pkg.build?.nsis?.allowToChangeInstallationDirectory !== true ||
    pkg.build?.nsis?.perMachine !== false) {
  failures.push("package.json: NSIS must be assisted per-user with path choice");
}

const securitySource = fs.readFileSync(path.join(desktopRoot, "src/main/security.cjs"), "utf8");
if (!/connect-src 'none'/.test(securitySource)) {
  failures.push("security.cjs: CSP must disable renderer connections");
}
if (!/frame-src 'none'/.test(securitySource)) {
  failures.push("security.cjs: CSP must disable frames");
}

const mainSource = fs.readFileSync(path.join(desktopRoot, "src/main/main.cjs"), "utf8");
for (const forbidden of [
  /nodeIntegration:\s*true/,
  /contextIsolation:\s*false/,
  /sandbox:\s*false/,
  /webviewTag:\s*true/
]) {
  if (forbidden.test(mainSource)) {
    failures.push(`main.cjs: forbidden insecure preference ${forbidden}`);
  }
}

const updatePolicy = fs.readFileSync(path.join(desktopRoot, "src/main/update-policy.cjs"), "utf8");
if (!updatePolicy.includes('"REPLACE_WITH_RELEASE_PUBLIC_KEY"')) {
  failures.push("update-policy.cjs: release public key placeholder missing");
}

const cloudSource = fs.readFileSync(path.join(desktopRoot, "src/main/cloud-auth.cjs"), "utf8");
if (!cloudSource.includes("https://rzqzvhvydmqhtcuovcco.supabase.co") ||
    !cloudSource.includes("sb_publishable_dh3MpDvuiQFvq3aY7Z_N0A_7q-_Zch_")) {
  failures.push("cloud-auth.cjs: fixed Supabase origin/key missing");
}

const allSources = files
  .filter((file) => file.includes(`${path.sep}src${path.sep}`))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(allSources)) {
  failures.push("source contains a private key");
}
if (/console\.(?:log|error|warn|info)\s*\(/.test(allSources)) {
  failures.push("source must not log requests/secrets");
}

if (failures.length) {
  process.stderr.write(`\nstatic checks failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`check-syntax: ${files.length} files passed static checks\n`);
