import type { Point, TargetSegment } from './types';
import { cutoutForeground, keepOverlappingComponent, rasterizePolygon } from './cutout';
import { t } from './i18n';

/**
 * Edge-guided, browser-only target tracer. This is deterministic computer
 * vision, NOT a learned image segmentation model. The user outlines an ROI,
 * whose boundary is refined toward nearby high-contrast pixel edges.
 */
export type TraceMode = 'outline' | 'details';
export interface TraceOptions {
  precision: number;
  maximumSegments: number;
  mode: TraceMode;
}
export interface TraceResult {
  segments: TargetSegment[];
  contour: Point[];
  note: string;
}
type P = { x: number; y: number };
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

function signedArea(points: P[]): number {
  let sum = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  });
  return sum / 2;
}
function resample(points: P[], step: number): P[] {
  const result: P[] = [];
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length];
    const n = Math.max(1, Math.ceil(dist(p, q) / step));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      result.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  });
  return result;
}
function segmentDistance(p: P, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < .00001) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function rdp(points: P[], epsilon: number): P[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let far = -1, best = epsilon;
    for (let i = start + 1; i < end; i++) {
      const d = segmentDistance(points[i], points[start], points[end]);
      if (d > best) { best = d; far = i; }
    }
    if (far !== -1) {
      keep[far] = 1;
      stack.push([start, far], [far, end]);
    }
  }
  return points.filter((_p, i) => keep[i] === 1);
}
function simplifyClosed(points: P[], eps: number): P[] {
  let split = 1;
  for (let i = 2; i < points.length; i++) {
    if (dist(points[i], points[0]) > dist(points[split], points[0])) split = i;
  }
  return [
    ...rdp(points.slice(0, split + 1), eps).slice(0, -1),
    ...rdp([...points.slice(split), points[0]], eps).slice(0, -1),
  ];
}
function gradientOf(frame: ImageData): Float32Array {
  const w = frame.width, h = frame.height;
  const gray = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = frame.data[j] * .2126 + frame.data[j + 1] * .7152 + frame.data[j + 2] * .0722;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
      + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
    const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
      + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
    mag[i] = Math.min(255, Math.hypot(gx, gy) / 4);
  }
  return mag;
}
function insideMask(points: P[], w: number, h: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  const src = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = src[i * 4 + 3] > 128 ? 1 : 0;
  return mask;
}
interface Candidate { a: P; b: P; score: number }
function internalLines(gradient: Float32Array, outline: P[], w: number, h: number, precision: number, max: number, providedMask?: Uint8Array): Candidate[] {
  if (max <= 0 || precision <= 20) return [];
  const mask = providedMask ?? insideMask(outline, w, h);
  const threshold = 33 + (100 - precision) * .76;
  const minLength = 5 + Math.pow((100 - precision) / 100, 1.4) * 18;
  const found: Candidate[] = [];
  for (const angle of [0, Math.PI / 6, Math.PI / 3, Math.PI / 2, Math.PI * 2 / 3, Math.PI * 5 / 6]) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const bins = new Map<number, number[]>();
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const idx = y * w + x;
      if (!mask[idx] || !mask[idx - 2] || !mask[idx + 2] ||
          !mask[idx - w * 2] || !mask[idx + w * 2] || gradient[idx] < threshold) continue;
      const rho = Math.round(-s * x + c * y);
      const t = c * x + s * y;
      const bin = bins.get(rho);
      if (bin) bin.push(t);
      else bins.set(rho, [t]);
    }
    for (const [rho, values] of bins) {
      if (values.length < minLength * .55) continue;
      values.sort((a, b) => a - b);
      let start = 0;
      for (let j = 1; j <= values.length; j++) {
        if (j < values.length && values[j] - values[j - 1] <= 3.4) continue;
        const len = values[j - 1] - values[start];
        const count = j - start;
        if (len >= minLength && count / len >= .48) {
          found.push({
            a: { x: values[start] * c - rho * s, y: values[start] * s + rho * c },
            b: { x: values[j - 1] * c - rho * s, y: values[j - 1] * s + rho * c },
            score: count,
          });
        }
        start = j;
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  for (const item of found) {
    const center = { x: (item.a.x + item.b.x) / 2, y: (item.a.y + item.b.y) / 2 };
    const angle = Math.atan2(item.b.y - item.a.y, item.b.x - item.a.x);
    if (chosen.some((p) => {
      const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
      const a = Math.atan2(p.b.y - p.a.y, p.b.x - p.a.x);
      return dist(center, c) < 7 && Math.abs(Math.sin(angle - a)) < .23;
    })) continue;
    chosen.push(item);
    if (chosen.length >= max) break;
  }
  return chosen;
}

function decimateClosed(points: P[], max: number): P[] {
  if (points.length <= max) return points.slice();
  const out: P[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * points.length / max)]);
  return out;
}

