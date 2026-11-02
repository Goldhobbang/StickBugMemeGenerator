import './styles/main.css';
import type {
  DecodedFrame,
  Point,
  Settings,
  TargetSegment,
  UserSegment,
} from './core/types';
import { DEFAULT_SETTINGS } from './core/types';
import { decodeGif, memeDurationFrom } from './core/gifDecoder';
import { computeTimeline, stageAtTime, STAGE_LABELS } from './core/timeline';
import { distToSegmentPx, segmentLengthPx } from './core/interpolation';
import { renderFrame, type RenderProject } from './core/renderFrame';
import templateData from './assets/stickbug-template.json';
import gifMeta from './assets/gif-meta.json';

// ---------------------------------------------------------------- state

interface AppState {
  image: HTMLImageElement | null;
  imageURL: string | null;
  userSegments: UserSegment[];
  redoStack: UserSegment[][];
  selectedId: string | null;
  tool: 'draw' | 'select';
  settings: Settings;
  decoded: { width: number; height: number; frames: DecodedFrame[] } | null;
  memeStartFrame: number;
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
  image: null,
  imageURL: null,
  userSegments: [],
  redoStack: [],
  selectedId: null,
  tool: 'draw',
  settings: { ...DEFAULT_SETTINGS },
  decoded: null,
  memeStartFrame: (gifMeta as { memeStartFrame: number }).memeStartFrame ?? 44,
  playing: false,
  playT: 0,
  lastTick: 0,
  exportedURL: null,
  refError: null,
  exporting: false,
  worker: null,
  idCounter: 1,
};

const tpl = templateData as { segments: TargetSegment[]; memeStartFrame: number };
const TARGETS: TargetSegment[] = [...tpl.segments].sort((a, b) => a.order - b.order);
const N = TARGETS.length;
const targetById = new Map(TARGETS.map((t) => [t.id, t]));

const CALIBRATE_MODE = new URLSearchParams(location.search).has('calibrate');

// ---------------------------------------------------------------- dom

const app = document.getElementById('app')!;

