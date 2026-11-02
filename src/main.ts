import './styles/main.css';
import type {
  DecodedFrame,
  Point,
  Settings,
  TargetSegment,
  UserSegment,
} from './core/types';
import { DEFAULT_SETTINGS } from './core/types';
import { decodeGif, decodeGifFile } from './core/gifDecoder';
import { decodeVideoFile, VIDEO_SAMPLE_FPS } from './core/videoDecoder';
import { preferredVideoFormat, recordProjectVideo } from './core/videoRecorder';
import { mountCustomGifPanel, type CustomGifPanel } from './core/customGifPanel';
import { computeTimeline, stageAtTime, STAGE_LABELS } from './core/timeline';
import { distToSegmentPx, segmentLengthPx } from './core/interpolation';
import { renderFrame, type RenderProject } from './core/renderFrame';
import { autoAssignTargets, buildEffectiveSegments, coveredTargetCount, effectiveSegmentCount } from './core/segmentMapping';
import { VARIATIONS, type VariationId } from './core/variations';
import { mountTimelineEditor, type PhaseId, type PhaseSpec, type TimelineEditor } from './core/timelineEditor';

// ---------------------------------------------------------------- state

interface AppState {
  variation: VariationId;
  customMediaKind: 'gif' | 'video';
  outputFormat: 'gif' | 'video';
  recordingAbort: AbortController | null;
  image: HTMLImageElement | null;
  imageURL: string | null;
  userSegments: UserSegment[];
  redoStack: UserSegment[][];
  selectedId: string | null;
  tool: 'draw' | 'select';
  settings: Settings;
  decoded: { width: number; height: number; frames: DecodedFrame[] } | null;
  memeStartFrame: number;
  /** Exclusive end frame of selected original meme footage. */
  memeEndFrameExclusive: number;
  playing: boolean;
  playT: number;
  lastTick: number;
  exportedURL: string | null;
  refError: string | null;
  exporting: boolean;
  worker: Worker | null;
  idCounter: number;
}

const state: AppState = {
  variation: 'stickbug',
  customMediaKind: 'gif',
  outputFormat: 'gif',
  recordingAbort: null,
  image: null,
  imageURL: null,
  userSegments: [],
  redoStack: [],
  selectedId: null,
  tool: 'draw',
  settings: { ...DEFAULT_SETTINGS },
  decoded: null,
  memeStartFrame: VARIATIONS.stickbug.memeStartFrame,
  memeEndFrameExclusive: 0,
  playing: false,
  playT: 0,
  lastTick: 0,
  exportedURL: null,
  refError: null,
  exporting: false,
  worker: null,
  idCounter: 1,
};

const TARGETS: TargetSegment[] = [...VARIATIONS.stickbug.segments].sort((a, b) => a.order - b.order);
let N = TARGETS.length;
const targetById = new Map(TARGETS.map((t) => [t.id, t]));

const CALIBRATE_MODE = new URLSearchParams(location.search).has('calibrate');

// ---------------------------------------------------------------- dom

const app = document.getElementById('app')!;

