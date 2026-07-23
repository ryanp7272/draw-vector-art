import { compoundPathData } from "./path-geometry.js";
import {
  frameCorners,
  frameMapMatrix,
  IDENTITY_MATRIX,
  isIdentityMatrix,
  matrixPower,
  mirrorMatrix,
  multiplyMatrices,
  transformMatrix,
  type AffineMatrix,
} from "./matrix.js";
import type { BezierNode, Drawable, Gradient, Paint, Point, ResolvedFrame, Scene } from "./schema.js";
import { resolveScene, type ResolvedDrawable, type ResolvedScene } from "./resolver.js";

export interface CompileOptions {
  debug?: boolean;
}

type PrimitiveDrawable = Exclude<
  Drawable,
  { type: "group" } | { type: "clone" } | { type: "instance" } | { type: "repeater" }
>;

interface DefinitionCollector {
  values: string[];
  keys: Set<string>;
}

interface DebugItem {
  id: string;
  corners: Point[];
}

interface CompileState {
  graph: ResolvedScene;
  definitions: DefinitionCollector;
  debugItems: DebugItem[];
}

interface RenderContext {
  outputId: string;
  copied: boolean;
  extraMatrix: AffineMatrix;
  ancestorMatrix: AffineMatrix;
  forceTemplate: boolean;
  clip: boolean;
  collectDebug: boolean;
  sourceTrail: ReadonlySet<string>;
}

const INTERNAL_ID_PREFIX = "_dva__";

