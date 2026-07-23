import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { runBenchmark } from "../scripts/benchmark.js";
import { compileSvg, escapeXml } from "../scripts/compiler.js";
import { validateScene } from "../scripts/diagnostics.js";
import { applyMatrix, boundsForPoints, frameCorners, matrixPower, transformMatrix } from "../scripts/matrix.js";
import { compareScene, renderScene } from "../scripts/render.js";
import { resolveScene } from "../scripts/resolver.js";
import { sceneJsonSchema } from "../scripts/schema.js";

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

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundedFrame(frame: { x: number; y: number; width: number; height: number }) {
  return {
    x: rounded(frame.x),
    y: rounded(frame.y),
    width: rounded(frame.width),
    height: rounded(frame.height),
  };
}

function debugPolygonFor(svg: string, id: string): string | undefined {
  const overlay = svg.match(/<g id="debug-overlay"[\s\S]*?<\/svg>/)?.[0];
  if (!overlay) return undefined;
  const polygons = [...overlay.matchAll(/<polygon points="([^"]+)"\/>/g)].map((match) => match[1]);
  const labels = [...overlay.matchAll(/<text\b[^>]*>([^<]+)<\/text>/g)].map((match) => match[1]);
  const index = labels.indexOf(id);
  return index < 0 ? undefined : polygons[index];
}

test("validates a semantic fixture without warnings", async () => {
  const result = validateScene(await fixture("rocket.scene.json"));
  assert.deepEqual(result.report.summary, { errors: 0, warnings: 0, objects: 15, bezierNodes: 9 });
});

test("exports an input JSON Schema that keeps additive v0.3 fields optional", () => {
  const schema = sceneJsonSchema() as { required?: string[] };
  assert.ok(schema.required?.includes("version"));
  assert.ok(schema.required?.includes("layers"));
  assert.equal(schema.required?.includes("gradients"), false);
  assert.equal(schema.required?.includes("effects"), false);
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

test("composes affine transforms around local origins and calculates transformed bounds", () => {
  const frame = { x: 10, y: 20, width: 40, height: 20 };
  const canvasSpace = {
    frame: { x: 0, y: 0, width: 256, height: 256 },
    unitsWidth: 256,
    unitsHeight: 256,
  };
  const matrix = transformMatrix(
    {
      origin: { x: 50, y: 50 },
      translate: { x: 5, y: -3 },
      rotate: 90,
      scale: { x: 2, y: 0.5 },
      skew: { x: 0, y: 0 },
    },
    frame,
    canvasSpace,
  );

  assert.deepEqual(roundedFrame(boundsForPoints(frameCorners(frame, matrix))), {
    x: 30,
    y: -13,
    width: 10,
    height: 80,
  });

  const radialStep = transformMatrix(
    {
      origin: { x: 50, y: 100 },
      translate: { x: 0, y: 0 },
      rotate: 36,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
    },
    { x: 111, y: 25, width: 34, height: 88 },
    canvasSpace,
  );
  const opposite = applyMatrix(matrixPower(radialStep, 5), { x: 128, y: 25 });
  assert.deepEqual({ x: rounded(opposite.x), y: rounded(opposite.y) }, { x: 128, y: 201 });
  const fullTurn = applyMatrix(matrixPower(radialStep, 10), { x: 128, y: 25 });
  assert.deepEqual({ x: rounded(fullTurn.x), y: rounded(fullTurn.y) }, { x: 128, y: 25 });
});

test("uses transformed visual bounds for off-canvas diagnostics", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "translated-outside",
        type: "ellipse",
        frame: { type: "absolute", x: 20, y: 20, width: 30, height: 30 },
        transform: {
          origin: { x: 50, y: 50 },
          translate: { x: 300, y: 0 },
          rotate: 0,
          scale: { x: 1, y: 1 },
          skew: { x: 0, y: 0 },
        },
        paint,
      },
    ]),
  );
  assert.ok(
    result.report.issues.some(
      (entry) => entry.severity === "error" && entry.code === "off-canvas" && entry.objectId === "translated-outside",
    ),
  );

  const mirroredInstance = validateScene(
    simpleScene([
      {
        id: "dot-template",
        type: "ellipse",
        template: true,
        frame: { type: "absolute", x: 20, y: 20, width: 30, height: 30 },
        paint,
      },
      {
        id: "mirrored-instance",
        type: "instance",
        source: "dot-template",
        frame: { type: "mirror", of: "dot-template", axis: "x", at: 128 },
        transform: {
          origin: { x: 50, y: 50 },
          translate: { x: 80, y: 0 },
          rotate: 0,
          scale: { x: 1, y: 1 },
          skew: { x: 0, y: 0 },
        },
      },
    ]),
  );
  assert.ok(
    mirroredInstance.report.issues.some(
      (entry) => entry.severity === "error" && entry.code === "off-canvas" && entry.objectId === "mirrored-instance",
    ),
  );
});

