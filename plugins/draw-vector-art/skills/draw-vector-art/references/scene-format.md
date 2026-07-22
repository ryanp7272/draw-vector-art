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
  "references": [],
  "layers": []
}
```

- Keep `version` at `1`.
- Keep `style` at `flat-geometric`.
- Use `adapt`, `trace`, or `inspire` for reference intent. Default to `adapt`.
- Define colors as hexadecimal values in `palette` and use `@palette-key` elsewhere.
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

## Diagnostics and output

`validate` returns JSON-pointer paths and semantic object IDs. Fix errors before rendering. Review warnings for hidden paint, literal colors, partially off-canvas frames, open filled paths, broken smooth handles, full occlusion, or excessive complexity.

`render` writes:

- `drawing.svg`
- `preview-64.png`
- `preview-256.png`
- `preview-1024.png`
- `debug.svg`
- `debug.png`
- `report.json`

`compare` writes the same artifacts plus `compare.png`, containing the reference, current render, and difference overlay.
