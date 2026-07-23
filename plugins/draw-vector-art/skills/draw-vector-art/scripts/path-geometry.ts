import type { CompoundSubpath, PathSegment, Point, ResolvedFrame } from "./schema.js";

export interface CubicArcSegment {
  control1: Point;
  control2: Point;
  to: Point;
}

function samePoint(left: Point, right: Point, epsilon = 1e-9): boolean {
  return Math.abs(left.x - right.x) < epsilon && Math.abs(left.y - right.y) < epsilon;
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

export function arcToCubics(from: Point, segment: Extract<PathSegment, { type: "arc" }>): CubicArcSegment[] {
  const to = segment.to;
  if (samePoint(from, to)) return [];

  let radiusX = Math.abs(segment.radius.x);
  let radiusY = Math.abs(segment.radius.y);
  const rotation = ((segment.rotation % 360) * Math.PI) / 180;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const halfX = (from.x - to.x) / 2;
  const halfY = (from.y - to.y) / 2;
  const transformedX = cosine * halfX + sine * halfY;
  const transformedY = -sine * halfX + cosine * halfY;

  const radiiScale = transformedX ** 2 / radiusX ** 2 + transformedY ** 2 / radiusY ** 2;
  if (radiiScale > 1) {
    const correction = Math.sqrt(radiiScale);
    radiusX *= correction;
    radiusY *= correction;
  }

  const numerator = Math.max(
    0,
    radiusX ** 2 * radiusY ** 2 - radiusX ** 2 * transformedY ** 2 - radiusY ** 2 * transformedX ** 2,
  );
  const denominator = radiusX ** 2 * transformedY ** 2 + radiusY ** 2 * transformedX ** 2;
  const direction = segment.largeArc === (segment.sweep === "clockwise") ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : direction * Math.sqrt(numerator / denominator);
  const centerPrimeX = coefficient * ((radiusX * transformedY) / radiusY);
  const centerPrimeY = coefficient * (-(radiusY * transformedX) / radiusX);
  const centerX = cosine * centerPrimeX - sine * centerPrimeY + (from.x + to.x) / 2;
  const centerY = sine * centerPrimeX + cosine * centerPrimeY + (from.y + to.y) / 2;

  const startVectorX = (transformedX - centerPrimeX) / radiusX;
  const startVectorY = (transformedY - centerPrimeY) / radiusY;
  const endVectorX = (-transformedX - centerPrimeX) / radiusX;
  const endVectorY = (-transformedY - centerPrimeY) / radiusY;
  const startAngle = vectorAngle(1, 0, startVectorX, startVectorY);
  let sweepAngle = vectorAngle(startVectorX, startVectorY, endVectorX, endVectorY);
  if (segment.sweep === "clockwise" && sweepAngle < 0) sweepAngle += Math.PI * 2;
  if (segment.sweep === "counterclockwise" && sweepAngle > 0) sweepAngle -= Math.PI * 2;

  const sectionCount = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const sectionAngle = sweepAngle / sectionCount;
  const pointAndDerivative = (angle: number): { point: Point; derivative: Point } => {
    const angleCosine = Math.cos(angle);
    const angleSine = Math.sin(angle);
    return {
      point: {
        x: centerX + radiusX * cosine * angleCosine - radiusY * sine * angleSine,
        y: centerY + radiusX * sine * angleCosine + radiusY * cosine * angleSine,
      },
      derivative: {
        x: -radiusX * cosine * angleSine - radiusY * sine * angleCosine,
        y: -radiusX * sine * angleSine + radiusY * cosine * angleCosine,
      },
    };
  };

  const output: CubicArcSegment[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionStart = startAngle + index * sectionAngle;
    const sectionEnd = sectionStart + sectionAngle;
    const start = pointAndDerivative(sectionStart);
    const end = pointAndDerivative(sectionEnd);
    const alpha = (4 / 3) * Math.tan(sectionAngle / 4);
    output.push({
      control1: {
        x: start.point.x + alpha * start.derivative.x,
        y: start.point.y + alpha * start.derivative.y,
      },
      control2: {
        x: end.point.x - alpha * end.derivative.x,
        y: end.point.y - alpha * end.derivative.y,
      },
      to: index === sectionCount - 1 ? to : end.point,
    });
  }
  return output;
}

function pointOnQuadratic(a: Point, b: Point, c: Point, t: number): Point {
  const opposite = 1 - t;
  return {
    x: opposite ** 2 * a.x + 2 * opposite * t * b.x + t ** 2 * c.x,
    y: opposite ** 2 * a.y + 2 * opposite * t * b.y + t ** 2 * c.y,
  };
}

function pointOnCubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const opposite = 1 - t;
  return {
    x: opposite ** 3 * a.x + 3 * opposite ** 2 * t * b.x + 3 * opposite * t ** 2 * c.x + t ** 3 * d.x,
    y: opposite ** 3 * a.y + 3 * opposite ** 2 * t * b.y + 3 * opposite * t ** 2 * c.y + t ** 3 * d.y,
  };
}