test("rejects authored and generated SVG ID collisions before compilation", () => {
  const fixedCollision = validateScene(
    simpleScene([
      {
        id: "drawing-title",
        type: "ellipse",
        frame: { type: "absolute", x: 20, y: 20, width: 30, height: 30 },
        paint,
      },
    ]),
  );
  assert.ok(
    fixedCollision.report.issues.some(
      (entry) => entry.code === "reserved-svg-id" && entry.objectId === "drawing-title",
    ),
  );

  const generatedCollision = validateScene(
    simpleScene([
      {
        id: "mask",
        type: "ellipse",
        frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
        paint,
      },
      {
        id: "bar",
        type: "group",
        clipTo: "mask",
        frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
        children: [
          {
            id: "bar-fill",
            type: "rectangle",
            frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
            paint,
          },
        ],
      },
      {
        id: "shape-bar",
        type: "group",
        clipTo: "mask",
        frame: { type: "absolute", x: 80, y: 20, width: 40, height: 40 },
        children: [
          {
            id: "shape-bar-fill",
            type: "rectangle",
            frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
            paint,
          },
        ],
      },
      {
        id: "clip-bar",
        type: "ellipse",
        frame: { type: "absolute", x: 140, y: 20, width: 40, height: 40 },
        paint,
      },
    ]),
  );
  assert.ok(generatedCollision.report.issues.some((entry) => entry.code === "generated-id-collision"));
  assert.ok(
    generatedCollision.report.issues.some(
      (entry) => entry.code === "reserved-svg-id" && entry.objectId === "clip-bar",
    ),
  );
});

test("uses sampled Bézier and arc geometry for frame and canvas bounds", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "overshooting-bezier",
        type: "bezier-path",
        frame: { type: "absolute", x: 20, y: 10, width: 80, height: 80 },
        nodes: [
          { x: 20, y: 50, out: { x: 0, y: -100 } },
          { x: 80, y: 50, in: { x: 0, y: -100 } },
        ],
        closed: false,
        fillRule: "nonzero",
        paint: { fill: "none", stroke: "@ink", strokeWidth: 2 },
      },
      {
        id: "overshooting-arc",
        type: "compound-path",
        frame: { type: "absolute", x: 120, y: 40, width: 100, height: 100 },
        subpaths: [
          {
            start: { x: 0, y: 0 },
            segments: [
              {
                type: "arc",
                radius: { x: 1, y: 100 },
                to: { x: 100, y: 100 },
              },
            ],
            closed: false,
          },
        ],
        fillRule: "evenodd",
        paint: { fill: "none", stroke: "@ink", strokeWidth: 2 },
      },
    ]),
  );
  assert.equal(result.report.valid, true, JSON.stringify(result.report.issues));
  for (const objectId of ["overshooting-bezier", "overshooting-arc"]) {
    assert.ok(
      result.report.issues.some(
        (entry) => entry.code === "geometry-outside-frame" && entry.objectId === objectId,
      ),
      `${objectId} did not report geometry outside its frame`,
    );
    assert.ok(
      result.report.issues.some(
        (entry) => entry.code === "partially-off-canvas" && entry.objectId === objectId,
      ),
      `${objectId} did not use sampled geometry for canvas bounds`,
    );
  }
});

test("compiles semantic IDs, clipping, and true clone reflection", async () => {
  const scene = await validFixture("rocket.scene.json");
  const svg = compileSvg(scene);
  assert.match(svg, /id="rocket-body"/);
  assert.match(svg, /id="body-highlight" clip-path="url\(#clip-body-highlight\)"/);
  assert.match(svg, /id="right-fin" transform="translate\(348 0\) scale\(-1 1\)"/);
  assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)="https?:|data:/i);
});

