export class ResolutionError extends Error {
    objectId;
    constructor(message, objectId) {
        super(message);
        this.objectId = objectId;
        this.name = "ResolutionError";
    }
}
function anchorPoint(frame, anchor) {
    const horizontal = anchor.endsWith("left") || anchor === "left" ? 0 : anchor.endsWith("right") || anchor === "right" ? 1 : 0.5;
    const vertical = anchor.startsWith("top") || anchor === "top" ? 0 : anchor.startsWith("bottom") || anchor === "bottom" ? 1 : 0.5;
    return {
        x: frame.x + frame.width * horizontal,
        y: frame.y + frame.height * vertical,
    };
}
function localFrame(frame, resolveId) {
    if (frame.type === "absolute") {
        return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    }
    if (frame.type === "mirror") {
        const source = resolveId(frame.of);
        if (frame.axis === "x") {
            return {
                x: 2 * frame.at - source.x - source.width + frame.offset.x,
                y: source.y + frame.offset.y,
                width: source.width,
                height: source.height,
            };
        }
        return {
            x: source.x + frame.offset.x,
            y: 2 * frame.at - source.y - source.height + frame.offset.y,
            width: source.width,
            height: source.height,
        };
    }
    const target = resolveId(frame.to);
    const targetPoint = anchorPoint(target, frame.targetAnchor);
    const draft = { x: 0, y: 0, width: frame.width, height: frame.height };
    const selfPoint = anchorPoint(draft, frame.selfAnchor);
    return {
        x: targetPoint.x - selfPoint.x + frame.offset.x,
        y: targetPoint.y - selfPoint.y + frame.offset.y,
        width: frame.width,
        height: frame.height,
    };
}
function mapFrame(frame, space) {
    return {
        x: space.frame.x + (frame.x / space.unitsWidth) * space.frame.width,
        y: space.frame.y + (frame.y / space.unitsHeight) * space.frame.height,
        width: (frame.width / space.unitsWidth) * space.frame.width,
        height: (frame.height / space.unitsHeight) * space.frame.height,
    };
}
function layoutFrames(children, group) {
    if (group.layout.type === "free")
        return undefined;
    const { type, gap, padding, align, justify } = group.layout;
    const dimensions = children.map((child) => {
        if (child.frame.type !== "absolute") {
            throw new ResolutionError(`${type} layout requires absolute child frames so their sizes are deterministic`, child.id);
        }
        return { id: child.id, width: child.frame.width, height: child.frame.height };
    });
    const mainAvailable = 100 - 2 * padding;
    const mainUsed = dimensions.reduce((sum, item) => sum + (type === "row" ? item.width : item.height), 0) +
        Math.max(0, dimensions.length - 1) * gap;
    const mainOffset = justify === "start" ? 0 : justify === "end" ? mainAvailable - mainUsed : (mainAvailable - mainUsed) / 2;
    let cursor = padding + mainOffset;
    const result = new Map();
    for (const item of dimensions) {
        const crossSize = type === "row" ? item.height : item.width;
        const crossAvailable = 100 - 2 * padding;
        const crossOffset = align === "start" ? 0 : align === "end" ? crossAvailable - crossSize : (crossAvailable - crossSize) / 2;
        const frame = type === "row"
            ? { x: cursor, y: padding + crossOffset, width: item.width, height: item.height }
            : { x: padding + crossOffset, y: cursor, width: item.width, height: item.height };
        result.set(item.id, frame);
        cursor += (type === "row" ? item.width : item.height) + gap;
    }
    return result;
}
function resolveSiblings(objects, space, inheritedVisibility, byId, ownerGroup) {
    const objectById = new Map(objects.map((object) => [object.id, object]));
    const localResolved = new Map();
    const resolving = new Set();
    const laidOut = ownerGroup ? layoutFrames(objects, ownerGroup) : undefined;
    const resolveLocalById = (id) => {
        const existing = localResolved.get(id);
        if (existing)
            return existing;
        if (resolving.has(id))
            throw new ResolutionError(`Placement cycle detected at ${id}`, id);
        const object = objectById.get(id);
        if (!object)
            throw new ResolutionError(`Placement references missing sibling ${id}`, id);
        resolving.add(id);
        const resolved = laidOut?.get(id) ?? localFrame(object.frame, resolveLocalById);
        localResolved.set(id, resolved);
        resolving.delete(id);
        return resolved;
    };
    return objects.map((object) => {
        const frame = mapFrame(resolveLocalById(object.id), space);
        const visible = inheritedVisibility && object.visible;
        const children = object.type === "group"
            ? resolveSiblings(object.children, { frame, unitsWidth: 100, unitsHeight: 100 }, visible, byId, object)
            : [];
        const resolved = { object, frame, visible, children };
        if (byId.has(object.id))
            throw new ResolutionError(`Duplicate object ID ${object.id}`, object.id);
        byId.set(object.id, resolved);
        return resolved;
    });
}
export function resolveScene(scene) {
    const byId = new Map();
    const rootSpace = {
        frame: { x: 0, y: 0, width: scene.canvas.width, height: scene.canvas.height },
        unitsWidth: scene.canvas.width,
        unitsHeight: scene.canvas.height,
    };
    const layers = resolveSiblings(scene.layers, rootSpace, true, byId);
    return { scene, layers, byId };
}
export function flattenResolved(layers) {
    const result = [];
    const visit = (item) => {
        result.push(item);
        item.children.forEach(visit);
    };
    layers.forEach(visit);
    return result;
}
