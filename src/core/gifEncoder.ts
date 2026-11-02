import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { gifencDelayMs } from './gifTiming';

/** Pixels gathered across every frame before one shared palette is built. */
export const PALETTE_SAMPLE_PIXELS = 48_000;

export type GifPalette = number[][];

/**
 * How many pixels to skip so each frame contributes about the same number of
 * samples. Sampling only the first frames would miss the meme footage colors.
 */
export function perFrameSampleStride(
  pixelCount: number,
  frameCount: number,
  maxSamples = PALETTE_SAMPLE_PIXELS,
): number {
  const budget = Math.max(1, Math.floor(maxSamples / Math.max(1, frameCount)));
  return Math.max(1, Math.floor(Math.max(1, pixelCount) / budget));
}

export function createPixelSampler(maxSamples = PALETTE_SAMPLE_PIXELS) {
  const data = new Uint8ClampedArray(maxSamples * 4);
  let count = 0;
  return {
    get count() {
      return count;
    },
    add(rgba: Uint8ClampedArray, stride: number): void {
      const step = Math.max(1, stride);
      const pixels = (rgba.length / 4) | 0;
      for (let pixel = 0; pixel < pixels && count < maxSamples; pixel += step) {
        const source = pixel * 4;
        const dest = count * 4;
        data[dest] = rgba[source];
        data[dest + 1] = rgba[source + 1];
        data[dest + 2] = rgba[source + 2];
        data[dest + 3] = rgba[source + 3];
        count++;
      }
    },
    /** Exact-length copy. gifenc reads the whole underlying ArrayBuffer. */
    bytes(): Uint8ClampedArray {
      return data.slice(0, count * 4);
    },
  };
}

export function paletteFromSamples(samples: Uint8ClampedArray): GifPalette {
  if (samples.length < 4) return [[0, 0, 0, 255]];
  const palette = quantize(samples, 256, { format: 'rgba4444' });
  return palette.length > 0 ? palette : [[0, 0, 0, 255]];
}

function tightRgba(rgba: Uint8ClampedArray): Uint8ClampedArray {
  if (rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength) return rgba;
  return rgba.slice();
}

export interface GifFrameWriter {
  readonly frames: number;
  add(rgba: Uint8ClampedArray, delayMs: number): void;
  finish(): Uint8Array;
}

/**
 * One palette for the whole GIF. The first frame stores it as the global
 * color table; later frames reuse those indices. Per-frame palettes flicker.
 */
export function createGifFrameWriter(
  width: number,
  height: number,
  palette: GifPalette,
): GifFrameWriter {
  const gif = GIFEncoder();
  let frames = 0;
  return {
    get frames() {
      return frames;
    },
    add(rgba, delayMs) {
      const index = applyPalette(tightRgba(rgba), palette, 'rgba4444');
      const delay = gifencDelayMs(delayMs);
      gif.writeFrame(
        index,
        width,
        height,
        frames === 0 ? { palette, delay } : { delay },
      );
      frames++;
    },
    finish() {
      if (frames === 0) throw new Error('GIF export produced no frames.');
      gif.finish();
      const bytes = gif.bytes().slice();
      if (bytes.length < 7 || bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) {
        throw new Error('Encoder did not produce a valid GIF header.');
      }
      return bytes;
    },
  };
}
