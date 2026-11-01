#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopRoot = path.resolve(__dirname, "..");
const testDir = path.join(desktopRoot, "test");
const files = fs.readdirSync(testDir)
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => path.join(testDir, name));

if (!files.length) {
  process.stderr.write("run-tests: no test files found\n");
  process.exit(1);
}

// In-process isolation avoids the Windows sandbox's named-pipe restriction on
// the test runner. Production code never spawns a process here.
const result = spawnSync(
  process.execPath,
  ["--test", "--test-isolation=none", ...files],
  { cwd: desktopRoot, stdio: "inherit" }
);
if (result.error) {
  process.stderr.write(`run-tests: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
