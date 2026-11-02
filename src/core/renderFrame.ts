import type { Point, Settings, UserSegment, TargetSegment, DecodedFrame } from './types';
import { applyEasing, lerpPoint } from './interpolation';
import { computeTimeline } from './timeline';
import { fitSegmentsToTargets } from './segmentMapping';

export interface RenderProject {
  image: HTMLImageElement | null;
  userSegments: UserSegment[]; // sorted by order
  template: TargetSegment[];
  targetById: Map<string, TargetSegment>;
  settings: Settings;
  gifWidth: number;
  gifHeight: number;
  memeFrames: DecodedFrame[];
  memeStartIndex: number;
  memeDuration: number;
}

export function currentSegmentsAt(
  t: number,
  proj: RenderProject,
): { start: Point; end: Point }[] {
  const s = proj.settings;
  const segs = [...proj.userSegments].sort((a, b) => a.order - b.order);
  const n = segs.length;
  const timeline = computeTimeline(n, s, proj.memeDuration);
  const { revealDuration, phaseCEnd, phaseDEnd } = timeline;
  const fitted = fitSegmentsToTargets(segs, proj.targetById);

  // Count revealed during phase A; all visible afterwards (until F hides them).
  let visibleCount = n;
  if (t < 0 || n === 0) visibleCount = 0;
  else if (revealDuration > 0 && t < revealDuration) {
    // Reveal one complete line at each equally spaced point of the total
    // reveal period. The first line appears immediately, the last before
    // the hold phase, regardless of how many lines the template requires.
    visibleCount = Math.min(n, Math.floor((t / revealDuration) * n) + 1);
  }

  let easedT = 0;
  if (t >= phaseDEnd) easedT = 1;
  else if (t > phaseCEnd && s.transformDuration > 0) {
    easedT = applyEasing((t - phaseCEnd) / s.transformDuration, s.easing);
  }

  const result: { start: Point; end: Point }[] = [];
  for (let i = 0; i < visibleCount && i < n; i++) {
    const u = segs[i];
    const destination = fitted.get(u.id);
    if (!destination) {
      result.push({ start: u.start, end: u.end });
      continue;
    }
    result.push({
      start: lerpPoint(u.start, destination.start, easedT),
      end: lerpPoint(u.end, destination.end, easedT),
    });
  }
  return result;
}

export function isGrayPhase(t: number, proj: RenderProject): boolean {
  const timeline = computeTimeline(proj.userSegments.length, proj.settings, proj.memeDuration);
  return t >= timeline.phaseBEnd;
}

export function memeTimeAt(t: number, proj: RenderProject): number {
  const tl = computeTimeline(proj.userSegments.length, proj.settings, proj.memeDuration);
  const mt = t - tl.phaseEEnd;
  if (proj.memeDuration <= 0) return 0;
  return ((mt % proj.memeDuration) + proj.memeDuration) % proj.memeDuration;
}

function drawContainCover(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  img: HTMLImageElement | ImageBitmap,
  iw: number,
  ih: number,
  cw: number,
  ch: number,
  fit: 'contain' | 'cover',
  bg: string | null,
): void {
  if (bg) {
    (ctx as CanvasRenderingContext2D).fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
  }
  const scale = fit === 'contain' ? Math.min(cw / iw, ch / ih) : Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  // biome-ignore lint: canvas drawImage accepts both
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).drawImage(img, dx, dy, dw, dh);
}

/** Deterministic frame renderer. Same logic drives preview + export. */
export function renderFrame(
  timeSeconds: number,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  proj: RenderProject,
): void {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return;
  const s = proj.settings;
  const tl = computeTimeline(proj.userSegments.length, s, proj.memeDuration);
  const t = timeSeconds;

  if (t >= tl.phaseEEnd) {
    // Phase F: original meme footage only.
    const mt = memeTimeAt(t, proj);
    let acc = 0;
    let frame = proj.memeFrames[proj.memeStartIndex] ?? proj.memeFrames[0];
    for (let i = proj.memeStartIndex; i < proj.memeFrames.length; i++) {
      const d = proj.memeFrames[i].delaySec;
      if (mt < acc + d) {
        frame = proj.memeFrames[i];
        break;
      }
      acc += d;
      frame = proj.memeFrames[i];
    }
    if (frame) {
      // Draw composited ImageData scaled to canvas. Nearest-neighbor:
      // source palette pixels must not be smoothed.
      const tmp = getBlitCanvas(proj.gifWidth, proj.gifHeight);
      const tctx = tmp.getContext('2d');
      if (tctx) {
        tctx.putImageData(frame.imageData, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, W, H);
        // biome-ignore lint
        (ctx as CanvasRenderingContext2D).drawImage(tmp, 0, 0, W, H);
      }
    }
    return;
  }

  // Phases A–E.
  const gray = isGrayPhase(t, proj);
  if (gray) {
    (ctx as CanvasRenderingContext2D).fillStyle = s.backgroundColor;
    ctx.fillRect(0, 0, W, H);
  } else if (proj.image) {
    const iw = (proj.image as HTMLImageElement).naturalWidth || proj.gifWidth;
    const ih = (proj.image as HTMLImageElement).naturalHeight || proj.gifHeight;
    drawContainCover(ctx, proj.image, iw, ih, W, H, s.imageFit, '#000');
  } else {
    (ctx as CanvasRenderingContext2D).fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  const segs = currentSegmentsAt(t, proj);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const scale = Math.max(W / proj.gifWidth, 1);
  ctx.lineWidth = Math.max(1, s.segmentWidth * scale);
  (ctx as CanvasRenderingContext2D).strokeStyle = s.segmentColor;
  for (const sg of segs) {
    ctx.beginPath();
    ctx.moveTo(sg.start.x * W, sg.start.y * H);
    ctx.lineTo(sg.end.x * W, sg.end.y * H);
    ctx.stroke();
  }
}

let blitCanvas: HTMLCanvasElement | null = null;
function getBlitCanvas(w: number, h: number): HTMLCanvasElement {
  if (!blitCanvas) blitCanvas = document.createElement('canvas');
  if (blitCanvas.width !== w || blitCanvas.height !== h) {
    blitCanvas.width = w;
    blitCanvas.height = h;
  }
  return blitCanvas;
}
