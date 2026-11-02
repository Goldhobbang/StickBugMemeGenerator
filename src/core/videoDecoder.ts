import type { DecodedFrame } from './types';
import type { DecodedGif } from './gifDecoder';

/**
 * Decode a short browser-playable video into the same frame model as a GIF.
 * Frame seeking happens locally using HTMLVideoElement and Canvas 2D.
 *
 * Video input is sampled at 15 fps, deliberately bounding browser memory.
 * The exported transformation uses these sampled frames, not the original
 * codec bitstream, so it is silent and may have a lower source frame rate.
 */
export const VIDEO_SAMPLE_FPS = 15;
export const VIDEO_MAX_SECONDS = 20;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_MAX_RGBA_BYTES = 180 * 1024 * 1024;
const VIDEO_MAX_SIDE = 512;

export interface VideoDecodeOptions {
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Video decoding cancelled.', 'AbortError');
}

function awaitEvent(
  element: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal?: AbortSignal,
): Promise<void> {
  abortIfNeeded(signal);
  return new Promise<void>((resolve, reject) => {
    const deadline = window.setTimeout(() => fail(new Error('Timed out waiting for video ' + eventName + '.')), 20000);
    const cleanup = () => {
      window.clearTimeout(deadline);
      element.removeEventListener(eventName, success);
      element.removeEventListener('error', failure);
      signal?.removeEventListener('abort', cancelled);
    };
    const success = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const failure = () => fail(new Error('Could not decode the selected video. This codec may not be supported by your browser.'));
    const cancelled = () => fail(new DOMException('Video decoding cancelled.', 'AbortError'));
    element.addEventListener(eventName, success, { once: true });
    element.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

async function seekVideo(element: HTMLVideoElement, seconds: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  const time = Math.min(Math.max(0, seconds), Math.max(0, element.duration - 0.002));
  if (Math.abs(element.currentTime - time) < 0.001 && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = awaitEvent(element, 'seeked', signal);
  element.currentTime = time;
  await seeked;
  if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await awaitEvent(element, 'loadeddata', signal);
}

export async function decodeVideoFile(file: File, options: VideoDecodeOptions = {}): Promise<DecodedGif> {
  if (file.size > VIDEO_MAX_BYTES) throw new Error('Video must be 100 MB or smaller.');
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name))
    throw new Error('Choose a browser-supported MP4, WebM, MOV, or M4V video.');
  abortIfNeeded(options.signal);

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  // Keeping the element mounted improves video frame extraction on iOS.
  video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0';
  document.body.appendChild(video);

  try {
    const metadata = awaitEvent(video, 'loadedmetadata', options.signal);
    video.src = url;
    video.load();
    await metadata;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration is unavailable or invalid.');
    if (duration > VIDEO_MAX_SECONDS)
      throw new Error('Video is too long. Trim it to 20 seconds or less before uploading.');
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video dimensions are invalid.');

    const ratio = Math.min(1, VIDEO_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(2, Math.round(video.videoWidth * ratio / 2) * 2);
    const height = Math.max(2, Math.round(video.videoHeight * ratio / 2) * 2);
    const frameCount = Math.max(1, Math.ceil(duration * VIDEO_SAMPLE_FPS));
    if (width * height * 4 * frameCount > VIDEO_MAX_RGBA_BYTES)
      throw new Error('Video would exceed 180 MB of decoded frames. Use a shorter or smaller video.');

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      await awaitEvent(video, 'loadeddata', options.signal);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    const frames: DecodedFrame[] = [];
    let previousCentiseconds = 0;

    for (let index = 0; index < frameCount; index++) {
      abortIfNeeded(options.signal);
      if (index !== 0) await seekVideo(video, (index * duration) / frameCount, options.signal);
      ctx.drawImage(video, 0, 0, width, height);
      const nextCentiseconds = Math.max(
        previousCentiseconds + 1,
        Math.round(((index + 1) * duration * 100) / frameCount),
      );
      const delayCs = nextCentiseconds - previousCentiseconds;
      previousCentiseconds = nextCentiseconds;
      frames.push({ imageData: ctx.getImageData(0, 0, width, height), delayCs, delaySec: delayCs / 100 });
      if (index % 4 === 0 || index === frameCount - 1) {
        options.progress?.((index + 1) / frameCount);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return { width, height, frames, totalSec: previousCentiseconds / 100 };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