function number(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function color(value: string, scene: Scene): string {
  if (!value.startsWith("@")) return value;
  const key = value.slice(1);
  const resolved = scene.palette[key];
  if (!resolved) throw new Error(`Unknown palette reference ${value}`);
  return resolved;
}

function addDefinition(collector: DefinitionCollector, key: string, markup: string): void {
  if (collector.keys.has(key)) return;
  collector.keys.add(key);
  collector.values.push(markup);
}

function matrixText(matrix: AffineMatrix): string {
  return `matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.e)} ${number(matrix.f)})`;
}

function matrixAttribute(matrix: AffineMatrix): string {
  return isIdentityMatrix(matrix) ? "" : ` transform="${matrixText(matrix)}"`;
}

function gradientDefinition(id: string, gradient: Gradient, frame: ResolvedFrame, scene: Scene): string {
  const stops = gradient.stops
    .map(
      (stop) =>
        `<stop offset="${number(stop.offset)}%" stop-color="${color(stop.color, scene)}" stop-opacity="${number(stop.opacity)}"/>`,
    )
    .join("");
  if (gradient.type === "linear") {
    const from = mapPoint(gradient.from, frame);
    const to = mapPoint(gradient.to, frame);
    return `<linearGradient id="${escapeXml(id)}" gradientUnits="userSpaceOnUse" x1="${number(from.x)}" y1="${number(from.y)}" x2="${number(to.x)}" y2="${number(to.y)}">${stops}</linearGradient>`;
  }

  const focal = gradient.focal ?? gradient.center;
  return `<radialGradient id="${escapeXml(id)}" gradientUnits="userSpaceOnUse" cx="${number(gradient.center.x)}" cy="${number(gradient.center.y)}" fx="${number(focal.x)}" fy="${number(focal.y)}" r="${number(gradient.radius)}" gradientTransform="translate(${number(frame.x)} ${number(frame.y)}) scale(${number(frame.width / 100)} ${number(frame.height / 100)})">${stops}</radialGradient>`;
}

function paintValue(
  value: string,
  scene: Scene,
  renderedId: string,
  frame: ResolvedFrame,
  definitions: DefinitionCollector,
): string {
  if (!value.startsWith("gradient:")) return color(value, scene);
  const name = value.slice("gradient:".length);
  const gradient = scene.gradients[name];
  if (!gradient) throw new Error(`Unknown gradient reference ${value}`);
  const id = `${INTERNAL_ID_PREFIX}resource__${renderedId}__gradient__${name}`;
  addDefinition(definitions, `gradient:${id}`, gradientDefinition(id, gradient, frame, scene));
  return `url(#${id})`;
}

function shadowDefinition(id: string, paint: Paint, frame: ResolvedFrame, scene: Scene): string | undefined {
  if (!paint.effect) return undefined;
  const name = paint.effect.slice("effect:".length);
  const effect = scene.effects[name];
  if (!effect) throw new Error(`Unknown effect reference ${paint.effect}`);
  const paddingX = effect.blur * 3 + Math.abs(effect.dx) + 16;
  const paddingY = effect.blur * 3 + Math.abs(effect.dy) + 16;
  return `<filter id="${escapeXml(id)}" filterUnits="userSpaceOnUse" x="${number(frame.x - paddingX)}" y="${number(frame.y - paddingY)}" width="${number(frame.width + paddingX * 2)}" height="${number(frame.height + paddingY * 2)}" color-interpolation-filters="sRGB"><feDropShadow dx="${number(effect.dx)}" dy="${number(effect.dy)}" stdDeviation="${number(effect.blur)}" flood-color="${color(effect.color, scene)}" flood-opacity="${number(effect.opacity)}"/></filter>`;
}

function paintAttributes(
  paint: Paint,
  scene: Scene,
  clip = false,
  renderedId?: string,
  frame?: ResolvedFrame,
  definitions?: DefinitionCollector,
): string {
  if (clip) return 'fill="#fff" stroke="none"';
  if (!renderedId || !frame || !definitions) throw new Error("Rendered paint requires a resource context");
  const attributes = [
    `fill="${paintValue(paint.fill, scene, renderedId, frame, definitions)}"`,
    `stroke="${paintValue(paint.stroke, scene, renderedId, frame, definitions)}"`,
    `stroke-width="${number(paint.strokeWidth)}"`,
    `opacity="${number(paint.opacity)}"`,
    `stroke-linecap="${paint.lineCap}"`,
    `stroke-linejoin="${paint.lineJoin}"`,
  ];
  if (paint.effect) {
    const name = paint.effect.slice("effect:".length);
    const id = `${INTERNAL_ID_PREFIX}resource__${renderedId}__effect__${name}`;
    const definition = shadowDefinition(id, paint, frame, scene);
    if (definition) addDefinition(definitions, `effect:${id}`, definition);
    attributes.push(`filter="url(#${id})"`);
  }
  return attributes.join(" ");
}

export function mapPoint(point: Point, frame: ResolvedFrame): Point {
  return {
    x: frame.x + (point.x / 100) * frame.width,
    y: frame.y + (point.y / 100) * frame.height,
  };
}

function mapHandle(node: BezierNode, handle: Point | undefined, frame: ResolvedFrame): Point {
  if (!handle) return mapPoint(node, frame);
  return mapPoint({ x: node.x + handle.x, y: node.y + handle.y }, frame);
}

function segmentCommand(from: BezierNode, to: BezierNode, frame: ResolvedFrame): string {
  const end = mapPoint(to, frame);
  if (!from.out && !to.in) return `L ${number(end.x)} ${number(end.y)}`;
  const control1 = mapHandle(from, from.out, frame);
  const control2 = mapHandle(to, to.in, frame);
  return `C ${number(control1.x)} ${number(control1.y)} ${number(control2.x)} ${number(control2.y)} ${number(end.x)} ${number(end.y)}`;
}

export function pathData(nodes: BezierNode[], closed: boolean, frame: ResolvedFrame): string {
  const first = nodes[0];
  if (!first) return "";
  const start = mapPoint(first, frame);
  const commands = [`M ${number(start.x)} ${number(start.y)}`];
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const current = nodes[index];
    if (previous && current) commands.push(segmentCommand(previous, current, frame));
  }
  const last = nodes.at(-1);
  if (closed && last && nodes.length > 1) {
    commands.push(segmentCommand(last, first, frame), "Z");
  }
  return commands.join(" ");
}

function pointsAttribute(points: Point[], frame: ResolvedFrame): string {
  return points
    .map((point) => {
      const mapped = mapPoint(point, frame);
      return `${number(mapped.x)},${number(mapped.y)}`;
    })
    .join(" ");
}

