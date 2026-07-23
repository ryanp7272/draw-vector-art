import { z } from "zod";

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const PALETTE_REF_PATTERN = /^@[a-z][a-z0-9-]*$/;
export const GRADIENT_REF_PATTERN = /^gradient:[a-z][a-z0-9-]*$/;
export const EFFECT_REF_PATTERN = /^effect:[a-z][a-z0-9-]*$/;
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const finiteNumber = z.number().finite();
const localCoordinate = finiteNumber.min(0).max(100);
const handleCoordinate = finiteNumber.min(-100).max(100);
const nonNegative = finiteNumber.min(0);
const positive = finiteNumber.gt(0);
const localPositive = finiteNumber.min(0.001).max(100);
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

export type Anchor = z.infer<typeof AnchorSchema>;

export const PointSchema = z
  .object({ x: localCoordinate, y: localCoordinate })
  .strict();

export type Point = z.infer<typeof PointSchema>;

const HandleSchema = z
  .object({ x: handleCoordinate, y: handleCoordinate })
  .strict();

const OffsetSchema = z
  .object({ x: finiteNumber.default(0), y: finiteNumber.default(0) })
  .strict();

const ScaleFactorSchema = z.union([
  finiteNumber.min(-8).max(-0.01),
  finiteNumber.min(0.01).max(8),
]);

const ScaleSchema = z
  .object({ x: ScaleFactorSchema.default(1), y: ScaleFactorSchema.default(1) })
  .strict();

const SkewSchema = z
  .object({ x: finiteNumber.min(-80).max(80).default(0), y: finiteNumber.min(-80).max(80).default(0) })
  .strict();

export const TransformSchema = z
  .object({
    origin: PointSchema.default({ x: 50, y: 50 }),
    translate: OffsetSchema.default({ x: 0, y: 0 }),
    rotate: finiteNumber.min(-360).max(360).default(0),
    scale: ScaleSchema.default({ x: 1, y: 1 }),
    skew: SkewSchema.default({ x: 0, y: 0 }),
  })
  .strict();

export type Transform = z.infer<typeof TransformSchema>;

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

export type Frame = z.infer<typeof FrameSchema>;

export const ResolvedFrameSchema = z
  .object({ x: finiteNumber, y: finiteNumber, width: positive, height: positive })
  .strict();

export type ResolvedFrame = z.infer<typeof ResolvedFrameSchema>;

const PaintColorRefSchema = z
  .string()
  .refine(
    (value) =>
      value === "none" ||
      PALETTE_REF_PATTERN.test(value) ||
      GRADIENT_REF_PATTERN.test(value) ||
      HEX_COLOR_PATTERN.test(value),
    "Use none, a palette reference, a named gradient such as gradient:sunlit, or a hexadecimal color",
  );

const EffectRefSchema = z
  .string()
  .regex(EFFECT_REF_PATTERN, "Use a named effect reference such as effect:lift");

export const PaintSchema = z
  .object({
    fill: PaintColorRefSchema.default("none"),
    stroke: PaintColorRefSchema.default("none"),
    strokeWidth: nonNegative.max(32).default(0),
    opacity: finiteNumber.min(0).max(1).default(1),
    lineCap: z.enum(["butt", "round", "square"]).default("round"),
    lineJoin: z.enum(["miter", "round", "bevel"]).default("round"),
    effect: EffectRefSchema.optional(),
  })
  .strict();

export type Paint = z.infer<typeof PaintSchema>;

