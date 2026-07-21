import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const cli = path.join(projectRoot, "dist", "scripts", "cli.js");

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
