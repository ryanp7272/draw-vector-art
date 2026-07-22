import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createBlindKey, runBenchmark } from "../scripts/benchmark.js";

const projectRoot = process.cwd();
const evaluationDirectory = path.join(projectRoot, "tests", "evaluation");
const pilotDirectory = path.join(evaluationDirectory, "pilot");

interface RunCase {
  taskId: string;
  directSvg: string;
  engineScene: string;
}

interface RunManifest {
  version: number;
  name: string;
  description: string;
  protocol: {
    directSvg: string;
    sceneEngine: string;
  };
  cases: RunCase[];
}

async function writeRun(name: string, cases: RunCase[]): Promise<{ runPath: string; output: string }> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "draw-vector-benchmark-test-"));
  const runPath = path.join(temporaryDirectory, "run.json");
  const manifest: RunManifest = {
    version: 1,
    name,
    description: "Automated benchmark runner test",
    protocol: {
      directSvg: "One raw SVG draft",
      sceneEngine: "Validated semantic scene",
    },
    cases,
  };
  await writeFile(runPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { runPath, output: path.join(temporaryDirectory, "output") };
}

function pilotCase(taskId: "text-rocket" | "text-fox"): RunCase {
  if (taskId === "text-rocket") {
    return {
      taskId,
      directSvg: path.join(pilotDirectory, "direct", "text-rocket.svg"),
      engineScene: path.join(projectRoot, "tests", "fixtures", "rocket.scene.json"),
    };
  }
  return {
    taskId,
    directSvg: path.join(pilotDirectory, "direct", "text-fox.svg"),
    engineScene: path.join(pilotDirectory, "engine", "text-fox.scene.json"),
  };
}

async function rgba(input: string | Buffer): Promise<Buffer> {
  return sharp(input).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer();
}

test("assigns a deterministic, balanced blind key for all 12 evaluation tasks", async () => {
  const manifest = JSON.parse(await readFile(path.join(evaluationDirectory, "tasks.json"), "utf8")) as {
    tasks: Array<{ id: string }>;
  };
  const taskIds = manifest.tasks.map((task) => task.id);
  const first = createBlindKey("balanced-test", taskIds);
  const second = createBlindKey("balanced-test", [...taskIds].reverse());

  assert.equal(Object.values(first).filter((assignment) => assignment.A === "scene-engine").length, 6);
  for (const taskId of taskIds) assert.deepEqual(second[taskId], first[taskId]);
});

test("rejects duplicate benchmark task IDs before rendering", async () => {
  const duplicate = pilotCase("text-rocket");
  const { runPath, output } = await writeRun("duplicate-task-test", [duplicate, { ...duplicate }]);
  await assert.rejects(runBenchmark(runPath, output), /duplicate task ID text-rocket/i);
});

test("marks a missing-task run incomplete and builds A/B from native 64 px previews", async () => {
  const { runPath, output } = await writeRun("native-64-test", [pilotCase("text-rocket")]);
  const report = await runBenchmark(runPath, output);
  assert.equal(report.completeEvaluation, false);
  assert.equal(report.evaluatedTasks, 1);

  const benchmarkCase = report.cases[0];
  assert.ok(benchmarkCase);
  const metadata = await sharp(benchmarkCase.artifacts.blind64).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 128, height: 108 });

  const blindKey = JSON.parse(await readFile(report.artifacts.blindKey, "utf8")) as Record<
    string,
    { A: "direct-svg" | "scene-engine" }
  >;
  const methodA = blindKey[benchmarkCase.taskId]?.A;
  assert.ok(methodA);
  const source64 = path.join(output, benchmarkCase.taskId, methodA, "preview-64.png");
  const actualA = await sharp(benchmarkCase.artifacts.blind64)
    .extract({ left: 0, top: 44, width: 64, height: 64 })
    .png()
    .toBuffer();
  assert.deepEqual(await rgba(actualA), await rgba(source64));
});

test("uses reference source and intent in Reference/A/B review sheets", async () => {
  const source = pilotCase("text-fox");
  const referenceCase: RunCase = { ...source, taskId: "reference-fox" };
  const { runPath, output } = await writeRun("reference-sheet-test", [referenceCase]);
  const report = await runBenchmark(runPath, output);
  const benchmarkCase = report.cases[0];
  assert.ok(benchmarkCase);
  assert.deepEqual(benchmarkCase.reference, {
    source: "../../assets/evaluation-references/fox-badge.svg",
    intent: "adapt",
  });
  assert.ok(benchmarkCase.artifacts.referencePreview);
  assert.ok(benchmarkCase.artifacts.referencePreview64);

  const [labeledMetadata, blindMetadata, nativeMetadata] = await Promise.all([
    sharp(benchmarkCase.artifacts.labeled).metadata(),
    sharp(benchmarkCase.artifacts.blind).metadata(),
    sharp(benchmarkCase.artifacts.blind64).metadata(),
  ]);
  assert.deepEqual({ width: labeledMetadata.width, height: labeledMetadata.height }, { width: 1536, height: 556 });
  assert.deepEqual({ width: blindMetadata.width, height: blindMetadata.height }, { width: 1536, height: 556 });
  assert.deepEqual({ width: nativeMetadata.width, height: nativeMetadata.height }, { width: 192, height: 108 });

  const actualReference = await sharp(benchmarkCase.artifacts.blind64)
    .extract({ left: 0, top: 44, width: 64, height: 64 })
    .png()
    .toBuffer();
  assert.deepEqual(await rgba(actualReference), await rgba(benchmarkCase.artifacts.referencePreview64));

  const scorecard = await readFile(report.artifacts.scorecard, "utf8");
  assert.match(scorecard, /reference_intent/);
  assert.match(scorecard, /"reference-fox","text-plus-reference","adapt"/);
});
