/**
 * Delay conversions between GIF centiseconds, gifuct-js milliseconds,
 * and the millisecond delay gifenc writes into a graphics control extension.
 */

export interface GifDelay {
  delayCs: number;
  delaySec: number;
}

/**
 * gifuct-js reports frame delay in milliseconds (file centiseconds × 10).
 * A missing or non-positive delay falls back to one centisecond (10ms).
 */
export function delayMsFromGifuct(delayMs: number | undefined): GifDelay {
  const ms = delayMs != null && delayMs > 0 ? delayMs : 10;
  const delayCs = Math.max(1, Math.round(ms / 10));
  return { delayCs, delaySec: delayCs / 100 };
}

/**
 * gifenc's `delay` option is milliseconds and is stored as round(ms / 10)
 * centiseconds. Keep at least 10ms so the stored delay is at least 1cs.
 */
export function gifencDelayMs(delayMs: number): number {
  return Math.max(10, Math.round(delayMs / 10) * 10);
}

/**
 * Introduction frames are scheduled in centiseconds so a 30fps step does not
 * collapse to 30ms and shorten the phase by 10%. A 30fps second becomes
 * 30/40/30ms and still sums to the phase length.
 */
export function introFrameDelaysMs(durationSec: number, fps: number): number[] {
  const introEndCs = Math.round(Math.max(0, durationSec) * 100);
  const safeFps = fps > 0 ? fps : 30;
  const delays: number[] = [];
  let cursorCs = 0;
  let frame = 0;
  while (cursorCs < introEndCs) {
    const nextCs = Math.min(
      introEndCs,
      Math.max(cursorCs + 1, Math.round(((frame + 1) * 100) / safeFps)),
    );
    delays.push((nextCs - cursorCs) * 10);
    cursorCs = nextCs;
    frame++;
  }
  return delays;
}
