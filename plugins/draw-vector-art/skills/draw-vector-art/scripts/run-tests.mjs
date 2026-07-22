#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDirectory = path.join(skillDirectory, "dist", "tests");
const entries = await readdir(testDirectory, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

if (!testFiles.length) throw new Error(`No compiled tests found in ${testDirectory}`);

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", ...testFiles], {
    cwd: skillDirectory,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Test runner stopped by signal ${signal}`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
