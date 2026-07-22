import { flattenResolved, resolveScene } from "./resolver.js";
function number(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
}
export function escapeXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function color(value, scene) {
    if (!value.startsWith("@"))
        return value;
    const key = value.slice(1);
    const resolved = scene.palette[key];
    if (!resolved)
        throw new Error(`Unknown palette reference ${value}`);
    return resolved;
}
function paintAttributes(paint, scene, clip = false) {
    if (clip)
        return 'fill="#fff" stroke="none"';
    const attributes = [
        `fill="${color(paint.fill, scene)}"`,
        `stroke="${color(paint.stroke, scene)}"`,
        `stroke-width="${number(paint.strokeWidth)}"`,
        `opacity="${number(paint.opacity)}"`,
        `stroke-linecap="${paint.lineCap}"`,
        `stroke-linejoin="${paint.lineJoin}"`,
    ];
    return attributes.join(" ");
}
export function mapPoint(point, frame) {
    return {
        x: frame.x + (point.x / 100) * frame.width,
        y: frame.y + (point.y / 100) * frame.height,
    };
}
function mapHandle(node, handle, frame) {
    if (!handle)
        return mapPoint(node, frame);
    return mapPoint({ x: node.x + handle.x, y: node.y + handle.y }, frame);
}
function segmentCommand(from, to, frame) {
    const end = mapPoint(to, frame);
    if (!from.out && !to.in)
        return `L ${number(end.x)} ${number(end.y)}`;
    const control1 = mapHandle(from, from.out, frame);
    const control2 = mapHandle(to, to.in, frame);
    return `C ${number(control1.x)} ${number(control1.y)} ${number(control2.x)} ${number(control2.y)} ${number(end.x)} ${number(end.y)}`;
}
export function pathData(nodes, closed, frame) {
    const first = nodes[0];
    if (!first)
        return "";
    const start = mapPoint(first, frame);
    const commands = [`M ${number(start.x)} ${number(start.y)}`];
    for (let index = 1; index < nodes.length; index += 1) {
        const previous = nodes[index - 1];
        const current = nodes[index];
        if (previous && current)
            commands.push(segmentCommand(previous, current, frame));
    }
    const last = nodes.at(-1);
    if (closed && last && nodes.length > 1) {
        commands.push(segmentCommand(last, first, frame), "Z");
    }
    return commands.join(" ");
}
function pointsAttribute(points, frame) {
    return points
        .map((point) => {
        const mapped = mapPoint(point, frame);
        return `${number(mapped.x)},${number(mapped.y)}`;
    })
        .join(" ");
}
function primitiveElement(object, frame, scene, id, paintOverride, clip = false, transform) {
    const paint = paintOverride ?? object.paint;
    const transformAttribute = transform ? ` transform="${transform}"` : "";
    const common = `id="${escapeXml(id)}"${transformAttribute} ${paintAttributes(paint, scene, clip)}`;
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
    }
}
function sourcePrimitive(resolved, graph, trail = new Set()) {
    if (resolved.object.type !== "clone")
        return resolved;
    if (trail.has(resolved.object.id))
        throw new Error(`Clone cycle detected at ${resolved.object.id}`);
    trail.add(resolved.object.id);
    const source = graph.byId.get(resolved.object.source);
    if (!source)
        throw new Error(`Clone ${resolved.object.id} references missing source ${resolved.object.source}`);
    return sourcePrimitive(source, graph, trail);
}
function geometryForResolved(resolved, graph, id, clip = false) {
    if (resolved.object.type === "group")
        throw new Error(`Group ${resolved.object.id} cannot be used as primitive geometry`);
    if (resolved.object.type === "clone") {
        const source = sourcePrimitive(resolved, graph);
        if (source.object.type === "group" || source.object.type === "clone") {
            throw new Error(`Clone source ${source.object.id} is not a primitive`);
        }
        const mirrorTransform = resolved.object.frame.type === "mirror"
            ? resolved.object.frame.axis === "x"
                ? `translate(${number(2 * (resolved.frame.x + resolved.frame.width / 2))} 0) scale(-1 1)`
                : `translate(0 ${number(2 * (resolved.frame.y + resolved.frame.height / 2))}) scale(1 -1)`
            : undefined;
        return primitiveElement(source.object, resolved.frame, graph.scene, id, resolved.object.paint, clip, mirrorTransform);
    }
    return primitiveElement(resolved.object, resolved.frame, graph.scene, id, undefined, clip);
}
function renderResolved(resolved, graph) {
    if (!resolved.visible)
        return "";
    if (resolved.object.type === "group") {
        const clip = resolved.object.clipTo ? ` clip-path="url(#clip-${escapeXml(resolved.object.id)})"` : "";
        return `<g id="${escapeXml(resolved.object.id)}"${clip}>${resolved.children.map((child) => renderResolved(child, graph)).join("")}</g>`;
    }
    return geometryForResolved(resolved, graph, resolved.object.id);
}
function clipDefinitions(graph) {
    return flattenResolved(graph.layers)
        .filter((resolved) => resolved.object.type === "group" && Boolean(resolved.object.clipTo))
        .map((resolved) => {
        if (resolved.object.type !== "group" || !resolved.object.clipTo)
            return "";
        const target = graph.byId.get(resolved.object.clipTo);
        if (!target)
            throw new Error(`Group ${resolved.object.id} references missing clip target ${resolved.object.clipTo}`);
        return `<clipPath id="clip-${escapeXml(resolved.object.id)}">${geometryForResolved(target, graph, `clip-shape-${resolved.object.id}`, true)}</clipPath>`;
    });
}
function debugOverlay(graph) {
    const { width, height } = graph.scene.canvas;
    const lines = [];
    for (let x = 0; x <= width; x += 16) {
        lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
    }
    for (let y = 0; y <= height; y += 16) {
        lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
    }
    const frameBoxes = flattenResolved(graph.layers)
        .map(({ object, frame }) => {
        return `<rect x="${number(frame.x)}" y="${number(frame.y)}" width="${number(frame.width)}" height="${number(frame.height)}"/>`;
    })
        .join("");
    const labels = flattenResolved(graph.layers)
        .map(({ object, frame }) => {
        const labelY = Math.max(6, frame.y - 2);
        return `<text x="${number(frame.x + 1)}" y="${number(labelY)}">${escapeXml(object.id)}</text>`;
    })
        .join("");
    return `<g id="debug-overlay" pointer-events="none"><g fill="none" stroke="#2563eb" stroke-width="0.35" opacity="0.25">${lines.join("")}</g><g fill="none" stroke="#e11d48" stroke-width="0.65">${frameBoxes}</g><g fill="#e11d48" stroke="none" font-family="sans-serif" font-size="5">${labels}</g></g>`;
}
export function compileSvg(scene, options = {}) {
    const graph = resolveScene(scene);
    const defs = clipDefinitions(graph);
    const background = color(scene.canvas.background, scene);
    const backgroundElement = background === "none"
        ? ""
        : `<rect id="canvas-background" x="0" y="0" width="${number(scene.canvas.width)}" height="${number(scene.canvas.height)}" fill="${background}"/>`;
    const body = graph.layers.map((layer) => renderResolved(layer, graph)).join("");
    const debug = options.debug ? debugOverlay(graph) : "";
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${number(scene.canvas.width)}" height="${number(scene.canvas.height)}" viewBox="0 0 ${number(scene.canvas.width)} ${number(scene.canvas.height)}" role="img" aria-labelledby="drawing-title">`,
        `<title id="drawing-title">${escapeXml(scene.brief.prompt)}</title>`,
        defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "",
        backgroundElement,
        body,
        debug,
        "</svg>",
    ].join("");
}
