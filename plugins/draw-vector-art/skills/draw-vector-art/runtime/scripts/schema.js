import { z } from "zod";
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const PALETTE_REF_PATTERN = /^@[a-z][a-z0-9-]*$/;
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const finiteNumber = z.number().finite();
const localCoordinate = finiteNumber.min(0).max(100);
const handleCoordinate = finiteNumber.min(-100).max(100);
const nonNegative = finiteNumber.min(0);
const positive = finiteNumber.gt(0);
const id = z.string().regex(ID_PATTERN, "Use lowercase semantic IDs such as left-eye");
export const AnchorSchema = z.enum([
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right",
]);
export const PointSchema = z
    .object({ x: localCoordinate, y: localCoordinate })
    .strict();
const HandleSchema = z
    .object({ x: handleCoordinate, y: handleCoordinate })
    .strict();
const OffsetSchema = z
    .object({ x: finiteNumber.default(0), y: finiteNumber.default(0) })
    .strict();
const AbsoluteFrameSchema = z
    .object({
    type: z.literal("absolute"),
    x: finiteNumber,
    y: finiteNumber,
    width: positive,
    height: positive,
})
    .strict();
const RelativeFrameSchema = z
    .object({
    type: z.literal("relative"),
    to: id,
    selfAnchor: AnchorSchema.default("center"),
    targetAnchor: AnchorSchema.default("center"),
    offset: OffsetSchema.default({ x: 0, y: 0 }),
    width: positive,
    height: positive,
})
    .strict();
const MirrorFrameSchema = z
    .object({
    type: z.literal("mirror"),
    of: id,
    axis: z.enum(["x", "y"]),
    at: finiteNumber,
    offset: OffsetSchema.default({ x: 0, y: 0 }),
})
    .strict();
export const FrameSchema = z.discriminatedUnion("type", [
    AbsoluteFrameSchema,
    RelativeFrameSchema,
    MirrorFrameSchema,
]);
export const ResolvedFrameSchema = z
    .object({ x: finiteNumber, y: finiteNumber, width: positive, height: positive })
    .strict();
const ColorRefSchema = z
    .string()
    .refine((value) => value === "none" || PALETTE_REF_PATTERN.test(value) || HEX_COLOR_PATTERN.test(value), "Use none, a palette reference such as @accent, or a hexadecimal color");
export const PaintSchema = z
    .object({
    fill: ColorRefSchema.default("none"),
    stroke: ColorRefSchema.default("none"),
    strokeWidth: nonNegative.max(32).default(0),
    opacity: finiteNumber.min(0).max(1).default(1),
    lineCap: z.enum(["butt", "round", "square"]).default("round"),
    lineJoin: z.enum(["miter", "round", "bevel"]).default("round"),
})
    .strict();
const BaseObjectSchema = z.object({
    id,
    frame: FrameSchema,
    visible: z.boolean().default(true),
});
const PaintedObjectSchema = BaseObjectSchema.extend({
    paint: PaintSchema,
});
const EllipseSchema = PaintedObjectSchema.extend({
    type: z.literal("ellipse"),
}).strict();
const RectangleSchema = PaintedObjectSchema.extend({
    type: z.literal("rectangle"),
}).strict();
const RoundedRectangleSchema = PaintedObjectSchema.extend({
    type: z.literal("rounded-rectangle"),
    radius: finiteNumber.min(0).max(50),
}).strict();
const PolygonSchema = PaintedObjectSchema.extend({
    type: z.literal("polygon"),
    points: z.array(PointSchema).min(3).max(64),
}).strict();
const LineSchema = PaintedObjectSchema.extend({
    type: z.literal("line"),
    from: PointSchema,
    to: PointSchema,
}).strict();
export const BezierNodeSchema = PointSchema.extend({
    in: HandleSchema.optional(),
    out: HandleSchema.optional(),
    smooth: z.boolean().default(false),
}).strict();
const BezierPathSchema = PaintedObjectSchema.extend({
    type: z.literal("bezier-path"),
    nodes: z.array(BezierNodeSchema).min(2).max(64),
    closed: z.boolean().default(true),
    fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
}).strict();
const CloneSchema = BaseObjectSchema.extend({
    type: z.literal("clone"),
    source: id,
    paint: PaintSchema.optional(),
}).strict();
const LayoutSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("free") }).strict(),
    z
        .object({
        type: z.enum(["row", "column"]),
        gap: nonNegative.max(100).default(0),
        padding: nonNegative.max(49).default(0),
        align: z.enum(["start", "center", "end"]).default("center"),
        justify: z.enum(["start", "center", "end"]).default("center"),
    })
        .strict(),
]);
export const DrawableSchema = z.lazy(() => z.discriminatedUnion("type", [
    EllipseSchema,
    RectangleSchema,
    RoundedRectangleSchema,
    PolygonSchema,
    LineSchema,
    BezierPathSchema,
    CloneSchema,
    BaseObjectSchema.extend({
        type: z.literal("group"),
        clipTo: id.optional(),
        layout: LayoutSchema.default({ type: "free" }),
        children: z.array(DrawableSchema).min(1).max(64),
    }).strict(),
]));
const ReferenceSchema = z
    .object({
    path: z.string().min(1),
    intent: z.enum(["adapt", "trace", "inspire"]).default("adapt"),
    note: z.string().max(500).optional(),
})
    .strict();
export const SceneSchema = z
    .object({
    version: z.literal(1),
    brief: z
        .object({
        prompt: z.string().min(1).max(2000),
        style: z.literal("flat-geometric").default("flat-geometric"),
        referenceIntent: z.enum(["adapt", "trace", "inspire"]).default("adapt"),
    })
        .strict(),
    canvas: z
        .object({
        width: finiteNumber.min(16).max(4096).default(256),
        height: finiteNumber.min(16).max(4096).default(256),
        background: ColorRefSchema.default("none"),
    })
        .strict(),
    palette: z.record(id, z.string().regex(HEX_COLOR_PATTERN, "Palette colors must be hexadecimal")),
    references: z.array(ReferenceSchema).max(8).default([]),
    layers: z.array(DrawableSchema).min(1).max(64),
})
    .strict();
export function sceneJsonSchema() {
    return z.toJSONSchema(SceneSchema, {
        target: "draft-2020-12",
        reused: "ref",
    });
}