const BaseObjectSchema = z.object({
  id,
  frame: FrameSchema,
  visible: z.boolean().default(true),
  template: z.boolean().default(false),
  transform: TransformSchema.optional(),
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

export type BezierNode = z.infer<typeof BezierNodeSchema>;

const BezierPathSchema = PaintedObjectSchema.extend({
  type: z.literal("bezier-path"),
  nodes: z.array(BezierNodeSchema).min(2).max(64),
  closed: z.boolean().default(true),
  fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
}).strict();

const LinePathSegmentSchema = z
  .object({ type: z.literal("line"), to: PointSchema })
  .strict();

const QuadraticPathSegmentSchema = z
  .object({ type: z.literal("quadratic"), control: PointSchema, to: PointSchema })
  .strict();

const CubicPathSegmentSchema = z
  .object({ type: z.literal("cubic"), control1: PointSchema, control2: PointSchema, to: PointSchema })
  .strict();

const ArcPathSegmentSchema = z
  .object({
    type: z.literal("arc"),
    radius: z.object({ x: localPositive, y: localPositive }).strict(),
    rotation: finiteNumber.min(-360).max(360).default(0),
    largeArc: z.boolean().default(false),
    sweep: z.enum(["clockwise", "counterclockwise"]).default("clockwise"),
    to: PointSchema,
  })
  .strict();

export const PathSegmentSchema = z.discriminatedUnion("type", [
  LinePathSegmentSchema,
  QuadraticPathSegmentSchema,
  CubicPathSegmentSchema,
  ArcPathSegmentSchema,
]);

export type PathSegment = z.infer<typeof PathSegmentSchema>;

export const CompoundSubpathSchema = z
  .object({
    start: PointSchema,
    segments: z.array(PathSegmentSchema).min(1).max(64),
    closed: z.boolean().default(true),
  })
  .strict();

export type CompoundSubpath = z.infer<typeof CompoundSubpathSchema>;

const CompoundPathSchema = PaintedObjectSchema.extend({
  type: z.literal("compound-path"),
  subpaths: z.array(CompoundSubpathSchema).min(1).max(16),
  fillRule: z.enum(["nonzero", "evenodd"]).default("evenodd"),
}).strict();

const CloneSchema = BaseObjectSchema.extend({
  type: z.literal("clone"),
  source: id,
  paint: PaintSchema.optional(),
}).strict();

const InstanceSchema = BaseObjectSchema.extend({
  type: z.literal("instance"),
  source: id,
}).strict();

const RepeaterSchema = BaseObjectSchema.extend({
  type: z.literal("repeater"),
  source: id,
  count: z.number().int().min(1).max(32),
  step: TransformSchema,
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

export type Drawable =
  | z.infer<typeof EllipseSchema>
  | z.infer<typeof RectangleSchema>
  | z.infer<typeof RoundedRectangleSchema>
  | z.infer<typeof PolygonSchema>
  | z.infer<typeof LineSchema>
  | z.infer<typeof BezierPathSchema>
  | z.infer<typeof CompoundPathSchema>
  | z.infer<typeof CloneSchema>
  | z.infer<typeof InstanceSchema>
  | z.infer<typeof RepeaterSchema>
  | Group;

export interface Group {
  id: string;
  type: "group";
  frame: Frame;
  visible: boolean;
  template: boolean;
  transform?: Transform | undefined;
  clipTo?: string | undefined;
  layout: z.infer<typeof LayoutSchema>;
  children: Drawable[];
}

export const DrawableSchema: z.ZodType<Drawable> = z.lazy(() =>
  z.discriminatedUnion("type", [
    EllipseSchema,
    RectangleSchema,
    RoundedRectangleSchema,
    PolygonSchema,
    LineSchema,
    BezierPathSchema,
    CompoundPathSchema,
    CloneSchema,
    InstanceSchema,
    RepeaterSchema,
    BaseObjectSchema.extend({
      type: z.literal("group"),
      clipTo: id.optional(),
      layout: LayoutSchema.default({ type: "free" }),
      children: z.array(DrawableSchema).min(1).max(64),
    }).strict(),
  ]),
);

const ReferenceSchema = z
  .object({
    path: z.string().min(1),
    intent: z.enum(["adapt", "trace", "inspire"]).default("adapt"),
    note: z.string().max(500).optional(),
  })
  .strict();

const GradientStopSchema = z
  .object({
    offset: finiteNumber.min(0).max(100),
    color: z
      .string()
      .refine(
        (value) => PALETTE_REF_PATTERN.test(value) || HEX_COLOR_PATTERN.test(value),
        "Gradient stops use a palette reference or hexadecimal color",
      ),
    opacity: finiteNumber.min(0).max(1).default(1),
  })
  .strict();

const LinearGradientSchema = z
  .object({
    type: z.literal("linear"),
    from: PointSchema,
    to: PointSchema,
    stops: z.array(GradientStopSchema).min(2).max(8),
  })
  .strict();

const RadialGradientSchema = z
  .object({
    type: z.literal("radial"),
    center: PointSchema,
    focal: PointSchema.optional(),
    radius: localCoordinate.gt(0),
    stops: z.array(GradientStopSchema).min(2).max(8),
  })
  .strict();

export const GradientSchema = z.discriminatedUnion("type", [LinearGradientSchema, RadialGradientSchema]);
export type Gradient = z.infer<typeof GradientSchema>;

const ShadowEffectSchema = z
  .object({
    type: z.literal("shadow"),
    dx: finiteNumber.min(-32).max(32).default(0),
    dy: finiteNumber.min(-32).max(32).default(4),
    blur: nonNegative.max(16).default(4),
    color: z
      .string()
      .refine(
        (value) => PALETTE_REF_PATTERN.test(value) || HEX_COLOR_PATTERN.test(value),
        "Shadow colors use a palette reference or hexadecimal color",
      ),
    opacity: finiteNumber.gt(0).max(1).default(0.25),
  })
  .strict();

export const EffectSchema = ShadowEffectSchema;
export type Effect = z.infer<typeof EffectSchema>;

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
        background: PaintColorRefSchema.default("none"),
      })
      .strict(),
    palette: z.record(id, z.string().regex(HEX_COLOR_PATTERN, "Palette colors must be hexadecimal")),
    gradients: z.record(id, GradientSchema).default({}),
    effects: z.record(id, EffectSchema).default({}),
    references: z.array(ReferenceSchema).max(8).default([]),
    layers: z.array(DrawableSchema).min(1).max(64),
  })
  .strict();

export type Scene = z.infer<typeof SceneSchema>;

export function sceneJsonSchema(): unknown {
  return z.toJSONSchema(SceneSchema, {
    target: "draft-2020-12",
    reused: "ref",
    io: "input",
  });
}
