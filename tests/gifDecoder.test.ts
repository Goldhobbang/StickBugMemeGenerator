import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GIFEncoder } from 'gifenc';
import { compositeGif } from '../src/core/gifDecoder';

function buildGif(
  frames: { pixels: number[]; delay: number; dispose: number; transparentIndex?: number }[],
  palette: number[][],
  width: number,
  height: number,
): Uint8Array {
  const gif = GIFEncoder();
  for (const frame of frames) {
    gif.writeFrame(new Uint8Array(frame.pixels), width, height, {
      palette,
      delay: frame.delay,
      dispose: frame.dispose,
      transparent: frame.transparentIndex != null,
      transparentIndex: frame.transparentIndex ?? 0,
    });
  }
  gif.finish();
  return gif.bytes().slice();
}

function pixel(rgba: Uint8ClampedArray, index: number): number[] {
  const offset = index * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
}

describe('compositeGif transparency and disposal', () => {
  it('clears a disposal-2 frame to transparent instead of leaving an opaque black hole', () => {
    const bytes = buildGif([
      { pixels: [1, 0, 0, 0], delay: 100, dispose: 2, transparentIndex: 0 },
      { pixels: [0, 0, 0, 2], delay: 100, dispose: 2, transparentIndex: 0 },
    ], [[0, 0, 0], [255, 0, 0], [0, 0, 255]], 2, 2);
    const decoded = compositeGif(bytes);
    expect(pixel(decoded.frames[0].rgba, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[0].rgba, 1)[3]).toBe(0);
    // The red pixel must not survive as opaque black after the frame is disposed.
    expect(pixel(decoded.frames[1].rgba, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(decoded.frames[1].rgba, 3)).toEqual([0, 0, 255, 255]);
    expect(decoded.frames[0].delayCs).toBe(10);
  });

  it('restores disposal 2 to the opaque logical-screen background color', () => {
    const bytes = buildGif([
      { pixels: [1, 1, 1, 1], delay: 100, dispose: 2, transparentIndex: 2 },
      { pixels: [2, 2, 2, 2], delay: 100, dispose: 2, transparentIndex: 2 },
    ], [[255, 0, 0], [0, 0, 255], [0, 0, 0]], 2, 2);
    const decoded = compositeGif(bytes);
    expect(pixel(decoded.frames[0].rgba, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(decoded.frames[1].rgba, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[1].rgba, 3)).toEqual([255, 0, 0, 255]);
  });

  it('restores the canvas from before a disposal-3 frame', () => {
    const bytes = buildGif([
      { pixels: [0, 0, 0, 0], delay: 100, dispose: 1, transparentIndex: 2 },
      { pixels: [1, 1, 1, 1], delay: 100, dispose: 3, transparentIndex: 2 },
      { pixels: [2, 2, 2, 2], delay: 100, dispose: 1, transparentIndex: 2 },
    ], [[255, 0, 0], [0, 0, 255], [0, 0, 0]], 2, 2);
    const decoded = compositeGif(bytes);
    expect(pixel(decoded.frames[0].rgba, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[1].rgba, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(decoded.frames[2].rgba, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded.frames[2].rgba, 3)).toEqual([255, 0, 0, 255]);
  });
});

describe('Stick Bug reference GIF', () => {
  const bytes = readFileSync(new URL('../public/stick-bug.gif', import.meta.url));
  const decoded = compositeGif(bytes);

  it('keeps the original frame count, size, and 10cs timing', () => {
    expect(decoded.width).toBe(220);
    expect(decoded.height).toBe(124);
    expect(decoded.frames).toHaveLength(101);
    expect(decoded.frames.every((frame) => frame.delayCs === 10)).toBe(true);
    expect(decoded.totalSec).toBeCloseTo(10.1);
  });

  it('stays fully opaque, with no transparent holes from the background index', () => {
    for (const index of [0, 43, 44, 100]) {
      const rgba = decoded.frames[index].rgba;
      for (let pixelIndex = 3; pixelIndex < rgba.length; pixelIndex += 4) {
        expect(rgba[pixelIndex]).toBe(255);
      }
    }
  });
});
