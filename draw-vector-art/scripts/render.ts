import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { compileSvg } from "./compiler.js";
import { validateScene, type ValidationReport } from "./diagnostics.js";
import type { Scene } from "./schema.js";

export interface RenderArtifacts {
  directory: string;
  svg: string;
  previews: Record<string, string>;
  debugSvg: string;
  debugPng: string;
  report: string;
}

function rasterize(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function renderScene(scene: Scene, outputDirectory: string, report?: ValidationReport): Promise<RenderArtifacts> {
  const validated = report ? { scene, report } : validateScene(scene);
  if (!validated.report.valid) {
    throw new Error(`Scene has ${validated.report.summary.errors} validation error(s); render aborted`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const svg = compileSvg(scene);
  const debugSvg = compileSvg(scene, { debug: true });
  const svgPath = path.join(outputDirectory, "drawing.svg");
  const debugSvgPath = path.join(outputDirectory, "debug.svg");
  const debugPngPath = path.join(outputDirectory, "debug.png");
  const reportPath = path.join(outputDirectory, "report.json");
  const previewPaths: Record<string, string> = {};

  await Promise.all([
    writeFile(svgPath, `${svg}\n`, "utf8"),
    writeFile(debugSvgPath, `${debugSvg}\n`, "utf8"),
    writeFile(debugPngPath, rasterize(debugSvg, 1024)),
    writeJson(reportPath, validated.report),
    ...[64, 256, 1024].map(async (size) => {
      const previewPath = path.join(outputDirectory, `preview-${size}.png`);
      previewPaths[String(size)] = previewPath;
      await writeFile(previewPath, rasterize(svg, size));
    }),
  ]);

  return {
    directory: outputDirectory,
    svg: svgPath,
    previews: previewPaths,
    debugSvg: debugSvgPath,
    debugPng: debugPngPath,
    report: reportPath,
  };
}

function labelSvg(label: string, width: number): Buffer {
  const safe = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return Buffer.from(`<svg width="${width}" height="52"><rect width="100%" height="100%" fill="#111827"/><text x="20" y="35" fill="#fff" font-family="sans-serif" font-size="24" font-weight="600">${safe}</text></svg>`);
}

async function normalizedPanel(input: string | Buffer, size: number): Promise<Buffer> {
  return sharp(input)
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

export async function compareScene(
  scene: Scene,
  referencePath: string,
  outputDirectory: string,
  report?: ValidationReport,
): Promise<{ compare: string; artifacts: RenderArtifacts }> {
  const artifacts = await renderScene(scene, outputDirectory, report);
  const size = 1024;
  const [referenceFile, currentFile] = await Promise.all([
    readFile(referencePath),
    readFile(artifacts.previews[String(size)] ?? path.join(outputDirectory, "preview-1024.png")),
  ]);
  const [reference, current] = await Promise.all([
    normalizedPanel(referenceFile, size),
    normalizedPanel(currentFile, size),
  ]);
  const difference = await sharp(reference)
    .composite([{ input: current, blend: "difference" }])
    .png()
    .toBuffer();
  const labels = ["Reference", "Current vector", "Difference overlay"];
  const canvas = sharp({
    create: {
      width: size * 3,
      height: size + 52,
      channels: 4,
      background: "#ffffff",
    },
  });
  const comparePath = path.join(outputDirectory, "compare.png");
  await canvas
    .composite([
      { input: reference, left: 0, top: 52 },
      { input: current, left: size, top: 52 },
      { input: difference, left: size * 2, top: 52 },
      ...labels.map((label, index) => ({ input: labelSvg(label, size), left: index * size, top: 0 })),
    ])
    .png()
    .toFile(comparePath);
  return { compare: comparePath, artifacts };
}
