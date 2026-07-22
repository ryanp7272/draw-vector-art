#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runBenchmark } from "./benchmark.js";
import { validateScene, type ValidationIssue } from "./diagnostics.js";
import { compareScene, renderScene } from "./render.js";
import { sceneJsonSchema } from "./schema.js";

interface ParsedArgs {
  command?: string;
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value) continue;
    if (value.startsWith("--")) {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      options.set(value.slice(2), next);
      index += 1;
    } else {
      positional.push(value);
    }
  }
  return command ? { command, positional, options } : { positional, options };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function usage(): string {
  return [
    "draw-vector-art commands:",
    "  schema [--out <schema.json>]",
    "  validate <scene.json>",
    "  render <scene.json> --out <directory>",
    "  compare <scene.json> --reference <image> --out <directory>",
    "  benchmark <run.json> --out <directory>",
  ].join("\n");
}

function fatalIssue(error: unknown): ValidationIssue {
  return {
    severity: "error",
    code: "cli-error",
    message: error instanceof Error ? error.message : String(error),
    path: "/",
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (parsed.command === "schema") {
    const schema = `${JSON.stringify(sceneJsonSchema(), null, 2)}\n`;
    const output = parsed.options.get("out");
    if (output) {
      await writeFile(output, schema, "utf8");
      process.stdout.write(`${JSON.stringify({ ok: true, schema: path.resolve(output) }, null, 2)}\n`);
    } else {
      process.stdout.write(schema);
    }
    return;
  }

  if (parsed.command === "benchmark") {
    const runPath = parsed.positional[0];
    if (!runPath) throw new Error("benchmark requires a run JSON path");
    const outputDirectory = parsed.options.get("out");
    if (!outputDirectory) throw new Error("benchmark requires --out <directory>");
    const report = await runBenchmark(runPath, outputDirectory);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          run: report.run,
          evaluatedTasks: report.evaluatedTasks,
          totalTasks: report.totalTasks,
          completeEvaluation: report.completeEvaluation,
          artifacts: report.artifacts,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const scenePath = parsed.positional[0];
  if (!scenePath) throw new Error(`${parsed.command} requires a scene JSON path`);
  const input = await readJson(scenePath);
  const result = validateScene(input);

  if (parsed.command === "validate") {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    if (!result.report.valid) process.exitCode = 1;
    return;
  }

  if (!result.scene || !result.report.valid) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const outputDirectory = parsed.options.get("out");
  if (!outputDirectory) throw new Error(`${parsed.command} requires --out <directory>`);

  if (parsed.command === "render") {
    const artifacts = await renderScene(result.scene, outputDirectory, result.report);
    process.stdout.write(`${JSON.stringify({ ok: true, artifacts, validation: result.report.summary }, null, 2)}\n`);
    return;
  }

  if (parsed.command === "compare") {
    const explicitReference = parsed.options.get("reference");
    const sceneReference = result.scene.references[0]?.path;
    const reference = explicitReference ?? sceneReference;
    if (!reference) throw new Error("compare requires --reference <image> or a scene reference");
    const resolvedReference = path.isAbsolute(reference)
      ? reference
      : path.resolve(explicitReference ? process.cwd() : path.dirname(path.resolve(scenePath)), reference);
    const comparison = await compareScene(result.scene, resolvedReference, outputDirectory, result.report);
    process.stdout.write(`${JSON.stringify({ ok: true, ...comparison, validation: result.report.summary }, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command ${parsed.command}\n${usage()}`);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ valid: false, issues: [fatalIssue(error)] }, null, 2)}\n`);
  process.exitCode = 1;
});
