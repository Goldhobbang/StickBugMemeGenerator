import type { Point } from './types';
import { cutoutPrompts } from './cutout';
import { t } from './i18n';

/**
 * Optional on-device semantic object segmentation using Google's MagicTouch
 * model through MediaPipe Tasks Vision. Inference occurs in the browser.
 * The library/model are downloaded on FIRST use; no API key or server proxy.
 * When network/model/browser support is missing the local edge tracer remains
 * fully usable.
 */
export interface SegmentationCorrection { point: Point; positive: boolean; }
export interface ModelMask {
  values: Float32Array;
  width: number;
  height: number;
}
/** Pinned to the tasks-vision release that implements setImage + brush segment(). */
export const MEDIAPIPE_VISION_VERSION = '1.2.0';
export const SEGMENTATION_LIBRARY_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VISION_VERSION}/vision_bundle.mjs`;
export const SEGMENTATION_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VISION_VERSION}/wasm`;
/** MagicTouch int8 model revision 1. Do not use the floating "latest" path. */
export const SEGMENTATION_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task';

let cached: Promise<{ engine: any; BrushMode: any; delegate: 'GPU' | 'CPU' }> | null = null;

async function acquire(): Promise<{ engine: any; BrushMode: any; delegate: 'GPU' | 'CPU' }> {
  if (!cached) {
    cached = (async () => {
      const library: any = await import(/* @vite-ignore */ SEGMENTATION_LIBRARY_URL);
      if (!library.InteractiveSegmenter || !library.FilesetResolver)
        throw new Error(t('err.aiBrowser'));
      const fileset = await library.FilesetResolver.forVisionTasks(SEGMENTATION_WASM_URL);
      const create = (delegate: 'GPU' | 'CPU') => library.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEGMENTATION_MODEL_URL, delegate },
      });
      let engine: any;
      let delegate: 'GPU' | 'CPU' = 'GPU';
      try {
        engine = await create('GPU');
      } catch {
        delegate = 'CPU';
        engine = await create('CPU');
      }
      if (typeof engine.setImage !== 'function')
        throw new Error(t('err.aiBrush'));
      return { engine, BrushMode: library.BrushMode, delegate };
    })();
  }
  try {
    return await cached;
  } catch (error) {
    cached = null;
    throw error;
  }
}

function polygonCentroid(points: Point[]): Point {
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < .000001) {
    return {
      x: points.reduce((a, p) => a + p.x, 0) / points.length,
      y: points.reduce((a, p) => a + p.y, 0) / points.length,
    };
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

function inferenceCanvas(frame: ImageData): HTMLCanvasElement {
  const long = Math.max(frame.width, frame.height);
  const scale = long > 768 ? 768 / long : long < 384 ? 384 / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(frame.width * scale));
  canvas.height = Math.max(2, Math.round(frame.height * scale));
  const ctx = canvas.getContext('2d')!;
  const source = document.createElement('canvas');
  source.width = frame.width;
  source.height = frame.height;
  source.getContext('2d')!.putImageData(frame, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function readMask(response: any): ModelMask {
  const mask = response?.confidenceMasks?.[0] ?? response?.mask ?? response;
  if (!mask || typeof mask.getAsFloat32Array !== 'function')
    throw new Error(t('err.aiMask'));
  const values = new Float32Array(mask.getAsFloat32Array());
  const width = Number(mask.width);
  const height = Number(mask.height);
  response?.close?.();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height !== values.length)
    throw new Error(t('err.aiMaskSize'));
  return { values, width, height };
}

export async function segmentObjectFromSketch(frame: ImageData, polygon: Point[], corrections: SegmentationCorrection[] = []): Promise<ModelMask> {
  if (polygon.length < 3) throw new Error(t('err.sketchLoop'));
  const prompts = cutoutPrompts(polygon);
  const positive = prompts.positive.length ? prompts.positive : [polygonCentroid(polygon)];
  const run = async (forceCpu = false): Promise<ModelMask> => {
    if (forceCpu) cached = null;
    const loaded = await acquire();
    if (forceCpu && loaded.delegate !== 'CPU') {
      cached = null;
      const cpu = await acquireCpu();
      return segmentWith(cpu.engine, cpu.BrushMode, frame, positive, prompts.negative, corrections);
    }
    try {
      return segmentWith(loaded.engine, loaded.BrushMode, frame, positive, prompts.negative, corrections);
    } catch (error) {
      if (!forceCpu && loaded.delegate === 'GPU') return run(true);
      throw error;
    }
  };
  return run(false);
}

async function acquireCpu(): Promise<{ engine: any; BrushMode: any; delegate: 'CPU' }> {
  const library: any = await import(/* @vite-ignore */ SEGMENTATION_LIBRARY_URL);
  const fileset = await library.FilesetResolver.forVisionTasks(SEGMENTATION_WASM_URL);
  const engine = await library.InteractiveSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: SEGMENTATION_MODEL_URL, delegate: 'CPU' },
  });
  const ready = { engine, BrushMode: library.BrushMode, delegate: 'CPU' as const };
  cached = Promise.resolve(ready);
  return ready;
}

function segmentWith(
  engine: any,
  BrushMode: any,
  frame: ImageData,
  positive: Point[],
  negative: Point[],
  corrections: SegmentationCorrection[],
): ModelMask {
  const canvas = inferenceCanvas(frame);
  engine.setImage(canvas);
  const clampPoint = (p: Point) => ({
    x: Math.max(0, Math.min(1, p.x)),
    y: Math.max(0, Math.min(1, p.y)),
  });
  const positiveMode = BrushMode?.POSITIVE ?? 1;
  const negativeMode = BrushMode?.NEGATIVE ?? 2;
  const strokes = [
    { brushMode: positiveMode, point: positive.map(clampPoint), isCompleted: true },
    ...(negative.length
      ? [{ brushMode: negativeMode, point: negative.map(clampPoint), isCompleted: true }]
      : []),
    ...corrections.map(({ point, positive: include }) => ({
      brushMode: include ? positiveMode : negativeMode,
      point: [clampPoint(point)],
      isCompleted: true,
    })),
  ];
  return readMask(engine.segment(strokes));
}
