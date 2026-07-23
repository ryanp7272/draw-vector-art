import type { Point, ResolvedFrame, Transform } from "./schema.js";

export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface TransformSpace {
  frame: ResolvedFrame;
  unitsWidth: number;
  unitsHeight: number;
}

export const IDENTITY_MATRIX: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyMatrices(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function translationMatrix(x: number, y: number): AffineMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaleMatrix(x: number, y: number): AffineMatrix {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function rotationMatrix(degrees: number): AffineMatrix {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 };
}

export function skewXMatrix(degrees: number): AffineMatrix {
  return { a: 1, b: 0, c: Math.tan((degrees * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

export function skewYMatrix(degrees: number): AffineMatrix {
  return { a: 1, b: Math.tan((degrees * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
}

export function applyMatrix(matrix: AffineMatrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function matrixPower(matrix: AffineMatrix, exponent: number): AffineMatrix {
  let result = IDENTITY_MATRIX;
  let factor = matrix;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = multiplyMatrices(result, factor);
    factor = multiplyMatrices(factor, factor);
    remaining = Math.floor(remaining / 2);
  }
  return result;
}

export function transformMatrix(
  transform: Transform | undefined,
  frame: ResolvedFrame,
  space: TransformSpace,
): AffineMatrix {
  if (!transform) return IDENTITY_MATRIX;
  const origin = {
    x: frame.x + (transform.origin.x / 100) * frame.width,
    y: frame.y + (transform.origin.y / 100) * frame.height,
  };
  const translateX = (transform.translate.x / space.unitsWidth) * space.frame.width;
  const translateY = (transform.translate.y / space.unitsHeight) * space.frame.height;
  return [
    translationMatrix(translateX, translateY),
    translationMatrix(origin.x, origin.y),
    rotationMatrix(transform.rotate),
    skewYMatrix(transform.skew.y),
    skewXMatrix(transform.skew.x),
    scaleMatrix(transform.scale.x, transform.scale.y),
    translationMatrix(-origin.x, -origin.y),
  ].reduce(multiplyMatrices, IDENTITY_MATRIX);
}

export function frameMapMatrix(source: ResolvedFrame, target: ResolvedFrame): AffineMatrix {
  return [
    translationMatrix(target.x, target.y),
    scaleMatrix(target.width / source.width, target.height / source.height),
    translationMatrix(-source.x, -source.y),
  ].reduce(multiplyMatrices, IDENTITY_MATRIX);
}

export function mirrorMatrix(frame: ResolvedFrame, axis: "x" | "y"): AffineMatrix {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return axis === "x"
    ? multiplyMatrices(
        translationMatrix(2 * centerX, 0),
        scaleMatrix(-1, 1),
      )
    : multiplyMatrices(
        translationMatrix(0, 2 * centerY),
        scaleMatrix(1, -1),
      );
}

export function frameCorners(frame: ResolvedFrame, matrix: AffineMatrix = IDENTITY_MATRIX): Point[] {
  return [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.width, y: frame.y },
    { x: frame.x + frame.width, y: frame.y + frame.height },
    { x: frame.x, y: frame.y + frame.height },
  ].map((point) => applyMatrix(matrix, point));
}

export function boundsForPoints(points: Point[]): ResolvedFrame {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

export function isIdentityMatrix(matrix: AffineMatrix, epsilon = 1e-10): boolean {
  return (
    Math.abs(matrix.a - 1) < epsilon &&
    Math.abs(matrix.b) < epsilon &&
    Math.abs(matrix.c) < epsilon &&
    Math.abs(matrix.d - 1) < epsilon &&
    Math.abs(matrix.e) < epsilon &&
    Math.abs(matrix.f) < epsilon
  );
}
