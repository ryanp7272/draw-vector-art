import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { compileSvg, escapeXml } from "../scripts/compiler.js";
import { validateScene } from "../scripts/diagnostics.js";
import { compareScene, renderScene } from "../scripts/render.js";
import { resolveScene } from "../scripts/resolver.js";

const projectRoot = process.cwd();

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(projectRoot, "tests", "fixtures", name), "utf8")) as unknown;
}

async function validFixture(name: string) {
  const result = validateScene(await fixture(name));
  assert.equal(result.report.valid, true, JSON.stringify(result.report.issues, null, 2));
  assert.ok(result.scene);
  return result.scene;
}

function simpleScene(layers: unknown[]): unknown {
  return {
    version: 1,
    brief: { prompt: "Diagnostic fixture", style: "flat-geometric", referenceIntent: "adapt" },
    canvas: { width: 256, height: 256, background: "@background" },
    palette: { background: "#FFFFFF", ink: "#111827" },
    references: [],
    layers,
  };
}

const paint = { fill: "@ink", stroke: "none", strokeWidth: 0 };

test("validates a semantic fixture without warnings", async () => {
  const result = validateScene(await fixture("rocket.scene.json"));
  assert.deepEqual(result.report.summary, { errors: 0, warnings: 0, objects: 15, bezierNodes: 9 });
});

test("resolves relative anchors, mirrored frames, and group layouts", async () => {
  const scene = await validFixture("rocket.scene.json");
  const resolved = resolveScene(scene);
  assert.deepEqual(resolved.byId.get("porthole")?.frame, { x: 107, y: 57, width: 42, height: 42 });
  assert.deepEqual(resolved.byId.get("right-fin")?.frame, { x: 144, y: 126, width: 60, height: 76 });
  const firstStar = resolved.byId.get("star-one")?.frame;
  assert.ok(firstStar);
  assert.ok(firstStar.x > 25 && firstStar.x < 40);
  assert.ok(firstStar.y > 30 && firstStar.y < 40);
});

test("compiles semantic IDs, clipping, and true clone reflection", async () => {
  const scene = await validFixture("rocket.scene.json");
  const svg = compileSvg(scene);
  assert.match(svg, /id="rocket-body"/);
  assert.match(svg, /id="body-highlight" clip-path="url\(#clip-body-highlight\)"/);
  assert.match(svg, /id="right-fin" transform="translate\(348 0\) scale\(-1 1\)"/);
  assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)="https?:|data:/i);
});

test("escapes prompt text and rejects unmodeled raw SVG", async () => {
  const source = (await fixture("rocket.scene.json")) as Record<string, unknown>;
  const safeInput = structuredClone(source) as Record<string, unknown>;
  (safeInput.brief as Record<string, unknown>).prompt = 'Rocket <fast> & "safe"';
  const safe = validateScene(safeInput);
  assert.ok(safe.scene);
  assert.match(compileSvg(safe.scene), /Rocket &lt;fast&gt; &amp; &quot;safe&quot;/);
  assert.equal(escapeXml("<'&\">"), "&lt;&apos;&amp;&quot;&gt;");

  const unsafe = structuredClone(source) as { layers: Array<Record<string, unknown>> };
  const firstLayer = unsafe.layers[0];
  assert.ok(firstLayer);
  firstLayer.rawSvg = "<script>alert(1)</script>";
  const rejected = validateScene(unsafe);
  assert.equal(rejected.report.valid, false);
  assert.ok(rejected.report.issues.some((entry) => entry.code === "schema-unrecognized_keys"));
});

test("reports placement cycles and missing palette entries", async () => {
  const cycle = validateScene(await fixture("cycle.scene.json"));
  assert.equal(cycle.report.valid, false);
  assert.ok(cycle.report.issues.some((entry) => entry.code === "placement-resolution"));

  const source = (await fixture("rocket.scene.json")) as { layers: Array<Record<string, unknown>> };
  const changed = structuredClone(source);
  const pad = changed.layers.find((layer) => layer.id === "launch-pad");
  assert.ok(pad);
  (pad.paint as Record<string, unknown>).fill = "@missing";
  const missing = validateScene(changed);
  assert.ok(missing.report.issues.some((entry) => entry.code === "missing-palette-color"));
});

test("rejects clone cycles, invalid hex lengths, and points outside the local grid", () => {
  const cloneCycle = validateScene(
    simpleScene([
      {
        id: "first-clone",
        type: "clone",
        source: "second-clone",
        frame: { type: "absolute", x: 20, y: 20, width: 30, height: 30 },
      },
      {
        id: "second-clone",
        type: "clone",
        source: "first-clone",
        frame: { type: "absolute", x: 60, y: 20, width: 30, height: 30 },
      },
    ]),
  );
  assert.ok(cloneCycle.report.issues.some((entry) => entry.code === "clone-cycle"));

  const invalidGeometry = simpleScene([
    {
      id: "bad-polygon",
      type: "polygon",
      frame: { type: "absolute", x: 20, y: 20, width: 80, height: 80 },
      points: [{ x: 0, y: 0 }, { x: 101, y: 50 }, { x: 0, y: 100 }],
      paint,
    },
  ]) as { palette: Record<string, string> };
  invalidGeometry.palette.ink = "#12345";
  const rejected = validateScene(invalidGeometry);
  assert.equal(rejected.report.valid, false);
  assert.ok(rejected.report.issues.some((entry) => entry.code === "schema-too_big"));
  assert.ok(rejected.report.issues.some((entry) => entry.code === "schema-invalid_format"));
});