function primitiveElement(
  object: PrimitiveDrawable,
  frame: ResolvedFrame,
  scene: Scene,
  definitions: DefinitionCollector,
  id: string,
  paintOverride?: Paint,
  clip = false,
  transform?: string,
): string {
  const paint = paintOverride ?? object.paint;
  const transformAttribute = transform ? ` transform="${transform}"` : "";
  const common = `id="${escapeXml(id)}"${transformAttribute} ${paintAttributes(paint, scene, clip, id, frame, definitions)}`;
  switch (object.type) {
    case "ellipse":
      return `<ellipse ${common} cx="${number(frame.x + frame.width / 2)}" cy="${number(frame.y + frame.height / 2)}" rx="${number(frame.width / 2)}" ry="${number(frame.height / 2)}"/>`;
    case "rectangle":
      return `<rect ${common} x="${number(frame.x)}" y="${number(frame.y)}" width="${number(frame.width)}" height="${number(frame.height)}"/>`;
    case "rounded-rectangle": {
      const radius = (Math.min(frame.width, frame.height) * object.radius) / 100;
      return `<rect ${common} x="${number(frame.x)}" y="${number(frame.y)}" width="${number(frame.width)}" height="${number(frame.height)}" rx="${number(radius)}" ry="${number(radius)}"/>`;
    }
    case "polygon":
      return `<polygon ${common} points="${pointsAttribute(object.points, frame)}"/>`;
    case "line": {
      const from = mapPoint(object.from, frame);
      const to = mapPoint(object.to, frame);
      return `<line ${common} x1="${number(from.x)}" y1="${number(from.y)}" x2="${number(to.x)}" y2="${number(to.y)}"/>`;
    }
    case "bezier-path":
      return `<path ${common} d="${pathData(object.nodes, object.closed, frame)}" fill-rule="${object.fillRule}"/>`;
    case "compound-path":
      return `<path ${common} d="${compoundPathData(object.subpaths, frame, number)}" fill-rule="${object.fillRule}"/>`;
  }
}

function isPrimitive(object: Drawable): object is PrimitiveDrawable {
  return !["group", "clone", "instance", "repeater"].includes(object.type);
}

function sourcePrimitive(resolved: ResolvedDrawable, graph: ResolvedScene, trail = new Set<string>()): ResolvedDrawable {
  if (resolved.object.type !== "clone") return resolved;
  if (trail.has(resolved.object.id)) throw new Error(`Clone cycle detected at ${resolved.object.id}`);
  trail.add(resolved.object.id);
  const source = graph.byId.get(resolved.object.source);
  if (!source) throw new Error(`Clone ${resolved.object.id} references missing source ${resolved.object.source}`);
  return sourcePrimitive(source, graph, trail);
}

function cloneSourceVisible(resolved: ResolvedDrawable, graph: ResolvedScene, trail = new Set<string>()): boolean {
  if (!resolved.visible || trail.has(resolved.object.id)) return false;
  if (resolved.object.type !== "clone") return true;
  const source = graph.byId.get(resolved.object.source);
  if (!source) return false;
  return cloneSourceVisible(source, graph, new Set(trail).add(resolved.object.id));
}

function recordDebug(state: CompileState, context: RenderContext, frame: ResolvedFrame, localMatrix: AffineMatrix): void {
  if (!context.collectDebug || context.clip) return;
  const worldMatrix = multiplyMatrices(context.ancestorMatrix, localMatrix);
  state.debugItems.push({ id: context.outputId, corners: frameCorners(frame, worldMatrix) });
}

function sourceTransform(resolved: ResolvedDrawable): AffineMatrix {
  return transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
}

function cloneMatrices(resolved: ResolvedDrawable, context: RenderContext): {
  local: AffineMatrix;
  legacyTransform?: string;
} {
  const objectTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
  const beforeMirror = multiplyMatrices(context.extraMatrix, objectTransform);
  if (resolved.object.frame.type !== "mirror") return { local: beforeMirror };
  const reflection = mirrorMatrix(resolved.frame, resolved.object.frame.axis);
  const local = multiplyMatrices(beforeMirror, reflection);
  if (isIdentityMatrix(context.extraMatrix) && !resolved.object.transform) {
    const centerX = resolved.frame.x + resolved.frame.width / 2;
    const centerY = resolved.frame.y + resolved.frame.height / 2;
    return {
      local,
      legacyTransform:
        resolved.object.frame.axis === "x"
          ? `translate(${number(2 * centerX)} 0) scale(-1 1)`
          : `translate(0 ${number(2 * centerY)}) scale(1 -1)`,
    };
  }
  return { local };
}

