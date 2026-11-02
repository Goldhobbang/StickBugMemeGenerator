import type { TargetSegment } from './types';
import stickTemplate from '../assets/stickbug-template.json';
import rickTemplate from '../assets/rickroll-template.json';

export type VariationId = 'stickbug' | 'rickroll';

export interface VariationPreset {
  id: VariationId;
  name: string;
  description: string;
  gifFile: string;
  // The lightweight source file may have been spatially resized, but the
  // complete original frame order and centisecond delays are retained.
  referenceWidth: number;
  referenceHeight: number;
  memeStartFrame: number;
  segments: TargetSegment[];
  backgroundColor: string;
  segmentColor: string;
  exportFilename: string;
}

export const VARIATIONS: Record<VariationId, VariationPreset> = {
  stickbug: {
    id: 'stickbug',
    name: 'Stick Bug',
    description: 'Draw at least 9 lines. Extra strokes automatically split the Stick Bug outline; 57 original meme frames follow (5.7 seconds).',
    gifFile: 'stick-bug.gif',
    referenceWidth: 220,
    referenceHeight: 124,
    memeStartFrame: stickTemplate.memeStartFrame,
    segments: stickTemplate.segments as TargetSegment[],
    backgroundColor: '#808080',
    segmentColor: '#a855f7',
    exportFilename: 'stick-bug-custom.gif',
  },
  rickroll: {
    id: 'rickroll',
    name: 'RickRoll',
    description: 'Draw at least 42 lines. Extra strokes automatically split Rick Astley’s face outline; 180 original frames follow (9 seconds).',
    gifFile: 'rick-roll-256.gif',
    referenceWidth: 256,
    referenceHeight: 256,
    memeStartFrame: rickTemplate.memeStartFrame,
    segments: rickTemplate.segments as TargetSegment[],
    backgroundColor: '#827679',
    segmentColor: '#f7f3e5',
    exportFilename: 'rickroll-custom.gif',
  },
};
