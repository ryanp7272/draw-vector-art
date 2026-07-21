import path from "node:path";
import { z } from "zod";
import { flattenResolved, ResolutionError, resolveScene, type ResolvedDrawable } from "./resolver.js";
import {
  PALETTE_REF_PATTERN,
  SceneSchema,
  type BezierNode,
  type Drawable,
  type Paint,
  type Point,
  type ResolvedFrame,
  type Scene,
} from "./schema.js";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  path: string;
  objectId?: string;
}

export interface ValidationReport {
  valid: boolean;
  summary: {
    errors: number;
    warnings: number;
    objects: number;
    bezierNodes: number;
  };
  issues: ValidationIssue[];
}

export interface ValidationResult {
  scene?: Scene;
  report: ValidationReport;
}

function jsonPointer(parts: PropertyKey[]): string {
  if (parts.length === 0) return "/";
  return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function issue(
  severity: IssueSeverity,
  code: string,
  message: string,
  pointer: string,
  objectId?: string,
): ValidationIssue {
  return objectId
    ? { severity, code, message, path: pointer, objectId }
    : { severity, code, message, path: pointer };
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((entry) => issue("error", `schema-${entry.code}`, entry.message, jsonPointer(entry.path)));
}

interface LocatedObject {
  object: Drawable;
  path: string;
  siblings: Drawable[];
  parent?: Drawable;
}

function collectObjects(objects: Drawable[], basePath: string, parent?: Drawable): LocatedObject[] {
  const collected: LocatedObject[] = [];
  objects.forEach((object, index) => {
    const objectPath = `${basePath}/${index}`;
    const located: LocatedObject = parent
      ? { object, path: objectPath, siblings: objects, parent }
      : { object, path: objectPath, siblings: objects };
    collected.push(located);
    if (object.type === "group") {
      collected.push(...collectObjects(object.children, `${objectPath}/children`, object));
    }
  });
  return collected;
}

function paintsFor(object: Drawable): Paint[] {
  if (object.type === "group") return [];
  if (object.type === "clone") return object.paint ? [object.paint] : [];
  return [object.paint];
}

function checkPaletteRef(value: string, scene: Scene, pointer: string, objectId: string | undefined, issues: ValidationIssue[]): void {
  if (PALETTE_REF_PATTERN.test(value)) {
    const key = value.slice(1);
    if (!(key in scene.palette)) {
      issues.push(issue("error", "missing-palette-color", `${value} is not defined in the scene palette`, pointer, objectId));
    }
  } else if (value.startsWith("#") && objectId) {
    issues.push(
      issue(
        "warning",
        "literal-paint-color",
        "Use a named palette reference so repeated colors stay consistent",
        pointer,
        objectId,
      ),
    );
  }
}

function pointOnCubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * a.x + 3 * mt ** 2 * t * b.x + 3 * mt * t ** 2 * c.x + t ** 3 * d.x,
    y: mt ** 3 * a.y + 3 * mt ** 2 * t * b.y + 3 * mt * t ** 2 * c.y + t ** 3 * d.y,
  };
}

function handle(node: BezierNode, side: "in" | "out"): Point {
  const vector = node[side];
  return vector ? { x: node.x + vector.x, y: node.y + vector.y } : { x: node.x, y: node.y };
}

export function flattenBezier(nodes: BezierNode[], closed: boolean, steps = 12): Point[] {
  if (nodes.length === 0) return [];
  const output: Point[] = [{ x: nodes[0]?.x ?? 0, y: nodes[0]?.y ?? 0 }];
  const count = closed ? nodes.length : nodes.length - 1;
  for (let index = 0; index < count; index += 1) {
    const from = nodes[index];
    const to = nodes[(index + 1) % nodes.length];
    if (!from || !to) continue;
    const curved = Boolean(from.out || to.in);
    if (!curved) {
      output.push({ x: to.x, y: to.y });
      continue;
    }
    const control1 = handle(from, "out");
    const control2 = handle(to, "in");
    for (let step = 1; step <= steps; step += 1) {
      output.push(pointOnCubic(from, control1, control2, to, step / steps));
    }
  }
  return output;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  const epsilon = 1e-7;
  if (Math.abs(o1) < epsilon || Math.abs(o2) < epsilon || Math.abs(o3) < epsilon || Math.abs(o4) < epsilon) {
    return false;
  }
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

export function hasSelfIntersection(points: Point[], closed: boolean): boolean {
  const segments: Array<[Point, Point]> = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from && to) segments.push([from, to]);
  }
  if (closed && points.length > 2) {
    const first = points[0];
    const last = points.at(-1);
    if (first && last && (first.x !== last.x || first.y !== last.y)) segments.push([last, first]);
  }
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 1; right < segments.length; right += 1) {
      if (Math.abs(left - right) <= 1) continue;
      if (closed && left === 0 && right === segments.length - 1) continue;
      const a = segments[left];
      const b = segments[right];
      if (a && b && segmentsIntersect(a[0], a[1], b[0], b[1])) return true;
    }
  }
  return false;
}

