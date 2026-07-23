import path from "node:path";
import { applyMatrix, boundsForPoints, frameCorners, frameMapMatrix, IDENTITY_MATRIX, isIdentityMatrix, matrixPower, mirrorMatrix, multiplyMatrices, transformMatrix, } from "./matrix.js";
import { flattenCompoundSubpath, pointsEqual } from "./path-geometry.js";
import { flattenResolved, ResolutionError, resolveScene, } from "./resolver.js";
import { EFFECT_REF_PATTERN, GRADIENT_REF_PATTERN, PALETTE_REF_PATTERN, SceneSchema, } from "./schema.js";
function jsonPointer(parts) {
    if (parts.length === 0)
        return "/";
    return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
function issue(severity, code, message, pointer, objectId) {
    return objectId
        ? { severity, code, message, path: pointer, objectId }
        : { severity, code, message, path: pointer };
}
function zodIssues(error) {
    return error.issues.map((entry) => issue("error", `schema-${entry.code}`, entry.message, jsonPointer(entry.path)));
}
function collectObjects(objects, basePath, parent) {
    const collected = [];
    objects.forEach((object, index) => {
        const objectPath = `${basePath}/${index}`;
        const located = parent
            ? { object, path: objectPath, siblings: objects, parent }
            : { object, path: objectPath, siblings: objects };
        collected.push(located);
        if (object.type === "group") {
            collected.push(...collectObjects(object.children, `${objectPath}/children`, object));
        }
    });
    return collected;
}
function paintsFor(object) {
    if (object.type === "group" || object.type === "instance" || object.type === "repeater")
        return [];
    if (object.type === "clone")
        return object.paint ? [object.paint] : [];
    return [object.paint];
}
function checkPaletteRef(value, scene, pointer, objectId, issues, warnLiteral = true) {
    if (PALETTE_REF_PATTERN.test(value)) {
        const key = value.slice(1);
        if (!(key in scene.palette)) {
            issues.push(issue("error", "missing-palette-color", `${value} is not defined in the scene palette`, pointer, objectId));
        }
    }
    else if (warnLiteral && value.startsWith("#") && objectId) {
        issues.push(issue("warning", "literal-paint-color", "Use a named palette reference so repeated colors stay consistent", pointer, objectId));
    }
}
function resourceName(value) {
    return value.slice(value.indexOf(":") + 1);
}
function checkPaintValue(value, scene, pointer, objectId, issues, usedGradients) {
    if (GRADIENT_REF_PATTERN.test(value)) {
        const name = resourceName(value);
        usedGradients.add(name);
        if (!(name in scene.gradients)) {
            issues.push(issue("error", "missing-gradient", `${value} is not defined in scene gradients`, pointer, objectId));
        }
        return;
    }
    checkPaletteRef(value, scene, pointer, objectId, issues);
}
function checkEffectRef(value, scene, pointer, objectId, issues, usedEffects) {
    if (!EFFECT_REF_PATTERN.test(value))
        return;
    const name = resourceName(value);
    usedEffects.add(name);
    if (!(name in scene.effects)) {
        issues.push(issue("error", "missing-effect", `${value} is not defined in scene effects`, pointer, objectId));
    }
}
function pointOnCubic(a, b, c, d, t) {
    const mt = 1 - t;
    return {
        x: mt ** 3 * a.x + 3 * mt ** 2 * t * b.x + 3 * mt * t ** 2 * c.x + t ** 3 * d.x,
        y: mt ** 3 * a.y + 3 * mt ** 2 * t * b.y + 3 * mt * t ** 2 * c.y + t ** 3 * d.y,
    };
}
function handle(node, side) {
    const vector = node[side];
    return vector ? { x: node.x + vector.x, y: node.y + vector.y } : { x: node.x, y: node.y };
}
export function flattenBezier(nodes, closed, steps = 12) {
    if (nodes.length === 0)
        return [];
    const output = [{ x: nodes[0]?.x ?? 0, y: nodes[0]?.y ?? 0 }];
    const count = closed ? nodes.length : nodes.length - 1;
    for (let index = 0; index < count; index += 1) {
        const from = nodes[index];
        const to = nodes[(index + 1) % nodes.length];
        if (!from || !to)
            continue;
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
function orientation(a, b, c) {
    return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}
function segmentsIntersect(a, b, c, d) {
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
export function hasSelfIntersection(points, closed) {
    const segments = [];
    for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        if (from && to)
            segments.push([from, to]);
    }
    if (closed && points.length > 2) {
        const first = points[0];
        const last = points.at(-1);
        if (first && last && (first.x !== last.x || first.y !== last.y))
            segments.push([last, first]);
    }
    for (let left = 0; left < segments.length; left += 1) {
        for (let right = left + 1; right < segments.length; right += 1) {
            if (Math.abs(left - right) <= 1)
                continue;
            if (closed && left === 0 && right === segments.length - 1)
                continue;
            const a = segments[left];
            const b = segments[right];
            if (a && b && segmentsIntersect(a[0], a[1], b[0], b[1]))
                return true;
        }
    }
    return false;
}
function polylineSegments(points, closed) {
    const segments = [];
    for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        if (from && to)
            segments.push([from, to]);
    }
    const first = points[0];
    const last = points.at(-1);
    if (closed && first && last && !pointsEqual(first, last))
        segments.push([last, first]);
    return segments;
}
function polylinesCross(leftPoints, leftClosed, rightPoints, rightClosed) {
    const leftSegments = polylineSegments(leftPoints, leftClosed);
    const rightSegments = polylineSegments(rightPoints, rightClosed);
    return leftSegments.some((left) => rightSegments.some((right) => segmentsIntersect(left[0], left[1], right[0], right[1])));
}
function smoothHandlesAligned(node) {
    if (!node.smooth || !node.in || !node.out)
        return true;
    const cross = node.in.x * node.out.y - node.in.y * node.out.x;
    const dot = node.in.x * node.out.x + node.in.y * node.out.y;
    return Math.abs(cross) < 0.5 && dot <= 0;
}
function inside(inner, outer) {
    return (inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height);
}
function overlapsCanvas(frame, scene) {
    return frame.x < scene.canvas.width && frame.y < scene.canvas.height && frame.x + frame.width > 0 && frame.y + frame.height > 0;
}
function outsideLocalGrid(points) {
    const epsilon = 1e-7;
    return points.some((point) => point.x < -epsilon || point.y < -epsilon || point.x > 100 + epsilon || point.y > 100 + epsilon);
}
function isSourceObject(object) {
    return object.type === "clone" || object.type === "instance" || object.type === "repeater";
}
function isClonePrimitive(object) {
    return object.type !== "group" && object.type !== "instance" && object.type !== "repeater";
}
function referenceEdges(object) {
    const edges = [];
    if (object.frame.type === "relative")
        edges.push({ from: object.id, to: object.frame.to, kind: "frame" });
    if (object.frame.type === "mirror")
        edges.push({ from: object.id, to: object.frame.of, kind: "frame" });
    if (isSourceObject(object))
        edges.push({ from: object.id, to: object.source, kind: "source" });
    return edges;
}
function checkReferenceCycles(siblingLists, locatedById, issues) {
    const reported = new Set();
    for (const siblings of siblingLists) {
        const byId = new Map(siblings.map((object) => [object.id, object]));
        const state = new Map();
        const nodeStack = [];
        const edgeStack = [];
        const visit = (id) => {
            const object = byId.get(id);
            if (!object)
                return;
            state.set(id, "active");
            nodeStack.push(id);
            for (const edge of referenceEdges(object)) {
                if (!byId.has(edge.to))
                    continue;
                const targetState = state.get(edge.to);
                if (!targetState) {
                    edgeStack.push(edge);
                    visit(edge.to);
                    edgeStack.pop();
                    continue;
                }
                if (targetState !== "active")
                    continue;
                const cycleStart = nodeStack.lastIndexOf(edge.to);
                if (cycleStart < 0)
                    continue;
                const cycleNodes = nodeStack.slice(cycleStart);
                const cycleEdges = [...edgeStack.slice(cycleStart), edge];
                if (!cycleEdges.some((entry) => entry.kind === "source"))
                    continue;
                const onlySources = cycleEdges.every((entry) => entry.kind === "source");
                const onlyClones = cycleNodes.every((node) => byId.get(node)?.type === "clone");
                const code = onlySources ? (onlyClones ? "clone-cycle" : "source-cycle") : "mixed-reference-cycle";
                const key = `${code}:${[...cycleNodes].sort().join(",")}`;
                if (reported.has(key))
                    continue;
                reported.add(key);
                const sourceEdge = cycleEdges.find((entry) => entry.kind === "source") ?? edge;
                const located = locatedById.get(sourceEdge.from);
                const message = code === "clone-cycle"
                    ? `Clone reference cycle reaches ${sourceEdge.to}`
                    : code === "source-cycle"
                        ? `Source reference cycle includes ${cycleNodes.join(" -> ")}`
                        : `Placement and source references form a mixed cycle through ${cycleNodes.join(" -> ")}`;
                issues.push(issue("error", code, message, `${located?.path ?? "/layers"}/source`, sourceEdge.from));
            }
            nodeStack.pop();
            state.set(id, "done");
        };
        siblings.forEach((object) => {
            if (!state.has(object.id))
                visit(object.id);
        });
    }
}
const EXPANSION_LIMIT = 256;
const SCENE_EXPANSION_LIMIT = 512;
function expandedObjectCount(resolved, graph, throughReuse, trail = new Set()) {
    if (!resolved.visible || (resolved.object.template && !throughReuse))
        return 0;
    if (trail.has(resolved.object.id))
        return SCENE_EXPANSION_LIMIT + 1;
    const nextTrail = new Set(trail).add(resolved.object.id);
    const clamp = (value) => Math.min(value, SCENE_EXPANSION_LIMIT + 1);
    if (resolved.object.type === "group") {
        return clamp(1 + resolved.children.reduce((sum, child) => sum + expandedObjectCount(child, graph, throughReuse, nextTrail), 0));
    }
    if (resolved.object.type === "instance" || resolved.object.type === "repeater") {
        const source = graph.byId.get(resolved.object.source);
        if (!source)
            return 0;
        const sourceCount = expandedObjectCount(source, graph, true, nextTrail);
        return clamp(resolved.object.type === "repeater"
            ? 1 + resolved.object.count * (1 + sourceCount)
            : 1 + sourceCount);
    }
    return 1;
}
function sourceChainVisible(resolved, graph, trail = new Set()) {
    if (!resolved.visible || trail.has(resolved.object.id))
        return false;
    if (resolved.object.type !== "clone")
        return true;
    const source = graph.byId.get(resolved.object.source);
    if (!source)
        return false;
    return sourceChainVisible(source, graph, new Set(trail).add(resolved.object.id));
}
function sourcePrimitiveObject(resolved, graph, trail = new Set()) {
    if (trail.has(resolved.object.id))
        return undefined;
    if (resolved.object.type !== "clone")
        return resolved.object;
    const source = graph.byId.get(resolved.object.source);
    if (!source)
        return undefined;
    return sourcePrimitiveObject(source, graph, new Set(trail).add(resolved.object.id));
}
function mapLocalPoint(point, frame) {
    return {
        x: frame.x + (point.x / 100) * frame.width,
        y: frame.y + (point.y / 100) * frame.height,
    };
}
function primitiveVisualPoints(object, frame) {
    if (object.type === "bezier-path") {
        return flattenBezier(object.nodes, object.closed, 24).map((point) => mapLocalPoint(point, frame));
    }
    if (object.type === "compound-path") {
        const points = object.subpaths.flatMap((subpath) => flattenCompoundSubpath(subpath, 12));
        return points.length > 0 ? points.map((point) => mapLocalPoint(point, frame)) : frameCorners(frame);
    }
    return frameCorners(frame);
}
function nonEmptyBounds(points) {
    const bounds = boundsForPoints(points);
    const epsilon = 1e-7;
    return {
        x: bounds.width === 0 ? bounds.x - epsilon / 2 : bounds.x,
        y: bounds.height === 0 ? bounds.y - epsilon / 2 : bounds.y,
        width: bounds.width === 0 ? epsilon : bounds.width,
        height: bounds.height === 0 ? epsilon : bounds.height,
    };
}
function collectVisualSamples(graph, locatedById) {
    const samples = new Map();
    const add = (ownerId, pointer, points, matrix) => {
        const bounds = nonEmptyBounds(points.map((point) => applyMatrix(matrix, point)));
        const list = samples.get(ownerId) ?? [];
        list.push({ bounds, ownerId, path: pointer });
        samples.set(ownerId, list);
    };
    const visit = (resolved, parentMatrix, throughReuse, ownerOverride, trail) => {
        if (!resolved.visible || (resolved.object.template && !throughReuse) || trail.has(resolved.object.id))
            return;
        const located = locatedById.get(resolved.object.id);
        const owner = ownerOverride ?? { id: resolved.object.id, path: located?.path ?? "/layers" };
        const ownTransform = transformMatrix(resolved.object.transform, resolved.frame, resolved.space);
        const composed = multiplyMatrices(parentMatrix, ownTransform);
        if (resolved.object.type === "group") {
            const nextTrail = new Set(trail).add(resolved.object.id);
            resolved.children.forEach((child) => visit(child, composed, throughReuse, ownerOverride, nextTrail));
            return;
        }
        if (resolved.object.type === "clone") {
            const source = graph.byId.get(resolved.object.source);
            if (!source || !sourceChainVisible(source, graph))
                return;
            const cloneMatrix = resolved.object.frame.type === "mirror"
                ? multiplyMatrices(composed, mirrorMatrix(resolved.frame, resolved.object.frame.axis))
                : composed;
            const sourceObject = sourcePrimitiveObject(source, graph);
            if (sourceObject)
                add(owner.id, owner.path, primitiveVisualPoints(sourceObject, resolved.frame), cloneMatrix);
            return;
        }
        if (resolved.object.type === "instance" || resolved.object.type === "repeater") {
            const source = graph.byId.get(resolved.object.source);
            if (!source || !source.visible)
                return;
            const mapped = frameMapMatrix(source.frame, resolved.frame);
            const frameMap = resolved.object.frame.type === "mirror"
                ? multiplyMatrices(mirrorMatrix(resolved.frame, resolved.object.frame.axis), mapped)
                : mapped;
            const nextTrail = new Set(trail).add(resolved.object.id);
            if (resolved.object.type === "instance") {
                visit(source, multiplyMatrices(composed, frameMap), true, owner, nextTrail);
                return;
            }
            const step = transformMatrix(resolved.object.step, resolved.frame, resolved.space);
            for (let index = 0; index < resolved.object.count; index += 1) {
                const repeated = multiplyMatrices(multiplyMatrices(composed, matrixPower(step, index)), frameMap);
                visit(source, repeated, true, owner, nextTrail);
            }
            return;
        }
        add(owner.id, owner.path, primitiveVisualPoints(resolved.object, resolved.frame), composed);
    };
    graph.layers.forEach((layer) => visit(layer, IDENTITY_MATRIX, false, undefined, new Set()));
    return samples;
}
function hasComplexPaint(object) {
    return paintsFor(object).some((paint) => GRADIENT_REF_PATTERN.test(paint.fill) || GRADIENT_REF_PATTERN.test(paint.stroke) || Boolean(paint.effect));
}
function objectOpaqueRectangle(resolved, scene) {
    if (resolved.object.type !== "rectangle" ||
        !resolved.visible ||
        resolved.object.template ||
        Boolean(resolved.object.transform) ||
        hasComplexPaint(resolved.object)) {
        return false;
    }
    const paint = resolved.object.paint;
    if (paint.opacity < 1 || paint.fill === "none")
        return false;
    if (paint.fill.startsWith("@"))
        return Boolean(scene.palette[paint.fill.slice(1)]);
    return true;
}
function checkOcclusion(siblings, locatedById, scene, issues) {
    for (let index = 0; index < siblings.length; index += 1) {
        const current = siblings[index];
        if (!current)
            continue;
        if (current.object.type === "group") {
            if (!current.object.template && !current.object.transform && !current.object.clipTo) {
                checkOcclusion(current.children, locatedById, scene, issues);
            }
            continue;
        }
        if (!current.visible ||
            current.object.template ||
            current.object.transform ||
            current.object.type === "clone" ||
            current.object.type === "instance" ||
            current.object.type === "repeater" ||
            hasComplexPaint(current.object)) {
            continue;
        }
        for (let aboveIndex = index + 1; aboveIndex < siblings.length; aboveIndex += 1) {
            const above = siblings[aboveIndex];
            if (above && objectOpaqueRectangle(above, scene) && inside(current.frame, above.frame)) {
                const located = locatedById.get(current.object.id);
                issues.push(issue("warning", "fully-occluded", `${current.object.id} is completely covered by later rectangle ${above.object.id}`, located?.path ?? "/layers", current.object.id));
                break;
            }
        }
    }
}
function semanticIssues(scene) {
    const issues = [];
    const located = collectObjects(scene.layers, "/layers");
    const locatedById = new Map(located.map((item) => [item.object.id, item]));
    const seenIds = new Map();
    const referencedIds = new Set();
    const usedGradients = new Set();
    const usedEffects = new Set();
    let bezierNodes = 0;
    let compoundSegments = 0;
    const generatedSvgIds = new Map();
    const reserveGeneratedId = (id, path, description, objectId) => {
        const previous = generatedSvgIds.get(id);
        if (previous) {
            issues.push(issue("error", "generated-id-collision", `Engine-generated SVG ID ${id} for ${description} conflicts with ${previous.description}`, path, objectId));
            return;
        }
        generatedSvgIds.set(id, objectId ? { path, description, objectId } : { path, description });
    };
    reserveGeneratedId("drawing-title", "/brief/prompt", "the accessible title");
    reserveGeneratedId("canvas-background", "/canvas/background", "the canvas background");
    reserveGeneratedId("debug-overlay", "/layers", "the debug overlay");
    for (const entry of located) {
        if (entry.object.type !== "group" || !entry.object.clipTo)
            continue;
        reserveGeneratedId(`clip-${entry.object.id}`, `${entry.path}/clipTo`, `the clip path for ${entry.object.id}`, entry.object.id);
        reserveGeneratedId(`clip-shape-${entry.object.id}`, `${entry.path}/clipTo`, `the clip geometry for ${entry.object.id}`, entry.object.id);
    }
    checkPaintValue(scene.canvas.background, scene, "/canvas/background", undefined, issues, usedGradients);
    if (Object.keys(scene.gradients).length > 16) {
        issues.push(issue("error", "excessive-gradients", "Use at most 16 named gradients", "/gradients"));
    }
    if (Object.keys(scene.effects).length > 8) {
        issues.push(issue("error", "excessive-effects", "Use at most 8 named effects", "/effects"));
    }
    for (const [name, gradient] of Object.entries(scene.gradients)) {
        const gradientPath = `/gradients/${name}`;
        if (gradient.type === "linear" && pointsEqual(gradient.from, gradient.to)) {
            issues.push(issue("error", "degenerate-gradient", `Linear gradient ${name} must use distinct start and end points`, `${gradientPath}/to`));
        }
        if (gradient.type === "radial" && gradient.focal) {
            const distance = Math.hypot(gradient.focal.x - gradient.center.x, gradient.focal.y - gradient.center.y);
            if (distance > gradient.radius) {
                issues.push(issue("warning", "radial-focal-outside", `Radial gradient ${name} has a focal point outside its radius`, `${gradientPath}/focal`));
            }
        }
        gradient.stops.forEach((stop, index) => {
            checkPaletteRef(stop.color, scene, `${gradientPath}/stops/${index}/color`, undefined, issues, false);
            const previous = gradient.stops[index - 1];
            if (previous && stop.offset < previous.offset) {
                issues.push(issue("error", "gradient-stop-order", "Gradient stop offsets must be in nondecreasing order", `${gradientPath}/stops/${index}/offset`));
            }
        });
    }
    for (const [name, effect] of Object.entries(scene.effects)) {
        checkPaletteRef(effect.color, scene, `/effects/${name}/color`, undefined, issues, false);
        if (effect.dx === 0 && effect.dy === 0 && effect.blur === 0) {
            issues.push(issue("warning", "ineffective-shadow", `Shadow effect ${name} has no offset or blur`, `/effects/${name}`));
        }
    }
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
        const reservedId = generatedSvgIds.get(object.id);
        if (reservedId) {
            issues.push(issue("error", "reserved-svg-id", `Object ID ${object.id} conflicts with ${reservedId.description}; choose another semantic ID`, `${entry.path}/id`, object.id));
        }
        const firstPath = seenIds.get(object.id);
        if (firstPath) {
            issues.push(issue("error", "duplicate-id", `${object.id} was already defined at ${firstPath}`, `${entry.path}/id`, object.id));
        }
        else {
            seenIds.set(object.id, `${entry.path}/id`);
        }
        const siblingIds = new Set(entry.siblings.map((sibling) => sibling.id));
        if (object.frame.type === "relative" && !siblingIds.has(object.frame.to)) {
            issues.push(issue("error", "missing-frame-reference", `Relative frame target ${object.frame.to} must be a sibling`, `${entry.path}/frame/to`, object.id));
        }
        if (object.frame.type === "mirror" && !siblingIds.has(object.frame.of)) {
            issues.push(issue("error", "missing-frame-reference", `Mirror target ${object.frame.of} must be a sibling`, `${entry.path}/frame/of`, object.id));
        }
        if (isSourceObject(object)) {
            const source = entry.siblings.find((sibling) => sibling.id === object.source);
            if (!source) {
                const sourceKind = object.type === "clone" ? "clone" : object.type;
                issues.push(issue("error", `missing-${sourceKind}-source`, `${sourceKind[0]?.toUpperCase() ?? "S"}${sourceKind.slice(1)} source ${object.source} must be a sibling`, `${entry.path}/source`, object.id));
            }
            else {
                referencedIds.add(source.id);
                if (object.type === "clone" && !isClonePrimitive(source)) {
                    issues.push(issue("error", "invalid-clone-source", "Clone sources must resolve through primitives or other clones", `${entry.path}/source`, object.id));
                }
                if (!source.visible) {
                    issues.push(issue("warning", "invisible-source", `Source ${source.id} is hidden, so ${object.id} will not render its content`, `${entry.path}/source`, object.id));
                }
            }
        }
        if (object.type === "group" && object.clipTo) {
            const target = entry.siblings.find((sibling) => sibling.id === object.clipTo);
            if (!target) {
                issues.push(issue("error", "missing-clip-target", `Clip target ${object.clipTo} must be a sibling`, `${entry.path}/clipTo`, object.id));
            }
            else if (!isClonePrimitive(target)) {
                issues.push(issue("error", "invalid-clip-target", "Clip targets must resolve through drawable primitives or clones", `${entry.path}/clipTo`, object.id));
            }
            else {
                referencedIds.add(target.id);
            }
        }
        if (!object.visible) {
            issues.push(issue("warning", "hidden-object", "Object is explicitly hidden and will not be exported", `${entry.path}/visible`, object.id));
        }
        if (object.template && entry.parent?.type === "group" && entry.parent.layout.type !== "free") {
            issues.push(issue("error", "template-in-layout", "Templates cannot occupy row or column layout slots; move the template outside the layout group", `${entry.path}/template`, object.id));
        }
        paintsFor(object).forEach((paint) => {
            const paintPath = `${entry.path}/paint`;
            checkPaintValue(paint.fill, scene, `${paintPath}/fill`, object.id, issues, usedGradients);
            checkPaintValue(paint.stroke, scene, `${paintPath}/stroke`, object.id, issues, usedGradients);
            if (paint.effect) {
                checkEffectRef(paint.effect, scene, `${paintPath}/effect`, object.id, issues, usedEffects);
            }
            if (paint.opacity === 0 || (paint.fill === "none" && (paint.stroke === "none" || paint.strokeWidth === 0))) {
                issues.push(issue("warning", "invisible-paint", "Object paint makes this object invisible", paintPath, object.id));
            }
        });
        if (object.type === "polygon" && hasSelfIntersection(object.points, true)) {
            issues.push(issue("error", "self-intersection", "Polygon edges intersect; reorder or revise its points", `${entry.path}/points`, object.id));
        }
        if (object.type === "bezier-path") {
            bezierNodes += object.nodes.length;
            const flattened = flattenBezier(object.nodes, object.closed);
            if (outsideLocalGrid(flattened)) {
                issues.push(issue("warning", "geometry-outside-frame", "Bézier geometry extends outside its local 0–100 frame", `${entry.path}/nodes`, object.id));
            }
            if (hasSelfIntersection(flattened, object.closed)) {
                issues.push(issue("error", "self-intersection", "Bézier path intersects itself", `${entry.path}/nodes`, object.id));
            }
            object.nodes.forEach((node, index) => {
                if (!smoothHandlesAligned(node)) {
                    issues.push(issue("warning", "broken-smooth-handle", "Smooth node handles should be collinear and point in opposite directions", `${entry.path}/nodes/${index}`, object.id));
                }
            });
            if (!object.closed && object.paint.fill !== "none") {
                issues.push(issue("warning", "open-filled-path", "Open paths with fills are implicitly closed by SVG", `${entry.path}/closed`, object.id));
            }
            if (object.nodes.length > 24) {
                issues.push(issue("warning", "complex-path", "Prefer multiple semantic shapes over a path with more than 24 nodes", `${entry.path}/nodes`, object.id));
            }
        }
        if (object.type === "compound-path") {
            const flattened = [];
            let extendsOutsideFrame = false;
            const objectSegments = object.subpaths.reduce((sum, subpath) => sum + subpath.segments.length, 0);
            object.subpaths.forEach((subpath, subpathIndex) => {
                let current = subpath.start;
                subpath.segments.forEach((segment, segmentIndex) => {
                    const segmentPath = `${entry.path}/subpaths/${subpathIndex}/segments/${segmentIndex}`;
                    if (segment.type === "arc" && pointsEqual(current, segment.to)) {
                        issues.push(issue("error", "degenerate-arc", "Arc start and endpoint must differ; use two arcs to draw a full ellipse", `${segmentPath}/to`, object.id));
                    }
                    else {
                        const zeroLength = segment.type === "line"
                            ? pointsEqual(current, segment.to)
                            : segment.type === "quadratic"
                                ? pointsEqual(current, segment.to) && pointsEqual(current, segment.control)
                                : segment.type === "cubic"
                                    ? pointsEqual(current, segment.to) &&
                                        pointsEqual(current, segment.control1) &&
                                        pointsEqual(current, segment.control2)
                                    : false;
                        if (zeroLength) {
                            issues.push(issue("warning", "zero-length-segment", "Path segment has no visible length", `${segmentPath}/to`, object.id));
                        }
                    }
                    current = segment.to;
                });
                if (!subpath.closed && object.paint.fill !== "none") {
                    issues.push(issue("warning", "open-filled-path", "Open subpaths with fills are implicitly closed by SVG", `${entry.path}/subpaths/${subpathIndex}/closed`, object.id));
                }
                const points = flattenCompoundSubpath(subpath, 6);
                extendsOutsideFrame ||= outsideLocalGrid(points);
                flattened.push({ subpath, points, index: subpathIndex });
                if (hasSelfIntersection(points, subpath.closed)) {
                    issues.push(issue("error", "self-intersection", "Compound subpath intersects itself", `${entry.path}/subpaths/${subpathIndex}/segments`, object.id));
                }
                const uniquePoints = points.filter((point, index, all) => all.findIndex((candidate) => pointsEqual(candidate, point)) === index);
                if (subpath.closed && uniquePoints.length < 3) {
                    issues.push(issue("error", "degenerate-subpath", "Closed subpaths need at least three distinct sampled points", `${entry.path}/subpaths/${subpathIndex}`, object.id));
                }
            });
            if (extendsOutsideFrame) {
                issues.push(issue("warning", "geometry-outside-frame", "Compound path geometry extends outside its local 0–100 frame", `${entry.path}/subpaths`, object.id));
            }
            compoundSegments += objectSegments;
            if (objectSegments > 48) {
                issues.push(issue("warning", "complex-path", `Compound path contains ${objectSegments} segments; prefer 48 or fewer`, `${entry.path}/subpaths`, object.id));
            }
            for (let right = 1; objectSegments <= 128 && right < flattened.length; right += 1) {
                const current = flattened[right];
                if (!current)
                    continue;
                for (let left = 0; left < right; left += 1) {
                    const previous = flattened[left];
                    if (previous &&
                        polylinesCross(previous.points, previous.subpath.closed, current.points, current.subpath.closed)) {
                        issues.push(issue("warning", "crossing-subpaths", `Subpath ${right} crosses subpath ${left}; verify the intended fill rule`, `${entry.path}/subpaths/${right}`, object.id));
                        break;
                    }
                }
            }
        }
    }
    const siblingLists = [...new Set(located.map((entry) => entry.siblings))];
    checkReferenceCycles(siblingLists, locatedById, issues);
    const effectivelyReferenced = new Set();
    const markReferenced = (id) => {
        if (effectivelyReferenced.has(id))
            return;
        effectivelyReferenced.add(id);
        const object = locatedById.get(id)?.object;
        if (!object)
            return;
        if (object.type === "group")
            object.children.forEach((child) => markReferenced(child.id));
        if (isSourceObject(object))
            markReferenced(object.source);
    };
    referencedIds.forEach(markReferenced);
    for (const entry of located) {
        if (entry.object.template && !effectivelyReferenced.has(entry.object.id)) {
            issues.push(issue("warning", "unused-template", "Template is not referenced by a clone, instance, repeater, or clipping group", `${entry.path}/template`, entry.object.id));
        }
    }
    for (const name of Object.keys(scene.gradients)) {
        if (!usedGradients.has(name)) {
            issues.push(issue("warning", "unused-gradient", `Gradient ${name} is never used`, `/gradients/${name}`));
        }
    }
    for (const name of Object.keys(scene.effects)) {
        if (!usedEffects.has(name)) {
            issues.push(issue("warning", "unused-effect", `Effect ${name} is never used`, `/effects/${name}`));
        }
    }
    if (located.length > 40) {
        issues.push(issue("warning", "excessive-objects", `Scene contains ${located.length} objects; prefer 40 or fewer for editable flat art`, "/layers"));
    }
    if (bezierNodes > 200) {
        issues.push(issue("warning", "excessive-nodes", `Scene contains ${bezierNodes} Bézier nodes; simplify the geometry`, "/layers"));
    }
    if (compoundSegments > 256) {
        issues.push(issue("warning", "excessive-segments", `Scene contains ${compoundSegments} compound path segments; simplify the geometry`, "/layers"));
    }
    try {
        const resolved = resolveScene(scene);
        const hasSourceCycle = issues.some((entry) => ["clone-cycle", "source-cycle", "mixed-reference-cycle"].includes(entry.code));
        let sceneExpansion = 0;
        if (!hasSourceCycle) {
            for (const layer of resolved.layers) {
                sceneExpansion = Math.min(SCENE_EXPANSION_LIMIT + 1, sceneExpansion + expandedObjectCount(layer, resolved, false));
            }
            if (sceneExpansion > SCENE_EXPANSION_LIMIT) {
                issues.push(issue("error", "excessive-expansion", `Scene expands to more than ${SCENE_EXPANSION_LIMIT} rendered objects`, "/layers"));
            }
            for (const item of flattenResolved(resolved.layers)) {
                if (item.object.type !== "instance" && item.object.type !== "repeater")
                    continue;
                const entry = locatedById.get(item.object.id);
                const expanded = expandedObjectCount(item, resolved, true);
                if (expanded > EXPANSION_LIMIT) {
                    issues.push(issue("error", "excessive-expansion", `${item.object.id} expands to more than ${EXPANSION_LIMIT} rendered objects`, `${entry?.path ?? "/layers"}/source`, item.object.id));
                }
                if (item.object.type === "repeater" && item.object.count > 1) {
                    const step = transformMatrix(item.object.step, item.frame, item.space);
                    if (isIdentityMatrix(step)) {
                        issues.push(issue("warning", "identity-repeat-step", "Repeater step is the identity, so every copy overlaps exactly", `${entry?.path ?? "/layers"}/step`, item.object.id));
                    }
                }
            }
        }
        if (!hasSourceCycle && sceneExpansion <= SCENE_EXPANSION_LIMIT) {
            const visualSamples = collectVisualSamples(resolved, locatedById);
            const canvas = { x: 0, y: 0, width: scene.canvas.width, height: scene.canvas.height };
            for (const [ownerId, samples] of visualSamples) {
                const first = samples[0];
                if (!first)
                    continue;
                if (samples.every((sample) => !overlapsCanvas(sample.bounds, scene))) {
                    issues.push(issue("error", "off-canvas", "Object is completely outside the canvas", first.path, ownerId));
                }
                else if (samples.some((sample) => !inside(sample.bounds, canvas))) {
                    issues.push(issue("warning", "partially-off-canvas", "Object geometry extends beyond the canvas", first.path, ownerId));
                }
            }
        }
        checkOcclusion(resolved.layers, locatedById, scene, issues);
    }
    catch (error) {
        if (error instanceof ResolutionError) {
            const entry = error.objectId ? locatedById.get(error.objectId) : undefined;
            issues.push(issue("error", "placement-resolution", error.message, entry?.path ?? "/layers", error.objectId));
        }
        else {
            throw error;
        }
    }
    return { issues, objects: located.length, bezierNodes };
}
function reportFrom(issues, objects, bezierNodes) {
    const errors = issues.filter((entry) => entry.severity === "error").length;
    const warnings = issues.length - errors;
    return {
        valid: errors === 0,
        summary: { errors, warnings, objects, bezierNodes },
        issues,
    };
}
export function validateScene(input) {
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
