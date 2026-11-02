import type { Easing, Point } from './types';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function applyEasing(t: number, easing: Easing): number {
  const c = Math.min(1, Math.max(0, t));
  if (easing === 'linear') return c;
  if (easing === 'ease-out') return 1 - Math.pow(1 - c, 3);
  // ease-in-out cubic
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

export function segmentLengthPx(a: Point, b: Point, w: number, h: number): number {
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.hypot(dx, dy);
}

export function distToSegmentPx(
  p: Point,
  a: Point,
  b: Point,
  w: number,
  h: number,
): number {
  const px = p.x * w;
  const py = p.y * h;
  const ax = a.x * w;
  const ay = a.y * h;
  const bx = b.x * w;
  const by = b.y * h;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