function smoothHandlesAligned(node: BezierNode): boolean {
  if (!node.smooth || !node.in || !node.out) return true;
  const cross = node.in.x * node.out.y - node.in.y * node.out.x;
  const dot = node.in.x * node.out.x + node.in.y * node.out.y;
  return Math.abs(cross) < 0.5 && dot <= 0;
}

function inside(inner: ResolvedFrame, outer: ResolvedFrame): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function overlapsCanvas(frame: ResolvedFrame, scene: Scene): boolean {
  return frame.x < scene.canvas.width && frame.y < scene.canvas.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}

function objectOpaqueRectangle(resolved: ResolvedDrawable, scene: Scene): boolean {
  if (resolved.object.type !== "rectangle" || !resolved.visible) return false;
  const paint = resolved.object.paint;
  if (paint.opacity < 1 || paint.fill === "none") return false;
  if (paint.fill.startsWith("@")) return Boolean(scene.palette[paint.fill.slice(1)]);
  return true;
}

function checkOcclusion(siblings: ResolvedDrawable[], locatedById: Map<string, LocatedObject>, scene: Scene, issues: ValidationIssue[]): void {
  for (let index = 0; index < siblings.length; index += 1) {
    const current = siblings[index];
    if (!current) continue;
    if (current.object.type === "group") {
      checkOcclusion(current.children, locatedById, scene, issues);
      continue;
    }
    if (!current.visible) continue;
    for (let aboveIndex = index + 1; aboveIndex < siblings.length; aboveIndex += 1) {
      const above = siblings[aboveIndex];
      if (above && objectOpaqueRectangle(above, scene) && inside(current.frame, above.frame)) {
        const located = locatedById.get(current.object.id);
        issues.push(
          issue(
            "warning",
            "fully-occluded",
            `${current.object.id} is completely covered by later rectangle ${above.object.id}`,
            located?.path ?? "/layers",
            current.object.id,
          ),
        );
        break;
      }
    }
  }
}