test("composes an affine transform after clone reflection", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "asymmetric-source",
        type: "polygon",
        frame: { type: "absolute", x: 20, y: 20, width: 20, height: 20 },
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 20 },
          { x: 30, y: 100 },
        ],
        paint,
      },
      {
        id: "rotated-clone",
        type: "clone",
        source: "asymmetric-source",
        frame: { type: "mirror", of: "asymmetric-source", axis: "x", at: 50 },
        transform: { rotate: 90 },
      },
    ]),
  );
  assert.ok(result.scene);
  assert.match(
    compileSvg(result.scene),
    /id="rotated-clone" transform="matrix\(0 -1 -1 0 100 100\)"/,
  );
});

test("debug polygons include transformed primitive and group source geometry reused by instances and repeaters", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "transformed-primitive",
        type: "ellipse",
        template: true,
        frame: { type: "absolute", x: 10, y: 20, width: 20, height: 10 },
        transform: { rotate: 90 },
        paint,
      },
      {
        id: "primitive-instance",
        type: "instance",
        source: "transformed-primitive",
        frame: { type: "absolute", x: 100, y: 100, width: 40, height: 20 },
      },
      {
        id: "transformed-group",
        type: "group",
        template: true,
        frame: { type: "absolute", x: 20, y: 40, width: 20, height: 10 },
        transform: { rotate: 90 },
        children: [
          {
            id: "group-fill",
            type: "rectangle",
            frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
            paint,
          },
        ],
      },
      {
        id: "group-repeater",
        type: "repeater",
        source: "transformed-group",
        count: 1,
        step: {},
        frame: { type: "absolute", x: 160, y: 160, width: 40, height: 20 },
      },
    ]),
  );
  assert.equal(result.report.valid, true, JSON.stringify(result.report.issues));
  assert.ok(result.scene);

  const svg = compileSvg(result.scene, { debug: true });
  assert.equal(debugPolygonFor(svg, "primitive-instance"), "130,90 130,130 110,130 110,90");
  assert.equal(debugPolygonFor(svg, "group-repeater__0"), "190,150 190,190 170,190 170,150");
});

test("expands template groups, instances, and a ten-copy radial repeater into unique editable IDs", async () => {
  const scene = await validFixture("sunflower-medallion.scene.json");
  const svg = compileSvg(scene);
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "compiled SVG contains duplicate IDs");
  assert.doesNotMatch(svg, /<use\b/i);
  assert.doesNotMatch(svg, /\bid="petal-template"/);
  assert.doesNotMatch(svg, /\bid="leaf-template"/);
  assert.match(svg, /<g id="petal-ring" data-source="petal-template"/);
  assert.match(svg, /<g id="leaf-left" data-source="leaf-template"/);
  assert.match(svg, /<g id="leaf-right" data-source="leaf-template"/);

  for (let index = 0; index < 10; index += 1) {
    assert.match(svg, new RegExp(`<g id="petal-ring__${index}" data-source="petal-template"`));
    assert.match(svg, new RegExp(`\\bid="petal-ring__${index}__petal-template"`));
    assert.match(svg, new RegExp(`\\bid="petal-ring__${index}__petal-template__petal-shape"`));
  }
  assert.equal([...svg.matchAll(/\bid="petal-ring__\d+"/g)].length, 10);
  assert.match(svg, /\bid="leaf-left__leaf-template__leaf-blade"/);
  assert.match(svg, /\bid="leaf-right__leaf-template__leaf-blade"/);
});

test("namespaces copied clip paths and keeps clip geometry resource-free", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "clip-template",
        type: "ellipse",
        template: true,
        frame: { type: "absolute", x: 20, y: 20, width: 24, height: 24 },
        paint,
      },
      {
        id: "clipped-template",
        type: "group",
        template: true,
        clipTo: "clip-template",
        frame: { type: "absolute", x: 20, y: 20, width: 24, height: 24 },
        children: [
          {
            id: "clipped-fill",
            type: "rectangle",
            frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
            paint,
          },
        ],
      },
      {
        id: "clipped-copy",
        type: "instance",
        source: "clipped-template",
        frame: { type: "absolute", x: 80, y: 20, width: 24, height: 24 },
      },
    ]),
  );
  assert.equal(result.report.valid, true, JSON.stringify(result.report.issues));
  assert.ok(result.scene);
  const svg = compileSvg(result.scene);
  assert.match(
    svg,
    /id="clipped-copy__clipped-template" clip-path="url\(#_dva__clip__clipped-copy__clipped-template\)"/,
  );
  const clip = svg.match(/<clipPath id="_dva__clip__clipped-copy__clipped-template">([\s\S]*?)<\/clipPath>/)?.[1];
  assert.ok(clip);
  assert.match(clip, /id="_dva__clip-shape__clipped-copy__clipped-template"/);
  assert.match(clip, /fill="#fff" stroke="none"/);
  assert.doesNotMatch(clip, /url\(#|filter=/);
});

