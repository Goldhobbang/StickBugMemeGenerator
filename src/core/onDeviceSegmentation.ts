import type { Point } from './types';

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
const LIBRARY_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/latest/interactive_segmentation.task';

let cached: Promise<{ engine: any; BrushMode: any }> | null = null;

async function acquire(): Promise<{ engine: any; BrushMode: any }> {
  if (!cached) {
    cached = (async () => {
      const library: any = await import(/* @vite-ignore */ LIBRARY_URL);
      if (!library.InteractiveSegmenter || !library.FilesetResolver)
        throw new Error('MediaPipe interactive segmentation is unavailable in this browser.');
      const fileset = await library.FilesetResolver.forVisionTasks(WASM_URL);
      const engine = await library.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      });
      if (typeof engine.setImage !== 'function')
        throw new Error('The loaded segmentation library does not support brush prompts.');
      return { engine, BrushMode: library.BrushMode };
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

export async function segmentObjectFromSketch(frame: ImageData, polygon: Point[], corrections: SegmentationCorrection[] = []): Promise<ModelMask> {
  if (polygon.length < 3) throw new Error('Sketch a closed loop around the subject first.');
  const { engine, BrushMode } = await acquire();
  const canvas = document.createElement('canvas');
  canvas.width = frame.width; canvas.height = frame.height;
  canvas.getContext('2d')!.putImageData(frame, 0, 0);
  const center = polygonCentroid(polygon);
  const point = { x: Math.max(0, Math.min(1, center.x)), y: Math.max(0, Math.min(1, center.y)) };
  // MagicTouch v2 brush input: a positive mark at the center of the rough ROI.
  // If it picks the wrong instance, adjust the ROI or fall back to local trace.
  engine.setImage(canvas);
  const strokes = [
    { brushMode: BrushMode?.POSITIVE ?? 1, point: [point], isCompleted: true },
    ...corrections.map(({ point: p, positive }) => ({
      brushMode: positive ? (BrushMode?.POSITIVE ?? 1) : (BrushMode?.NEGATIVE ?? 2),
      point: [{ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }],
      isCompleted: true,
    })),
  ];
  const response = engine.segment(strokes);
  const mask = response?.confidenceMasks?.[0] ?? response?.mask ?? response;
  if (!mask || typeof mask.getAsFloat32Array !== 'function')
    throw new Error('The AI model did not return a usable confidence mask.');
  const values = new Float32Array(mask.getAsFloat32Array());
  const width = Number(mask.width), height = Number(mask.height);
  response?.close?.();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height !== values.length)
    throw new Error('The AI model returned an invalid mask size.');
  return { values, width, height };
}
