#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(scriptDirectory, "..");
const packagePath = path.join(skillDirectory, "package.json");
const lockPath = path.join(skillDirectory, "package-lock.json");
const bundledRuntime = path.join(skillDirectory, "runtime");
const runtimeEntry = path.join("runtime", "scripts", "cli.js");
const readyMarker = ".draw-vector-art-ready";
const markerProtocol = 2;
const minimumNode = [20, 3, 0];
const requiredPackages = ["@resvg/resvg-js", "sharp", "zod"];

function usage() {
  return [
    "draw-vector-art launcher commands:",
    "  doctor",
    "  prepare",
    "  schema [--out <schema.json>]",
    "  validate <scene.json>",
    "  render <scene.json> --out <directory>",
    "  compare <scene.json> --reference <image> --out <directory>",
    "  benchmark <run.json> --out <directory>",
    "",
    "The first engine command installs production dependencies into a writable cache.",
    "Set DRAW_VECTOR_ART_CACHE_DIR to override the cache parent directory.",
  ].join("\n");
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

function nodeSupported() {
  const current = process.versions.node.split(".").map((value) => Number.parseInt(value, 10));
  return minimumNode.every((minimum, index) => {
    const value = current[index] ?? 0;
    const priorEqual = minimumNode.slice(0, index).every((prior, priorIndex) => (current[priorIndex] ?? 0) === prior);
    return !priorEqual || value >= minimum;
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadConfiguration() {
  const [packageSource, lockSource] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const packageLock = JSON.parse(lockSource);
  if (packageJson.name !== packageLock.name || packageJson.version !== packageLock.version) {
    throw new Error("package.json and package-lock.json do not describe the same draw-vector-art release");
  }
  const lockHash = createHash("sha256").update(lockSource).digest("hex").slice(0, 16);
  const configuredCache = process.env.DRAW_VECTOR_ART_CACHE_DIR?.trim();
  const cacheParent = path.resolve(
    configuredCache || path.join(os.tmpdir(), `draw-vector-art-runtime-${process.getuid?.() ?? "user"}`),
  );
  const report = process.report?.getReport?.();
  const reportHeader = report && typeof report === "object" && "header" in report ? report.header : undefined;
  const glibc = reportHeader && typeof reportHeader === "object" && "glibcVersionRuntime" in reportHeader
    ? reportHeader.glibcVersionRuntime
    : undefined;
  const libc = process.platform === "linux" ? (glibc ? `glibc-${glibc}` : "musl-or-unknown") : "native";
  const nativeKey = [process.platform, process.arch, `abi${process.versions.modules}`, libc]
    .join("-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const versionKey = String(packageJson.version).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const cacheDirectory = path.join(cacheParent, `${versionKey}-${lockHash}-${nativeKey}`);
  const marker = {
    protocol: markerProtocol,
    version: packageJson.version,
    lockHash,
    platform: process.platform,
    architecture: process.arch,
    abi: process.versions.modules,
    libc,
  };
  return { packageJson, lockHash, cacheParent, cacheDirectory, configuredCache: Boolean(configuredCache), marker };
}

async function isSymlink(filePath) {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function dependenciesReady(rootDirectory, configuration) {
  if (await isSymlink(rootDirectory)) return false;
  const checks = [
    path.join(rootDirectory, runtimeEntry),
    ...requiredPackages.map((name) => path.join(rootDirectory, "node_modules", ...name.split("/"), "package.json")),
  ];
  if (!(await Promise.all(checks.map(pathExists))).every(Boolean)) return false;
  if (!configuration) return true;
  try {
    const marker = JSON.parse(await readFile(path.join(rootDirectory, readyMarker), "utf8"));
    return Object.entries(configuration.marker).every(([key, value]) => marker[key] === value);
  } catch {
    return false;
  }
}

async function secureCacheParent(configuration) {
  const { cacheParent, configuredCache } = configuration;
  await mkdir(cacheParent, { recursive: true, mode: 0o700 });
  const info = await lstat(cacheParent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Cache parent must be a real directory: ${cacheParent}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (info.uid !== process.getuid()) throw new Error(`Cache parent is not owned by the current user: ${cacheParent}`);
    if ((info.mode & 0o022) !== 0) {
      if (configuredCache) throw new Error(`Cache parent must not be group/world writable: ${cacheParent}`);
      await chmod(cacheParent, 0o700);
    }
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} stopped by signal ${signal}`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function installRuntime(configuration) {
  const { cacheDirectory, cacheParent, lockHash, packageJson } = configuration;
  if (await dependenciesReady(cacheDirectory, configuration)) return cacheDirectory;

  await secureCacheParent(configuration);
  if (await isSymlink(cacheDirectory)) throw new Error(`Refusing symlinked runtime cache: ${cacheDirectory}`);
  if (await pathExists(cacheDirectory)) await rm(cacheDirectory, { recursive: true, force: true });
  const prefix = path.join(cacheParent, `${packageJson.version}-${lockHash}.tmp-${process.pid}-${randomBytes(3).toString("hex")}-`);
  const stagingDirectory = await mkdtemp(prefix);

  try {
    await Promise.all([
      mkdir(path.join(stagingDirectory, "tests"), { recursive: true }),
      mkdir(path.join(stagingDirectory, "assets"), { recursive: true }),
    ]);
    await Promise.all([
      cp(bundledRuntime, path.join(stagingDirectory, "runtime"), { recursive: true }),
      cp(
        path.join(skillDirectory, "tests", "evaluation"),
        path.join(stagingDirectory, "tests", "evaluation"),
        { recursive: true },
      ),
      cp(
        path.join(skillDirectory, "assets", "evaluation-references"),
        path.join(stagingDirectory, "assets", "evaluation-references"),
        { recursive: true },
      ),
      copyFile(packagePath, path.join(stagingDirectory, "package.json")),
      copyFile(lockPath, path.join(stagingDirectory, "package-lock.json")),
    ]);

    process.stderr.write(`Preparing draw-vector-art ${packageJson.version} runtime in ${cacheParent}\n`);
    const npm = npmInvocation(["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]);
    const exitCode = await run(
      npm.command,
      npm.args,
      { cwd: stagingDirectory, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (exitCode !== 0) throw new Error(`npm ci exited with status ${exitCode}`);
    if (!(await dependenciesReady(stagingDirectory))) throw new Error("npm ci completed without all required runtime packages");
    const loadCheck = await run(
      process.execPath,
      [path.join(stagingDirectory, runtimeEntry), "help"],
      { cwd: stagingDirectory, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (loadCheck !== 0) throw new Error(`runtime dependency load check exited with status ${loadCheck}`);
    await writeFile(path.join(stagingDirectory, readyMarker), `${JSON.stringify(configuration.marker)}\n`, "utf8");

    if (await pathExists(cacheDirectory)) {
      if (await dependenciesReady(cacheDirectory, configuration)) {
        await rm(stagingDirectory, { recursive: true, force: true });
        return cacheDirectory;
      }
      throw new Error(`A competing process created an invalid runtime cache: ${cacheDirectory}`);
    }

    try {
      await rename(stagingDirectory, cacheDirectory);
    } catch (error) {
      if (await dependenciesReady(cacheDirectory, configuration)) {
        await rm(stagingDirectory, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
    return cacheDirectory;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not prepare the draw-vector-art runtime: ${message}. ` +
        "Check npm/network access, then retry `node scripts/run-engine.mjs prepare`.",
    );
  }
}

function npmStatus() {
  const npm = npmInvocation(["--version"]);
  const result = spawnSync(npm.command, npm.args, { encoding: "utf8" });
  return {
    available: result.status === 0,
    version: result.status === 0 ? result.stdout.trim() : null,
  };
}

async function doctor(configuration) {
  const [bundled, localReady, cachedReady] = await Promise.all([
    pathExists(path.join(skillDirectory, runtimeEntry)),
    dependenciesReady(skillDirectory),
    dependenciesReady(configuration.cacheDirectory, configuration),
  ]);
  const npm = npmStatus();
  const supported = nodeSupported();
  const canRun = supported && bundled && (localReady || cachedReady || npm.available);
  const next = localReady || cachedReady
    ? "Runtime is ready. Run an engine command."
    : npm.available
      ? "Run `node scripts/run-engine.mjs prepare` or let the first engine command prepare the cache."
      : "Install npm, or provide local production dependencies, before running the engine.";
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: canRun,
        skill: "draw-vector-art",
        version: configuration.packageJson.version,
        node: { version: process.versions.node, minimum: minimumNode.join("."), supported },
        npm,
        platform: process.platform,
        architecture: process.arch,
        runtime: { bundled, localDependencies: localReady, cachedDependencies: cachedReady },
        cache: {
          directory: configuration.cacheDirectory,
          overridden: Boolean(process.env.DRAW_VECTOR_ART_CACHE_DIR?.trim()),
        },
        next,
      },
      null,
      2,
    )}\n`,
  );
  if (!canRun) process.exitCode = 1;
}

async function runtimeRoot(configuration) {
  if (!process.env.DRAW_VECTOR_ART_FORCE_CACHE && (await dependenciesReady(skillDirectory))) return skillDirectory;
  return installRuntime(configuration);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!nodeSupported()) {
    throw new Error(`draw-vector-art requires Node.js ${minimumNode.join(".")} or newer; found ${process.versions.node}`);
  }
  if (!(await pathExists(path.join(bundledRuntime, "scripts", "cli.js")))) {
    throw new Error("The bundled runtime is missing. Reinstall draw-vector-art from a complete release.");
  }

  const configuration = await loadConfiguration();
  if (args[0] === "doctor") {
    await doctor(configuration);
    return;
  }
  if (args[0] === "prepare") {
    const root = await installRuntime(configuration);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          version: configuration.packageJson.version,
          runtime: "cache",
          directory: root,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const root = await runtimeRoot(configuration);
  const entry = path.join(root, runtimeEntry);
  const exitCode = await run(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        error: { code: "runtime-bootstrap-error", message },
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
