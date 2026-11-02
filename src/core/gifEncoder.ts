import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export interface ExportProgress {
  stage: string;
  done: number;
  total: number;
}

/**
 * Main-thread encoder fallback + worker message handler shared logic.
 * Frames arrive as RGBA buffers; we quantize each frame and write GIF.
 */
export function encodeFrames(
  frames: { data: Uint8ClampedArray; width: number; height: number; delayMs: number }[],
  width: number,
  height: number,
  onProgress?: (done: number, total: number) => void,
): Uint8Array {
  const gif = GIFEncoder();
  const fps: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const palette = quantize(f.data, 256, { format: 'rgba4444' });
    const index = applyPalette(f.data, palette, 'rgba4444');
    const delay = Math.max(20, Math.round(f.delayMs / 10) * 10);
    gif.writeFrame(index, width, height, { palette, delay });
    fps.push(delay);
    onProgress?.(i + 1, frames.length);
  }
  gif.finish();
  void fps;
  return gif.bytes();
}
