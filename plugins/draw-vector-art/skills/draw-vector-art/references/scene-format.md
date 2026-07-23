# Scene format

Use this reference to author version 1 scenes. Use `npm run draw -- schema` for the complete machine-readable schema.

## Top-level structure

```json
{
  "version": 1,
  "brief": {
    "prompt": "A friendly green owl icon",
    "style": "flat-geometric",
    "referenceIntent": "adapt"
  },
  "canvas": {
    "width": 256,
    "height": 256,
    "background": "@background"
  },
  "palette": {
    "background": "#F8FAFC",
    "body": "#22C55E",
    "outline": "#14532D"
  },
  "gradients": {},
  "effects": {},
  "references": [],
  "layers": []
}
```

- Keep `version` at `1`.
- Keep `style` at `flat-geometric`.
- Use `adapt`, `trace`, or `inspire` for reference intent. Default to `adapt`.
- Define colors as hexadecimal values in `palette` and use `@palette-key` elsewhere.
- Define reusable gradients and effects by name only when flat color is insufficient.
- Treat `layers` order as back-to-front SVG stacking order.
- Use local file paths only in `references`; the compiler never embeds them in the SVG.

## IDs and paint

Use unique lowercase IDs matching `[a-z][a-z0-9-]*`.

```json
"paint": {
  "fill": "@body",
  "stroke": "@outline",
  "strokeWidth": 3,
  "opacity": 1,
  "lineCap": "round",
  "lineJoin": "round"
}
```

Use `none` for no fill or stroke. A visible line requires a non-`none` stroke and positive `strokeWidth`. Direct hex colors are accepted in paint but produce a consistency warning.

Use `gradient:name` for a named gradient fill or stroke. Use `effect:name` in `paint.effect` for a named bounded effect. The engine never accepts raw `url(...)`, CSS, SVG transforms, or filter markup.

## Frames and coordinate spaces

Use canvas units for top-level frames. Use a local 0–100 coordinate space for children inside a group. All primitive points also use local 0–100 coordinates inside that primitive's resolved frame.

### Absolute frame

```json
"frame": {
  "type": "absolute",
  "x": 68,
  "y": 20,
  "width": 120,
  "height": 172
}
```

### Relative frame

Place an anchor on the new object against an anchor on a sibling:

```json
"frame": {
  "type": "relative",
  "to": "head",
  "selfAnchor": "center",
  "targetAnchor": "top",
  "offset": { "x": 0, "y": 28 },
  "width": 32,
  "height": 32
}
```

