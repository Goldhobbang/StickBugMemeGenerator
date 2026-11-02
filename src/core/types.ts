export interface Point {
  x: number;
  y: number;
}

export interface TargetSegment {
  id: string;
  start: Point;
  end: Point;
  order: number;
}

export interface UserSegment {
  id: string;
  start: Point; // normalized 0..1 in output canvas space
  end: Point;
  targetSegmentId: string;
  order: number;
  flipped: boolean;
}

export interface TemplateData {
  segments: TargetSegment[];
  memeStartFrame: number;
  source: string;
}

export type Easing = 'linear' | 'ease-in-out' | 'ease-out';

export type ImageFit = 'contain' | 'cover';

export interface Settings {
  revealTotalDuration: number;
  holdAfterReveal: number;
  grayHold: number;
  transformDuration: number;
  finalHold: number;
  backgroundColor: string;
  segmentColor: string;
  segmentWidth: number;
  easing: Easing;
  outputFps: number;
  imageFit: ImageFit;
  exportScale: 1 | 2 | 4;
}

export const DEFAULT_SETTINGS: Settings = {
  revealTotalDuration: 1.35, // 9 lines × 0.15 seconds (previous default)
  holdAfterReveal: 1.0,
  grayHold: 0.5,
  transformDuration: 1.0,
  finalHold: 0.3,
  backgroundColor: '#808080',
  segmentColor: '#a855f7',
  segmentWidth: 3,
  easing: 'ease-in-out',
  outputFps: 30,
  imageFit: 'contain',
  exportScale: 1,
};

export interface DecodedFrame {
  imageData: ImageData;
  delayCs: number;
  delaySec: number;
}

export interface GifMeta {
  width: number;
  height: number;
  frames: number;
  memeStartFrame: number;
  totalSec: number;
}
