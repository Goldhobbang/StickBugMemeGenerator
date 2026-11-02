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
    description: '9 lines transform into the Stick Bug pose, followed by 57 original meme frames (5.7 seconds).',
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
    description: '42 lines form the Rick Astley face from source frame 106, then 180 RickRoll frames play at 50ms each (9 seconds).',
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