export function flattenCompoundSubpath(subpath: CompoundSubpath, steps = 12): Point[] {
  const points: Point[] = [subpath.start];
  let current = subpath.start;
  for (const segment of subpath.segments) {
    if (segment.type === "line") {
      points.push(segment.to);
    } else if (segment.type === "quadratic") {
      for (let step = 1; step <= steps; step += 1) {
        points.push(pointOnQuadratic(current, segment.control, segment.to, step / steps));
      }
    } else if (segment.type === "cubic") {
      for (let step = 1; step <= steps; step += 1) {
        points.push(pointOnCubic(current, segment.control1, segment.control2, segment.to, step / steps));
      }
    } else {
      for (const cubic of arcToCubics(current, segment)) {
        for (let step = 1; step <= steps; step += 1) {
          points.push(pointOnCubic(current, cubic.control1, cubic.control2, cubic.to, step / steps));
        }
        current = cubic.to;
      }
      if (samePoint(current, segment.to)) continue;
    }
    current = segment.to;
  }
  return points;
}

function mapPoint(point: Point, frame: ResolvedFrame): Point {
  return {
    x: frame.x + (point.x / 100) * frame.width,
    y: frame.y + (point.y / 100) * frame.height,
  };
}

export function compoundPathData(
  subpaths: CompoundSubpath[],
  frame: ResolvedFrame,
  format: (value: number) => string,
): string {
  const commands: string[] = [];
  for (const subpath of subpaths) {
    let current = subpath.start;
    const start = mapPoint(current, frame);
    commands.push(`M ${format(start.x)} ${format(start.y)}`);
    for (const segment of subpath.segments) {
      if (segment.type === "line") {
        const to = mapPoint(segment.to, frame);
        commands.push(`L ${format(to.x)} ${format(to.y)}`);
      } else if (segment.type === "quadratic") {
        const control = mapPoint(segment.control, frame);
        const to = mapPoint(segment.to, frame);
        commands.push(`Q ${format(control.x)} ${format(control.y)} ${format(to.x)} ${format(to.y)}`);
      } else if (segment.type === "cubic") {
        const control1 = mapPoint(segment.control1, frame);
        const control2 = mapPoint(segment.control2, frame);
        const to = mapPoint(segment.to, frame);
        commands.push(
          `C ${format(control1.x)} ${format(control1.y)} ${format(control2.x)} ${format(control2.y)} ${format(to.x)} ${format(to.y)}`,
        );
      } else {
        const cubics = arcToCubics(current, segment);
        if (cubics.length === 0) throw new Error("Arc start and endpoint must differ");
        for (const cubic of cubics) {
          const control1 = mapPoint(cubic.control1, frame);
          const control2 = mapPoint(cubic.control2, frame);
          const to = mapPoint(cubic.to, frame);
          commands.push(
            `C ${format(control1.x)} ${format(control1.y)} ${format(control2.x)} ${format(control2.y)} ${format(to.x)} ${format(to.y)}`,
          );
        }
      }
      current = segment.to;
    }
    if (subpath.closed) commands.push("Z");
  }
  return commands.join(" ");
}

export function pointsEqual(left: Point, right: Point): boolean {
  return samePoint(left, right);
}
