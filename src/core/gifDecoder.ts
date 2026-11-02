import { parseGIF, decompressFrames } from 'gifuct-js';
import type { DecodedFrame } from './types';

export interface DecodedGif {
  width: number;
  height: number;
  frames: DecodedFrame[];
  totalSec: number;
}

/** Fully composite a gifuct-js GIF (handles offsets, disposal, transparency). */
export async function decodeGif(url: string): Promise<DecodedGif> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reference GIF fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const parsed = parseGIF(buf);
  const rawFrames = decompressFrames(parsed, true);
  if (rawFrames.length === 0) throw new Error('No frames decoded from reference GIF.');

  const width = parsed.lsd.width as number;
  const height = parsed.lsd.height as number;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D not available.');

  // Background: opaque black matches meme (black bars); disposal=1 keeps prior frame.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const out: DecodedFrame[] = [];
  let totalSec = 0;
  const tmp = document.createElement('canvas');

  for (const f of rawFrames) {
    const dims = f.dims as { left: number; top: number; width: number; height: number };
    const delayCs = (f.delay as number) || 0;
    // GIF spec: delay 0/1 often means 10cs minimum in viewers.
    const delaySec = delayCs <= 1 ? 0.1 : delayCs / 100;
    totalSec += delaySec;

    tmp.width = dims.width;
    tmp.height = dims.height;
    const tctx = tmp.getContext('2d');
    if (!tctx) throw new Error('Canvas 2D not available.');
    const img = new ImageData(
      new Uint8ClampedArray(f.patch as Uint8ClampedArray | number[]),
      dims.width,
      dims.height,
    );
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, dims.left, dims.top);

    const composited = ctx.getImageData(0, 0, width, height);
    out.push({ imageData: composited, delayCs, delaySec });
  }

  return { width, height, frames: out, totalSec };
}

export function memeDurationFrom(decoded: DecodedGif, memeStartFrame: number): number {
  let s = 0;
  for (let i = memeStartFrame; i < decoded.frames.length; i++) {
    s += decoded.frames[i].delaySec;
  }
  return s;
}
