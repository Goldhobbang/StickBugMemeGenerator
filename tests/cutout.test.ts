import { describe, expect, it } from 'vitest';
import { cutoutForeground, cutoutPrompts, pointInPolygon } from '../src/core/cutout';

function fill(width: number, height: number, color: [number, number, number]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function disk(
  rgba: Uint8ClampedArray,
  width: number,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number],
): void {
  for (let y = 0; y < rgba.length / 4 / width; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const o = (y * width + x) * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
    }
  }
}

describe('cutoutForeground', () => {
  it('drops background that a loose loop accidentally includes', () => {
    const width = 48;
    const height = 48;
    const rgba = fill(width, height, [30, 90, 210]);
    disk(rgba, width, 24, 24, 10, [220, 40, 50]);
    const polygon = [
      { x: 8, y: 8 },
      { x: 40, y: 8 },
      { x: 40, y: 40 },
      { x: 8, y: 40 },
    ];
    const result = cutoutForeground(rgba, width, height, polygon);
    expect(result.separated).toBe(true);
    let subject = 0;
    let leakedBackground = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = result.mask[y * width + x] === 1;
        const inDisk = (x - 24) ** 2 + (y - 24) ** 2 <= 10 * 10;
        if (on && inDisk) subject++;
        if (on && !inDisk) leakedBackground++;
      }
    }
    expect(subject).toBeGreaterThan(200);
    expect(leakedBackground).toBeLessThan(40);
  });

  it('keeps the sketch when the subject color matches the background', () => {
    const rgba = fill(32, 32, [80, 80, 80]);
    const polygon = [
      { x: 6, y: 6 },
      { x: 26, y: 6 },
      { x: 26, y: 26 },
      { x: 6, y: 26 },
    ];
    const result = cutoutForeground(rgba, 32, 32, polygon);
    expect(result.separated).toBe(false);
    expect(result.mask[16 * 32 + 16]).toBe(1);
    expect(result.mask[0]).toBe(0);
  });
});

describe('cutoutPrompts', () => {
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it('places positive marks inside the sketch and negative marks outside', () => {
    const prompts = cutoutPrompts(square);
    expect(prompts.positive.length).toBeGreaterThan(4);
    expect(prompts.negative.length).toBeGreaterThan(4);
    for (const point of prompts.positive) expect(pointInPolygon(point, square)).toBe(true);
    for (const point of prompts.negative) expect(pointInPolygon(point, square)).toBe(false);
  });
});
