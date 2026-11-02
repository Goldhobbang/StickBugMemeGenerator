import { describe, expect, it } from 'vitest';
import {
  MEDIAPIPE_VISION_VERSION,
  SEGMENTATION_LIBRARY_URL,
  SEGMENTATION_MODEL_URL,
  SEGMENTATION_WASM_URL,
} from '../src/core/onDeviceSegmentation';

describe('MagicTouch URLs', () => {
  it('pins the library, wasm, and model instead of a floating latest tag', () => {
    expect(MEDIAPIPE_VISION_VERSION).toBe('1.2.0');
    for (const url of [SEGMENTATION_LIBRARY_URL, SEGMENTATION_WASM_URL, SEGMENTATION_MODEL_URL]) {
      expect(url.includes('@latest')).toBe(false);
      expect(url.includes('/latest/')).toBe(false);
    }
    expect(SEGMENTATION_LIBRARY_URL).toContain('@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs');
    expect(SEGMENTATION_WASM_URL).toContain('@mediapipe/tasks-vision@1.2.0/wasm');
    expect(SEGMENTATION_MODEL_URL).toContain('/int8/1/interactive_segmentation.task');
  });
});
