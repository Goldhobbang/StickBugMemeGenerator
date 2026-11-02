import type { Point } from './types';

/**
 * Separate a subject from a loose sketch.
 * Outside colors are the background. Inside pixels that match those colors
 * are dropped, so a rough loop does not keep the surrounding scene.
 * When the subject is the same color as the background, the sketch itself
 * is returned and `separated` is false.
 */
export interface CutoutMask {
  mask: Uint8Array;
  separated: boolean;
  foreground: number;
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersect = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Even-odd fill. Polygon is in pixel coordinates. */
export function rasterizePolygon(
  width: number,
  height: number,
  polygon: { x: number; y: number }[],
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (polygon.length < 3) return mask;
  for (let y = 0; y < height; y++) {
    const ys = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      if ((a.y <= ys && b.y > ys) || (b.y <= ys && a.y > ys)) {
        const t = (ys - a.y) / (b.y - a.y);
        crossings.push(a.x + (b.x - a.x) * t);
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(crossings[i]));
      const x1 = Math.min(width, Math.floor(crossings[i + 1]));
      const row = y * width;
      for (let x = x0; x < x1; x++) mask[row + x] = 1;
    }
  }
  return mask;
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = mask.slice();
  const r2 = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

function rgbAt(rgba: Uint8ClampedArray, index: number): [number, number, number] {
  const o = index * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2]];
}

function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function componentMask(mask: Uint8Array, width: number, _height: number, minArea: number): Uint8Array {
  const seen = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const stack: number[] = [];
  let bestArea = 0;
  let bestId = 0;
  const areas: number[] = [];
  const ids = new Int32Array(mask.length);
  let nextId = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    nextId++;
    let area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      ids[i] = nextId;
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      const neighbors = [i - 1, i + 1, i - width, i + width];
      for (let n = 0; n < 4; n++) {
        const j = neighbors[n];
        if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue;
        const nx = j % width;
        const ny = (j / width) | 0;
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    areas[nextId] = area;
    if (area > bestArea) {
      bestArea = area;
      bestId = nextId;
    }
  }
  for (let i = 0; i < mask.length; i++) {
    const id = ids[i];
    if (id && (id === bestId || areas[id] >= minArea)) out[i] = 1;
  }
  return out;
}

/** Keep the foreground component that overlaps the user's sketch the most. */
export function keepOverlappingComponent(
  mask: Uint8Array,
  region: Uint8Array,
  width: number,
  _height: number,
): Uint8Array {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let bestScore = 0;
  let best: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells: number[] = [];
    let score = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      score += region[i] ? 1 : 0;
      const x = i % width;
      const y = (i / width) | 0;
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= mask.length || seen[j] || !mask[j]) continue;
        const nx = j % width;
        const ny = (j / width) | 0;
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = cells;
    }
  }
  if (bestScore === 0) return mask;
  const out = new Uint8Array(mask.length);
  for (const i of best) out[i] = 1;
  return out;
}

export function cutoutForeground(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  polygonPx: { x: number; y: number }[],
): CutoutMask {
  const inside = rasterizePolygon(width, height, polygonPx);
  let insideCount = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside[y * width + x]) continue;
      insideCount++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (insideCount < 12) return { mask: inside, separated: false, foreground: insideCount };

  const pad = 14;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(width - 1, maxX + pad);
  const y1 = Math.min(height - 1, maxY + pad);
  const samples: [number, number, number][] = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 90)));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const i = y * width + x;
      if (inside[i]) continue;
      samples.push(rgbAt(rgba, i));
      if (samples.length >= 96) break;
    }
    if (samples.length >= 96) break;
  }
  if (samples.length < 8) return { mask: inside, separated: false, foreground: insideCount };

  const nearestBg = (index: number) => {
    const color = rgbAt(rgba, index);
    let best = Number.POSITIVE_INFINITY;
    for (let s = 0; s < samples.length; s++) {
      const d = dist2(color, samples[s]);
      if (d < best) best = d;
    }
    return best;
  };

  // Pixels this far from every nearby background sample are treated as subject.
  const subjectCut = 62 * 62;
  const mask = new Uint8Array(inside.length);
  let foreground = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    if (nearestBg(i) >= subjectCut) {
      mask[i] = 1;
      foreground++;
    }
  }
  if (foreground < 12 || foreground > insideCount * 0.92) {
    return { mask: inside, separated: false, foreground: insideCount };
  }

  const grown = dilate(mask, width, height, 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (inside[i] || !grown[i]) continue;
      if (nearestBg(i) >= subjectCut) {
        mask[i] = 1;
        foreground++;
      }
    }
  }

  const cleaned = componentMask(mask, width, height, Math.max(10, Math.round(foreground * 0.04)));
  let kept = 0;
  for (let i = 0; i < cleaned.length; i++) kept += cleaned[i];
  if (kept < 12) return { mask: inside, separated: false, foreground: insideCount };
  return { mask: cleaned, separated: true, foreground: kept };
}

function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Positive scribbles sit inside the sketch. Negative scribbles sit just
 * outside it, so the segmenter learns both the subject and the background.
 */
export function cutoutPrompts(polygon: Point[]): { positive: Point[]; negative: Point[] } {
  if (polygon.length < 3) return { positive: [], negative: [] };
  const positive: Point[] = [];
  const negative: Point[] = [];
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(0.04, Math.min(maxX - minX, maxY - minY));
  const offset = clamp(span * 0.12, 0.015, 0.06);
  const count = 12;
  const outward = signedArea(polygon) >= 0 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const f = t * polygon.length;
    const index = Math.floor(f) % polygon.length;
    const next = (index + 1) % polygon.length;
    const local = f - Math.floor(f);
    const a = polygon[index];
    const b = polygon[next];
    const x = a.x + (b.x - a.x) * local;
    const y = a.y + (b.y - a.y) * local;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Screen y grows downward. For a CCW loop the outward normal is (dy, -dx).
    const nx = (dy / len) * outward;
    const ny = (-dx / len) * outward;
    const inward = { x: clamp(x - nx * offset, 0, 1), y: clamp(y - ny * offset, 0, 1) };
    const outwardPoint = { x: clamp(x + nx * offset, 0, 1), y: clamp(y + ny * offset, 0, 1) };
    if (pointInPolygon(inward, polygon)) positive.push(inward);
    if (!pointInPolygon(outwardPoint, polygon)) negative.push(outwardPoint);
  }
  let cx = 0;
  let cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  const center = { x: cx / polygon.length, y: cy / polygon.length };
  if (pointInPolygon(center, polygon)) positive.unshift(center);
  return { positive: positive.slice(0, 14), negative: negative.slice(0, 14) };
}
