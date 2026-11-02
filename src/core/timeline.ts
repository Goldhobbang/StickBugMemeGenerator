import type { Settings } from './types';

export interface Timeline {
  revealDuration: number;
  phaseAEnd: number;
  phaseBEnd: number;
  phaseCEnd: number;
  phaseDEnd: number;
  phaseEEnd: number;
  memeDuration: number;
  total: number;
}

export function computeTimeline(
  segmentCount: number,
  settings: Settings,
  memeDuration: number,
): Timeline {
  const revealDuration = segmentCount * settings.revealInterval;
  const phaseAEnd = revealDuration;
  const phaseBEnd = phaseAEnd + settings.holdAfterReveal;
  const phaseCEnd = phaseBEnd + settings.grayHold;
  const phaseDEnd = phaseCEnd + settings.transformDuration;
  const phaseEEnd = phaseDEnd + settings.finalHold;
  return {
    revealDuration,
    phaseAEnd,
    phaseBEnd,
    phaseCEnd,
    phaseDEnd,
    phaseEEnd,
    memeDuration,
    total: phaseEEnd + memeDuration,
  };
}

export type Stage = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export function stageAtTime(t: number, tl: Timeline): Stage {
  if (t < tl.phaseAEnd) return 'A';
  if (t < tl.phaseBEnd) return 'B';
  if (t < tl.phaseCEnd) return 'C';
  if (t < tl.phaseDEnd) return 'D';
  if (t < tl.phaseEEnd) return 'E';
  return 'F';
}

export const STAGE_LABELS: Record<Stage, string> = {
  A: 'A · Reveal',
  B: 'B · Hold',
  C: 'C · Gray bg',
  D: 'D · Transform',
  E: 'E · Final hold',
  F: 'F · Stick Bug',
};