test("keeps copied clips and paint resources in an authored-impossible SVG ID namespace", () => {
  const input = simpleScene([
    {
      id: "b",
      type: "group",
      template: true,
      clipTo: "mask",
      frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
      children: [
        {
          id: "gradient-source",
          type: "rectangle",
          frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
          paint: { fill: "gradient:shade", stroke: "none", strokeWidth: 0, effect: "effect:shadow" },
        },
      ],
    },
    {
      id: "mask",
      type: "ellipse",
      template: true,
      frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
      paint,
    },
    {
      id: "a",
      type: "instance",
      source: "b",
      frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
    },
    {
      id: "clip-a",
      type: "instance",
      source: "b",
      frame: { type: "absolute", x: 80, y: 20, width: 40, height: 40 },
    },
    {
      id: "resource",
      type: "instance",
      source: "b",
      frame: { type: "absolute", x: 140, y: 20, width: 40, height: 40 },
    },
  ]) as Record<string, unknown>;
  input.gradients = {
    shade: {
      type: "linear",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
      stops: [
        { offset: 0, color: "@ink" },
        { offset: 100, color: "@background" },
      ],
    },
  };
  input.effects = {
    shadow: { type: "shadow", dx: 1, dy: 2, blur: 2, color: "@ink", opacity: 0.2 },
  };

  const result = validateScene(input);
  assert.equal(result.report.valid, true, JSON.stringify(result.report.issues));
  assert.ok(result.scene);
  const svg = compileSvg(result.scene);
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, `compiled SVG contains duplicate IDs: ${ids.join(", ")}`);
  assert.match(svg, /<clipPath id="_dva__clip__a__b">/);
  assert.match(svg, /<g id="clip-a__b"/);
  assert.match(svg, /<(?:linearGradient|filter) id="_dva__resource__/);
  assert.doesNotMatch(svg, /<(?:linearGradient|radialGradient|filter) id="resource__/);
});

test("compiles compound arcs, named gradients, and one bounded shadow without unsafe SVG", async () => {
  const scene = await validFixture("sunflower-medallion.scene.json");
  const svg = compileSvg(scene);
  const linearGradients = [...svg.matchAll(/<linearGradient\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  const radialGradients = [...svg.matchAll(/<radialGradient\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  const filters = [...svg.matchAll(/<filter\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/filter>/g)];
  assert.ok(linearGradients.length >= 3);
  assert.ok(radialGradients.length >= 1);
  assert.equal(filters.length, 1);
  for (const gradient of [...linearGradients, ...radialGradients]) {
    assert.match(gradient[0], /gradientUnits="userSpaceOnUse"/);
  }

  const resourceIds = new Set(
    [...linearGradients, ...radialGradients, ...filters].map((match) => match[1]).filter((id): id is string => Boolean(id)),
  );
  const resourceReferences = [...svg.matchAll(/(?:fill|stroke|filter)="url\(#([^)]+)\)"/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));
  assert.ok(resourceReferences.length >= 13);
  for (const resourceId of resourceReferences) {
    assert.ok(resourceIds.has(resourceId), `resource reference #${resourceId} has no local definition`);
  }

  const firstPetal = svg.match(/<path\b[^>]*\bid="petal-ring__0__petal-template__petal-shape"[^>]*>/)?.[0];
  const oppositePetal = svg.match(/<path\b[^>]*\bid="petal-ring__5__petal-template__petal-shape"[^>]*>/)?.[0];
  assert.ok(firstPetal && oppositePetal);
  const firstPetalGradient = firstPetal.match(/fill="url\(#([^)]+)\)"/)?.[1];
  const oppositePetalGradient = oppositePetal.match(/fill="url\(#([^)]+)\)"/)?.[1];
  assert.ok(firstPetalGradient && oppositePetalGradient);
  assert.notEqual(firstPetalGradient, oppositePetalGradient, "repeated objects must receive frame-correct gradient resources");
  const firstPetalDefinition = linearGradients.find((match) => match[1] === firstPetalGradient)?.[0];
  const oppositePetalDefinition = linearGradients.find((match) => match[1] === oppositePetalGradient)?.[0];
  assert.ok(firstPetalDefinition && oppositePetalDefinition);

  const filter = filters[0]?.[0];
  assert.ok(filter);
  assert.match(filter, /\bx="[^"]+"/);
  assert.match(filter, /\by="[^"]+"/);
  assert.match(filter, /\bwidth="[^"]+"/);
  assert.match(filter, /\bheight="[^"]+"/);
  assert.ok(
    /<feDropShadow\b/.test(filter) ||
      (/<feGaussianBlur\b/.test(filter) && /<feOffset\b/.test(filter) && /<feFlood\b/.test(filter)),
    "shadow filter must use the fixed safe primitive graph",
  );

  const ring = svg.match(/<path\b[^>]*\bid="center-ring"[^>]*>/)?.[0];
  assert.ok(ring, "center-ring path was not compiled");
  assert.match(ring, /fill-rule="evenodd"/);
  const pathDataAttribute = ring.match(/\bd="([^"]+)"/)?.[1];
  assert.ok(pathDataAttribute);
  assert.equal([...pathDataAttribute.matchAll(/\bM\b/g)].length, 2);
  assert.equal([...pathDataAttribute.matchAll(/\bC\b/g)].length, 8);
  assert.equal([...pathDataAttribute.matchAll(/\bZ\b/g)].length, 2);
  assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)="https?:|data:|url\(https?:/i);
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

test("reports missing gradient and effect references, source cycles, and malformed arcs", () => {
  const missingDefinitions = validateScene(
    simpleScene([
      {
        id: "missing-definitions",
        type: "ellipse",
        frame: { type: "absolute", x: 40, y: 40, width: 80, height: 80 },
        paint: {
          fill: "gradient:not-defined",
          stroke: "none",
          strokeWidth: 0,
          effect: "effect:not-defined",
        },
      },
    ]),
  );
  assert.ok(missingDefinitions.report.issues.some((entry) => entry.code === "missing-gradient"));
  assert.ok(missingDefinitions.report.issues.some((entry) => entry.code === "missing-effect"));

  const sourceCycle = validateScene(
    simpleScene([
      {
        id: "first-instance",
        type: "instance",
        source: "second-instance",
        frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
      },
      {
        id: "second-instance",
        type: "instance",
        source: "first-instance",
        frame: { type: "absolute", x: 80, y: 20, width: 40, height: 40 },
      },
    ]),
  );
  assert.ok(
    sourceCycle.report.issues.some(
      (entry) => entry.severity === "error" && /cycle/i.test(`${entry.code} ${entry.message}`),
    ),
  );

  const degenerateArc = validateScene(
    simpleScene([
      {
        id: "degenerate-arc",
        type: "compound-path",
        frame: { type: "absolute", x: 20, y: 20, width: 80, height: 80 },
        subpaths: [
          {
            start: { x: 20, y: 20 },
            segments: [
              {
                type: "arc",
                radius: { x: 20, y: 20 },
                to: { x: 20, y: 20 },
              },
            ],
            closed: false,
          },
        ],
        fillRule: "evenodd",
        paint,
      },
    ]),
  );
  assert.ok(degenerateArc.report.issues.some((entry) => entry.code === "degenerate-arc"));

  const zeroRadius = validateScene(
    simpleScene([
      {
        id: "zero-radius-arc",
        type: "compound-path",
        frame: { type: "absolute", x: 20, y: 20, width: 80, height: 80 },
        subpaths: [
          {
            start: { x: 20, y: 20 },
            segments: [
              {
                type: "arc",
                radius: { x: 0, y: 20 },
                to: { x: 80, y: 80 },
              },
            ],
            closed: false,
          },
        ],
        fillRule: "evenodd",
        paint,
      },
    ]),
  );
  assert.ok(zeroRadius.report.issues.some((entry) => entry.code === "schema-too_small"));

  const subnormalRadiusInput = simpleScene([
    {
      id: "subnormal-radius-arc",
      type: "compound-path",
      frame: { type: "absolute", x: 20, y: 20, width: 80, height: 80 },
      subpaths: [
        {
          start: { x: 20, y: 20 },
          segments: [
            {
              type: "arc",
              radius: { x: 1e-300, y: 20 },
              to: { x: 80, y: 80 },
            },
          ],
          closed: false,
        },
      ],
      fillRule: "evenodd",
      paint: { fill: "none", stroke: "@ink", strokeWidth: 2 },
    },
  ]);
  const subnormalRadius = validateScene(subnormalRadiusInput);
  assert.ok(subnormalRadius.report.issues.some((entry) => entry.code === "schema-too_small"));

  const minimumRadiusInput = structuredClone(subnormalRadiusInput) as {
    layers: Array<{ subpaths: Array<{ segments: Array<{ radius: { x: number } }> }> }>;
  };
  const minimumRadius = minimumRadiusInput.layers[0]?.subpaths[0]?.segments[0]?.radius;
  assert.ok(minimumRadius);
  minimumRadius.x = 0.001;
  const minimumRadiusResult = validateScene(minimumRadiusInput);
  assert.equal(minimumRadiusResult.report.valid, true, JSON.stringify(minimumRadiusResult.report.issues));
  const minimumRadiusScene = minimumRadiusResult.scene;
  assert.ok(minimumRadiusScene);
  assert.doesNotThrow(() => compileSvg(minimumRadiusScene));
});

test("keeps invisible reuse sources hidden instead of failing during compilation", () => {
  const result = validateScene(
    simpleScene([
      {
        id: "hidden-source",
        type: "ellipse",
        visible: false,
        frame: { type: "absolute", x: 20, y: 20, width: 30, height: 30 },
        paint,
      },
      {
        id: "hidden-clone",
        type: "clone",
        source: "hidden-source",
        frame: { type: "absolute", x: 60, y: 20, width: 30, height: 30 },
      },
      {
        id: "hidden-instance",
        type: "instance",
        source: "hidden-source",
        frame: { type: "absolute", x: 100, y: 20, width: 30, height: 30 },
      },
      {
        id: "hidden-repeat",
        type: "repeater",
        source: "hidden-source",
        count: 2,
        frame: { type: "absolute", x: 140, y: 20, width: 30, height: 30 },
        step: { translate: { x: 36, y: 0 } },
      },
    ]),
  );
  assert.equal(result.report.valid, true);
  assert.ok(result.report.issues.some((entry) => entry.code === "invisible-source"));
  assert.ok(result.scene);
  const svg = compileSvg(result.scene);
  assert.doesNotMatch(svg, /<ellipse\b/);
  assert.doesNotMatch(svg, /id="hidden-clone"/);
  assert.match(svg, /<g id="hidden-instance"[^>]*><\/g>/);
  assert.match(svg, /<g id="hidden-repeat"[^>]*>/);
});

test("rejects templates in automatic layouts and excessive reuse expansion", () => {
  const layoutResult = validateScene(
    simpleScene([
      {
        id: "layout-group",
        type: "group",
        frame: { type: "absolute", x: 20, y: 20, width: 100, height: 40 },
        layout: { type: "row", gap: 4, padding: 2, align: "center", justify: "center" },
        children: [
          {
            id: "layout-template",
            type: "ellipse",
            template: true,
            frame: { type: "absolute", x: 0, y: 0, width: 20, height: 20 },
            paint,
          },
        ],
      },
    ]),
  );
  assert.ok(layoutResult.report.issues.some((entry) => entry.code === "template-in-layout"));

  const templateChildren = Array.from({ length: 64 }, (_, index) => ({
    id: `template-part-${index}`,
    type: "ellipse",
    frame: { type: "absolute", x: index, y: 20, width: 1, height: 1 },
    paint,
  }));
  const expansionResult = validateScene(
    simpleScene([
      {
        id: "large-template",
        type: "group",
        template: true,
        frame: { type: "absolute", x: 0, y: 0, width: 100, height: 100 },
        children: templateChildren,
      },
      {
        id: "large-repeat",
        type: "repeater",
        source: "large-template",
        count: 32,
        frame: { type: "absolute", x: 20, y: 20, width: 100, height: 100 },
        step: { rotate: 10 },
      },
    ]),
  );
  assert.ok(expansionResult.report.issues.some((entry) => entry.code === "excessive-expansion"));
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

test("rejects excessive named paint resources", () => {
  const input = simpleScene([
    {
      id: "resource-check",
      type: "ellipse",
      frame: { type: "absolute", x: 20, y: 20, width: 40, height: 40 },
      paint,
    },
  ]) as Record<string, unknown>;
  input.gradients = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `gradient-${index}`,
      {
        type: "linear",
        from: { x: 0, y: 0 },
        to: { x: 100, y: 100 },
        stops: [
          { offset: 0, color: "@ink" },
          { offset: 100, color: "@background" },
        ],
      },
    ]),
  );
  input.effects = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `shadow-${index}`,
      { type: "shadow", dx: 0, dy: 2, blur: 2, color: "@ink", opacity: 0.2 },
    ]),
  );
  const result = validateScene(input);
  assert.ok(result.report.issues.some((entry) => entry.code === "excessive-gradients"));
  assert.ok(result.report.issues.some((entry) => entry.code === "excessive-effects"));
});

test("matches the committed SVG snapshot", async () => {
  const scene = await validFixture("rocket.scene.json");
  const expected = (await readFile(path.join(projectRoot, "tests", "snapshots", "rocket.svg"), "utf8")).trim();
  assert.equal(compileSvg(scene), expected);
});

test("matches the committed v0.3 showcase SVG snapshot", async () => {
  const scene = await validFixture("sunflower-medallion.scene.json");
  const expected = (
    await readFile(path.join(projectRoot, "tests", "snapshots", "sunflower-medallion.svg"), "utf8")
  ).trim();
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

test("renders the v0.3 showcase as a detailed native 64 px icon", async () => {
  const scene = await validFixture("sunflower-medallion.scene.json");
  const output = await mkdtemp(path.join(os.tmpdir(), "draw-vector-art-sunflower-"));
  const artifacts = await renderScene(scene, output);
  const metadata = await sharp(artifacts.previews["64"]).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 64, height: 64 });

  const { data, info } = await sharp(artifacts.previews["64"])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: info.width, height: info.height, channels: info.channels }, { width: 64, height: 64, channels: 4 });
  const pixel = (x: number, y: number): [number, number, number, number] => {
    const index = (y * info.width + x) * info.channels;
    return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, data[index + 3] ?? 0];
  };
  const background = [255, 248, 231, 255];
  assert.deepEqual(pixel(0, 0), background);
  assert.notDeepEqual(pixel(32, 28), background);
  assert.notDeepEqual(pixel(32, 19), pixel(32, 28));
  const topPetal = pixel(32, 8);
  const oppositePetal = pixel(32, 48);
  const oppositePetalDifference = topPetal.reduce(
    (sum, channel, index) => sum + Math.abs(channel - (oppositePetal[index] ?? 0)),
    0,
  );
  assert.ok(
    oppositePetalDifference <= 24,
    `opposite petals lost their local gradient orientation (difference ${oppositePetalDifference})`,
  );

  let nonBackgroundPixels = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const current = pixel(x, y);
      const difference = current.reduce((sum, channel, index) => sum + Math.abs(channel - (background[index] ?? 0)), 0);
      if (difference > 8) nonBackgroundPixels += 1;
    }
  }
  assert.ok(nonBackgroundPixels > 900, `only ${nonBackgroundPixels} pixels differ from the background`);
  assert.ok(nonBackgroundPixels < 3_200, `the icon overwhelms its negative space (${nonBackgroundPixels} pixels)`);
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

test("runs the pilot benchmark and emits blinded scoring artifacts", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "draw-vector-benchmark-"));
  const run = path.join(projectRoot, "tests", "evaluation", "pilot", "run.json");
  const report = await runBenchmark(run, output);
  assert.equal(report.evaluatedTasks, 3);
  assert.equal(report.totalTasks, 12);
  assert.equal(report.completeEvaluation, false);
  assert.ok(report.cases.every((entry) => entry.sceneEngine.validationErrors === 0));
  await Promise.all([
    access(report.artifacts.contactSheet),
    access(report.artifacts.scorecard),
    access(report.artifacts.blindKey),
    ...report.cases.flatMap((entry) => [
      access(entry.artifacts.labeled),
      access(entry.artifacts.blind),
      access(entry.artifacts.blindSvgA),
      access(entry.artifacts.blindSvgB),
    ]),
  ]);
  const scorecardContents = await readFile(report.artifacts.scorecard, "utf8");
  assert.match(scorecardContents, /preferred_a_or_b/);
});