function geometryForClone(
  resolved: ResolvedDrawable,
  context: RenderContext,
  state: CompileState,
): string {
  if (resolved.object.type !== "clone") throw new Error(`${resolved.object.id} is not a clone`);
  if (!cloneSourceVisible(resolved, state.graph)) return "";
  const source = sourcePrimitive(resolved, state.graph);
  if (!isPrimitive(source.object)) throw new Error(`Clone source ${source.object.id} is not a primitive`);
  const transforms = cloneMatrices(resolved, context);
  recordDebug(state, context, resolved.frame, transforms.local);
  const transform = transforms.legacyTransform ?? (isIdentityMatrix(transforms.local) ? undefined : matrixText(transforms.local));
  return primitiveElement(
    source.object,
    resolved.frame,
    state.graph.scene,
    state.definitions,
    context.outputId,
    resolved.object.paint,
    context.clip,
    transform,
  );
}

function sourceFor(resolved: ResolvedDrawable, state: CompileState, trail: ReadonlySet<string>): {
  source: ResolvedDrawable;
  trail: ReadonlySet<string>;
} {
  if (resolved.object.type !== "instance" && resolved.object.type !== "repeater") {
    throw new Error(`${resolved.object.id} does not reference a reusable source`);
  }
  const source = state.graph.byId.get(resolved.object.source);
  if (!source) throw new Error(`${resolved.object.type} ${resolved.object.id} references missing source ${resolved.object.source}`);
  const next = new Set(trail);
  next.add(resolved.object.id);
  if (next.has(source.object.id)) throw new Error(`Reusable source cycle detected at ${source.object.id}`);
  next.add(source.object.id);
  return { source, trail: next };
}

function targetMap(resolved: ResolvedDrawable, source: ResolvedDrawable): AffineMatrix {
  const mapped = frameMapMatrix(source.frame, resolved.frame);
  if (resolved.object.frame.type !== "mirror") return mapped;
  return multiplyMatrices(mirrorMatrix(resolved.frame, resolved.object.frame.axis), mapped);
}

function childId(parent: RenderContext, object: Drawable): string {
  return parent.copied ? `${parent.outputId}__${object.id}` : object.id;
}

function registerClip(
  resolved: ResolvedDrawable,
  context: RenderContext,
  state: CompileState,
): string | undefined {
  if (resolved.object.type !== "group" || !resolved.object.clipTo) return undefined;
  const clipId = context.copied
    ? `${INTERNAL_ID_PREFIX}clip__${context.outputId}`
    : `clip-${context.outputId}`;
  const clipShapeId = context.copied
    ? `${INTERNAL_ID_PREFIX}clip-shape__${context.outputId}`
    : `clip-shape-${context.outputId}`;
  const key = `clip:${clipId}`;
  if (!state.definitions.keys.has(key)) {
    const target = state.graph.byId.get(resolved.object.clipTo);
    if (!target) throw new Error(`Group ${resolved.object.id} references missing clip target ${resolved.object.clipTo}`);
    const clipContext: RenderContext = {
      outputId: clipShapeId,
      copied: true,
      extraMatrix: IDENTITY_MATRIX,
      ancestorMatrix: IDENTITY_MATRIX,
      forceTemplate: true,
      clip: true,
      collectDebug: false,
      sourceTrail: context.sourceTrail,
    };
    const geometry = renderResolved(target, clipContext, state);
    addDefinition(state.definitions, key, `<clipPath id="${escapeXml(clipId)}">${geometry}</clipPath>`);
  }
  return clipId;
}

function renderPrimitive(resolved: ResolvedDrawable, context: RenderContext, state: CompileState): string {
  if (!isPrimitive(resolved.object)) throw new Error(`${resolved.object.id} is not a primitive`);
  const ownTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
  const localMatrix = multiplyMatrices(context.extraMatrix, ownTransform);
  recordDebug(state, context, resolved.frame, localMatrix);
  const transform = isIdentityMatrix(localMatrix) ? undefined : matrixText(localMatrix);
  return primitiveElement(
    resolved.object,
    resolved.frame,
    state.graph.scene,
    state.definitions,
    context.outputId,
    undefined,
    context.clip,
    transform,
  );
}

