import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { validateScene } from "./diagnostics.js";
import { renderScene } from "./render.js";

type ReferenceIntent = "adapt" | "trace" | "inspire";
type BenchmarkMethod = "direct-svg" | "scene-engine";

interface EvaluationTask {
  id: string;
  mode: "text-only" | "text-plus-reference";
  prompt: string;
  reference?: string;
  intent?: ReferenceIntent;
  checks: string[];
}

interface EvaluationManifest {
  version: number;
  rubric: Record<string, number>;
  tasks: EvaluationTask[];
}

interface BenchmarkCase {
  taskId: string;
  directSvg: string;
  engineScene: string;
}

interface BenchmarkRun {
  version: number;
  name: string;
  description: string;
  protocol: {
    directSvg: string;
    sceneEngine: string;
  };
  cases: BenchmarkCase[];
}

interface MethodMetrics {
  primitiveElements: number;
  semanticIds: number;
  bytes: number;
}

interface CaseReport {
  taskId: string;
  mode: EvaluationTask["mode"];
  prompt: string;
  checks: string[];
  reference?: {
    source: string;
    intent: ReferenceIntent;
  };
  directSvg: MethodMetrics;
  sceneEngine: MethodMetrics & {
    objects: number;
    bezierNodes: number;
    validationErrors: number;
    validationWarnings: number;
  };
  artifacts: {
    labeled: string;
    blind: string;
    blind64: string;
    blindSvgA: string;
    blindSvgB: string;
    referencePreview?: string;
    referencePreview64?: string;
  };
}

export interface BenchmarkReport {
  version: number;
  run: string;
  description: string;
  generatedAt: string;
  completeEvaluation: boolean;
  evaluatedTasks: number;
  totalTasks: number;
  protocol: BenchmarkRun["protocol"];
  cases: CaseReport[];
  artifacts: {
    contactSheet: string;
    scorecard: string;
    blindKey: string;
  };
  caveat: string;
}

export type BlindKey = Record<string, { A: BenchmarkMethod; B: BenchmarkMethod }>;

