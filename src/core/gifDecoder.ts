import { decompressFrames, parseGIF } from 'gifuct-js';
import type { DecodedFrame } from './types';
import { delayMsFromGifuct } from './gifTiming';

export interface DecodedGif {
  width: number;
  height: number;
  frames: DecodedFrame[];
  totalSec: number;
}

export interface CompositedFrame {
  rgba: Uint8ClampedArray;
  delayCs: number;
  delaySec: number;
}

export interface CompositedGif {
  width: number;
  height: number;
  frames: CompositedFrame[];
  totalSec: number;
}

type Rgba = [number, number, number, number];

interface PatchFrame {
  patch: Uint8ClampedArray;
  dims: { left: number; top: number; width: number; height: number };
  disposalType?: number;
  transparentIndex?: number;
  delay?: number;
}

/**
 * Background color from the logical screen descriptor.
 * When that index is the frame's transparent color, cleared pixels stay
 * transparent instead of becoming an opaque hole.
 */
export function gifBackgroundPixel(
  globalColorTable: ArrayLike<ArrayLike<number>> | undefined,
  backgroundColorIndex: number,
  transparentIndex: number | null,
): Rgba {
  if (transparentIndex != null && backgroundColorIndex === transparentIndex) {
    return [0, 0, 0, 0];
  }
  const color = globalColorTable?.[backgroundColorIndex];
  if (!color) return [0, 0, 0, 0];
  return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, 255];
}

function fillRect(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
  color: Rgba,
): void {
  const x0 = Math.max(0, Math.min(width, rect.left));
  const y0 = Math.max(0, Math.min(height, rect.top));
  const x1 = Math.max(0, Math.min(width, rect.left + rect.width));
  const y1 = Math.max(0, Math.min(height, rect.top + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * width + x) * 4;
      canvas[offset] = color[0];
      canvas[offset + 1] = color[1];
      canvas[offset + 2] = color[2];
      canvas[offset + 3] = color[3];
    }
  }
}

function copyToArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

function blitPatch(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  frame: PatchFrame,
): void {
  const { left, top, width: patchWidth, height: patchHeight } = frame.dims;
  const patch = frame.patch;
  for (let y = 0; y < patchHeight; y++) {
    const destY = top + y;
    if (destY < 0 || destY >= height) continue;
    for (let x = 0; x < patchWidth; x++) {
      const destX = left + x;
      if (destX < 0 || destX >= width) continue;
      const source = (y * patchWidth + x) * 4;
      const alpha = patch[source + 3];
      if (alpha === 0) continue;
      const offset = (destY * width + destX) * 4;
      if (alpha === 255) {
        canvas[offset] = patch[source];
        canvas[offset + 1] = patch[source + 1];
        canvas[offset + 2] = patch[source + 2];
        canvas[offset + 3] = 255;
        continue;
      }
      const inverse = 255 - alpha;
      canvas[offset] = Math.round((patch[source] * alpha + canvas[offset] * inverse) / 255);
      canvas[offset + 1] = Math.round((patch[source + 1] * alpha + canvas[offset + 1] * inverse) / 255);
      canvas[offset + 2] = Math.round((patch[source + 2] * alpha + canvas[offset + 2] * inverse) / 255);
      canvas[offset + 3] = Math.round(alpha + (canvas[offset + 3] * inverse) / 255);
    }
  }
}

/**
 * Decode GIF patches into full frames.
 * Disposal 2 restores the previous frame rectangle to the background color.
 * Disposal 3 restores the canvas from before that frame was drawn.
 * Transparent patch pixels do not erase what is already there.
 */
export function compositeGif(bytes: ArrayBuffer | Uint8Array): CompositedGif {
  const parsed = parseGIF(copyToArrayBuffer(bytes));
  const frameCount = parsed.frames.length;
  if (frameCount === 0) throw new Error('GIF has no frames.');
  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const pixels = width * height;
  if (pixels > 1024 * 1024 || pixels * frameCount * 4 > 180 * 1024 * 1024) {
    throw new Error('GIF is too large to decode safely in this browser. Use a smaller GIF (up to 180 MB of decoded frames).');
  }
  const source = decompressFrames(parsed, true) as PatchFrame[];
  if (!source.length) throw new Error('No frames decoded from reference GIF.');

  const backgroundIndex = parsed.lsd.backgroundColorIndex ?? 0;
  const globalTable = parsed.gct as ArrayLike<ArrayLike<number>> | undefined;
  const canvas = new Uint8ClampedArray(pixels * 4);
  const initialTransparent = source.find((frame) => frame.transparentIndex != null)?.transparentIndex ?? null;
  const initial = gifBackgroundPixel(globalTable, backgroundIndex, initialTransparent);
  canvas.fill(0);
  for (let i = 0; i < pixels; i++) {
    const offset = i * 4;
    canvas[offset] = initial[0];
    canvas[offset + 1] = initial[1];
    canvas[offset + 2] = initial[2];
    canvas[offset + 3] = initial[3];
  }

  const frames: CompositedFrame[] = [];
  let totalSec = 0;
  let previousDisposal = 0;
  let previousRect: PatchFrame['dims'] | null = null;
  let previousTransparent: number | null = initialTransparent;
  let savedBeforePrevious: Uint8ClampedArray | null = null;

  for (const frame of source) {
    if (previousDisposal === 2 && previousRect) {
      fillRect(
        canvas,
        width,
        height,
        previousRect,
        gifBackgroundPixel(globalTable, backgroundIndex, previousTransparent),
      );
    } else if (previousDisposal === 3 && savedBeforePrevious) {
      canvas.set(savedBeforePrevious);
    }

    const disposal = frame.disposalType ?? 0;
    const before = disposal === 3 ? canvas.slice() : null;
    blitPatch(canvas, width, height, frame);
    const delay = delayMsFromGifuct(frame.delay);
    totalSec += delay.delaySec;
    frames.push({ rgba: new Uint8ClampedArray(canvas), ...delay });

    previousDisposal = disposal;
    previousRect = frame.dims;
    previousTransparent = frame.transparentIndex ?? null;
    savedBeforePrevious = before;
  }

  return { width, height, frames, totalSec };
}

/**
 * Decode GIF patches to complete frames. gifuct-js reports delay in
 * milliseconds (file centiseconds × 10).
 */
export async function decodeGif(url: string): Promise<DecodedGif> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Reference GIF fetch failed: ${response.status}`);
  return decodeGifBuffer(await response.arrayBuffer());
}

/** Decode a user-supplied GIF locally, without uploading it anywhere. */
export async function decodeGifFile(file: File): Promise<DecodedGif> {
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('Custom GIF must be 20 MB or smaller.');
  }
  if (file.type !== 'image/gif' && !file.name.toLowerCase().endsWith('.gif')) {
    throw new Error('Select a .gif file.');
  }
  return decodeGifBuffer(await file.arrayBuffer());
}

function decodeGifBuffer(bytes: ArrayBuffer): DecodedGif {
  const composited = compositeGif(bytes);
  return {
    width: composited.width,
    height: composited.height,
    totalSec: composited.totalSec,
    frames: composited.frames.map((frame): DecodedFrame => {
      const pixels = new Uint8ClampedArray(frame.rgba.length);
      pixels.set(frame.rgba);
      return {
        imageData: new ImageData(pixels, composited.width, composited.height),
        delayCs: frame.delayCs,
        delaySec: frame.delaySec,
      };
    }),
  };
}