function renderGroup(resolved: ResolvedDrawable, context: RenderContext, state: CompileState): string {
  if (resolved.object.type !== "group") throw new Error(`${resolved.object.id} is not a group`);
  const ownTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
  const localMatrix = multiplyMatrices(context.extraMatrix, ownTransform);
  recordDebug(state, context, resolved.frame, localMatrix);
  const clipId = registerClip(resolved, context, state);
  const clip = clipId ? ` clip-path="url(#${escapeXml(clipId)})"` : "";
  const transform = matrixAttribute(localMatrix);
  const descendantAncestor = multiplyMatrices(context.ancestorMatrix, localMatrix);
  const children = resolved.children
    .map((child) =>
      renderResolved(
        child,
        {
          outputId: childId(context, child.object),
          copied: context.copied,
          extraMatrix: IDENTITY_MATRIX,
          ancestorMatrix: descendantAncestor,
          forceTemplate: false,
          clip: context.clip,
          collectDebug: context.collectDebug,
          sourceTrail: context.sourceTrail,
        },
        state,
      ),
    )
    .join("");
  return `<g id="${escapeXml(context.outputId)}"${transform}${clip}>${children}</g>`;
}

function renderInstance(resolved: ResolvedDrawable, context: RenderContext, state: CompileState): string {
  if (resolved.object.type !== "instance") throw new Error(`${resolved.object.id} is not an instance`);
  const { source, trail } = sourceFor(resolved, state, context.sourceTrail);
  const ownTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
  const mapped = targetMap(resolved, source);
  const localMatrix = multiplyMatrices(multiplyMatrices(context.extraMatrix, ownTransform), mapped);
  const debugMatrix = multiplyMatrices(localMatrix, sourceTransform(source));
  recordDebug(state, context, source.frame, debugMatrix);
  const descendantAncestor = multiplyMatrices(context.ancestorMatrix, localMatrix);
  const sourceOutputId = `${context.outputId}__${source.object.id}`;
  const content = renderResolved(
    source,
    {
      outputId: sourceOutputId,
      copied: true,
      extraMatrix: IDENTITY_MATRIX,
      ancestorMatrix: descendantAncestor,
      forceTemplate: true,
      clip: context.clip,
      collectDebug: false,
      sourceTrail: trail,
    },
    state,
  );
  return `<g id="${escapeXml(context.outputId)}" data-source="${escapeXml(source.object.id)}"${matrixAttribute(localMatrix)}>${content}</g>`;
}

function renderRepeater(resolved: ResolvedDrawable, context: RenderContext, state: CompileState): string {
  if (resolved.object.type !== "repeater") throw new Error(`${resolved.object.id} is not a repeater`);
  const { source, trail } = sourceFor(resolved, state, context.sourceTrail);
  const ownTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
  const localMatrix = multiplyMatrices(context.extraMatrix, ownTransform);
  recordDebug(state, context, resolved.frame, localMatrix);
  const descendantAncestor = multiplyMatrices(context.ancestorMatrix, localMatrix);
  const mapped = targetMap(resolved, source);
  const sourceDebugTransform = sourceTransform(source);
  const step = transformMatrix(resolved.object.step, resolved.frame, resolved.space);
  const copies: string[] = [];
  for (let index = 0; index < resolved.object.count; index += 1) {
    const copyMatrix = multiplyMatrices(matrixPower(step, index), mapped);
    const copyId = `${context.outputId}__${index}`;
    const copyContext: RenderContext = {
      outputId: copyId,
      copied: true,
      extraMatrix: copyMatrix,
      ancestorMatrix: descendantAncestor,
      forceTemplate: true,
      clip: context.clip,
      collectDebug: context.collectDebug,
      sourceTrail: trail,
    };
    const debugMatrix = multiplyMatrices(copyMatrix, sourceDebugTransform);
    recordDebug(state, copyContext, source.frame, debugMatrix);
    const copyAncestor = multiplyMatrices(descendantAncestor, copyMatrix);
    const content = renderResolved(
      source,
      {
        outputId: `${copyId}__${source.object.id}`,
        copied: true,
        extraMatrix: IDENTITY_MATRIX,
        ancestorMatrix: copyAncestor,
        forceTemplate: true,
        clip: context.clip,
        collectDebug: false,
        sourceTrail: trail,
      },
      state,
    );
    copies.push(
      `<g id="${escapeXml(copyId)}" data-source="${escapeXml(source.object.id)}"${matrixAttribute(copyMatrix)}>${content}</g>`,
    );
  }
  return `<g id="${escapeXml(context.outputId)}" data-source="${escapeXml(source.object.id)}"${matrixAttribute(localMatrix)}>${copies.join("")}</g>`;
}

