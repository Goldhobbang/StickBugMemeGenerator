import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';
import { computeTimeline, stageAtTime } from '../src/core/timeline';

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('computeTimeline', () => {
  it('places the six phases from the timing fields and meme length', () => {
    const timeline = computeTimeline(9, settings(), 5.7);
    expect(timeline.revealDuration).toBeCloseTo(1.35);
    expect(timeline.phaseAEnd).toBeCloseTo(1.35);
    expect(timeline.phaseBEnd).toBeCloseTo(2.35);
    expect(timeline.phaseCEnd).toBeCloseTo(2.85);
    expect(timeline.phaseDEnd).toBeCloseTo(3.85);
    expect(timeline.phaseEEnd).toBeCloseTo(4.15);
    expect(timeline.memeDuration).toBeCloseTo(5.7);
    expect(timeline.total).toBeCloseTo(9.85);
  });

  it('keeps the configured reveal duration before any strokes are drawn', () => {
    const empty = computeTimeline(0, settings(), 5.7);
    const drawn = computeTimeline(9, settings(), 5.7);
    expect(empty.revealDuration).toBe(drawn.revealDuration);
    expect(empty.total).toBeCloseTo(drawn.total);
  });

  it('does not give a negative reveal window', () => {
    const timeline = computeTimeline(3, settings({ revealTotalDuration: -2 }), 1);
    expect(timeline.revealDuration).toBe(0);
    expect(timeline.phaseAEnd).toBe(0);
    expect(timeline.total).toBeCloseTo(1 + 1 + 0.5 + 1 + 0.3);
  });
});

describe('stageAtTime', () => {
  const timeline = computeTimeline(9, settings(), 5.7);

  it('names each phase, including the boundary where the next phase starts', () => {
    expect(stageAtTime(0, timeline)).toBe('A');
    expect(stageAtTime(1.349, timeline)).toBe('A');
    expect(stageAtTime(timeline.phaseAEnd, timeline)).toBe('B');
    expect(stageAtTime(timeline.phaseBEnd, timeline)).toBe('C');
    expect(stageAtTime(timeline.phaseCEnd, timeline)).toBe('D');
    expect(stageAtTime(timeline.phaseDEnd, timeline)).toBe('E');
    expect(stageAtTime(timeline.phaseEEnd, timeline)).toBe('F');
    expect(stageAtTime(timeline.total + 2, timeline)).toBe('F');
  });
});
