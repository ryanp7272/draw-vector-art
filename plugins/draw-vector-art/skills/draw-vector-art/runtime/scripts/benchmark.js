import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { validateScene } from "./diagnostics.js";
import { renderScene } from "./render.js";
// Compiled benchmark modules live in dist/scripts or runtime/scripts. Resolve the
// bundled evaluation assets from there so invoking the CLI from another cwd works.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const evaluationManifestPath = path.resolve(moduleDirectory, "../../tests/evaluation/tasks.json");
const forbiddenSvg = /<(?:script|foreignObject|image)\b|<!DOCTYPE\b|(?:href|src)\s*=\s*["'](?:https?:|data:|file:)|url\(\s*["']?(?:https?:|data:|file:)/i;
const primitiveElement = /<(?:path|ellipse|circle|rect|polygon|polyline|line)\b/gi;
const semanticId = /\bid\s*=\s*["'][^"']+["']/gi;
function safeSvg(svg, taskId) {
    if (!/<svg\b/i.test(svg))
        throw new Error(`${taskId}: direct baseline is missing an <svg> root`);
    if (forbiddenSvg.test(svg))
        throw new Error(`${taskId}: direct baseline contains unsafe or remote SVG content`);
}
function countMatches(source, expression) {
    return source.match(expression)?.length ?? 0;
}
function rasterize(svg, width) {
    return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}
function escapeXml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function labelSvg(label, width, background = "#111827") {
    const compact = width <= 96;
    const fontSize = compact ? Math.max(9, Math.min(14, Math.floor((width - 8) / Math.max(label.length * 0.58, 1)))) : 18;
    const x = compact ? 4 : 16;
    const y = compact ? 27 : 29;
    return Buffer.from(`<svg width="${width}" height="44"><rect width="100%" height="100%" fill="${background}"/><text x="${x}" y="${y}" fill="#fff" font-family="sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(label)}</text></svg>`);
}
async function normalizedPanel(input, size) {
    return sharp(input)
        .resize(size, size, { fit: "contain", background: "#ffffff" })
        .flatten({ background: "#ffffff" })
        .png()
        .toBuffer();
}
async function nativePanel(input, size) {
    const metadata = await sharp(input).metadata();
    if (metadata.width !== size || metadata.height !== size) {
        throw new Error(`Expected a native ${size}x${size} benchmark preview, got ${metadata.width ?? "?"}x${metadata.height ?? "?"}`);
    }
    return sharp(input).flatten({ background: "#ffffff" }).png().toBuffer();
}
async function comparisonSheet(panels, output, size = 512, requireNativeSize = false) {
    const renderedPanels = await Promise.all(panels.map(async (panel) => requireNativeSize
        ? nativePanel(Buffer.isBuffer(panel.input) ? panel.input : await readFile(panel.input), size)
        : normalizedPanel(panel.input, size)));
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
function blindRank(runName, taskId) {
    return createHash("sha256").update(`${runName}:${taskId}`).digest("hex");
}
function stableCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function createBlindKey(runName, taskIds) {
    const uniqueTaskIds = new Set(taskIds);
    if (uniqueTaskIds.size !== taskIds.length) {
        throw new Error("Cannot assign blind methods to duplicate task IDs");
    }
    const ranked = [...uniqueTaskIds].sort((left, right) => {
        const rankOrder = stableCompare(blindRank(runName, left), blindRank(runName, right));
        return rankOrder || stableCompare(left, right);
    });
    const engineA = new Set(ranked.slice(0, Math.floor(ranked.length / 2)));
    return Object.fromEntries(taskIds.map((taskId) => [
        taskId,
        engineA.has(taskId)
            ? { A: "scene-engine", B: "direct-svg" }
            : { A: "direct-svg", B: "scene-engine" },
    ]));
}
function csvCell(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function scorecard(tasks) {
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
async function contactSheet(rows, output) {
    const width = 1024;
    const rowHeight = 600;
    const renderedRows = await Promise.all(rows.map(async ({ taskId, labeled }) => {
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
    }));
    await sharp({
        create: { width, height: rowHeight * renderedRows.length, channels: 4, background: "#ffffff" },
    })
        .composite(renderedRows.map((input, index) => ({ input, left: 0, top: index * rowHeight })))
        .png()
        .toFile(output);
}
function firstDuplicate(values) {
    const seen = new Set();
    return values.find((value) => {
        if (seen.has(value))
            return true;
        seen.add(value);
        return false;
    });
}
function hasExactTaskSet(actualIds, expectedIds) {
    if (actualIds.length !== expectedIds.length)
        return false;
    const actual = new Set(actualIds);
    return actual.size === expectedIds.length && expectedIds.every((taskId) => actual.has(taskId));
}
function taskReference(task) {
    if (task.mode !== "text-plus-reference")
        return undefined;
    if (!task.reference)
        throw new Error(`${task.id}: text-plus-reference task is missing a reference path`);
    if (!task.intent)
        throw new Error(`${task.id}: text-plus-reference task is missing a reference intent`);
    return {
        source: task.reference,
        absolutePath: path.resolve(path.dirname(evaluationManifestPath), task.reference),
        intent: task.intent,
    };
}
export async function runBenchmark(runManifestPath, outputDirectory) {
    const absoluteRunPath = path.resolve(runManifestPath);
    const runDirectory = path.dirname(absoluteRunPath);
    const run = JSON.parse(await readFile(absoluteRunPath, "utf8"));
    const evaluation = JSON.parse(await readFile(evaluationManifestPath, "utf8"));
    if (run.version !== 1)
        throw new Error(`Unsupported benchmark run version ${run.version}`);
    if (!run.cases.length)
        throw new Error("Benchmark run must include at least one case");
    const expectedTaskIds = evaluation.tasks.map((task) => task.id);
    const duplicateEvaluationTask = firstDuplicate(expectedTaskIds);
    if (duplicateEvaluationTask)
        throw new Error(`Evaluation manifest contains duplicate task ID ${duplicateEvaluationTask}`);
    const runTaskIds = run.cases.map((benchmarkCase) => benchmarkCase.taskId);
    const duplicateRunTask = firstDuplicate(runTaskIds);
    if (duplicateRunTask)
        throw new Error(`Benchmark run contains duplicate task ID ${duplicateRunTask}`);
    const tasksById = new Map(evaluation.tasks.map((task) => [task.id, task]));
    for (const taskId of runTaskIds) {
        if (!tasksById.has(taskId))
            throw new Error(`Unknown evaluation task ${taskId}`);
    }
    const blindAssignments = createBlindKey(run.name, runTaskIds);
    await mkdir(outputDirectory, { recursive: true });
    const reports = [];
    const blindKey = {};
    for (const benchmarkCase of run.cases) {
        const task = tasksById.get(benchmarkCase.taskId);
        if (!task)
            throw new Error(`Unknown evaluation task ${benchmarkCase.taskId}`);
        const reference = taskReference(task);
        const taskOutput = path.join(outputDirectory, task.id);
        const directOutput = path.join(taskOutput, "direct-svg");
        const engineOutput = path.join(taskOutput, "scene-engine");
        await Promise.all([mkdir(directOutput, { recursive: true }), mkdir(engineOutput, { recursive: true })]);
        const directPath = path.resolve(runDirectory, benchmarkCase.directSvg);
        const scenePath = path.resolve(runDirectory, benchmarkCase.engineScene);
        const directSvg = await readFile(directPath, "utf8");
        safeSvg(directSvg, task.id);
        const directPngs = Object.fromEntries(await Promise.all([64, 256, 1024].map(async (size) => {
            const output = path.join(directOutput, `preview-${size}.png`);
            await writeFile(output, rasterize(directSvg, size));
            return [String(size), output];
        })));
        await writeFile(path.join(directOutput, "drawing.svg"), directSvg, "utf8");
        const sceneSource = await readFile(scenePath, "utf8");
        const validation = validateScene(JSON.parse(sceneSource));
        if (!validation.scene || !validation.report.valid) {
            throw new Error(`${task.id}: engine scene failed validation: ${JSON.stringify(validation.report.issues)}`);
        }
        const engineArtifacts = await renderScene(validation.scene, engineOutput, validation.report);
        const engineSvg = await readFile(engineArtifacts.svg, "utf8");
        const [directLarge, engineLarge, directSmall, engineSmall] = await Promise.all([
            readFile(directPngs["1024"]),
            readFile(engineArtifacts.previews["1024"]),
            readFile(directPngs["64"]),
            readFile(engineArtifacts.previews["64"]),
        ]);
        let referenceLarge;
        let referenceSmall;
        let referencePreview;
        let referencePreview64;
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
        if (!assignment)
            throw new Error(`${task.id}: blind assignment was not created`);
        blindKey[task.id] = assignment;
        const isEngineA = assignment.A === "scene-engine";
        const blindSvgA = path.join(taskOutput, "A.svg");
        const blindSvgB = path.join(taskOutput, "B.svg");
        const blindPanels = [
            ...(reference && referenceLarge
                ? [{ input: referenceLarge, label: `Reference (${reference.intent})`, background: "#0F766E" }]
                : []),
            { input: isEngineA ? engineLarge : directLarge, label: "A" },
            { input: isEngineA ? directLarge : engineLarge, label: "B" },
        ];
        const blind64Panels = [
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
        writeFile(scorecardPath, scorecard(run.cases.map((entry) => tasksById.get(entry.taskId))), "utf8"),
        writeFile(blindKeyPath, `${JSON.stringify(blindKey, null, 2)}\n`, "utf8"),
    ]);
    const report = {
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
    const portableReport = {
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
