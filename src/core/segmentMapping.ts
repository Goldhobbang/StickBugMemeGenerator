import type { Point, TargetSegment, UserSegment } from './types';

/**
 * Assign automatically managed source strokes to target segments.
 * Manually selected mappings are never overwritten.
 *
 * Every target is represented if there are at least as many source strokes
 * as target lines and enough non-manually-pinned strokes to cover the rest.
 * Extra strokes are distributed across the template in drawing order.
 */
export function autoAssignTargets(
  segments: UserSegment[],
  targets: TargetSegment[],
): void {
  if (targets.length === 0) return;
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  const targetIds = new Set(targets.map((target) => target.id));
  const manualTargets = new Set(
    ordered
      .filter((segment) => segment.mappingMode === 'manual' && targetIds.has(segment.targetSegmentId))
      .map((segment) => segment.targetSegmentId),
  );
  const uncovered = targets.filter((target) => !manualTargets.has(target.id));
  const candidates = uncovered.length ? uncovered : targets;
  const autos = ordered.filter((segment) => segment.mappingMode !== 'manual');

  if (!autos.length) return;
  for (let i = 0; i < autos.length; i++) {
    const index = Math.min(
      candidates.length - 1,
      Math.floor((i * candidates.length) / autos.length),
    );
    autos[i].targetSegmentId = candidates[index].id;
  }
}

/** Number of unique template lines represented by user strokes. */
export function coveredTargetCount(segments: UserSegment[], targets: TargetSegment[]): number {
  const validTargets = new Set(targets.map((target) => target.id));
  return new Set(
    segments.map((segment) => segment.targetSegmentId).filter((id) => validTargets.has(id)),
  ).size;
}

/**
 * Turn the editable user strokes into the actual animated strokes.
 *
 * User strokes remain untouched; each missing template line receives a
 * virtual stroke copied from the exact same source endpoints. Distribute
 * copies evenly among all drawn strokes, instead of cloning the last one.
 * This also repairs uncovered targets after manual mappings: any positive
 * number of user strokes can complete the entire target outline.
 *
 * Virtual strokes only exist in preview/export, not in the editor or its
 * undo history. Their stable IDs are unique for each missing target.
 */
export function buildEffectiveSegments(
  userSegments: UserSegment[],
  targets: TargetSegment[],
): UserSegment[] {
  if (userSegments.length === 0 || targets.length === 0) return [];

  const originals = [...userSegments]
    .sort((a, b) => a.order - b.order)
    .map((segment, i): UserSegment => ({
      ...segment,
      order: i,
      start: { ...segment.start },
      end: { ...segment.end },
    }));

  // Work on copies; do not change the user's manual target mappings.
  autoAssignTargets(originals, targets);

  const usedIds = new Set(originals.map((segment) => segment.targetSegmentId));
  const missingTargets = targets
    .filter((target) => !usedIds.has(target.id))
    .sort((a, b) => a.order - b.order);

  const result = [...originals];
  for (let i = 0; i < missingTargets.length; i++) {
    // A round-robin style balanced allocation of clones to source lines.
    // For M originals, every original supplies either floor(K/M) or
    // ceil(K/M) clones, regardless of where the missing targets lie.
    const source = originals[i % originals.length];
    result.push({
      ...source,
      id: `clone:${source.id}:${missingTargets[i].id}`,
      start: { ...source.start },
      end: { ...source.end },
      order: result.length,
      targetSegmentId: missingTargets[i].id,
      mappingMode: 'auto',
    });
  }
  return result;
}

export function effectiveSegmentCount(
  userSegments: UserSegment[],
  targets: TargetSegment[],
): number {
  return buildEffectiveSegments(userSegments, targets).length;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

export interface FittedSegment {
  id: string;
  start: Point;
  end: Point;
}

/**
 * Build the final outline, without overlapping extra strokes.
 * Multiple user strokes assigned to one target split that target into
 * equal contiguous sections, preserving the exact overall target geometry.
 *
 * All intermediate animation frames interpolate to these same endpoints.
 */
export function fitSegmentsToTargets(
  segments: UserSegment[],
  targets: ReadonlyMap<string, TargetSegment>,
): Map<string, FittedSegment> {
  const groups = new Map<string, UserSegment[]>();
  for (const segment of [...segments].sort((a, b) => a.order - b.order)) {
    if (!groups.has(segment.targetSegmentId)) groups.set(segment.targetSegmentId, []);
    groups.get(segment.targetSegmentId)!.push(segment);
  }

  const fitted = new Map<string, FittedSegment>();
  for (const [targetId, group] of groups) {
    const target = targets.get(targetId);
    if (!target) continue;
    for (let i = 0; i < group.length; i++) {
      const user = group[i];
      const a = lerpPoint(target.start, target.end, i / group.length);
      const b = lerpPoint(target.start, target.end, (i + 1) / group.length);
      fitted.set(user.id, {
        id: user.id,
        start: user.flipped ? b : a,
        end: user.flipped ? a : b,
      });
    }
  }
  return fitted;
}