app.innerHTML = `
<header class="app-header">
  <h1>Stick <span class="bug">Bug</span> Meme Generator</h1>
  <p>Turn your image into a Stick Bug meme.</p>
</header>
<div class="layout">
  <section class="panel" aria-label="Image editor">
    <h2>Image Editor</h2>
    <div class="toolbar">
      <button id="btn-upload">Upload image</button>
      <input type="file" id="file-input" accept="image/png,image/jpeg,image/webp" hidden />
      <button id="tool-draw" class="active">Draw</button>
      <button id="tool-select">Select</button>
      <button id="btn-undo" disabled>Undo</button>
      <button id="btn-redo" disabled>Redo</button>
      <button id="btn-del" class="danger" disabled>Delete</button>
      <button id="btn-clear" class="danger">Clear</button>
      <span class="seg-count short" id="seg-count">Segments: 0 / ${N}</span>
    </div>
    <div class="dropzone" id="dropzone">Drag &amp; drop PNG / JPEG / WebP here, or click Upload</div>
    <div class="editor-wrap"><canvas id="editor" class="editor" width="440" height="248"></canvas></div>
    <div id="mapping" class="mapping-list" aria-label="Segment mapping"></div>
    ${CALIBRATE_MODE ? '<div class="calib-hint"><b>Calibration mode</b> (?calibrate=1): reference frame F43 shown. Draw = add target segment. Select + drag = adjust. <button id="btn-calib-export" class="small">Copy template JSON</button> <button id="btn-calib-use" class="small">Use as template</button></div>' : ''}
  </section>
  <section class="panel" aria-label="Animation preview">
    <h2>Animation Preview</h2>
    <div class="stage-badge" id="stage">–</div>
    <canvas id="preview" class="preview-canvas" width="440" height="248"></canvas>
    <div class="seek-row">
      <button id="btn-play" class="small">Play</button>
      <button id="btn-restart" class="small">Restart</button>
      <input type="range" id="seek" min="0" max="1000" value="0" aria-label="Seek" />
      <span class="time-label" id="time">0.0 / 0.0s</span>
    </div>
    <div class="toolbar">
      <button id="btn-generate" class="primary" disabled>Generate GIF</button>
      <a id="btn-download" style="display:none"><button class="primary">Download stick-bug-custom.gif</button></a>
      <button id="btn-cancel" class="danger" style="display:none">Cancel</button>
    </div>
    <div class="progress" id="progress"><div id="progress-bar"></div></div>
    <div class="status info" id="status">Loading reference GIF…</div>
    <img id="result" class="result-img" alt="Generated GIF" />
    <details class="settings">
      <summary>Settings</summary>
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

function setStatus(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

// ---------------------------------------------------------------- project for renderer

function buildProject(): RenderProject | null {
  if (!state.decoded) return null;
  const memeFrames = state.decoded.frames;
  let memeDuration = 0;
  for (let i = state.memeStartFrame; i < memeFrames.length; i++) {
    memeDuration += memeFrames[i].delaySec;
  }
  return {
    image: state.image,
    userSegments: [...state.userSegments].sort((a, b) => a.order - b.order),
    template: TARGETS,
    targetById,
    settings: state.settings,
    gifWidth: state.decoded.width,
    gifHeight: state.decoded.height,
    memeFrames,
    memeStartIndex: state.memeStartFrame,
    memeDuration,
  };
}

function totalDuration(): number {
  const memeDur = state.decoded
    ? memeDurationFrom(
        {
          width: state.decoded.width,
          height: state.decoded.height,
          frames: state.decoded.frames,
          totalSec: 0,
        },
        state.memeStartFrame,
      )
    : 0;
  return computeTimeline(state.userSegments.length, state.settings, memeDur).total;
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
  const W = state.decoded?.width ?? 220;
  const H = state.decoded?.height ?? 124;
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
    // Show composited reference frame F43 as annotation background.
    const f = state.decoded.frames[43] ?? state.decoded.frames[0];
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
    if (state.userSegments.length >= N) {
      setStatus(`Maximum ${N} segments reached. Delete one to redraw it.`, 'error');
      return;
    }
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
          targetSegmentId: TARGETS[order]?.id ?? TARGETS[0].id,
          order,
          flipped: false,
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
        <span style="color:var(--muted)">t${targetIdx + 1}</span>`;
      row.querySelector('select')!.addEventListener('change', (e) => {
        checkpoint();
        sg.targetSegmentId = (e.target as HTMLSelectElement).value;
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
  // Re-assign orders by array position.
  state.userSegments.forEach((sg, i) => (sg.order = i));
  renderMapping();
  refreshUndoRedo();
  updateCounts();
  drawEditor();
  if (clearErr && state.refError === null) {
    const v = validate();
    setStatus(v ?? 'Ready. Draw segments, then preview.', v ? 'error' : 'info');
  } else {
    updateGenerateButton();
  }
}

function updateCounts(): void {
  segCountEl.textContent = `Segments: ${state.userSegments.length} / ${N}`;
  segCountEl.className = `seg-count ${state.userSegments.length === N ? 'ok' : 'short'}`;
  updateGenerateButton();
}

function validate(): string | null {
  if (state.refError) return state.refError;
  if (!state.decoded) return 'Reference GIF still loading…';
  if (!state.image) return 'Upload an image to begin.';
  if (state.userSegments.length !== N)
    return `Draw exactly ${N} segments (now ${state.userSegments.length}).`;
  const W = state.decoded.width;
  const H = state.decoded.height;
  const seen = new Set<string>();
  for (const sg of state.userSegments) {
    if (segmentLengthPx(sg.start, sg.end, W, H) < 4) return 'One segment is too short.';
    if (seen.has(sg.targetSegmentId)) return 'Duplicate target mapping — each segment needs a unique target.';
    seen.add(sg.targetSegmentId);
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
$('btn-del').addEventListener('click', () => {
  if (CALIBRATE_MODE || !state.selectedId) return;
  checkpoint();
  state.userSegments = state.userSegments.filter((s) => s.id !== state.selectedId);
  // Reassign targets in drawing order.
  state.userSegments.forEach((sg, i) => (sg.targetSegmentId = TARGETS[i]?.id ?? TARGETS[0].id));
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

function renderSettings(): void {
  const grid = $('settings-grid');
  const s = state.settings;
  grid.innerHTML = `
    <label>Reveal interval (s)<input type="number" id="set-reveal" min="0.02" max="2" step="0.01" value="${s.revealInterval}"></label>
    <label>Initial hold (s)<input type="number" id="set-hold" min="0" max="5" step="0.1" value="${s.holdAfterReveal}"></label>
    <label>Gray hold (s)<input type="number" id="set-gray" min="0" max="5" step="0.1" value="${s.grayHold}"></label>
    <label>Transform (s)<input type="number" id="set-trans" min="0.1" max="5" step="0.1" value="${s.transformDuration}"></label>
    <label>Final hold (s)<input type="number" id="set-final" min="0" max="5" step="0.1" value="${s.finalHold}"></label>
    <label>Background<input type="color" id="set-bg" value="${s.backgroundColor}"></label>
    <label>Segment color<input type="color" id="set-seg" value="${s.segmentColor}"></label>
    <label>Stroke width (px)<input type="number" id="set-w" min="1" max="12" step="1" value="${s.segmentWidth}"></label>
    <label>Easing<select id="set-ease"><option value="linear">linear</option><option value="ease-in-out">ease-in-out</option><option value="ease-out">ease-out</option></select></label>
    <label>Preview/export FPS<select id="set-fps"><option>15</option><option>30</option><option>24</option></select></label>
    <label>Image fit<select id="set-fit"><option value="contain">contain</option><option value="cover">cover</option></select></label>
    <label>Export scale<select id="set-scale"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>`;
  const num = (id: string, fn: (v: number) => void) =>
    $(id).addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) {
        fn(v);
        drawEditor();
      }
    });
  num('set-reveal', (v) => (state.settings.revealInterval = Math.min(2, Math.max(0.02, v))));
  num('set-hold', (v) => (state.settings.holdAfterReveal = Math.min(5, Math.max(0, v))));
  num('set-gray', (v) => (state.settings.grayHold = Math.min(5, Math.max(0, v))));
  num('set-trans', (v) => (state.settings.transformDuration = Math.min(5, Math.max(0.1, v))));
  num('set-final', (v) => (state.settings.finalHold = Math.min(5, Math.max(0, v))));
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
  });
  ($('set-scale') as HTMLSelectElement).value = String(s.exportScale);
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
    $('stage').textContent = `${STAGE_LABELS[stageAtTime(state.playT, tl)]} · ${state.playT.toFixed(1)}s`;
  }
  $('time').textContent = `${state.playT.toFixed(1)} / ${total.toFixed(1)}s`;
  if (total > 0) seek.value = String(Math.round((state.playT / total) * 1000));
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
  const step = 1 / fps;
  const tl = computeTimeline(proj.userSegments.length, state.settings, proj.memeDuration);
  const out: { data: Uint8ClampedArray; width: number; height: number; delayMs: number }[] = [];

  // Phases A–E at fixed fps.
  for (let t = 0; t < tl.phaseEEnd; t += step) {
    renderFrame(t, c, scaledProj);
    const ctx = c.getContext('2d')!;
    out.push({ data: ctx.getImageData(0, 0, W, H).data, width: W, height: H, delayMs: (step * 1000) });
  }
  // Phase F: original frames verbatim, scaled up.
  const blit = document.createElement('canvas');
  for (let i = state.memeStartFrame; i < proj.memeFrames.length; i++) {
    const f = proj.memeFrames[i];
    blit.width = f.imageData.width;
    blit.height = f.imageData.height;
    blit.getContext('2d')!.putImageData(f.imageData, 0, 0);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(blit, 0, 0, W, H);
    out.push({
      data: ctx.getImageData(0, 0, W, H).data,
      width: W,
      height: H,
      delayMs: Math.max(20, f.delaySec * 1000),
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
    dl.download = 'stick-bug-custom.gif';
    dl.style.display = '';
    setStatus(`Done — ${frames.length} frames, ${(blob.size / 1024).toFixed(0)} KB.`, 'ok');
  } catch (e) {
    setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    state.exporting = false;
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
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./workers/gifExport.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      worker = null;
    }
    state.worker = worker;
    const onCancel = () => {
      try {
        worker?.terminate();
      } catch {
        /* noop */
      }
      state.worker = null;
      reject(new Error('Export cancelled.'));
    };
    $('btn-cancel').onclick = onCancel;

    if (!worker) {
      // Fallback: chunked main-thread encode to keep UI alive.
      (async () => {
        const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
        const gif = GIFEncoder();
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i];
          const palette = quantize(f.data, 256, { format: 'rgba4444' });
          const index = applyPalette(f.data, palette, 'rgba4444');
          gif.writeFrame(index, width, height, {
            palette,
            delay: Math.max(20, Math.round(f.delayMs / 10) * 10),
          });
          ($('progress-bar') as HTMLElement).style.width = `${((i + 1) / frames.length) * 100}%`;
          if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        gif.finish();
        resolve(gif.bytes());
      })().catch(reject);
      return;
    }

    const w = worker;
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'progress'; done: number; total: number }
        | { type: 'done'; buffer: ArrayBuffer }
        | { type: 'error'; message: string };
      if (msg.type === 'progress') {
        ($('progress-bar') as HTMLElement).style.width = `${(msg.done / msg.total) * 100}%`;
        setStatus(`Encoding ${msg.done}/${msg.total}…`, 'info');
      } else if (msg.type === 'done') {
        state.worker = null;
        w.terminate();
        resolve(new Uint8Array(msg.buffer));
      } else {
        state.worker = null;
        w.terminate();
        reject(new Error(msg.message));
      }
    };
    w.onerror = (ev) => {
      state.worker = null;
      try {
        w.terminate();
      } catch {
        /* noop */
      }
      reject(new Error(`Worker error: ${ev.message || 'unknown'}`));
    };
    const buffers = frames.map((f) => f.data.buffer as ArrayBuffer);
    const delaysMs = frames.map((f) => f.delayMs);
    w.postMessage({ type: 'export', frames: buffers, width, height, delaysMs }, buffers);
  });
}