test("detects self-intersection, off-canvas geometry, occlusion, and literal paint", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "crossed",
        type: "polygon",
        frame: { type: "absolute", x: 20, y: 20, width: 80, height: 80 },
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
          { x: 100, y: 0 },
        ],
        paint,
      },
      {
        id: "hidden-circle",
        type: "ellipse",
        frame: { type: "absolute", x: 120, y: 40, width: 30, height: 30 },
        paint,
      },
      {
        id: "cover",
        type: "rectangle",
        frame: { type: "absolute", x: 110, y: 30, width: 60, height: 60 },
        paint: { fill: "#123456", stroke: "none", strokeWidth: 0 },
      },
      {
        id: "outside",
        type: "ellipse",
        frame: { type: "absolute", x: 300, y: 300, width: 20, height: 20 },
        paint,
      },
    ]),
  );
  const codes = new Set(result.report.issues.map((entry) => entry.code));
  assert.ok(codes.has("self-intersection"));
  assert.ok(codes.has("fully-occluded"));
  assert.ok(codes.has("off-canvas"));
  assert.ok(codes.has("literal-paint-color"));
});

test("warns when a scene exceeds the editable object budget", () => {
  const layers = Array.from({ length: 41 }, (_, index) => ({
    id: `dot-${index}`,
    type: "ellipse",
    frame: { type: "absolute", x: index * 2, y: 20, width: 1, height: 1 },
    paint,
  }));
  const result = validateScene(simpleScene(layers));
  assert.ok(result.report.issues.some((entry) => entry.code === "excessive-objects"));
});

test("matches the committed SVG snapshot", async () => {
  const scene = await validFixture("rocket.scene.json");
  const expected = (await readFile(path.join(projectRoot, "tests", "snapshots", "rocket.svg"), "utf8")).trim();
  assert.equal(compileSvg(scene), expected);
});

test("renders deterministic multi-scale artifacts and a comparison sheet", async () => {
  const scene = await validFixture("rocket.scene.json");
  const output = await mkdtemp(path.join(os.tmpdir(), "draw-vector-art-"));
  const artifacts = await renderScene(scene, output);
  await Promise.all(Object.values(artifacts.previews).map((file) => stat(file)));
  const smallMetadata = await sharp(artifacts.previews["64"]).metadata();
  assert.deepEqual({ width: smallMetadata.width, height: smallMetadata.height }, { width: 64, height: 64 });
  const debugMetadata = await sharp(artifacts.debugPng).metadata();
  assert.deepEqual({ width: debugMetadata.width, height: debugMetadata.height }, { width: 1024, height: 1024 });

  const snapshotSvg = await readFile(path.join(projectRoot, "tests", "snapshots", "rocket.svg"), "utf8");
  const expectedRaster = new Resvg(snapshotSvg, { fitTo: { mode: "width", value: 256 } }).render().asPng();
  const [actualRaw, expectedRaw] = await Promise.all([
    sharp(artifacts.previews["256"]).raw().toBuffer(),
    sharp(expectedRaster).raw().toBuffer(),
  ]);
  assert.equal(actualRaw.length, expectedRaw.length);
  let largestDifference = 0;
  for (let index = 0; index < actualRaw.length; index += 1) {
    largestDifference = Math.max(largestDifference, Math.abs((actualRaw[index] ?? 0) - (expectedRaw[index] ?? 0)));
  }
  assert.ok(largestDifference <= 1, `Raster drift was ${largestDifference}`);

  const comparison = await compareScene(scene, artifacts.svg, output);
  const compareMetadata = await sharp(comparison.compare).metadata();
  assert.deepEqual({ width: compareMetadata.width, height: compareMetadata.height }, { width: 3072, height: 1076 });
});

test("ships a balanced 12-task evaluation set with usable local references", async () => {
  const manifestPath = path.join(projectRoot, "tests", "evaluation", "tasks.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    tasks: Array<{ mode: string; reference?: string }>;
  };
  assert.equal(manifest.tasks.length, 12);
  assert.equal(manifest.tasks.filter((task) => task.mode === "text-only").length, 6);
  const referenceTasks = manifest.tasks.filter((task) => task.mode === "text-plus-reference");
  assert.equal(referenceTasks.length, 6);
  await Promise.all(
    referenceTasks.map(async (task) => {
      assert.ok(task.reference);
      const referencePath = path.resolve(path.dirname(manifestPath), task.reference);
      await access(referencePath);
      const metadata = await sharp(referencePath).metadata();
      assert.equal(metadata.format, "svg");
    }),
  );
});