/** Keep the silhouette. A huge epsilon turns the subject into a blob. */
function simplifyOutline(points: P[], precision: number, budget: number): P[] {
  let epsilon = 0.65 + Math.pow((100 - precision) / 100, 1.5) * 4.5;
  let simple = simplifyClosed(points, epsilon);
  let guard = 0;
  while (simple.length > Math.max(budget, 3) * 1.35 && epsilon < 12 && guard++ < 8) {
    epsilon = epsilon * 1.16 + 0.2;
    simple = simplifyClosed(points, epsilon);
  }
  if (simple.length > budget) simple = decimateClosed(simple, budget);
  return simple.length >= 3 ? simple : points.slice(0, Math.max(3, Math.min(points.length, budget)));
}

function outerContour(binary: Uint8Array, w: number, h: number): P[] {
  const stride = w + 1;
  const next = new Map<number, number[]>();
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const a = ay * stride + ax;
    const b = by * stride + bx;
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!binary[i]) continue;
      if (y === 0 || !binary[i - w]) edge(x, y, x + 1, y);
      if (x === w - 1 || !binary[i + 1]) edge(x + 1, y, x + 1, y + 1);
      if (y === h - 1 || !binary[i + w]) edge(x + 1, y + 1, x, y + 1);
      if (x === 0 || !binary[i - 1]) edge(x, y + 1, x, y);
    }
  }
  let largest: P[] = [];
  let largestArea = 0;
  for (const [first, edges] of next) {
    while (edges.length) {
      const ring: P[] = [];
      let at = first;
      let closed = false;
      let steps = 0;
      while (steps++ < w * h * 4) {
        ring.push({ x: at % stride, y: Math.floor(at / stride) });
        const choices = next.get(at);
        if (!choices?.length) break;
        at = choices.pop()!;
        if (at === first) {
          closed = true;
          break;
        }
      }
      if (closed && ring.length >= 3) {
        const area = Math.abs(signedArea(ring));
        if (area > largestArea) {
          largestArea = area;
          largest = ring;
        }
      }
    }
  }
  return largestArea >= 40 ? largest : [];
}

function ringTargets(
  simple: P[],
  normalize: (p: P) => Point,
): TargetSegment[] {
  const targets: TargetSegment[] = [];
  simple.forEach((p, i) => {
    const next = simple[(i + 1) % simple.length];
    if (dist(p, next) < 1.1) return;
    targets.push({
      id: 't' + targets.length,
      start: normalize(p),
      end: normalize(next),
      order: targets.length,
    });
  });
  return targets;
}

