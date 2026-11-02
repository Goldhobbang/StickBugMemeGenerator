/// <reference lib="webworker" />
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export interface ExportRequest {
  type: 'export';
  frames: ArrayBuffer[];
  width: number;
  height: number;
  delaysMs: number[];
}

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  const { frames, width, height, delaysMs } = e.data;
  if (e.data.type !== 'export') return;
  try {
    const gif = GIFEncoder();
    const total = frames.length;
    for (let i = 0; i < total; i++) {
      const rgba = new Uint8ClampedArray(frames[i]);
      const palette = quantize(rgba, 256, { format: 'rgba4444' });
      const index = applyPalette(rgba, palette, 'rgba4444');
      // Preserve source centisecond timing; clamp only sub-20ms delays
      // (widely ignored minimum in browsers). No FPS resampling here.
      const delay = Math.max(10, Math.round((delaysMs[i] ?? 100) / 10) * 10);
      gif.writeFrame(index, width, height, { palette, delay });
      (self as unknown as Worker).postMessage({ type: 'progress', done: i + 1, total });
    }
    gif.finish();
    // gifenc may return a view onto an oversized internal buffer.
    // Transfer only the actual GIF bytes, not unused buffer capacity.
    const bytes = gif.bytes().slice();
    (self as unknown as Worker).postMessage(
      { type: 'done', buffer: bytes.buffer },
      [bytes.buffer],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
