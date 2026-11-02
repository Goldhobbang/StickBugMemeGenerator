import { renderFrame, type RenderProject } from './renderFrame';
import { computeTimeline } from './timeline';

export interface VideoRecordingFormat {
  mimeType: string;
  extension: 'mp4' | 'webm';
  label: string;
}

const CANDIDATES: VideoRecordingFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', label: 'MP4 (H.264)' },
  { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4' },
  { mimeType: 'video/webm;codecs=vp8', extension: 'webm', label: 'WebM (VP8)' },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm', label: 'WebM (VP9)' },
  { mimeType: 'video/webm', extension: 'webm', label: 'WebM' },
];

export function availableVideoFormats(): VideoRecordingFormat[] {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function') return [];
  return CANDIDATES.filter((candidate) => MediaRecorder.isTypeSupported(candidate.mimeType));
}

export function preferredVideoFormat(): VideoRecordingFormat | null {
  return availableVideoFormats()[0] ?? null;
}

export interface RecordVideoOptions {
  project: RenderProject;
  fps: number;
  scale: number;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
}

function waitUntil(deadline: number, signal?: AbortSignal): Promise<void> {
  ensureNotAborted(signal);
  const remaining = Math.max(0, deadline - performance.now());
  return new Promise<void>((resolve, reject) => {
    let timeout = 0;
    const clear = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => { clear(); reject(new DOMException('Video export cancelled.', 'AbortError')); };
    timeout = window.setTimeout(() => { clear(); resolve(); }, remaining);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Record the same deterministic frame renderer that drives the GIF preview.
 * Frames are streamed through CanvasCaptureMediaStreamTrack and MediaRecorder
 * rather than buffering an entire output video in RGBA memory.
 *
 * Video is silent. Browser-native MediaRecorder determines the exact codec,
 * and wall-clock scheduling approximates the requested frame rate.
 */
export async function recordProjectVideo(options: RecordVideoOptions): Promise<{
  blob: Blob;
  format: VideoRecordingFormat;
  totalFrames: number;
}> {
  const { project, signal, onProgress } = options;
  ensureNotAborted(signal);
  const frameRate = Math.max(10, Math.min(30, Math.round(options.fps)));
  const scale = Math.max(1, Math.min(4, Math.round(options.scale)));
  const duration = computeTimeline(project.userSegments.length, project.settings, project.memeDuration).total;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 90)
    throw new Error('Video export duration must be between 0 and 90 seconds.');
  const count = Math.max(1, Math.ceil(duration * frameRate));
  const canvas = document.createElement('canvas');
  canvas.width = project.gifWidth * scale;
  canvas.height = project.gifHeight * scale;
  if (canvas.width * canvas.height > 1920 * 1080)
    throw new Error('Video export exceeds 1920×1080. Lower the export scale.');

  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  let manual = typeof track?.requestFrame === 'function';
  if (!manual) {
    stream.getTracks().forEach((t) => t.stop());
    stream = canvas.captureStream(frameRate);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  }
  if (!track) throw new Error('Canvas recording track is not supported by this browser.');

  const available = availableVideoFormats();
  let recorder: MediaRecorder | null = null;
  let format: VideoRecordingFormat | null = null;
  for (const candidate of available) {
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: candidate.mimeType,
        videoBitsPerSecond: Math.round(Math.max(1_500_000, Math.min(8_000_000, canvas.width * canvas.height * frameRate * 0.18))),
      });
      format = candidate;
      break;
    } catch { /* Try a different codec supported by the browser. */ }
  }
  if (!recorder || !format) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('This browser cannot record MP4 or WebM. Choose GIF export instead.');
  }

  const chunks: Blob[] = [];
  let resolveBlob!: (blob: Blob) => void;
  let rejectBlob!: (error: Error) => void;
  const blobPromise = new Promise<Blob>((resolve, reject) => {
    resolveBlob = resolve;
    rejectBlob = reject;
  });
  recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size) chunks.push(e.data); };
  recorder.onerror = () => rejectBlob(new Error('Browser video encoder failed.'));
  recorder.onstop = () => {
    if (chunks.length === 0) {
      rejectBlob(new Error('Video encoder produced an empty file.'));
    } else {
      resolveBlob(new Blob(chunks, { type: format!.mimeType.split(';')[0] }));
    }
  };

  try {
    renderFrame(0, canvas, project);
    recorder.start(500);
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      ensureNotAborted(signal);
      // The t=0 frame is prepared above to avoid an empty first video frame.
      if (i > 0) renderFrame(Math.min(duration - .0001, i / frameRate), canvas, project);
      if (manual) track.requestFrame();
      onProgress?.((i + 1) / count);
      await waitUntil(started + Math.min(duration, (i + 1) / frameRate) * 1000, signal);
    }
    ensureNotAborted(signal);
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await blobPromise;
    return { blob, format, totalFrames: count };
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
    // Consume the recording promise after abort so there is no unhandled rejection.
    await blobPromise.catch(() => undefined);
    throw error;
  } finally {
    track.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
}