// Compiled benchmark modules live in dist/scripts or runtime/scripts. Resolve the
// bundled evaluation assets from there so invoking the CLI from another cwd works.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const evaluationManifestPath = path.resolve(moduleDirectory, "../../tests/evaluation/tasks.json");
const forbiddenSvg = /<(?:script|foreignObject|image)\b|<!DOCTYPE\b|(?:href|src)\s*=\s*["'](?:https?:|data:|file:)|url\(\s*["']?(?:https?:|data:|file:)/i;
const primitiveElement = /<(?:path|ellipse|circle|rect|polygon|polyline|line)\b/gi;
const semanticId = /\bid\s*=\s*["'][^"']+["']/gi;

function safeSvg(svg: string, taskId: string): void {
  if (!/<svg\b/i.test(svg)) throw new Error(`${taskId}: direct baseline is missing an <svg> root`);
  if (forbiddenSvg.test(svg)) throw new Error(`${taskId}: direct baseline contains unsafe or remote SVG content`);
}

function countMatches(source: string, expression: RegExp): number {
  return source.match(expression)?.length ?? 0;
}

function rasterize(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function labelSvg(label: string, width: number, background = "#111827"): Buffer {
  const compact = width <= 96;
  const fontSize = compact ? Math.max(9, Math.min(14, Math.floor((width - 8) / Math.max(label.length * 0.58, 1)))) : 18;
  const x = compact ? 4 : 16;
  const y = compact ? 27 : 29;
  return Buffer.from(
    `<svg width="${width}" height="44"><rect width="100%" height="100%" fill="${background}"/><text x="${x}" y="${y}" fill="#fff" font-family="sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(label)}</text></svg>`,
  );
}

async function normalizedPanel(input: string | Buffer, size: number): Promise<Buffer> {
  return sharp(input)
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

async function nativePanel(input: Buffer, size: number): Promise<Buffer> {
  const metadata = await sharp(input).metadata();
  if (metadata.width !== size || metadata.height !== size) {
    throw new Error(`Expected a native ${size}x${size} benchmark preview, got ${metadata.width ?? "?"}x${metadata.height ?? "?"}`);
  }
  return sharp(input).flatten({ background: "#ffffff" }).png().toBuffer();
}

interface SheetPanel {
  input: string | Buffer;
  label: string;
  background?: string;
}

async function comparisonSheet(
  panels: SheetPanel[],
  output: string,
  size = 512,
  requireNativeSize = false,
): Promise<void> {
  const renderedPanels = await Promise.all(
    panels.map(async (panel) =>
      requireNativeSize
        ? nativePanel(Buffer.isBuffer(panel.input) ? panel.input : await readFile(panel.input), size)
        : normalizedPanel(panel.input, size),
    ),
  );
  await sharp({
    create: { width: size * panels.length, height: size + 44, channels: 4, background: "#ffffff" },
  })
    .composite([
      ...panels.map((panel, index) => ({
        input: labelSvg(panel.label, size, panel.background),
        left: index * size,
        top: 0,
      })),
      ...renderedPanels.map((input, index) => ({ input, left: index * size, top: 44 })),
    ])
    .png()
    .toFile(output);
}

function blindRank(runName: string, taskId: string): string {
  return createHash("sha256").update(`${runName}:${taskId}`).digest("hex");
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createBlindKey(runName: string, taskIds: readonly string[]): BlindKey {
  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    throw new Error("Cannot assign blind methods to duplicate task IDs");
  }

  const ranked = [...uniqueTaskIds].sort((left, right) => {
    const rankOrder = stableCompare(blindRank(runName, left), blindRank(runName, right));
    return rankOrder || stableCompare(left, right);
  });
  const engineA = new Set(ranked.slice(0, Math.floor(ranked.length / 2)));
  return Object.fromEntries(
    taskIds.map((taskId) => [
      taskId,
      engineA.has(taskId)
        ? { A: "scene-engine", B: "direct-svg" }
        : { A: "direct-svg", B: "scene-engine" },
    ]),
  ) as BlindKey;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scorecard(tasks: EvaluationTask[]): string {
  const headers = [
    "task_id",
    "mode",
    "reference_intent",
    "prompt",
    "a_prompt_match_0_2",
    "a_composition_0_2",
    "a_craft_0_2",
    "a_editability_0_2",
    "a_small_size_legibility_0_2",
    "b_prompt_match_0_2",
    "b_composition_0_2",
    "b_craft_0_2",
    "b_editability_0_2",
    "b_small_size_legibility_0_2",
    "preferred_a_or_b",
    "notes",
  ];
  return [
    headers.join(","),
    ...tasks.map((task) => [
      csvCell(task.id),
      csvCell(task.mode),
      csvCell(task.intent ?? ""),
      csvCell(task.prompt),
      ...Array.from({ length: 12 }, () => ""),
    ].join(",")),
  ].join("\n") + "\n";
}

async function contactSheet(rows: Array<{ taskId: string; labeled: string }>, output: string): Promise<void> {
  const width = 1024;
  const rowHeight = 600;
  const renderedRows = await Promise.all(
    rows.map(async ({ taskId, labeled }) => {
      const image = await sharp(await readFile(labeled)).resize({ width }).png().toBuffer();
      return sharp({
        create: { width, height: rowHeight, channels: 4, background: "#ffffff" },
      })
        .composite([
          { input: labelSvg(taskId, width, "#0F766E"), left: 0, top: 0 },
          { input: image, left: 0, top: 44 },
        ])
        .png()
        .toBuffer();
    }),
  );
  await sharp({
    create: { width, height: rowHeight * renderedRows.length, channels: 4, background: "#ffffff" },
  })
    .composite(renderedRows.map((input, index) => ({ input, left: 0, top: index * rowHeight })))
    .png()
    .toFile(output);
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function hasExactTaskSet(actualIds: readonly string[], expectedIds: readonly string[]): boolean {
  if (actualIds.length !== expectedIds.length) return false;
  const actual = new Set(actualIds);
  return actual.size === expectedIds.length && expectedIds.every((taskId) => actual.has(taskId));
}

function taskReference(task: EvaluationTask): { source: string; absolutePath: string; intent: ReferenceIntent } | undefined {
  if (task.mode !== "text-plus-reference") return undefined;
  if (!task.reference) throw new Error(`${task.id}: text-plus-reference task is missing a reference path`);
  if (!task.intent) throw new Error(`${task.id}: text-plus-reference task is missing a reference intent`);
  return {
    source: task.reference,
    absolutePath: path.resolve(path.dirname(evaluationManifestPath), task.reference),
    intent: task.intent,
  };
}

export async function runBenchmark(runManifestPath: string, outputDirectory: string): Promise<BenchmarkReport> {
  const absoluteRunPath = path.resolve(runManifestPath);
  const runDirectory = path.dirname(absoluteRunPath);
  const run = JSON.parse(await readFile(absoluteRunPath, "utf8")) as BenchmarkRun;
  const evaluation = JSON.parse(await readFile(evaluationManifestPath, "utf8")) as EvaluationManifest;
  if (run.version !== 1) throw new Error(`Unsupported benchmark run version ${run.version}`);
  if (!run.cases.length) throw new Error("Benchmark run must include at least one case");

  const expectedTaskIds = evaluation.tasks.map((task) => task.id);
  const duplicateEvaluationTask = firstDuplicate(expectedTaskIds);
  if (duplicateEvaluationTask) throw new Error(`Evaluation manifest contains duplicate task ID ${duplicateEvaluationTask}`);
  const runTaskIds = run.cases.map((benchmarkCase) => benchmarkCase.taskId);
  const duplicateRunTask = firstDuplicate(runTaskIds);
  if (duplicateRunTask) throw new Error(`Benchmark run contains duplicate task ID ${duplicateRunTask}`);

  const tasksById = new Map(evaluation.tasks.map((task) => [task.id, task]));
  for (const taskId of runTaskIds) {
    if (!tasksById.has(taskId)) throw new Error(`Unknown evaluation task ${taskId}`);
  }
  const blindAssignments = createBlindKey(run.name, runTaskIds);
  await mkdir(outputDirectory, { recursive: true });
  const reports: CaseReport[] = [];
  const blindKey: BlindKey = {};

  for (const benchmarkCase of run.cases) {
    const task = tasksById.get(benchmarkCase.taskId);
    if (!task) throw new Error(`Unknown evaluation task ${benchmarkCase.taskId}`);
    const reference = taskReference(task);
    const taskOutput = path.join(outputDirectory, task.id);
    const directOutput = path.join(taskOutput, "direct-svg");
    const engineOutput = path.join(taskOutput, "scene-engine");
    await Promise.all([mkdir(directOutput, { recursive: true }), mkdir(engineOutput, { recursive: true })]);

    const directPath = path.resolve(runDirectory, benchmarkCase.directSvg);
    const scenePath = path.resolve(runDirectory, benchmarkCase.engineScene);
    const directSvg = await readFile(directPath, "utf8");
    safeSvg(directSvg, task.id);
    const directPngs = Object.fromEntries(
      await Promise.all(
        [64, 256, 1024].map(async (size) => {
          const output = path.join(directOutput, `preview-${size}.png`);
          await writeFile(output, rasterize(directSvg, size));
          return [String(size), output] as const;
        }),
      ),
    );
    await writeFile(path.join(directOutput, "drawing.svg"), directSvg, "utf8");

    const sceneSource = await readFile(scenePath, "utf8");
    const validation = validateScene(JSON.parse(sceneSource) as unknown);
    if (!validation.scene || !validation.report.valid) {
      throw new Error(`${task.id}: engine scene failed validation: ${JSON.stringify(validation.report.issues)}`);
    }
    const engineArtifacts = await renderScene(validation.scene, engineOutput, validation.report);
    const engineSvg = await readFile(engineArtifacts.svg, "utf8");
    const [directLarge, engineLarge, directSmall, engineSmall] = await Promise.all([
      readFile(directPngs["1024"]!),
      readFile(engineArtifacts.previews["1024"]!),
      readFile(directPngs["64"]!),
      readFile(engineArtifacts.previews["64"]!),
    ]);

    let referenceLarge: Buffer | undefined;
    let referenceSmall: Buffer | undefined;
    let referencePreview: string | undefined;
    let referencePreview64: string | undefined;
    if (reference) {
      const referenceFile = await readFile(reference.absolutePath);
      [referenceLarge, referenceSmall] = await Promise.all([
        normalizedPanel(referenceFile, 1024),
        normalizedPanel(referenceFile, 64),
      ]);
      referencePreview = path.join(taskOutput, "reference.png");
      referencePreview64 = path.join(taskOutput, "reference-64.png");
      await Promise.all([
        writeFile(referencePreview, referenceLarge),
        writeFile(referencePreview64, referenceSmall),
      ]);
    }

    const labeled = path.join(taskOutput, "labeled.png");
    const blind = path.join(taskOutput, "blind.png");
    const blind64 = path.join(taskOutput, "blind-64.png");
    await comparisonSheet([
      ...(reference && referenceLarge
        ? [{ input: referenceLarge, label: `Reference (${reference.intent})`, background: "#0F766E" }]
        : []),
      { input: directLarge, label: "Direct SVG" },
      { input: engineLarge, label: "Scene engine" },
    ], labeled);

    const assignment = blindAssignments[task.id];
    if (!assignment) throw new Error(`${task.id}: blind assignment was not created`);
    blindKey[task.id] = assignment;
    const isEngineA = assignment.A === "scene-engine";
    const blindSvgA = path.join(taskOutput, "A.svg");
    const blindSvgB = path.join(taskOutput, "B.svg");
    const blindPanels: SheetPanel[] = [
      ...(reference && referenceLarge
        ? [{ input: referenceLarge, label: `Reference (${reference.intent})`, background: "#0F766E" }]
        : []),
      { input: isEngineA ? engineLarge : directLarge, label: "A" },
      { input: isEngineA ? directLarge : engineLarge, label: "B" },
    ];
    const blind64Panels: SheetPanel[] = [
      ...(reference && referenceSmall
        ? [{ input: referenceSmall, label: `Ref: ${reference.intent}`, background: "#0F766E" }]
        : []),
      { input: isEngineA ? engineSmall : directSmall, label: "A" },
      { input: isEngineA ? directSmall : engineSmall, label: "B" },
    ];
    await Promise.all([
      comparisonSheet(blindPanels, blind),
      comparisonSheet(blind64Panels, blind64, 64, true),
    ]);
    await Promise.all([
      writeFile(blindSvgA, isEngineA ? engineSvg : directSvg, "utf8"),
      writeFile(blindSvgB, isEngineA ? directSvg : engineSvg, "utf8"),
    ]);

    reports.push({
      taskId: task.id,
      mode: task.mode,
      prompt: task.prompt,
      checks: task.checks,
      ...(reference ? { reference: { source: reference.source, intent: reference.intent } } : {}),
      directSvg: {
        primitiveElements: countMatches(directSvg, primitiveElement),
        semanticIds: countMatches(directSvg, semanticId),
        bytes: Buffer.byteLength(directSvg),
      },
      sceneEngine: {
        primitiveElements: countMatches(engineSvg, primitiveElement),
        semanticIds: countMatches(engineSvg, semanticId),
        bytes: Buffer.byteLength(engineSvg),
        objects: validation.report.summary.objects,
        bezierNodes: validation.report.summary.bezierNodes,
        validationErrors: validation.report.summary.errors,
        validationWarnings: validation.report.summary.warnings,
      },
      artifacts: {
        labeled,
        blind,
        blind64,
        blindSvgA,
        blindSvgB,
        ...(referencePreview && referencePreview64 ? { referencePreview, referencePreview64 } : {}),
      },
    });
  }

  const contactSheetPath = path.join(outputDirectory, "contact-sheet.png");
  const scorecardPath = path.join(outputDirectory, "scorecard.csv");
  const blindKeyPath = path.join(outputDirectory, "blind-key.json");
  await Promise.all([
    contactSheet(reports.map((entry) => ({ taskId: entry.taskId, labeled: entry.artifacts.labeled })), contactSheetPath),
    writeFile(scorecardPath, scorecard(run.cases.map((entry) => tasksById.get(entry.taskId)!)), "utf8"),
    writeFile(blindKeyPath, `${JSON.stringify(blindKey, null, 2)}\n`, "utf8"),
  ]);

  const report: BenchmarkReport = {
    version: 1,
    run: run.name,
    description: run.description,
    generatedAt: new Date().toISOString(),
    completeEvaluation: hasExactTaskSet(runTaskIds, expectedTaskIds),
    evaluatedTasks: run.cases.length,
    totalTasks: evaluation.tasks.length,
    protocol: run.protocol,
    cases: reports,
    artifacts: { contactSheet: contactSheetPath, scorecard: scorecardPath, blindKey: blindKeyPath },
    caveat: "This runner creates evidence and blinded scoring materials; it does not assign subjective visual scores automatically.",
  };
  const portableReport: BenchmarkReport = {
    ...report,
    cases: report.cases.map((entry) => ({
      ...entry,
      artifacts: {
        labeled: path.relative(outputDirectory, entry.artifacts.labeled),
        blind: path.relative(outputDirectory, entry.artifacts.blind),
        blind64: path.relative(outputDirectory, entry.artifacts.blind64),
        blindSvgA: path.relative(outputDirectory, entry.artifacts.blindSvgA),
        blindSvgB: path.relative(outputDirectory, entry.artifacts.blindSvgB),
        ...(entry.artifacts.referencePreview && entry.artifacts.referencePreview64
          ? {
              referencePreview: path.relative(outputDirectory, entry.artifacts.referencePreview),
              referencePreview64: path.relative(outputDirectory, entry.artifacts.referencePreview64),
            }
          : {}),
      },
    })),
    artifacts: {
      contactSheet: path.relative(outputDirectory, report.artifacts.contactSheet),
      scorecard: path.relative(outputDirectory, report.artifacts.scorecard),
      blindKey: path.relative(outputDirectory, report.artifacts.blindKey),
    },
  };
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(portableReport, null, 2)}\n`, "utf8");
  return report;
}