function renderResolved(resolved: ResolvedDrawable, context: RenderContext, state: CompileState): string {
  if (!resolved.visible) return "";
  if (resolved.object.template && !context.forceTemplate) return "";
  switch (resolved.object.type) {
    case "group":
      return renderGroup(resolved, context, state);
    case "clone":
      return geometryForClone(resolved, context, state);
    case "instance":
      return renderInstance(resolved, context, state);
    case "repeater":
      return renderRepeater(resolved, context, state);
    default:
      return renderPrimitive(resolved, context, state);
  }
}

function debugOverlay(state: CompileState): string {
  const { width, height } = state.graph.scene.canvas;
  const lines: string[] = [];
  for (let x = 0; x <= width; x += 16) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  }
  for (let y = 0; y <= height; y += 16) {
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  }
  const frameBoxes = state.debugItems
    .map(({ corners }) => `<polygon points="${corners.map((point) => `${number(point.x)},${number(point.y)}`).join(" ")}"/>`)
    .join("");
  const labels = state.debugItems
    .map(({ id, corners }) => {
      const x = Math.min(...corners.map((point) => point.x));
      const y = Math.min(...corners.map((point) => point.y));
      return `<text x="${number(x + 1)}" y="${number(Math.max(6, y - 2))}">${escapeXml(id)}</text>`;
    })
    .join("");
  return `<g id="debug-overlay" pointer-events="none"><g fill="none" stroke="#2563eb" stroke-width="0.35" opacity="0.25">${lines.join("")}</g><g fill="none" stroke="#e11d48" stroke-width="0.65">${frameBoxes}</g><g fill="#e11d48" stroke="none" font-family="sans-serif" font-size="5">${labels}</g></g>`;
}

function rootContext(object: Drawable): RenderContext {
  return {
    outputId: object.id,
    copied: false,
    extraMatrix: IDENTITY_MATRIX,
    ancestorMatrix: IDENTITY_MATRIX,
    forceTemplate: false,
    clip: false,
    collectDebug: true,
    sourceTrail: new Set<string>(),
  };
}

export function compileSvg(scene: Scene, options: CompileOptions = {}): string {
  const graph = resolveScene(scene);
  const state: CompileState = {
    graph,
    definitions: { values: [], keys: new Set<string>() },
    debugItems: [],
  };
  const backgroundFrame = { x: 0, y: 0, width: scene.canvas.width, height: scene.canvas.height };
  const background = paintValue(scene.canvas.background, scene, "canvas-background", backgroundFrame, state.definitions);
  const backgroundElement =
    background === "none"
      ? ""
      : `<rect id="canvas-background" x="0" y="0" width="${number(scene.canvas.width)}" height="${number(scene.canvas.height)}" fill="${background}"/>`;
  const body = graph.layers.map((layer) => renderResolved(layer, rootContext(layer.object), state)).join("");
  const debug = options.debug ? debugOverlay(state) : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${number(scene.canvas.width)}" height="${number(scene.canvas.height)}" viewBox="0 0 ${number(scene.canvas.width)} ${number(scene.canvas.height)}" role="img" aria-labelledby="drawing-title">`,
    `<title id="drawing-title">${escapeXml(scene.brief.prompt)}</title>`,
    state.definitions.values.length > 0 ? `<defs>${state.definitions.values.join("")}</defs>` : "",
    backgroundElement,
    body,
    debug,
    "</svg>",
  ].join("");
}