function semanticIssues(scene: Scene): { issues: ValidationIssue[]; objects: number; bezierNodes: number } {
  const issues: ValidationIssue[] = [];
  const located = collectObjects(scene.layers, "/layers");
  const locatedById = new Map(located.map((item) => [item.object.id, item]));
  const seenIds = new Map<string, string>();
  let bezierNodes = 0;

  checkPaletteRef(scene.canvas.background, scene, "/canvas/background", undefined, issues);
  scene.references.forEach((reference, index) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference.path) || reference.path.startsWith("//")) {
      issues.push(issue("error", "non-local-reference", "Reference images must use local file paths", `/references/${index}/path`));
    }
    if (path.basename(reference.path).length === 0) {
      issues.push(issue("error", "invalid-reference-path", "Reference path must name a local file", `/references/${index}/path`));
    }
  });

  for (const entry of located) {
    const { object } = entry;
    const firstPath = seenIds.get(object.id);
    if (firstPath) {
      issues.push(issue("error", "duplicate-id", `${object.id} was already defined at ${firstPath}`, `${entry.path}/id`, object.id));
    } else {
      seenIds.set(object.id, `${entry.path}/id`);
    }

    const siblingIds = new Set(entry.siblings.map((sibling) => sibling.id));
    if (object.frame.type === "relative" && !siblingIds.has(object.frame.to)) {
      issues.push(issue("error", "missing-frame-reference", `Relative frame target ${object.frame.to} must be a sibling`, `${entry.path}/frame/to`, object.id));
    }
    if (object.frame.type === "mirror" && !siblingIds.has(object.frame.of)) {
      issues.push(issue("error", "missing-frame-reference", `Mirror target ${object.frame.of} must be a sibling`, `${entry.path}/frame/of`, object.id));
    }
    if (object.type === "clone") {
      const source = entry.siblings.find((sibling) => sibling.id === object.source);
      if (!source) {
        issues.push(issue("error", "missing-clone-source", `Clone source ${object.source} must be a sibling`, `${entry.path}/source`, object.id));
      } else if (source.type === "group") {
        issues.push(issue("error", "invalid-clone-source", "Clone sources must be drawable primitives, not groups", `${entry.path}/source`, object.id));
      } else {
        const visited = new Set([object.id]);
        let current: Drawable | undefined = source;
        while (current?.type === "clone") {
          if (visited.has(current.id)) {
            issues.push(issue("error", "clone-cycle", `Clone reference cycle reaches ${current.id}`, `${entry.path}/source`, object.id));
            break;
          }
          visited.add(current.id);
          const nextSource: string = current.source;
          current = entry.siblings.find((sibling) => sibling.id === nextSource);
        }
      }
    }
    if (object.type === "group" && object.clipTo) {
      const target = entry.siblings.find((sibling) => sibling.id === object.clipTo);
      if (!target) {
        issues.push(issue("error", "missing-clip-target", `Clip target ${object.clipTo} must be a sibling`, `${entry.path}/clipTo`, object.id));
      } else if (target.type === "group") {
        issues.push(issue("error", "invalid-clip-target", "Clip targets must be drawable primitives, not groups", `${entry.path}/clipTo`, object.id));
      }
    }
    if (!object.visible) {
      issues.push(issue("warning", "hidden-object", "Object is explicitly hidden and will not be exported", `${entry.path}/visible`, object.id));
    }

    paintsFor(object).forEach((paint, paintIndex) => {
      const paintPath = `${entry.path}${object.type === "clone" ? "/paint" : "/paint"}`;
      checkPaletteRef(paint.fill, scene, `${paintPath}/fill`, object.id, issues);
      checkPaletteRef(paint.stroke, scene, `${paintPath}/stroke`, object.id, issues);
      if (paint.opacity === 0 || (paint.fill === "none" && (paint.stroke === "none" || paint.strokeWidth === 0))) {
        issues.push(issue("warning", "invisible-paint", "Object paint makes this object invisible", paintPath, object.id));
      }
      if (paintIndex > 0) return;
    });

    if (object.type === "polygon" && hasSelfIntersection(object.points, true)) {
      issues.push(issue("error", "self-intersection", "Polygon edges intersect; reorder or revise its points", `${entry.path}/points`, object.id));
    }
    if (object.type === "bezier-path") {
      bezierNodes += object.nodes.length;
      const flattened = flattenBezier(object.nodes, object.closed);
      if (hasSelfIntersection(flattened, object.closed)) {
        issues.push(issue("error", "self-intersection", "Bézier path intersects itself", `${entry.path}/nodes`, object.id));
      }
      object.nodes.forEach((node, index) => {
        if (!smoothHandlesAligned(node)) {
          issues.push(
            issue(
              "warning",
              "broken-smooth-handle",
              "Smooth node handles should be collinear and point in opposite directions",
              `${entry.path}/nodes/${index}`,
              object.id,
            ),
          );
        }
      });
      if (!object.closed && object.paint.fill !== "none") {
        issues.push(issue("warning", "open-filled-path", "Open paths with fills are implicitly closed by SVG", `${entry.path}/closed`, object.id));
      }
      if (object.nodes.length > 24) {
        issues.push(issue("warning", "complex-path", "Prefer multiple semantic shapes over a path with more than 24 nodes", `${entry.path}/nodes`, object.id));
      }
    }
  }

  if (located.length > 40) {
    issues.push(issue("warning", "excessive-objects", `Scene contains ${located.length} objects; prefer 40 or fewer for editable flat art`, "/layers"));
  }
  if (bezierNodes > 200) {
    issues.push(issue("warning", "excessive-nodes", `Scene contains ${bezierNodes} Bézier nodes; simplify the geometry`, "/layers"));
  }

  try {
    const resolved = resolveScene(scene);
    for (const item of flattenResolved(resolved.layers)) {
      if (item.object.type === "group") continue;
      const entry = locatedById.get(item.object.id);
      if (!overlapsCanvas(item.frame, scene)) {
        issues.push(issue("error", "off-canvas", "Object is completely outside the canvas", entry?.path ?? "/layers", item.object.id));
      } else if (!inside(item.frame, { x: 0, y: 0, width: scene.canvas.width, height: scene.canvas.height })) {
        issues.push(issue("warning", "partially-off-canvas", "Object frame extends beyond the canvas", entry?.path ?? "/layers", item.object.id));
      }
    }
    checkOcclusion(resolved.layers, locatedById, scene, issues);
  } catch (error) {
    if (error instanceof ResolutionError) {
      const entry = error.objectId ? locatedById.get(error.objectId) : undefined;
      issues.push(issue("error", "placement-resolution", error.message, entry?.path ?? "/layers", error.objectId));
    } else {
      throw error;
    }
  }

  return { issues, objects: located.length, bezierNodes };
}

function reportFrom(issues: ValidationIssue[], objects: number, bezierNodes: number): ValidationReport {
  const errors = issues.filter((entry) => entry.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    valid: errors === 0,
    summary: { errors, warnings, objects, bezierNodes },
    issues,
  };
}

export function validateScene(input: unknown): ValidationResult {
  const parsed = SceneSchema.safeParse(input);
  if (!parsed.success) {
    return { report: reportFrom(zodIssues(parsed.error), 0, 0) };
  }
  const semantic = semanticIssues(parsed.data);
  return {
    scene: parsed.data,
    report: reportFrom(semantic.issues, semantic.objects, semantic.bezierNodes),
  };
}
