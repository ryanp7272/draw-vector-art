import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const cli = path.join(projectRoot, "dist", "scripts", "cli.js");
const launcher = path.join(projectRoot, "scripts", "run-engine.mjs");

test("launcher reports a usable bundled runtime without mutating the plugin", async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { version: string };
  const { stdout } = await execFileAsync(process.execPath, [launcher, "doctor"], { cwd: projectRoot });
  const report = JSON.parse(stdout) as {
    ok: boolean;
    version: string;
    node: { supported: boolean; minimum: string };
    runtime: { bundled: boolean; localDependencies: boolean };
    cache: { directory: string };
  };
  assert.equal(report.ok, true);
  assert.equal(report.version, packageJson.version);
  assert.equal(report.node.supported, true);
  assert.equal(report.node.minimum, "20.3.0");
  assert.equal(report.runtime.bundled, true);
  assert.equal(report.runtime.localDependencies, true);
  assert.match(report.cache.directory, new RegExp(`${process.platform}-${process.arch}`));
});

test("launcher dispatches the committed runtime from an arbitrary working directory", async () => {
  const { stdout } = await execFileAsync(process.execPath, [launcher, "schema"], { cwd: path.dirname(projectRoot) });
  const schema = JSON.parse(stdout) as { $schema?: string; type?: string };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
});

test("schema command emits JSON Schema", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "schema"], { cwd: projectRoot });
  const schema = JSON.parse(stdout) as { $schema?: string; type?: string };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
});

test("validate command returns a machine-readable report", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "validate", "tests/fixtures/rocket.scene.json"], {
    cwd: projectRoot,
  });
  const report = JSON.parse(stdout) as { valid: boolean; summary: { errors: number; warnings: number } };
  assert.equal(report.valid, true);
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, objects: 15, bezierNodes: 9 });
});