Available anchors are `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, and `bottom-right`.

### Mirrored frame

Reflect a sibling's frame across a parent-space axis:

```json
"frame": {
  "type": "mirror",
  "of": "left-eye",
  "axis": "x",
  "at": 128,
  "offset": { "x": 0, "y": 0 }
}
```

Use a `clone` with a mirrored frame to reflect asymmetric geometry as well as placement.

## Modeled transforms

Add `transform` to any object or group. Placement, anchors, and layouts resolve first from the untransformed frame; the transform changes only the final visual geometry. Translation uses containing-space units: canvas units at the top level and local 0–100 units inside a group. The origin is local to the object's frame.

```json
"transform": {
  "origin": { "x": 50, "y": 50 },
  "translate": { "x": 8, "y": -4 },
  "rotate": 18,
  "scale": { "x": 1.1, "y": 0.9 },
  "skew": { "x": 4, "y": 0 }
}
```

The engine builds a deterministic affine matrix in this order: translate, move to origin, rotate, skew Y, skew X, scale, then move back from origin. Negative scale values mirror geometry; neither scale axis may be zero. Use a mirrored frame when a mirrored sibling relationship communicates the intent more clearly.

## Primitive objects

Every object includes `id`, `type`, `frame`, and optional `visible`. Painted primitives include `paint`.

### Ellipse

```json
{
  "id": "eye",
  "type": "ellipse",
  "frame": { "type": "absolute", "x": 40, "y": 30, "width": 24, "height": 30 },
  "paint": { "fill": "@white", "stroke": "@outline", "strokeWidth": 2 }
}
```

### Rectangle and rounded rectangle

Use `rectangle` for hard corners. Use `rounded-rectangle` with `radius` from `0` to `50`; radius is a percentage of the frame's shorter side.

```json
{
  "id": "badge",
  "type": "rounded-rectangle",
  "frame": { "type": "absolute", "x": 60, "y": 80, "width": 80, "height": 28 },
  "radius": 30,
  "paint": { "fill": "@accent", "stroke": "none", "strokeWidth": 0 }
}
```

### Polygon

List at least three local points in perimeter order. Avoid crossed edges.

```json
{
  "id": "beak",
  "type": "polygon",
  "frame": { "type": "absolute", "x": 100, "y": 100, "width": 40, "height": 28 },
  "points": [{ "x": 0, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 100 }],
  "paint": { "fill": "@accent", "stroke": "none", "strokeWidth": 0 }
}
```

### Line

Use local endpoints and visible stroke paint:

```json
{
  "id": "smile",
  "type": "line",
  "frame": { "type": "absolute", "x": 90, "y": 140, "width": 76, "height": 20 },
  "from": { "x": 0, "y": 50 },
  "to": { "x": 100, "y": 50 },
  "paint": { "fill": "none", "stroke": "@outline", "strokeWidth": 3 }
}
```

### Bézier path

Specify nodes on the local grid. Treat `in` and `out` as handle vectors relative to their node, not absolute points. Omit both handles for a straight segment. Set `smooth: true` only when incoming and outgoing handles are collinear and point in opposite directions.

```json
{
  "id": "leaf",
  "type": "bezier-path",
  "frame": { "type": "absolute", "x": 60, "y": 50, "width": 100, "height": 140 },
  "nodes": [
    { "x": 0, "y": 50, "out": { "x": 24, "y": -46 } },
    { "x": 100, "y": 50, "in": { "x": -24, "y": -46 }, "out": { "x": -24, "y": 46 } },
    { "x": 0, "y": 50, "in": { "x": 24, "y": 46 } }
  ],
  "closed": true,
  "fillRule": "nonzero",
  "paint": { "fill": "@leaf", "stroke": "@outline", "strokeWidth": 3 }
}
```

Prefer 24 or fewer nodes per path. Divide complicated subjects into named semantic shapes instead of producing one long outline.

### Compound path

Use `compound-path` for holes, rings, and a small number of related contours that must share one fill rule. Each subpath starts on the local grid and contains line, quadratic, cubic, or arc segments. Arc semantics remain editable in the scene; the compiler converts arcs into deterministic cubic sections before mapping a non-square frame.

```json
{
  "id": "badge-ring",
  "type": "compound-path",
  "frame": { "type": "absolute", "x": 40, "y": 40, "width": 176, "height": 176 },
  "fillRule": "evenodd",
  "subpaths": [
    {
      "start": { "x": 50, "y": 0 },
      "closed": true,
      "segments": [
        { "type": "arc", "radius": { "x": 50, "y": 50 }, "rotation": 0, "largeArc": false, "sweep": "clockwise", "to": { "x": 50, "y": 100 } },
        { "type": "arc", "radius": { "x": 50, "y": 50 }, "rotation": 0, "largeArc": false, "sweep": "clockwise", "to": { "x": 50, "y": 0 } }
      ]
    }
  ],
  "paint": { "fill": "@accent", "stroke": "@outline", "strokeWidth": 3 }
}
```

Segment fields are:

- `line`: `to`
- `quadratic`: `control`, `to`
- `cubic`: `control1`, `control2`, `to`
- `arc`: `radius`, optional `rotation`, optional `largeArc`, optional `sweep`, and `to`

All endpoints and controls use 0–100 local coordinates. Arc radii use the same local units and range from `0.001` through `100`. The canvas Y axis points downward, so `clockwise` compiles to the SVG sweep direction. A full circle requires two arcs because an arc endpoint must differ from its start.

## Clone and mirror

Clone a primitive sibling and optionally override its paint. Use the clone's frame for its size and placement.

```json
{
  "id": "right-wing",
  "type": "clone",
  "source": "left-wing",
  "frame": { "type": "mirror", "of": "left-wing", "axis": "x", "at": 128 }
}
```

Clone sources must be primitives, not groups. Keep clone sources and clone frames within the same sibling list.

## Templates, instances, and repeaters

Set `template: true` on source-only artwork. A template participates in validation and may be referenced, but it is not exported directly. `visible: false` is different: it hides the artwork even when reused.

An `instance` can reuse a primitive or a multi-part group sibling. The source frame maps into the instance frame, then the instance transform is applied.

```json
{
  "id": "right-leaf",
  "type": "instance",
  "source": "leaf-template",
  "frame": { "type": "absolute", "x": 142, "y": 160, "width": 70, "height": 58 },
  "transform": { "rotate": -14 }
}
```

A `repeater` emits `count` mapped copies; `count` includes copy zero. Its `step` is a modeled affine transform applied repeatedly, so rotation around the target frame center produces a radial pattern.

```json
{
  "id": "petal-ring",
  "type": "repeater",
  "source": "petal-template",
  "frame": { "type": "absolute", "x": 28, "y": 28, "width": 200, "height": 200 },
  "count": 10,
  "step": { "origin": { "x": 50, "y": 50 }, "rotate": 36 }
}
```

Sources must be siblings. Mixed clone, instance, and repeater cycles are rejected, as are expansions beyond the bounded editable-node budget. Repeat copies stack from zero upward. The SVG expands copies into ordinary editable elements without `<use>` and assigns deterministic IDs such as `petal-ring__0__petal-shape`; double underscores cannot collide with authored IDs.

## Groups, layouts, and clipping

Groups create semantic SVG `<g>` elements. Children use local 0–100 group coordinates.

```json
{
  "id": "face",
  "type": "group",
  "frame": { "type": "absolute", "x": 48, "y": 48, "width": 160, "height": 120 },
  "layout": { "type": "free" },
  "children": []
}
```

Use row or column layout to place children from their declared widths and heights:

```json
"layout": {
  "type": "row",
  "gap": 8,
  "padding": 6,
  "align": "center",
  "justify": "center"
}
```

Row and column layouts require absolute child frames. Their original `x` and `y` values are ignored; their sizes remain authoritative.

To clip a group, set `clipTo` to a primitive sibling ID. The target geometry becomes a `<clipPath>` but remains independently editable in its normal layer.

## Named gradients and effects

Gradient coordinates use the local 0–100 frame, not the painted geometry's automatic bounding box. Stops use offsets from `0` to `100`, stay in authored order, and reference palette colors.
Keep at most 16 named gradients and 8 named effects in one editable scene.

```json
"gradients": {
  "sunlit": {
    "type": "linear",
    "from": { "x": 0, "y": 0 },
    "to": { "x": 100, "y": 100 },
    "stops": [
      { "offset": 0, "color": "@light", "opacity": 1 },
      { "offset": 100, "color": "@dark", "opacity": 1 }
    ]
  },
  "glow": {
    "type": "radial",
    "center": { "x": 42, "y": 38 },
    "focal": { "x": 35, "y": 30 },
    "radius": 64,
    "stops": [
      { "offset": 0, "color": "@light" },
      { "offset": 100, "color": "@dark" }
    ]
  }
}
```

V1 supports one safe effect recipe, a bounded shadow:

```json
"effects": {
  "lift": {
    "type": "shadow",
    "dx": 0,
    "dy": 4,
    "blur": 5,
    "color": "@shadow",
    "opacity": 0.24
  }
}
```

Apply it as `"effect": "effect:lift"` inside `paint`. Prefer no more than one subtle shadow in a small icon. The compiler generates a fixed local filter graph with bounded canvas-space margins; arbitrary filters remain unsupported.

## Diagnostics and output

`validate` returns JSON-pointer paths and semantic object IDs. Fix errors before rendering. Review warnings for hidden paint, unused templates or resources, geometry that curves outside its object frame, partially off-canvas transformed bounds, open filled paths, broken smooth handles, degenerate repeats, full occlusion, or excessive authored or expanded complexity.

Object IDs must not collide with engine-owned SVG IDs. The validator reserves `drawing-title`, `canvas-background`, `debug-overlay`, and the generated `clip-<group-id>` and `clip-shape-<group-id>` forms before compilation.

Version 0.3 still reads and emits scene format version `1`; existing v0.2 scenes need no migration and retain their output. A v0.2 engine will reject scenes that use these newer strict-schema fields, so keep the engine and scene together when sharing new-feature artwork.

`render` writes:

- `drawing.svg`
- `preview-64.png`
- `preview-256.png`
- `preview-1024.png`
- `debug.svg`
- `debug.png`
- `report.json`

`compare` writes the same artifacts plus `compare.png`, containing the reference, current render, and difference overlay.
