#!/usr/bin/env node
import process from "node:process";
import { runBenchmark } from "./benchmark.js";

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const output = readOption(args, "--out");
  const run = args[0];
  if (!run || run.startsWith("--") || !output) {
    process.stdout.write("Usage: npm run benchmark -- <run.json> --out <directory>\n");
    process.exitCode = 1;
    return;
  }
  const report = await runBenchmark(run, output);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
