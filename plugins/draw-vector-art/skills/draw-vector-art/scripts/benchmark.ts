import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { validateScene } from "./diagnostics.js";
import { renderScene } from "./render.js";

interface EvaluationTask {
  id: string;
  mode: "text-only" | "text-plus-reference";
  prompt: string;
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
  prompt: string;
  checks: string[];
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
    blindSvgA: string;
    blindSvgB: string;
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

const evaluationManifestPath = path.resolve("tests/evaluation/tasks.json");
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
  return Buffer.from(
    `<svg width="${width}" height="44"><rect width="100%" height="100%" fill="${background}"/><text x="16" y="29" fill="#fff" font-family="sans-serif" font-size="18" font-weight="700">${escapeXml(label)}</text></svg>`,
  );
}

async function normalizedPanel(input: string | Buffer, size: number): Promise<Buffer> {
  return sharp(input)
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

async function pairSheet(
  left: Buffer,
  right: Buffer,
  leftLabel: string,
  rightLabel: string,
  output: string,
  size = 512,
): Promise<void> {
  const [leftPanel, rightPanel] = await Promise.all([
    normalizedPanel(left, size),
    normalizedPanel(right, size),
  ]);
  await sharp({
    create: { width: size * 2, height: size + 44, channels: 4, background: "#ffffff" },
  })
    .composite([
      { input: labelSvg(leftLabel, size), left: 0, top: 0 },
      { input: labelSvg(rightLabel, size), left: size, top: 0 },
      { input: leftPanel, left: 0, top: 44 },
      { input: rightPanel, left: size, top: 44 },
    ])
    .png()
    .toFile(output);
}

function engineIsA(runName: string, taskId: string): boolean {
  return createHash("sha256").update(`${runName}:${taskId}`).digest()[0]! % 2 === 0;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scorecard(tasks: EvaluationTask[]): string {
  const headers = [
    "task_id",
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
    ...tasks.map((task) => [csvCell(task.id), csvCell(task.prompt), ...Array.from({ length: 12 }, () => "")].join(",")),
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

export async function runBenchmark(runManifestPath: string, outputDirectory: string): Promise<BenchmarkReport> {
  const absoluteRunPath = path.resolve(runManifestPath);
  const runDirectory = path.dirname(absoluteRunPath);
  const run = JSON.parse(await readFile(absoluteRunPath, "utf8")) as BenchmarkRun;
  const evaluation = JSON.parse(await readFile(evaluationManifestPath, "utf8")) as EvaluationManifest;
  if (run.version !== 1) throw new Error(`Unsupported benchmark run version ${run.version}`);
  if (!run.cases.length) throw new Error("Benchmark run must include at least one case");

  await mkdir(outputDirectory, { recursive: true });
  const tasksById = new Map(evaluation.tasks.map((task) => [task.id, task]));
  const reports: CaseReport[] = [];
  const blindKey: Record<string, { A: "direct-svg" | "scene-engine"; B: "direct-svg" | "scene-engine" }> = {};

  for (const benchmarkCase of run.cases) {
    const task = tasksById.get(benchmarkCase.taskId);
    if (!task) throw new Error(`Unknown evaluation task ${benchmarkCase.taskId}`);
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
    const directLarge = await readFile(directPngs["1024"]!);
    const engineLarge = await readFile(engineArtifacts.previews["1024"]!);
    const labeled = path.join(taskOutput, "labeled.png");
    const blind = path.join(taskOutput, "blind.png");
    await pairSheet(directLarge, engineLarge, "Direct SVG", "Scene engine", labeled);

    const isEngineA = engineIsA(run.name, task.id);
    blindKey[task.id] = isEngineA
      ? { A: "scene-engine", B: "direct-svg" }
      : { A: "direct-svg", B: "scene-engine" };
    const blindSvgA = path.join(taskOutput, "A.svg");
    const blindSvgB = path.join(taskOutput, "B.svg");
    await pairSheet(
      isEngineA ? engineLarge : directLarge,
      isEngineA ? directLarge : engineLarge,
      "A",
      "B",
      blind,
    );
    await Promise.all([
      writeFile(blindSvgA, isEngineA ? engineSvg : directSvg, "utf8"),
      writeFile(blindSvgB, isEngineA ? directSvg : engineSvg, "utf8"),
    ]);

    reports.push({
      taskId: task.id,
      prompt: task.prompt,
      checks: task.checks,
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
      artifacts: { labeled, blind, blindSvgA, blindSvgB },
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
    completeEvaluation: run.cases.length === evaluation.tasks.length,
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
        blindSvgA: path.relative(outputDirectory, entry.artifacts.blindSvgA),
        blindSvgB: path.relative(outputDirectory, entry.artifacts.blindSvgB),
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