/** Polygon coordinates are normalized 0..1, as are output targets. */
export function traceSelectedRegion(frame: ImageData, roughPolygon: Point[], options: TraceOptions): TraceResult {
  if (roughPolygon.length < 3) throw new Error(t('err.sketchLoop'));
  const precision = clamp(options.precision, 0, 100);
  const maximum = Math.round(clamp(options.maximumSegments, 3, 200));
  const scale = Math.min(1, 512 / Math.max(frame.width, frame.height));
  const w = Math.max(16, Math.round(frame.width * scale));
  const h = Math.max(16, Math.round(frame.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext('2d')!.putImageData(frame, 0, 0);
  const sample = document.createElement('canvas');
  sample.width = w;
  sample.height = h;
  const ctx = sample.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const points: P[] = roughPolygon.map((p) => ({
    x: clamp(p.x, 0, 1) * (w - 1),
    y: clamp(p.y, 0, 1) * (h - 1),
  }));
  if (Math.abs(signedArea(points)) < 80) throw new Error(t('err.areaSmall'));
  const cut = cutoutForeground(image.data, w, h, points);
  const fromMask = cut.separated ? outerContour(cut.mask, w, h) : [];
  const dense = fromMask.length >= 3 ? fromMask : resample(points, 2);
  const budget = options.mode === 'outline' ? maximum : Math.max(4, Math.floor(maximum * 0.82));
  const simple = simplifyOutline(dense, precision, budget);
  const normalize = (p: P): Point => ({
    x: clamp(p.x / Math.max(1, w - 1), 0, 1),
    y: clamp(p.y / Math.max(1, h - 1), 0, 1),
  });
  const targets = ringTargets(simple, normalize);
  const detailBudget = options.mode === 'details' ? Math.min(6, maximum - targets.length) : 0;
  const extra = detailBudget > 0
    ? internalLines(gradientOf(image), dense, w, h, precision, detailBudget, cut.mask)
    : [];
  extra.forEach(({ a, b }) => {
    targets.push({
      id: 't' + targets.length,
      start: normalize(a),
      end: normalize(b),
      order: targets.length,
    });
  });
  if (!targets.length) throw new Error(t('err.noLines'));
  return {
    segments: targets,
    contour: dense.map(normalize),
    note: t(cut.separated ? 'trace.cutout' : 'trace.sketch', {
      n: targets.length,
      outline: targets.length - extra.length,
      details: extra.length,
    }),
  };
}


/**
 * Convert a learned model's foreground confidence mask to the same editable
 * line data as local tracing. AI selects the object; precision controls the
 * VECTOR tracing step, not model inference confidence.
 */
export function traceSegmentationMask(
  frame: ImageData,
  modelMask: Float32Array,
  modelWidth: number,
  modelHeight: number,
  options: TraceOptions,
  sketch: Point[] = [],
): TraceResult {
  if (modelMask.length !== modelWidth * modelHeight)
    throw new Error(t('err.maskSize'));
  const precision = clamp(options.precision, 0, 100);
  const maxSegments = Math.round(clamp(options.maximumSegments, 3, 200));
  const scale = Math.min(1, 512 / Math.max(frame.width, frame.height));
  const w = Math.max(16, Math.round(frame.width * scale));
  const h = Math.max(16, Math.round(frame.height * scale));
  let peak = 0;
  for (let i = 0; i < modelMask.length; i++) if (modelMask[i] > peak) peak = modelMask[i];
  const confidence = peak > 1.5 ? 1 / peak : 1;
  let binary = new Uint8Array(w * h);
  let foreground = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const mx = Math.min(modelWidth - 1, Math.round(x * (modelWidth - 1) / Math.max(1, w - 1)));
    const my = Math.min(modelHeight - 1, Math.round(y * (modelHeight - 1) / Math.max(1, h - 1)));
    const selected = modelMask[my * modelWidth + mx] * confidence >= 0.42 ? 1 : 0;
    binary[y * w + x] = selected;
    foreground += selected;
  }
  if (sketch.length >= 3) {
    const region = rasterizePolygon(w, h, sketch.map((p) => ({
      x: clamp(p.x, 0, 1) * (w - 1),
      y: clamp(p.y, 0, 1) * (h - 1),
    })));
    binary = new Uint8Array(keepOverlappingComponent(binary, region, w, h));
    foreground = 0;
    for (let i = 0; i < binary.length; i++) foreground += binary[i];
  }
  if (foreground < 20 || foreground > 0.97 * w * h)
    throw new Error(t('err.aiIsolate'));

  const largest = outerContour(binary, w, h);
  if (largest.length < 3)
    throw new Error(t('err.aiOutline'));
  const budget = options.mode === 'outline' ? maxSegments : Math.max(4, Math.floor(maxSegments * 0.82));
  const simple = simplifyOutline(largest, precision, budget);

  const normalize = (p: P): Point => ({
    x: clamp(p.x / w, 0, 1), y: clamp(p.y / h, 0, 1),
  });
  const targets: TargetSegment[] = [];
  simple.forEach((p, i) => {
    const q = simple[(i + 1) % simple.length];
    if (dist(p, q) < 1.2) return;
    targets.push({ id: 't' + targets.length, order: targets.length,
      start: normalize(p), end: normalize(q) });
  });
  const source = document.createElement('canvas');
  source.width = frame.width; source.height = frame.height;
  source.getContext('2d')!.putImageData(frame, 0, 0);
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const gradients = gradientOf(ctx.getImageData(0, 0, w, h));
  const detailBudget = options.mode === 'details' ? Math.min(6, maxSegments - targets.length) : 0;
  const details = detailBudget > 0
    ? internalLines(gradients, largest, w, h, precision, detailBudget, binary)
    : [];
  details.forEach(({ a, b }) => {
    targets.push({ id: 't' + targets.length, order: targets.length,
      start: normalize(a), end: normalize(b) });
  });
  if (targets.length < 3) throw new Error(t('err.aiFew'));
  return {
    segments: targets,
    contour: largest.map(normalize),
    note: t('trace.ai', {
      n: targets.length,
      outline: targets.length - details.length,
      details: details.length,
    }),
  };
}
