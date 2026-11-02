/// <reference lib="webworker" />
import { createGifFrameWriter, type GifPalette } from '../core/gifEncoder';

type InMessage =
  | { type: 'start'; width: number; height: number; palette: GifPalette }
  | { type: 'frame'; delayMs: number; buffer: ArrayBuffer }
  | { type: 'finish' };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

let writer: ReturnType<typeof createGifFrameWriter> | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      writer = createGifFrameWriter(message.width, message.height, message.palette);
      scope.postMessage({ type: 'ready' });
      return;
    }
    if (!writer) throw new Error('Encoder not started.');
    if (message.type === 'frame') {
      writer.add(new Uint8ClampedArray(message.buffer), message.delayMs);
      scope.postMessage({ type: 'ack', done: writer.frames });
      return;
    }
    if (message.type === 'finish') {
      const frames = writer.frames;
      const bytes = writer.finish();
      writer = null;
      scope.postMessage({ type: 'done', buffer: bytes.buffer, frames }, [bytes.buffer]);
    }
  } catch (error) {
    writer = null;
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