$('btn-generate').addEventListener('click', runExport);
$('btn-cancel').addEventListener('click', () => {
  try {
    state.worker?.terminate();
  } catch {
    /* noop */
  }
  state.worker = null;
});

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
    if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'A')) return;
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
  setStatus(`Using ${TARGETS.length} calibrated targets for this session.`, 'ok');
});

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  fitEditorCanvas();
  renderSettings();
  renderMapping();
  refreshUndoRedo();
  updateCounts();
  drawEditor();
  requestAnimationFrame(previewTick);

  try {
    const decoded = await decodeGif(`${import.meta.env.BASE_URL}stick-bug.gif`);
    // BASE_URL is './' for GitHub Pages relative paths.
    state.decoded = decoded;
    state.refError = null;
    fitEditorCanvas();
    drawEditor();
    updatePreviewUI();
    const v = validate();
    setStatus(v ?? 'Reference loaded. Upload an image.', v ? 'info' : 'ok');
    updateGenerateButton();
  } catch (e) {
    // Retry with plain relative + absolute fallbacks.
    const tried: string[] = [];
    for (const url of ['stick-bug.gif', './stick-bug.gif', '/stick-bug.gif', 'src/assets/stick-bug.gif']) {
      try {
        tried.push(url);
        const decoded = await decodeGif(url);
        state.decoded = decoded;
        state.refError = null;
        fitEditorCanvas();
        drawEditor();
        updatePreviewUI();
        setStatus('Reference loaded. Upload an image.', 'ok');
        updateGenerateButton();
        return;
      } catch {
        /* try next */
      }
    }
    state.refError = `Reference GIF failed to load (tried ${tried.join(', ')}): ${e instanceof Error ? e.message : String(e)}`;
    setStatus(state.refError, 'error');
    updateGenerateButton();
  }
}

void init();
