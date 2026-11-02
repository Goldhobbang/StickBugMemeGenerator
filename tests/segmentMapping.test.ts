import { describe, expect, it } from 'vitest';
import {
  autoAssignTargets,
  buildEffectiveSegments,
  coveredTargetCount,
  fitSegmentsToTargets,
} from '../src/core/segmentMapping';
import type { TargetSegment, UserSegment } from '../src/core/types';

function target(id: string, order: number): TargetSegment {
  return { id, order, start: { x: 0, y: 0 }, end: { x: 1, y: order / 10 } };
}

function stroke(
  id: string,
  order: number,
  targetId = '',
  mode: 'auto' | 'manual' = 'auto',
  flipped = false,
): UserSegment {
  return {
    id,
    order,
    targetSegmentId: targetId,
    mappingMode: mode,
    flipped,
    start: { x: 0.1, y: 0.2 },
    end: { x: 0.4, y: 0.8 },
  };
}

describe('autoAssignTargets', () => {
  it('spreads automatic strokes across the template in drawing order', () => {
    const targets = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((order) => target('t' + order, order));
    const segments = [stroke('a', 0), stroke('b', 1)];
    autoAssignTargets(segments, targets);
    expect(segments.map((segment) => segment.targetSegmentId)).toEqual(['t0', 't4']);
  });

  it('leaves a manually pinned target in place', () => {
    const targets = [target('t0', 0), target('t1', 1), target('t2', 2)];
    const segments = [stroke('pinned', 0, 't2', 'manual'), stroke('auto', 1)];
    autoAssignTargets(segments, targets);
    expect(segments[0].targetSegmentId).toBe('t2');
    expect(segments[1].targetSegmentId).toBe('t0');
  });
});

describe('buildEffectiveSegments', () => {
  it('clones missing targets round-robin without editing the user strokes', () => {
    const targets = [0, 1, 2, 3].map((order) => target('t' + order, order));
    const original = [stroke('a', 0, 'keep'), stroke('b', 1, 'keep')];
    const effective = buildEffectiveSegments(original, targets);
    expect(original.map((segment) => segment.targetSegmentId)).toEqual(['keep', 'keep']);
    expect(effective).toHaveLength(4);
    expect(new Set(effective.map((segment) => segment.targetSegmentId))).toEqual(
      new Set(['t0', 't1', 't2', 't3']),
    );
    expect(effective.map((segment) => segment.id)).toEqual([
      'a',
      'b',
      'clone:a:t1',
      'clone:b:t3',
    ]);
    expect(coveredTargetCount(effective, targets)).toBe(4);
  });

  it('returns no strokes when the user or the template is empty', () => {
    expect(buildEffectiveSegments([], [target('t0', 0)])).toEqual([]);
    expect(buildEffectiveSegments([stroke('a', 0)], [])).toEqual([]);
    expect(coveredTargetCount([], [target('t0', 0)])).toBe(0);
  });
});

describe('fitSegmentsToTargets', () => {
  it('splits one template line into contiguous pieces and honors flip', () => {
    const line = target('t0', 0);
    line.end = { x: 1, y: 0 };
    const segments = [
      stroke('a', 0, 't0', 'auto', true),
      stroke('b', 1, 't0'),
    ];
    const fitted = fitSegmentsToTargets(segments, new Map([['t0', line]]));
    expect(fitted.get('a')).toMatchObject({ start: { x: 0.5, y: 0 }, end: { x: 0, y: 0 } });
    expect(fitted.get('b')).toMatchObject({ start: { x: 0.5, y: 0 }, end: { x: 1, y: 0 } });
  });
});