app.innerHTML = `
<header class="app-header">
  <h1>Stick <span class="bug">Bug</span> Meme Generator</h1>
  <p>Turn an image into a Stick Bug, RickRoll, or custom GIF/video meme.</p>
</header>
<div class="layout">
  <section class="panel" aria-label="Image editor">
    <h2>Image Editor</h2>
    <div class="variation-picker">
      <label for="variation-select">Final meme variation</label>
      <select id="variation-select" aria-label="Select final meme variation">
        <option value="stickbug">Stick Bug</option>
        <option value="rickroll">RickRoll</option>
        <option value="custom">Custom GIF · Auto Trace</option>
      </select>
      <p id="variation-description"></p>
    </div>
    <div id="custom-panel" class="custom-gif-panel" hidden></div>
    <div class="toolbar">
      <button id="btn-upload">Upload image</button>
      <input type="file" id="file-input" accept="image/png,image/jpeg,image/webp" hidden />
      <button id="tool-draw" class="active">Draw</button>
      <button id="tool-select">Select</button>
      <button id="btn-undo" disabled>Undo</button>
      <button id="btn-redo" disabled>Redo</button>
      <button id="btn-del" class="danger" disabled>Delete</button>
      <button id="btn-clear" class="danger">Clear</button>
      <span class="seg-count short" id="seg-count">Drawn: 0</span>
      <span class="seg-count template-count" id="seg-template">Template: ${N}</span>
      <span class="seg-count short" id="seg-animated">Animated: 0</span>
      <button class="small" id="btn-auto-map" title="Reset manual mappings and distribute strokes automatically">Auto-map all</button>
    </div>
    <div class="dropzone" id="dropzone">Drag &amp; drop PNG / JPEG / WebP here, or click Upload</div>
    <div class="editor-wrap"><canvas id="editor" class="editor" width="440" height="248"></canvas></div>
    <div id="mapping" class="mapping-list" aria-label="Segment mapping"></div>
    ${CALIBRATE_MODE ? '<div class="calib-hint"><b>Calibration mode</b> (?calibrate=1): final outline frame shown. Draw = add target segment. Select + drag = adjust. <button id="btn-calib-export" class="small">Copy template JSON</button> <button id="btn-calib-use" class="small">Use as template</button></div>' : ''}
  </section>
  <section class="panel" aria-label="Animation preview">
    <h2>Animation Preview</h2>
    <div class="stage-badge" id="stage">–</div>
    <canvas id="preview" class="preview-canvas" width="440" height="248"></canvas>
    <section class="timeline-panel" aria-label="Entire GIF timeline">
      <div id="timeline-editor" class="timeline-editor"></div>
    </section>
    <div class="seek-row">
      <button id="btn-play" class="small">Play</button>
      <button id="btn-restart" class="small">Restart</button>
      <input type="range" id="seek" min="0" max="1000" value="0" aria-label="Seek" />
      <span class="time-label" id="time">0.0 / 0.0s</span>
    </div>
    <div class="toolbar">
      <label class="export-format-label" for="export-format">Output
        <select id="export-format" aria-label="Output format">
          <option value="gif">Animated GIF (.gif)</option>
          <option value="video">Video (browser-supported MP4 / WebM)</option>
        </select>
      </label>
      <button id="btn-generate" class="primary" disabled>Generate GIF</button>
      <a id="btn-download" style="display:none"><button class="primary">Download stick-bug-custom.gif</button></a>
      <button id="btn-cancel" class="danger" style="display:none">Cancel</button>
    </div>
    <div class="progress" id="progress"><div id="progress-bar"></div></div>
    <div class="status info" id="status">Loading reference GIF…</div>
    <p id="export-format-hint" class="export-format-hint">GIF: silent animation. Video: silent MP4 or WebM using your browser's encoder.</p>
    <img id="result" class="result-img" alt="Generated GIF" />
    <video id="video-result" class="result-video" controls playsinline preload="metadata" aria-label="Generated video preview"></video>
    <details class="settings" open>
      <summary>Animation timing &amp; settings</summary>
      <div id="timing-summary" class="timing-summary" aria-live="polite"></div>
      <div class="settings-grid" id="settings-grid"></div>
    </details>
    <div class="kbd-hint"><kbd>Ctrl+Z</kbd> undo · <kbd>Ctrl+Y</kbd> redo · <kbd>Del</kbd> delete · <kbd>Esc</kbd> deselect · <kbd>Space</kbd> play/pause</div>
  </section>
</div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const editorCanvas = $('editor') as HTMLCanvasElement;
const previewCanvas = $('preview') as HTMLCanvasElement;
const statusEl = $('status');
const segCountEl = $('seg-count');
let timelineUI: TimelineEditor | null = null;
let customPanel: CustomGifPanel | null = null;
let uploadAbort: AbortController | null = null;

function setStatus(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function clearExportResult(): void {
  if (state.exportedURL) URL.revokeObjectURL(state.exportedURL);
  state.exportedURL = null;
  const image = $('result') as HTMLImageElement;
  image.removeAttribute('src');
  image.classList.remove('show');
  const video = $('video-result') as HTMLVideoElement;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.classList.remove('show');
  const download = $('btn-download') as HTMLAnchorElement;
  download.removeAttribute('href');
  download.style.display = 'none';
}

function updateOutputFormatUI(): void {
  const preferred = preferredVideoFormat();
  const selector = $('export-format') as HTMLSelectElement;
  const videoOption = selector.querySelector('option[value="video"]')!;
  (videoOption as HTMLOptionElement).disabled = !preferred;
  videoOption.textContent = preferred ? 'Video (.' + preferred.extension + ')' : 'Video (unsupported browser)';
  if (!preferred && state.outputFormat === 'video') state.outputFormat = 'gif';
  selector.value = state.outputFormat;
  selector.disabled = state.exporting;
  $('btn-generate').textContent = state.outputFormat === 'gif' ? 'Generate GIF' : 'Generate video';
  $('export-format-hint').textContent = state.outputFormat === 'gif'
    ? 'GIF: animated image without sound, using original source-frame timing.'
    : 'Video: silent ' + (preferred?.label ?? 'MP4/WebM') +
      ' captured in real time. Output container depends on browser support.';
  updateGenerateButton();
}

$('export-format').addEventListener('change', (event) => {
  if (state.exporting) return;
  state.outputFormat = (event.target as HTMLSelectElement).value === 'video' ? 'video' : 'gif';
  clearExportResult();
  updateOutputFormatUI();
});

// ---------------------------------------------------------------- project for renderer

/**
 * Source GIF playback is trimmed at original frame boundaries. Every chosen
 * source frame retains its original centisecond delay in both preview/export.
 */
function memeDurationThrough(endIndex: number): number {
  if (!state.decoded) return 0;
  let centiseconds = 0;
  const end = Math.min(state.decoded.frames.length, Math.max(state.memeStartFrame, endIndex));
  for (let i = state.memeStartFrame; i < end; i++)
    centiseconds += state.decoded.frames[i].delayCs;
  return centiseconds / 100;
}

function memeFullDuration(): number {
  return state.decoded ? memeDurationThrough(state.decoded.frames.length) : 0;
}

function selectedMemeDuration(): number {
  return memeDurationThrough(state.memeEndFrameExclusive);
}

function firstMemeFrameDuration(): number {
  return state.decoded?.frames[state.memeStartFrame]?.delaySec ?? 0;
}

/** Snap a requested clip length to the closest complete source frame. */
function setMemePlaybackSeconds(requestedSeconds: number): void {
  if (!state.decoded) return;
  const frames = state.decoded.frames;
  const targetCs = Math.round(requestedSeconds * 100);
  let sumCs = 0;
  let bestDifference = Number.POSITIVE_INFINITY;
  let bestEnd = state.memeStartFrame + 1;
  for (let i = state.memeStartFrame; i < frames.length; i++) {
    sumCs += frames[i].delayCs;
    const difference = Math.abs(sumCs - targetCs);
    if (difference < bestDifference) {
      bestDifference = difference;
      bestEnd = i + 1;
    }
  }
  state.memeEndFrameExclusive = bestEnd;
}

function buildProject(): RenderProject | null {
  if (!state.decoded || state.memeEndFrameExclusive <= state.memeStartFrame) return null;
  return {
    image: state.image,
    userSegments: buildEffectiveSegments(state.userSegments, TARGETS),
    template: TARGETS,
    targetById,
    settings: state.settings,
    gifWidth: state.decoded.width,
    gifHeight: state.decoded.height,
    memeFrames: state.decoded.frames,
    memeStartIndex: state.memeStartFrame,
    memeEndIndex: state.memeEndFrameExclusive,
    memeDuration: selectedMemeDuration(),
  };
}

function totalDuration(): number {
  return computeTimeline(
    effectiveSegmentCount(state.userSegments, TARGETS),
    state.settings,
    selectedMemeDuration(),
  ).total;
}

// ---------------------------------------------------------------- editor canvas

const editorCtx = editorCanvas.getContext('2d')!;
let calibTargets: TargetSegment[] = TARGETS.map((t) => ({ ...t }));
let calibSelected: string | null = null;

function canvasPos(e: PointerEvent): Point {
  const r = editorCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function fitEditorCanvas(): void {
  const variation = VARIATIONS[state.variation];
  const W = state.decoded?.width ?? variation.referenceWidth;
  const H = state.decoded?.height ?? variation.referenceHeight;
  editorCanvas.width = W * 2;
  editorCanvas.height = H * 2;
  previewCanvas.width = W * 2;
  previewCanvas.height = H * 2;
}

function drawEditor(draft?: { a: Point; b: Point }): void {
  const W = editorCanvas.width;
  const H = editorCanvas.height;
  editorCtx.clearRect(0, 0, W, H);
  const s = state.settings;

  if (CALIBRATE_MODE && state.decoded) {
    // Show the target frame immediately before the selected meme begins.
    const f = state.decoded.frames[Math.max(0, state.memeStartFrame - 1)] ?? state.decoded.frames[0];
    const tmp = document.createElement('canvas');
    tmp.width = f.imageData.width;
    tmp.height = f.imageData.height;
    tmp.getContext('2d')!.putImageData(f.imageData, 0, 0);
    editorCtx.imageSmoothingEnabled = false;
    editorCtx.drawImage(tmp, 0, 0, W, H);
    // Draw calibration targets.
    calibTargets.forEach((t, i) => {
      const sel = t.id === calibSelected;
      editorCtx.strokeStyle = sel ? '#22c55e' : '#facc15';
      editorCtx.lineWidth = sel ? 5 : 3;
      editorCtx.lineCap = 'round';
      editorCtx.beginPath();
      editorCtx.moveTo(t.start.x * W, t.start.y * H);
      editorCtx.lineTo(t.end.x * W, t.end.y * H);
      editorCtx.stroke();
      editorCtx.fillStyle = '#000';
      editorCtx.font = `${Math.max(12, W / 28)}px sans-serif`;
      const mx = ((t.start.x + t.end.x) / 2) * W;
      const my = ((t.start.y + t.end.y) / 2) * H;
      editorCtx.fillText(`t${i}`, mx + 4, my - 4);
    });
    if (draft) {
      editorCtx.strokeStyle = '#22c55e';
      editorCtx.lineWidth = 3;
      editorCtx.beginPath();
      editorCtx.moveTo(draft.a.x * W, draft.a.y * H);
      editorCtx.lineTo(draft.b.x * W, draft.b.y * H);
      editorCtx.stroke();
    }
    return;
  }

  // Normal mode: uploaded image with contain/cover fit.
  if (state.image) {
    const iw = state.image.naturalWidth;
    const ih = state.image.naturalHeight;
    const scale =
      s.imageFit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    editorCtx.fillStyle = '#000';
    editorCtx.fillRect(0, 0, W, H);
    editorCtx.drawImage(state.image, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    editorCtx.fillStyle = '#0d0d14';
    editorCtx.fillRect(0, 0, W, H);
    editorCtx.fillStyle = '#9a9ab0';
    editorCtx.font = '14px sans-serif';
    editorCtx.textAlign = 'center';
    editorCtx.fillText('Upload an image to start drawing', W / 2, H / 2);
    editorCtx.textAlign = 'left';
  }

  // Segments.
  const dprScale = W / (state.decoded?.width ?? 220);
  state.userSegments.forEach((sg, i) => {
    const sel = sg.id === state.selectedId;
    editorCtx.strokeStyle = sel ? '#e9d5ff' : s.segmentColor;
    editorCtx.lineWidth = Math.max(2, s.segmentWidth * dprScale) + (sel ? 2 : 0);
    editorCtx.lineCap = 'round';
    editorCtx.beginPath();
    editorCtx.moveTo(sg.start.x * W, sg.start.y * H);
    editorCtx.lineTo(sg.end.x * W, sg.end.y * H);
    editorCtx.stroke();
    if (sel) {
      for (const p of [sg.start, sg.end]) {
        editorCtx.fillStyle = '#fff';
        editorCtx.beginPath();
        editorCtx.arc(p.x * W, p.y * H, 7, 0, Math.PI * 2);
        editorCtx.fill();
        editorCtx.fillStyle = s.segmentColor;
        editorCtx.beginPath();
        editorCtx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
        editorCtx.fill();
      }
    }
    editorCtx.fillStyle = sel ? '#fff' : s.segmentColor;
    editorCtx.font = `bold ${Math.max(13, W / 30)}px sans-serif`;
    editorCtx.fillText(
      String(i + 1),
      ((sg.start.x + sg.end.x) / 2) * W + 6,
      ((sg.start.y + sg.end.y) / 2) * H - 6,
    );
  });

  if (draft) {
    editorCtx.strokeStyle = s.segmentColor;
    editorCtx.lineWidth = Math.max(2, s.segmentWidth * dprScale);
    editorCtx.setLineDash([8, 5]);
    editorCtx.beginPath();
    editorCtx.moveTo(draft.a.x * W, draft.a.y * H);
    editorCtx.lineTo(draft.b.x * W, draft.b.y * H);
    editorCtx.stroke();
    editorCtx.setLineDash([]);
  }
}

// --- pointer interactions
type DragMode =
  | { kind: 'new'; a: Point }
  | { kind: 'move'; id: string; dx: number; dy: number; last: Point }
  | { kind: 'endpoint'; id: string; which: 'start' | 'end' }
  | null;

let drag: DragMode = null;
let draftPt: { a: Point; b: Point } | null = null;
let hoverId: string | null = null;

function refreshUndoRedo(): void {
  ($('btn-undo') as HTMLButtonElement).disabled = undoStack.length === 0;
  ($('btn-redo') as HTMLButtonElement).disabled = state.redoStack.length === 0;
  ($('btn-del') as HTMLButtonElement).disabled = !state.selectedId && !CALIBRATE_MODE;
}

const undoStack: UserSegment[][] = [];
function doUndo(): void {
  if (CALIBRATE_MODE) return;
  if (undoStack.length === 0) return;
  state.redoStack.push(structuredClone(state.userSegments));
  state.userSegments = undoStack.pop()!;
  state.selectedId = null;
  afterSegmentsChanged();
}
function doRedo(): void {
  if (CALIBRATE_MODE) return;
  const nxt = state.redoStack.pop();
  if (!nxt) return;
  undoStack.push(structuredClone(state.userSegments));
  state.userSegments = nxt;
  afterSegmentsChanged();
}
function checkpoint(): void {
  undoStack.push(structuredClone(state.userSegments));
  if (undoStack.length > 100) undoStack.shift();
  state.redoStack = [];
}

function nearestSegment(p: Point): { id: string; dist: number } | null {
  const W = state.decoded?.width ?? 220;
  const H = state.decoded?.height ?? 124;
  let best: { id: string; dist: number } | null = null;
  for (const sg of state.userSegments) {
    const d = distToSegmentPx(p, sg.start, sg.end, W, H);
    if (!best || d < best.dist) best = { id: sg.id, dist: d };
  }
  return best;
}

function endpointNear(p: Point, sg: UserSegment): 'start' | 'end' | null {
  const W = editorCanvas.width;
  const H = editorCanvas.height;
  const r = 14;
  if (Math.hypot((p.x - sg.start.x) * W, (p.y - sg.start.y) * H) < r) return 'start';
  if (Math.hypot((p.x - sg.end.x) * W, (p.y - sg.end.y) * H) < r) return 'end';
  return null;
}

editorCanvas.addEventListener('pointerdown', (e) => {
  editorCanvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);

  if (CALIBRATE_MODE) {
    // Select existing or start new calibration segment.
    let hit: string | null = null;
    let best = 12;
    for (const t of calibTargets) {
      const d = distToSegmentPx(p, t.start, t.end, 220, 124);
      if (d < best) {
        best = d;
        hit = t.id;
      }
    }
    if (hit) {
      calibSelected = hit;
      const t = calibTargets.find((x) => x.id === hit)!;
      const ep = endpointNearCalib(p, t);
      drag = ep
        ? { kind: 'endpoint', id: hit, which: ep }
        : { kind: 'move', id: hit, dx: 0, dy: 0, last: p };
    } else {
      drag = { kind: 'new', a: p };
    }
    drawEditor();
    refreshUndoRedo();
    return;
  }

  if (!state.image) {
    setStatus('Upload an image before drawing segments.', 'error');
    return;
  }
  if (state.tool === 'draw') {
    // Extra strokes are valid: they will subdivide the target outline.
    drag = { kind: 'new', a: p };
    draftPt = { a: p, b: p };
  } else {
    const sg = state.userSegments.find((x) => x.id === state.selectedId);
    if (sg) {
      const ep = endpointNear(p, sg);
      if (ep) {
        drag = { kind: 'endpoint', id: sg.id, which: ep };
        checkpoint();
        return;
      }
    }
    const near = nearestSegment(p);
    const W = state.decoded?.width ?? 220;
    if (near && near.dist < 12 * (editorCanvas.width / W / 2)) {
      state.selectedId = near.id;
      drag = { kind: 'move', id: near.id, dx: 0, dy: 0, last: p };
      checkpoint();
    } else {
      state.selectedId = null;
    }
    afterSegmentsChanged(false);
  }
  drawEditor();
});

editorCanvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  if (!drag) {
    if (!CALIBRATE_MODE && state.tool === 'select') {
      const near = nearestSegment(p);
      const W = state.decoded?.width ?? 220;
      hoverId = near && near.dist < 12 * (editorCanvas.width / W / 2) ? near.id : null;
      editorCanvas.style.cursor = hoverId ? 'move' : 'default';
    }
    return;
  }
  if (drag.kind === 'new') {
    draftPt = { a: drag.a, b: p };
    drawEditor(draftPt);
  } else if (drag.kind === 'endpoint') {
    const dragId = (drag as { id: string }).id;
    const which = (drag as { which: 'start' | 'end' }).which;
    if (CALIBRATE_MODE) {
      const t = calibTargets.find((x) => x.id === dragId)!;
      if (which === 'start') t.start = p;
      else t.end = p;
      drawEditor();
    } else {
      const sg = state.userSegments.find((x) => x.id === dragId);
      if (sg) {
        if (which === 'start') sg.start = p;
        else sg.end = p;
        drawEditor();
      }
    }
  } else if (drag.kind === 'move') {
    const dx = p.x - drag.last.x;
    const dy = p.y - drag.last.y;
    drag.last = p;
    const dragId = (drag as { id: string }).id;
    if (CALIBRATE_MODE) {
      const t = calibTargets.find((x) => x.id === dragId)!;
      t.start = clampPt({ x: t.start.x + dx, y: t.start.y + dy });
      t.end = clampPt({ x: t.end.x + dx, y: t.end.y + dy });
      drawEditor();
    } else {
      const sg = state.userSegments.find((x) => x.id === dragId);
      if (sg) {
        sg.start = clampPt({ x: sg.start.x + dx, y: sg.start.y + dy });
        sg.end = clampPt({ x: sg.end.x + dx, y: sg.end.y + dy });
        drawEditor();
      }
    }
  }
});

editorCanvas.addEventListener('pointerup', (e) => {
  const p = canvasPos(e);
  if (drag?.kind === 'new') {
    if (CALIBRATE_MODE) {
      const a = drag.a;
      const W = state.decoded?.width ?? 220;
      const H = state.decoded?.height ?? 124;
      if (segmentLengthPx(a, p, W, H) >= 4) {
        calibTargets.push({
          id: `t${calibTargets.length}`,
          start: { ...a },
          end: { ...p },
          order: calibTargets.length,
        });
        calibTargets.forEach((t, i) => (t.order = i));
        calibSelected = calibTargets[calibTargets.length - 1].id;
      }
      drawEditor();
    } else {
      const a = drag.a;
      const W = state.decoded?.width ?? 220;
      const H = state.decoded?.height ?? 124;
      if (segmentLengthPx(a, p, W, H) < 4) {
        setStatus('Segment too short — drag a longer line.', 'error');
      } else {
        checkpoint();
        const order = state.userSegments.length;
        state.userSegments.push({
          id: `u${state.idCounter++}`,
          start: { ...a },
          end: { ...p },
          targetSegmentId: TARGETS[Math.min(order, N - 1)]?.id ?? '',
          order,
          flipped: false,
          mappingMode: 'auto',
        });
        state.selectedId = state.userSegments[state.userSegments.length - 1].id;
        afterSegmentsChanged();
      }
    }
  } else if (drag && !CALIBRATE_MODE) {
    afterSegmentsChanged();
  }
  drag = null;
  draftPt = null;
  drawEditor();
});

function clampPt(p: Point): Point {
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

function endpointNearCalib(p: Point, t: TargetSegment): 'start' | 'end' | null {
  const W = editorCanvas.width;
  const H = editorCanvas.height;
  const r = 14;
  if (Math.hypot((p.x - t.start.x) * W, (p.y - t.start.y) * H) < r) return 'start';
  if (Math.hypot((p.x - t.end.x) * W, (p.y - t.end.y) * H) < r) return 'end';
  return null;
}

// ---------------------------------------------------------------- mapping panel

function renderMapping(): void {
  const box = $('mapping');
  if (CALIBRATE_MODE) {
    box.innerHTML =
      `<div style="font-size:12px;color:var(--muted)">Calibration targets (${calibTargets.length}): ` +
      calibTargets
        .map(
          (t, i) =>
            `<button class="small" data-cal="${t.id}">t${i} (${t.start.x.toFixed(2)},${t.start.y.toFixed(2)})→(${t.end.x.toFixed(2)},${t.end.y.toFixed(2)})</button>`,
        )
        .join(' ') +
      ` <button class="small danger" id="cal-del">Delete selected</button></div>`;
    box.querySelectorAll('[data-cal]').forEach((b) =>
      b.addEventListener('click', () => {
        calibSelected = (b as HTMLElement).dataset.cal!;
        drawEditor();
      }),
    );
    $('cal-del')?.addEventListener('click', () => {
      calibTargets = calibTargets.filter((t) => t.id !== calibSelected);
      calibTargets.forEach((t, i) => (t.order = i));
      calibSelected = null;
      drawEditor();
      renderMapping();
    });
    return;
  }
  if (TARGETS.length === 0) {
    box.textContent = state.variation === 'custom'
      ? 'Sketch and trace the custom GIF target before mapping lines.'
      : 'No template targets available.';
    return;
  }
  const colors = ['#a855f7', '#22d3ee', '#f472b6', '#facc15', '#34d399', '#fb923c', '#818cf8', '#f87171', '#2dd4bf'];
  box.innerHTML = '';
  [...state.userSegments]
    .sort((a, b) => a.order - b.order)
    .forEach((sg, i) => {
      const row = document.createElement('div');
      row.className = 'mapping-row' + (sg.id === state.selectedId ? ' selected' : '');
      const targetIdx = TARGETS.findIndex((t) => t.id === sg.targetSegmentId);
      row.innerHTML = `<span class="swatch" style="background:${colors[i % colors.length]}"></span>
        <b>#${i + 1}</b>
        <select aria-label="Target for segment ${i + 1}">
          ${TARGETS.map((t, ti) => `<option value="${t.id}" ${t.id === sg.targetSegmentId ? 'selected' : ''}>→ target ${ti + 1}</option>`).join('')}
        </select>
        <button class="small" title="Reverse direction">⇄ ${sg.flipped ? 'rev' : 'fwd'}</button>
        <span title="${sg.mappingMode === 'manual' ? 'Pinned by user' : 'Automatically distributed'}" style="color:var(--muted)">${sg.mappingMode === 'manual' ? 'Pinned' : 'Auto'} · t${targetIdx + 1}</span>`;
      row.querySelector('select')!.addEventListener('change', (e) => {
        checkpoint();
        sg.targetSegmentId = (e.target as HTMLSelectElement).value;
        sg.mappingMode = 'manual';
        afterSegmentsChanged(false);
      });
      row.querySelector('button')!.addEventListener('click', () => {
        checkpoint();
        sg.flipped = !sg.flipped;
        afterSegmentsChanged(false);
      });
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'SELECT') return;
        state.selectedId = sg.id;
        afterSegmentsChanged(false);
      });
      box.appendChild(row);
    });
}

function afterSegmentsChanged(clearErr = true): void {
  state.userSegments.forEach((segment, index) => { segment.order = index; });
  // The automatic allocation always covers each template line if possible.
  // Manual per-line target selections remain pinned across edits and undo.
  autoAssignTargets(state.userSegments, TARGETS);
  renderMapping();
  refreshUndoRedo();
  updateCounts();
  drawEditor();
  updateTimingSummary();
  updatePreviewUI();
  if (clearErr && state.refError === null) {
    const issue = validate();
    setStatus(issue ?? 'Ready. Missing strokes are cloned evenly; extra strokes fit the final outline.', issue ? 'error' : 'ok');
  }
}

function updateCounts(): void {
  const drawn = state.userSegments.length;
  const animated = effectiveSegmentCount(state.userSegments, TARGETS);
  const clones = Math.max(0, animated - drawn);
  segCountEl.textContent = `Drawn: ${drawn}`;
  segCountEl.className = `seg-count ${drawn > 0 ? 'ok' : 'short'}`;
  $('seg-template').textContent = `Template: ${N}`;
  $('seg-animated').textContent = `Animated: ${animated}${clones ? ` (+${clones} copies)` : ''}`;
  $('seg-animated').className = `seg-count ${drawn > 0 ? 'ok' : 'short'}`;
  updateGenerateButton();
}

function validate(): string | null {
  if (state.refError) return state.refError;
  if (!state.decoded) return 'Reference GIF still loading…';
  if (state.memeStartFrame < 0 || state.memeStartFrame >= state.decoded.frames.length)
    return 'Invalid meme start frame for the selected variation.';
  if (state.memeEndFrameExclusive <= state.memeStartFrame || state.memeEndFrameExclusive > state.decoded.frames.length)
    return 'Choose a valid source GIF end frame.';
  if (state.variation === 'custom' && N === 0)
    return 'Sketch the custom GIF target and generate its outline first.';
  if (!state.image) return 'Upload an image to begin.';
  if (state.userSegments.length === 0)
    return 'Draw at least one line. Missing template lines will be cloned automatically.';
  const animatedSegments = buildEffectiveSegments(state.userSegments, TARGETS);
  if (coveredTargetCount(animatedSegments, TARGETS) !== N)
    return 'Could not cover the entire target outline. Try Auto-map all.';
  const W = state.decoded.width;
  const H = state.decoded.height;
  // The existing exporter buffers full RGBA frames. Prevent predictable
  // out-of-memory failures when combining long footage with 2×/4× output.
  const introSec = computeTimeline(animatedSegments.length, state.settings, 0).phaseEEnd;
  const frameEstimate = Math.ceil(introSec * state.settings.outputFps)
    + (state.memeEndFrameExclusive - state.memeStartFrame);
  const scale = state.settings.exportScale;
  const rawByteEstimate = frameEstimate * state.decoded.width * scale
    * state.decoded.height * scale * 4;
  if (rawByteEstimate > 260 * 1024 * 1024)
    return 'Export scale is too large for this clip. Choose 1× in Settings.';
  for (const sg of state.userSegments) {
    if (segmentLengthPx(sg.start, sg.end, W, H) < 4) return 'One segment is too short.';
    if (!targetById.has(sg.targetSegmentId)) return 'Unknown target mapping.';
  }
  return null;
}

function updateGenerateButton(): void {
  ($('btn-generate') as HTMLButtonElement).disabled = validate() !== null || state.exporting;
}

// ---------------------------------------------------------------- upload

function loadImageFile(file: File): void {
  const okTypes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!okTypes.includes(file.type)) {
    setStatus(`Unsupported format: ${file.type || file.name}. Use PNG, JPEG, or WebP.`, 'error');
    return;
  }
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageURL = url;
    drawEditor();
    const v = validate();
    setStatus(v ?? 'Image loaded. Draw segments.', v ? 'error' : 'ok');
    updateGenerateButton();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Could not decode that image — file may be corrupted.', 'error');
  };
  img.src = url;
}

$('btn-upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadImageFile(f);
});
const dz = $('dropzone');
dz.addEventListener('click', () => $('file-input').click());
['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('over');
  }),
);
dz.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadImageFile(f);
});

// ---------------------------------------------------------------- toolbar

$('tool-draw').addEventListener('click', () => {
  state.tool = 'draw';
  $('tool-draw').classList.add('active');
  $('tool-select').classList.remove('active');
  editorCanvas.classList.remove('select-mode');
});
$('tool-select').addEventListener('click', () => {
  state.tool = 'select';
  $('tool-select').classList.add('active');
  $('tool-draw').classList.remove('active');
  editorCanvas.classList.add('select-mode');
});
$('btn-undo').addEventListener('click', doUndo);
$('btn-redo').addEventListener('click', doRedo);
$('btn-auto-map').addEventListener('click', () => {
  if (CALIBRATE_MODE || state.userSegments.length === 0) return;
  checkpoint();
  for (const segment of state.userSegments) segment.mappingMode = 'auto';
  afterSegmentsChanged();
});
$('btn-del').addEventListener('click', () => {
  if (CALIBRATE_MODE || !state.selectedId) return;
  checkpoint();
  state.userSegments = state.userSegments.filter((s) => s.id !== state.selectedId);
  // Preserve manually selected mappings; redistribute auto strokes.
  state.selectedId = null;
  afterSegmentsChanged();
});
$('btn-clear').addEventListener('click', () => {
  if (CALIBRATE_MODE) {
    calibTargets = [];
    calibSelected = null;
    drawEditor();
    renderMapping();
    return;
  }
  if (state.userSegments.length === 0) return;
  checkpoint();
  state.userSegments = [];
  state.selectedId = null;
  afterSegmentsChanged();
});

// ---------------------------------------------------------------- settings panel

function timelinePhases(): PhaseSpec[] {
  const settings = state.settings;
  const memeLoaded = Boolean(state.decoded);
  // The reveal phase is skipped until the user draws their first stroke.
  const hasStrokes = state.userSegments.length > 0;
  return [
    { id: 'reveal', label: 'Line reveal', shortLabel: 'Reveal', color: '#7655d9',
      duration: hasStrokes ? settings.revealTotalDuration : 0, min: 0, max: hasStrokes ? 30 : 0 },
    { id: 'before', label: 'Before background change', shortLabel: 'Before', color: '#346da9',
      duration: settings.holdAfterReveal, min: 0, max: 30 },
    { id: 'after', label: 'After background change', shortLabel: 'After', color: '#1e8589',
      duration: settings.grayHold, min: 0, max: 30 },
    { id: 'motion', label: 'Transformation motion', shortLabel: 'Move', color: '#b8772a',
      duration: settings.transformDuration, min: 0, max: 30 },
    { id: 'final', label: 'Before original footage', shortLabel: 'Hold', color: '#9651a2',
      duration: settings.finalHold, min: 0, max: 30 },
    { id: 'meme', label: 'Original GIF footage', shortLabel: 'Meme', color: '#338760',
      duration: selectedMemeDuration(),
      min: memeLoaded ? firstMemeFrameDuration() : 0,
      max: memeLoaded ? memeFullDuration() : 0 },
  ];
}

/** Keep inputs and timeline consistent without stealing focus while typing. */
function syncTimingInputs(): void {
  const inputMap = [
    ['set-reveal', state.settings.revealTotalDuration],
    ['set-hold', state.settings.holdAfterReveal],
    ['set-gray', state.settings.grayHold],
    ['set-trans', state.settings.transformDuration],
    ['set-final', state.settings.finalHold],
    ['set-meme', selectedMemeDuration()],
  ] as const;
  for (const [id, seconds] of inputMap) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = seconds.toFixed(2);
  }
  const memeInput = document.getElementById('set-meme') as HTMLInputElement | null;
  if (memeInput) {
    memeInput.min = Math.max(0.01, firstMemeFrameDuration()).toFixed(2);
    memeInput.max = Math.max(0.01, memeFullDuration()).toFixed(2);
    memeInput.disabled = !state.decoded || state.exporting;
  }
  const detail = document.getElementById('meme-end-label');
  if (detail) {
    if (!state.decoded) detail.textContent = 'Loading source frames…';
    else detail.textContent =
      'Source ' + selectedMemeDuration().toFixed(2) + ' / ' + memeFullDuration().toFixed(2) +
      's · frames ' + state.memeStartFrame + '–' + (state.memeEndFrameExclusive - 1) +
      ' (' + (state.memeEndFrameExclusive - state.memeStartFrame) + ' frames)';
  }
}

/** Editing any handle changes its phase's duration, and no other durations. */
function syncCustomClipControls(): void {
  if (state.variation === 'custom' && state.decoded) {
    customPanel?.setSource(state.decoded.frames, state.memeStartFrame, state.memeEndFrameExclusive);
  }
}

function setTimelinePhaseDuration(id: PhaseId, seconds: number): void {
  if (state.exporting) return;
  const clamped = Math.min(30, Math.max(0, Math.round(seconds * 100) / 100));
  switch (id) {
    case 'reveal': state.settings.revealTotalDuration = clamped; break;
    case 'before': state.settings.holdAfterReveal = clamped; break;
    case 'after': state.settings.grayHold = clamped; break;
    case 'motion': state.settings.transformDuration = clamped; break;
    case 'final': state.settings.finalHold = clamped; break;
    case 'meme': setMemePlaybackSeconds(seconds); syncCustomClipControls(); break;
  }
  state.playT = Math.min(state.playT, totalDuration());
  updateTimingSummary();
  updatePreviewUI();
  updateGenerateButton();
}

function updateTimingSummary(): void {
  const summary = document.getElementById('timing-summary');
  if (!summary) return;
  const drawn = state.userSegments.length;
  const animated = effectiveSegmentCount(state.userSegments, TARGETS);
  const intro = computeTimeline(animated, state.settings, 0).phaseEEnd;
  const step = animated > 0 ? state.settings.revealTotalDuration / animated : 0;
  const meme = state.decoded ? selectedMemeDuration() : null;
  summary.textContent = `${drawn} drawn · ${animated} animated (${Math.max(0, animated - drawn)} clones) · template ${N} · ${state.settings.revealTotalDuration.toFixed(2)}s reveal (${step.toFixed(2)}s / line) · Intro ${intro.toFixed(2)}s`
    + (meme === null ? ' · Loading source media…' : ` · Source clip ${meme.toFixed(2)}s / ${memeFullDuration().toFixed(2)}s · Total ${(intro + meme).toFixed(2)}s`);
  syncTimingInputs();
  timelineUI?.refresh();
}

function renderSettings(): void {
  const grid = $('settings-grid');
  const s = state.settings;
  grid.innerHTML = `
    <div class="settings-section-title">Animation timing · seconds</div>
    <label>Total line reveal time (s)<input type="number" id="set-reveal" min="0" max="30" step="0.05" value="${s.revealTotalDuration}"></label>
    <label>Wait before background change (s)<input type="number" id="set-hold" min="0" max="30" step="0.1" value="${s.holdAfterReveal}"></label>
    <label>Wait after background change (s)<input type="number" id="set-gray" min="0" max="30" step="0.1" value="${s.grayHold}"></label>
    <label>Transformation motion (s)<input type="number" id="set-trans" min="0" max="30" step="0.1" value="${s.transformDuration}"></label>
    <label>Wait before original GIF (s)<input type="number" id="set-final" min="0" max="30" step="0.1" value="${s.finalHold}"></label>
    <label>Source clip playback length (s)<input type="number" id="set-meme" min="0.01" step="0.05" value="${selectedMemeDuration().toFixed(2)}">
      <small class="meme-end-detail" id="meme-end-label">Loading source frames…</small>
    </label>
    <div class="settings-section-title">Appearance &amp; export</div>
    <label>Background<input type="color" id="set-bg" value="${s.backgroundColor}"></label>
    <label>Segment color<input type="color" id="set-seg" value="${s.segmentColor}"></label>
    <label>Stroke width (px)<input type="number" id="set-w" min="1" max="12" step="1" value="${s.segmentWidth}"></label>
    <label>Easing<select id="set-ease"><option value="linear">linear</option><option value="ease-in-out">ease-in-out</option><option value="ease-out">ease-out</option></select></label>
    <label>Preview/export FPS<select id="set-fps"><option>15</option><option>30</option><option>24</option></select></label>
    <label>Image fit<select id="set-fit"><option value="contain">contain</option><option value="cover">cover</option></select></label>
    <label>Export scale<select id="set-scale"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>`;
  const num = (id: string, fn: (v: number) => void) =>
    $(id).addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.value.trim() === '') return;
      const v = Number(input.value);
      if (Number.isFinite(v)) {
        fn(v);
        state.playT = Math.min(state.playT, totalDuration());
        drawEditor();
        updateTimingSummary();
        updatePreviewUI();
        updateGenerateButton();
      }
    });
  num('set-reveal', (v) => (state.settings.revealTotalDuration = Math.min(30, Math.max(0, v))));
  num('set-hold', (v) => (state.settings.holdAfterReveal = Math.min(30, Math.max(0, v))));
  num('set-gray', (v) => (state.settings.grayHold = Math.min(30, Math.max(0, v))));
  num('set-trans', (v) => (state.settings.transformDuration = Math.min(30, Math.max(0, v))));
  num('set-final', (v) => (state.settings.finalHold = Math.min(30, Math.max(0, v))));
  num('set-meme', (v) => { setMemePlaybackSeconds(v); syncCustomClipControls(); });
  $('set-meme').addEventListener('change', () => {
    const input = $('set-meme') as HTMLInputElement;
    setMemePlaybackSeconds(Number(input.value));
    syncCustomClipControls();
    input.value = selectedMemeDuration().toFixed(2);
    updateTimingSummary();
    updatePreviewUI();
    updateGenerateButton();
  });
  num('set-w', (v) => (state.settings.segmentWidth = Math.min(12, Math.max(1, Math.round(v)))));
  $('set-bg').addEventListener('input', (e) => {
    state.settings.backgroundColor = (e.target as HTMLInputElement).value;
  });
  $('set-seg').addEventListener('input', (e) => {
    state.settings.segmentColor = (e.target as HTMLInputElement).value;
    drawEditor();
  });
  $('set-ease').addEventListener('change', (e) => {
    state.settings.easing = (e.target as HTMLSelectElement).value as Settings['easing'];
  });
  ($('set-ease') as HTMLSelectElement).value = s.easing;
  $('set-fps').addEventListener('change', (e) => {
    state.settings.outputFps = Number((e.target as HTMLSelectElement).value) || 30;
  });
  ($('set-fps') as HTMLSelectElement).value = String(s.outputFps);
  $('set-fit').addEventListener('change', (e) => {
    state.settings.imageFit = (e.target as HTMLSelectElement).value as Settings['imageFit'];
    drawEditor();
  });
  ($('set-fit') as HTMLSelectElement).value = s.imageFit;
  $('set-scale').addEventListener('change', (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    state.settings.exportScale = (v === 2 || v === 4 ? v : 1) as 1 | 2 | 4;
    updateGenerateButton();
    const issue = validate();
    if (issue && issue.includes('Export scale')) setStatus(issue, 'error');
  });
  ($('set-scale') as HTMLSelectElement).value = String(s.exportScale);
  updateTimingSummary();
}

// ---------------------------------------------------------------- preview loop

function previewTick(now: number): void {
  if (state.playing) {
    const dt = (now - state.lastTick) / 1000;
    state.playT += dt;
    const total = totalDuration();
    if (state.playT >= total && total > 0) {
      state.playT = total;
      state.playing = false;
      ($('btn-play') as HTMLButtonElement).textContent = 'Play';
    }
    updatePreviewUI();
  }
  state.lastTick = now;
  requestAnimationFrame(previewTick);
}

function updatePreviewUI(): void {
  const proj = buildProject();
  const total = totalDuration();
  const seek = $('seek') as HTMLInputElement;
  if (proj) {
    renderFrame(Math.min(state.playT, Math.max(0, total - 0.001)), previewCanvas, proj);
    const tl = computeTimeline(proj.userSegments.length, state.settings, proj.memeDuration);
    const stage = stageAtTime(state.playT, tl);
    const stageLabel = stage === 'F' ? `F · ${VARIATIONS[state.variation].name}` : STAGE_LABELS[stage];
    $('stage').textContent = `${stageLabel} · ${state.playT.toFixed(1)}s`;
  }
  $('time').textContent = `${state.playT.toFixed(1)} / ${total.toFixed(1)}s`;
  if (total > 0) seek.value = String(Math.round((state.playT / total) * 1000));
  timelineUI?.setPlayhead(state.playT);
}

$('btn-play').addEventListener('click', () => {
  if (!buildProject()) {
    setStatus('Reference GIF not loaded yet.', 'error');
    return;
  }
  const total = totalDuration();
  if (state.playT >= total - 0.01) state.playT = 0;
  state.playing = !state.playing;
  ($('btn-play') as HTMLButtonElement).textContent = state.playing ? 'Pause' : 'Play';
});
$('btn-restart').addEventListener('click', () => {
  state.playT = 0;
  state.playing = true;
  ($('btn-play') as HTMLButtonElement).textContent = 'Pause';
  updatePreviewUI();
});
$('seek').addEventListener('input', (e) => {
  const total = totalDuration();
  state.playT = (Number((e.target as HTMLInputElement).value) / 1000) * total;
  updatePreviewUI();
});

// ---------------------------------------------------------------- export

function collectExportFrames(): {
  frames: { data: Uint8ClampedArray; width: number; height: number; delayMs: number }[];
  width: number;
  height: number;
} {
  const proj = buildProject()!;
  const scale = state.settings.exportScale;
  const W = proj.gifWidth * scale;
  const H = proj.gifHeight * scale;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const scaledProj: RenderProject = { ...proj };
  const fps = state.settings.outputFps;
  const tl = computeTimeline(proj.userSegments.length, state.settings, proj.memeDuration);
  const out: { data: Uint8ClampedArray; width: number; height: number; delayMs: number }[] = [];
  const ctx = c.getContext('2d')!;

  // GIF stores delays in 10ms units. Generate the introduction on a
  // centisecond timeline so rounding a 30fps interval to 30ms does not
  // shorten the animation by 10%. A 30fps schedule becomes 30/40/30ms.
  const introEndCs = Math.round(tl.phaseEEnd * 100);
  let cursorCs = 0;
  let introFrame = 0;
  while (cursorCs < introEndCs) {
    const nextCs = Math.min(
      introEndCs,
      Math.max(cursorCs + 1, Math.round(((introFrame + 1) * 100) / fps)),
    );
    renderFrame(cursorCs / 100, c, scaledProj);
    out.push({
      data: ctx.getImageData(0, 0, W, H).data,
      width: W,
      height: H,
      delayMs: (nextCs - cursorCs) * 10,
    });
    cursorCs = nextCs;
    introFrame++;
  }
  // Phase F: original frames verbatim, scaled up. No resampling of
  // timing: each source frame keeps its own delay. At 1x, pixel data is
  // copied without smoothing (nearest-neighbor path in renderFrame).
  const blit = document.createElement('canvas');
  for (let i = state.memeStartFrame; i < proj.memeEndIndex; i++) {
    const f = proj.memeFrames[i];
    blit.width = f.imageData.width;
    blit.height = f.imageData.height;
    blit.getContext('2d')!.putImageData(f.imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(blit, 0, 0, W, H);
    out.push({
      data: ctx.getImageData(0, 0, W, H).data,
      width: W,
      height: H,
      // Copy each source frame ONCE, keeping its native centisecond delay.
      delayMs: f.delayCs * 10,
    });
  }
  return { frames: out, width: W, height: H };
}

async function runExport(): Promise<void> {
  const err = validate();
  if (err) {
    setStatus(err, 'error');
    return;
  }
  if (state.exporting) return;
  state.exporting = true;
  ($('variation-select') as HTMLSelectElement).disabled = true;
  updateGenerateButton();
  $('btn-cancel').style.display = '';
  $('progress').classList.add('show');

  try {
    setStatus('Rendering frames…', 'info');
    // Yield so UI paints before heavy loop.
    await new Promise((r) => setTimeout(r, 30));
    const { frames, width, height } = collectExportFrames();
    setStatus(`Encoding ${frames.length} frames…`, 'info');

    const bytes = await encodeWithWorkerOrFallback(frames, width, height);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' });
    if (state.exportedURL) URL.revokeObjectURL(state.exportedURL);
    state.exportedURL = URL.createObjectURL(blob);
    const img = $('result') as HTMLImageElement;
    img.src = state.exportedURL;
    img.classList.add('show');
    const dl = $('btn-download') as HTMLAnchorElement;
    dl.href = state.exportedURL;
    dl.download = VARIATIONS[state.variation].exportFilename;
    (dl.querySelector('button') as HTMLButtonElement).textContent = `Download ${dl.download}`;
    dl.style.display = '';
    setStatus(`Done — ${frames.length} frames, ${(blob.size / 1024).toFixed(0)} KB.`, 'ok');
  } catch (e) {
    setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    state.exporting = false;
    ($('variation-select') as HTMLSelectElement).disabled = false;
    $('btn-cancel').style.display = 'none';
    $('progress').classList.remove('show');
    updateGenerateButton();
  }
}

function encodeWithWorkerOrFallback(
  frames: { data: Uint8ClampedArray; width: number; height: number; delayMs: number }[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  // Keep the originals intact until the worker succeeds. Transferring every
  // frame detaches the only buffers, making recovery impossible if the worker
  // cannot load or is killed by the browser.
  let cancelled = false;
  let worker: Worker | null = null;
  const cancelError = () => new Error('Export cancelled.');
  const closeWorker = () => {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
    state.worker = null;
  };

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const finish = (bytes: Uint8Array) => {
      if (settled) return;
      settled = true;
      closeWorker();
      resolve(bytes);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeWorker();
      reject(error);
    };

    const cancelledByUser = () => {
      cancelled = true;
      fail(cancelError());
    };
    $('btn-cancel').onclick = cancelledByUser;

    // Chunked fallback avoids reliance on Web Worker module loading.
    // Also avoids a second complete copy of 2x/4x output frames in memory.
    async function encodeOnMainThread(reason: string): Promise<void> {
      if (settled || cancelled) return;
      closeWorker();
      setStatus(`Worker unavailable (${reason}). Encoding in browser…`, 'info');
      try {
        const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
        const gif = GIFEncoder();
        for (let i = 0; i < frames.length; i++) {
          if (cancelled || settled) throw cancelError();
          const frame = frames[i];
          const palette = quantize(frame.data, 256, { format: 'rgba4444' });
          const indexed = applyPalette(frame.data, palette, 'rgba4444');
          const delay = Math.max(10, Math.round(frame.delayMs / 10) * 10);
          gif.writeFrame(indexed, width, height, { palette, delay });
          $('progress-bar').style.width = `${((i + 1) / frames.length) * 100}%`;
          if (i % 4 === 0) {
            setStatus(`Encoding locally ${i + 1}/${frames.length}…`, 'info');
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
        gif.finish();
        const bytes = gif.bytes().slice();
        if (bytes.length < 7 || bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) {
          throw new Error('Encoder did not produce a valid GIF header.');
        }
        finish(bytes);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // Structured-cloning huge frame arrays can exhaust worker memory.
    // Such exports run directly with the chunked encoder instead.
    const totalBytes = frames.reduce((sum, f) => sum + f.data.byteLength, 0);
    if (totalBytes > 64 * 1024 * 1024) {
      void encodeOnMainThread('large export');
      return;
    }

    try {
      worker = new Worker(new URL('./workers/gifExport.worker.ts', import.meta.url), {
        type: 'module',
      });
      state.worker = worker;
    } catch (error) {
      void encodeOnMainThread(error instanceof Error ? error.message : 'startup failure');
      return;
    }

    const w = worker;
    w.onmessage = (e: MessageEvent) => {
      if (settled || cancelled) return;
      const msg = e.data as
        | { type: 'progress'; done: number; total: number }
        | { type: 'done'; buffer: ArrayBuffer }
        | { type: 'error'; message: string };
      if (msg.type === 'progress') {
        $('progress-bar').style.width = `${(msg.done / msg.total) * 100}%`;
        setStatus(`Encoding ${msg.done}/${msg.total}…`, 'info');
      } else if (msg.type === 'done') {
        const bytes = new Uint8Array(msg.buffer);
        if (bytes.length < 7 || bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) {
          void encodeOnMainThread('invalid worker output');
        } else {
          finish(bytes);
        }
      } else if (msg.type === 'error') {
        void encodeOnMainThread(msg.message || 'worker encoding error');
      } else {
        void encodeOnMainThread('unrecognized worker response');
      }
    };
    w.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      void encodeOnMainThread(event.message || 'worker script/load error');
    };
    w.onmessageerror = () => {
      void encodeOnMainThread('worker message deserialization error');
    };

    try {
      // Do NOT transfer/detach buffers: worker may fail before sending any
      // result, and the original pixels are needed for fallback encoding.
      w.postMessage({
        type: 'export',
        frames: frames.map((f) => f.data.buffer),
        width,
        height,
        delaysMs: frames.map((f) => f.delayMs),
      });
    } catch (error) {
      void encodeOnMainThread(error instanceof Error ? error.message : 'message send error');
    }
  });
}

$('btn-generate').addEventListener('click', runExport);


// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    doUndo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    doRedo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (CALIBRATE_MODE) {
      calibTargets = calibTargets.filter((t) => t.id !== calibSelected);
      calibSelected = null;
      drawEditor();
      renderMapping();
    } else ($('btn-del') as HTMLButtonElement).click();
  } else if (e.key === 'Escape') {
    state.selectedId = null;
    calibSelected = null;
    drag = null;
    draftPt = null;
    drawEditor();
    renderMapping();
    refreshUndoRedo();
  } else if (e.key === ' ') {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(ae.tagName)) return;
    e.preventDefault();
    ($('btn-play') as HTMLButtonElement).click();
  }
});

// ---------------------------------------------------------------- calibration export

$('btn-calib-export')?.addEventListener('click', async () => {
  const payload = {
    segments: calibTargets.map((t, i) => ({ ...t, order: i })),
    memeStartFrame: state.memeStartFrame,
  };
  await navigator.clipboard.writeText(JSON.stringify(payload)).catch(() => undefined);
  setStatus('Template JSON copied to clipboard.', 'ok');
});
$('btn-calib-use')?.addEventListener('click', () => {
  TARGETS.length = 0;
  calibTargets.forEach((t, i) => TARGETS.push({ ...t, order: i }));
  targetById.clear();
  TARGETS.forEach((t) => targetById.set(t.id, t));
  N = TARGETS.length;
  afterSegmentsChanged(false);
  setStatus(`Using ${N} calibrated targets for this session.`, 'ok');
});

// ---------------------------------------------------------------- variation loading and initialization

// Reusing decoded frames avoids reloading/downloading a variation after
// switching away from it. Every preset still has its own template and timing.
const decodedCache = new Map<VariationId, Awaited<ReturnType<typeof decodeGif>>>();
let variationLoadToken = 0;

async function selectVariation(id: VariationId): Promise<void> {
  const preset = VARIATIONS[id];
  if (!preset) return;
  const token = ++variationLoadToken;
  uploadAbort?.abort();
  uploadAbort = null;
  $('custom-panel').hidden = id !== 'custom';
  if (id === 'custom') customPanel?.reset();
  state.variation = id;
  state.customMediaKind = 'gif';
  state.memeStartFrame = preset.memeStartFrame;
  state.decoded = null;
  state.memeEndFrameExclusive = 0;
  state.refError = null;
  state.playing = false;
  state.playT = 0;
  ($('btn-play') as HTMLButtonElement).textContent = 'Play';
  state.settings.backgroundColor = preset.backgroundColor;
  state.settings.segmentColor = preset.segmentColor;
  // The two target outlines have different stroke counts and positions.
  // Keep the uploaded photo, but reset lines and mappings on preset change.
  state.userSegments = [];
  state.redoStack = [];
  undoStack.length = 0;
  state.selectedId = null;
  drag = null;
  draftPt = null;
  TARGETS.splice(0, TARGETS.length, ...preset.segments.map((segment) => ({ ...segment })));
  N = TARGETS.length;
  targetById.clear();
  for (const segment of TARGETS) targetById.set(segment.id, segment);
  calibTargets = TARGETS.map((target) => structuredClone(target));
  calibSelected = null;

  clearExportResult();
  ($('variation-select') as HTMLSelectElement).value = id;
  $('variation-description').textContent = preset.description;
  renderSettings();
  fitEditorCanvas();
  renderMapping();
  refreshUndoRedo();
  updateCounts();
  drawEditor();
  updatePreviewUI();
  if (id === 'custom') {
    setStatus('Upload a custom GIF, set IN/OUT frames, then sketch around its target object.', 'info');
    return;
  }
  setStatus(`Loading ${preset.name} reference GIF…`, 'info');

  try {
    let decoded = decodedCache.get(id);
    if (!decoded) {
      let error: unknown = null;
      const urls = [
        `${import.meta.env.BASE_URL}${preset.gifFile}`,
        `./${preset.gifFile}`,
        preset.gifFile,
      ];
      for (const url of [...new Set(urls)]) {
        try {
          decoded = await decodeGif(url);
          break;
        } catch (e) {
          error = e;
        }
      }
      if (!decoded) throw error ?? new Error('Could not load the reference GIF.');
      if (decoded.frames.length <= preset.memeStartFrame)
        throw new Error(`Reference GIF has only ${decoded.frames.length} frames (needs frame ${preset.memeStartFrame}).`);
      decodedCache.set(id, decoded);
    }
    if (token !== variationLoadToken) return;
    state.decoded = decoded;
    state.memeEndFrameExclusive = decoded.frames.length;
    fitEditorCanvas();
    drawEditor();
    renderMapping();
    updatePreviewUI();
    updateTimingSummary();
    setStatus(`${preset.name} loaded: ${decoded.frames.length} frames, ${decoded.totalSec.toFixed(2)}s. Draw one or more lines; missing strokes are copied and extra strokes are fitted.`, 'ok');
    updateGenerateButton();
  } catch (e) {
    if (token !== variationLoadToken) return;
    state.refError = `${preset.name} reference failed to load: ${e instanceof Error ? e.message : String(e)}`;
    setStatus(state.refError, 'error');
    updateGenerateButton();
  }
}

$('variation-select').addEventListener('change', (e) => {
  void selectVariation((e.target as HTMLSelectElement).value as VariationId);
});

function applyCustomTargets(segments: TargetSegment[]): void {
  if (state.variation !== 'custom') return;
  TARGETS.splice(0, TARGETS.length, ...segments.map((segment, i) => ({
    ...segment, id: 't' + i, order: i,
    start: { ...segment.start }, end: { ...segment.end },
  })));
  N = TARGETS.length;
  targetById.clear();
  TARGETS.forEach((target) => targetById.set(target.id, target));
  calibTargets = TARGETS.map((target) => structuredClone(target));
  for (const stroke of state.userSegments) {
    stroke.mappingMode = 'auto';
    stroke.targetSegmentId = TARGETS[0]?.id ?? '';
  }
  state.selectedId = null;
  afterSegmentsChanged(false);
  setStatus(N
    ? 'Custom target ready: ' + N + ' lines. Draw source strokes on the image editor and generate your GIF.'
    : 'Target is empty. Draw a rough closed loop to trace it.', N ? 'ok' : 'info');
}

function updateCustomClip(start: number, endExclusive: number): void {
  if (state.variation !== 'custom' || !state.decoded) return;
  const frameCount = state.decoded.frames.length;
  const nextStart = Math.max(0, Math.min(frameCount - 1, start));
  const nextEnd = Math.max(nextStart + 1, Math.min(frameCount, endExclusive));
  const changedStart = state.memeStartFrame !== nextStart;
  state.memeStartFrame = nextStart;
  state.memeEndFrameExclusive = nextEnd;
  state.playT = Math.min(state.playT, totalDuration());
  if (changedStart) {
    // A target outline is bound to the chosen IN frame, never to a stale frame.
    applyCustomTargets([]);
  }
  customPanel?.setSource(state.decoded.frames, nextStart, nextEnd);
  updateTimingSummary();
  updatePreviewUI();
  updateGenerateButton();
  if (changedStart) setStatus('IN frame changed. Sketch this frame to generate a new target outline.', 'info');
}

async function uploadCustomGif(file: File): Promise<void> {
  if (state.variation !== 'custom') return;
  const token = ++variationLoadToken;
  state.refError = null;
  setStatus('Decoding custom GIF locally…', 'info');
  try {
    const decoded = await decodeGifFile(file);
    if (token !== variationLoadToken || state.variation !== 'custom') return;
    state.decoded = decoded;
    state.memeStartFrame = 0;
    state.memeEndFrameExclusive = decoded.frames.length;
    state.playT = 0;
    applyCustomTargets([]);
    customPanel?.setSource(decoded.frames, 0, decoded.frames.length);
    fitEditorCanvas();
    drawEditor();
    renderMapping();
    updateTimingSummary();
    updatePreviewUI();
    updateGenerateButton();
    setStatus('Loaded ' + file.name + ': ' + decoded.frames.length +
      ' frames, ' + decoded.totalSec.toFixed(2) + 's. Sketch around your target on the IN frame.', 'ok');
  } catch (error) {
    if (token !== variationLoadToken) return;
    state.refError = error instanceof Error ? error.message : String(error);
    setStatus('Custom GIF failed: ' + state.refError, 'error');
    updateGenerateButton();
  }
}

async function init(): Promise<void> {
  fitEditorCanvas();
  customPanel = mountCustomGifPanel($('custom-panel'), {
    upload: (file) => { void uploadCustomGif(file); },
    clip: updateCustomClip,
    generated: applyCustomTargets,
    edited: applyCustomTargets,
    message: (msg, error) => setStatus(msg, error ? 'error' : 'ok'),
  });
  timelineUI = mountTimelineEditor($('timeline-editor'), {
    phases: timelinePhases,
    playhead: () => state.playT,
    changeDuration: setTimelinePhaseDuration,
    seek: (time) => {
      state.playing = false;
      ($('btn-play') as HTMLButtonElement).textContent = 'Play';
      state.playT = Math.min(totalDuration(), Math.max(0, time));
      updatePreviewUI();
    },
    drawThumbnail: (time, canvas) => {
      const project = buildProject();
      if (!project) return;
      const width = 224;
      const height = Math.max(1, Math.round(width * project.gifHeight / project.gifWidth));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      renderFrame(Math.min(time, Math.max(0, totalDuration() - 0.001)), canvas, project);
    },
  });
  renderSettings();
  renderMapping();
  refreshUndoRedo();
  updateCounts();
  drawEditor();
  requestAnimationFrame(previewTick);
  await selectVariation('stickbug');
}

void init();
