import { describe, expect, it } from 'vitest';
import { delayMsFromGifuct, gifencDelayMs, introFrameDelaysMs } from '../src/core/gifTiming';

describe('delayMsFromGifuct', () => {
  it('converts gifuct milliseconds back to GIF centiseconds', () => {
    // Stick Bug stores 10cs. gifuct reports 100ms.
    expect(delayMsFromGifuct(100)).toEqual({ delayCs: 10, delaySec: 0.1 });
    // RickRoll stores 5cs. gifuct reports 50ms.
    expect(delayMsFromGifuct(50)).toEqual({ delayCs: 5, delaySec: 0.05 });
    expect(delayMsFromGifuct(10)).toEqual({ delayCs: 1, delaySec: 0.01 });
  });

  it('falls back when the delay is missing or not positive', () => {
    expect(delayMsFromGifuct(0)).toEqual({ delayCs: 1, delaySec: 0.01 });
    expect(delayMsFromGifuct(undefined)).toEqual({ delayCs: 1, delaySec: 0.01 });
    expect(delayMsFromGifuct(-5)).toEqual({ delayCs: 1, delaySec: 0.01 });
  });

  it('rounds to the nearest centisecond', () => {
    expect(delayMsFromGifuct(15).delayCs).toBe(2);
    expect(delayMsFromGifuct(14).delayCs).toBe(1);
  });
});

describe('gifencDelayMs', () => {
  it('rounds to whole centiseconds and keeps a 10ms minimum', () => {
    expect(gifencDelayMs(100)).toBe(100);
    expect(gifencDelayMs(33)).toBe(30);
    expect(gifencDelayMs(35)).toBe(40);
    expect(gifencDelayMs(5)).toBe(10);
    expect(gifencDelayMs(0)).toBe(10);
  });
});

describe('introFrameDelaysMs', () => {
  it('sums to the phase length at 30fps without collapsing every step to 30ms', () => {
    const delays = introFrameDelaysMs(1, 30);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(1000);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(10);
    expect(delays.every((delay) => delay % 10 === 0)).toBe(true);
    expect(new Set(delays)).toEqual(new Set([30, 40]));
  });

  it('returns no frames for an empty introduction', () => {
    expect(introFrameDelaysMs(0, 30)).toEqual([]);
    expect(introFrameDelaysMs(-1, 30)).toEqual([]);
  });
});
