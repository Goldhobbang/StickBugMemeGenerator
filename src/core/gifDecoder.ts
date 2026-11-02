import { parseGIF, decompressFrames } from 'gifuct-js';
import type { DecodedFrame } from './types';

export interface DecodedGif {
  width: number;
  height: number;
  frames: DecodedFrame[];
  totalSec: number;
}

/**
 * Decode GIF patches to complete frames. gifuct-js reports delay in
 * MILLISECONDS (not centiseconds), while the GIF file stores centiseconds.
 * Apply the previous frame's disposal before painting the next patch.
 */
export async function decodeGif(url: string): Promise<DecodedGif> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Reference GIF fetch failed: ${response.status}`);
  const parsed = parseGIF(await response.arrayBuffer());
  const source = decompressFrames(parsed, true);
  if (!source.length) throw new Error('No frames decoded from reference GIF.');

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D not available.');

  // This reference GIF uses black outside the central meme footage.
  // Its global background index is also transparent, so use black for
  // cleared regions rather than leaving accidental transparent holes.
  const background = '#000000';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const patchCanvas = document.createElement('canvas');
  const frames: DecodedFrame[] = [];
  let totalSec = 0;
  let previousDisposal = 0;
  let previousRect: { left: number; top: number; width: number; height: number } | null = null;
  let savedBeforePrevious: ImageData | null = null;

  for (const frame of source) {
    // The disposal of the previous frame is applied just BEFORE this frame.
    if (previousDisposal === 2 && previousRect) {
      ctx.fillStyle = background;
      ctx.fillRect(previousRect.left, previousRect.top, previousRect.width, previousRect.height);
    } else if (previousDisposal === 3 && savedBeforePrevious) {
      ctx.putImageData(savedBeforePrevious, 0, 0);
    }

    const dims = frame.dims;
    const disposal = frame.disposalType ?? 0;
    const before = disposal === 3 ? ctx.getImageData(0, 0, width, height) : null;

    patchCanvas.width = dims.width;
    patchCanvas.height = dims.height;
    const patchCtx = patchCanvas.getContext('2d');
    if (!patchCtx) throw new Error('Canvas 2D not available.');
    patchCtx.putImageData(new ImageData(
      new Uint8ClampedArray(frame.patch), dims.width, dims.height,
    ), 0, 0);

    // drawImage alpha-composites transparent pixels instead of erasing
    // the previously rendered pixels (putImageData directly would not).
    ctx.drawImage(patchCanvas, dims.left, dims.top);
    const imageData = ctx.getImageData(0, 0, width, height);

    // The decoded delay is already in milliseconds. Keep the GIF's
    // centisecond precision; zero/unspecified delays get a 10ms fallback.
    const delayMs = frame.delay > 0 ? frame.delay : 10;
    const delayCs = Math.max(1, Math.round(delayMs / 10));
    const delaySec = delayCs / 100;
    totalSec += delaySec;
    frames.push({ imageData, delayCs, delaySec });

    previousDisposal = disposal;
    previousRect = dims;
    savedBeforePrevious = before;
  }

  return { width, height, frames, totalSec };
}

export function memeDurationFrom(decoded: DecodedGif, memeStartFrame: number): number {
  return decoded.frames.slice(memeStartFrame)
    .reduce((seconds, frame) => seconds + frame.delaySec, 0);
}
