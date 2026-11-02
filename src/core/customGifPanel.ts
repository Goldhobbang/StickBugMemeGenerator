import type { DecodedFrame, Point, TargetSegment } from './types';
import { traceSelectedRegion, traceSegmentationMask, type TraceMode, type TraceOptions } from './autoTrace';
import { segmentObjectFromSketch, type ModelMask, type SegmentationCorrection } from './onDeviceSegmentation';
import { applyI18n, t } from './i18n';

export interface CustomGifPanelCallbacks {
  upload(file: File): void;
  clip(start: number, endExclusive: number): void;
  generated(segments: TargetSegment[]): void;
  edited(segments: TargetSegment[]): void;
  message(text: string, error?: boolean): void;
}
export interface CustomGifPanel {
  reset(): void;
  setSource(frames: DecodedFrame[], start: number, endExclusive: number, sourceDescription?: string): void;
  setTargets(targets: TargetSegment[]): void;
  refreshCopy(): void;
}
type Tool = 'sketch' | 'edit' | 'add' | 'include' | 'exclude';
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export function mountCustomGifPanel(root: HTMLElement, callbacks: CustomGifPanelCallbacks): CustomGifPanel {
  root.innerHTML = [
    '<div class="custom-gif-heading"><strong data-i18n="custom.heading">Custom media · cutout</strong>',
    '<span class="custom-gif-pill" data-i18n="custom.pill">On this device · no API key</span></div>',
    '<div class="custom-gif-upload"><button type="button" id="custom-upload-btn" data-i18n="custom.upload">Upload GIF / video</button>',
    '<input type="file" id="custom-gif-file" accept="image/gif,video/mp4,video/webm,video/quicktime,video/x-m4v,.gif,.mp4,.webm,.mov,.m4v" hidden>',
    '<span id="custom-file-label">No custom GIF or video selected</span></div>',
    '<div class="custom-clip">',
    '<label><span data-i18n="custom.in">IN frame</span> <strong id="custom-in-value">–</strong>',
    '<input type="range" id="custom-in" min="0" max="0" value="0" disabled></label>',
    '<label><span data-i18n="custom.out">OUT frame</span> <strong id="custom-out-value">–</strong>',
    '<input type="range" id="custom-out" min="1" max="1" value="1" disabled></label>',
    '</div><p id="custom-clip-time" class="custom-gif-help">Upload GIF or video to select its clip range.</p>',
    '<div class="custom-target-tools">',
    '<button id="custom-sketch" class="active small" type="button" data-i18n="custom.sketch">Sketch region</button>',
    '<button id="custom-edit" class="small" type="button" data-i18n="custom.edit">Edit lines</button>',
    '<button id="custom-add" class="small" type="button" data-i18n="custom.add">Add line</button>',
    '<button id="custom-include" class="small" type="button" data-i18n="custom.include">Include object point</button>',
    '<button id="custom-exclude" class="small" type="button" data-i18n="custom.exclude">Exclude background point</button>',
    '<button id="custom-undo-prompt" class="small" type="button" data-i18n="custom.undo">Undo AI hint</button>',
    '<button id="custom-delete" class="danger small" type="button" data-i18n="custom.delete" disabled>Delete selected</button>',
    '<button id="custom-clear" class="small" type="button" data-i18n="custom.clear">Clear sketch</button>',
    '</div>',
    '<div class="custom-target-canvas-wrap"><canvas id="custom-target-canvas" width="256" height="256"></canvas></div>',
    '<p class="custom-gif-help" id="custom-canvas-help"></p>',
    '<div class="custom-trace-settings"><label><span data-i18n="custom.detail">Detail</span> <strong id="custom-detail-value">50%</strong>',
    '<input type="range" id="custom-detail" min="0" max="100" value="50" step="5"></label>',
    '<label><span data-i18n="custom.max">Max lines</span> <input type="number" id="custom-max" min="3" max="200" value="42"></label>',
    '<label><span data-i18n="custom.traceMode">Trace</span> <select id="custom-mode"><option value="details" data-i18n="custom.modeDetails">Outline + a few inner lines</option>',
    '<option value="outline" data-i18n="custom.modeOutline">Outer outline only</option></select></label></div>',
    '<div class="custom-target-actions"><button class="primary" type="button" id="custom-trace" data-i18n="custom.cutout" disabled>Cut out subject</button>',
    '<button type="button" id="custom-ai-trace" disabled>AI cutout</button>',
    '<span class="custom-gif-help" id="custom-target-count">0 target lines</span></div>',
    '<p class="custom-gif-note" data-i18n="custom.note"></p>',
  ].join('');

  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  const canvas = $<HTMLCanvasElement>('#custom-target-canvas');
  const ctx = canvas.getContext('2d')!;
  const inRange = $<HTMLInputElement>('#custom-in');
  const outRange = $<HTMLInputElement>('#custom-out');
  const precisionInput = $<HTMLInputElement>('#custom-detail');
  const maxInput = $<HTMLInputElement>('#custom-max');
  const modeInput = $<HTMLSelectElement>('#custom-mode');
  const traceButton = $<HTMLButtonElement>('#custom-trace');
  const aiButton = $<HTMLButtonElement>('#custom-ai-trace');
  const deleteButton = $<HTMLButtonElement>('#custom-delete');
  let frames: DecodedFrame[] = [];
  let inFrame = 0, outExclusive = 0;
  let sourceDescription = 'GIF';
  let sketch: Point[] = [];
  let contour: Point[] = [];
  let targets: TargetSegment[] = [];
  let learnedMask: ModelMask | null = null;
  let corrections: SegmentationCorrection[] = [];
  let cachedOverlayMask: ModelMask | null = null;
  let cachedOverlay: HTMLCanvasElement | null = null;
  let aiRequestId = 0;
  let aiBusy = false;
  let tool: Tool = 'sketch';
  let selected = -1;
  let pointer: null | { kind: 'sketch' | 'add' | 'endpoint' | 'move'; index?: number;
    which?: 'start' | 'end'; start?: Point; last?: Point } = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pos(event: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  }
  function normalizedDistance(a: Point, b: Point): number {
    return Math.hypot((a.x - b.x) * canvas.width, (a.y - b.y) * canvas.height);
  }
  function segmentDistance(p: Point, a: Point, b: Point): number {
    const dx = (b.x - a.x) * canvas.width, dy = (b.y - a.y) * canvas.height;
    const vx = (p.x - a.x) * canvas.width, vy = (p.y - a.y) * canvas.height;
    const t = dx * dx + dy * dy > 0 ? clamp((vx * dx + vy * dy) / (dx * dx + dy * dy), 0, 1) : 0;
    return Math.hypot(vx - dx * t, vy - dy * t);
  }

  function render(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const frame = frames[inFrame];
    if (frame) {
      ctx.putImageData(frame.imageData, 0, 0);
    } else {
      ctx.fillStyle = '#171721';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9a9ab0';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('custom.canvasEmpty'), canvas.width / 2, canvas.height / 2);
      ctx.textAlign = 'start';
    }
    const w = canvas.width, h = canvas.height;
    if (learnedMask && learnedMask.width > 0 && learnedMask.height > 0) {
      if (cachedOverlayMask !== learnedMask || !cachedOverlay) {
        const overlay = document.createElement('canvas');
        overlay.width = learnedMask.width; overlay.height = learnedMask.height;
        const overlayContext = overlay.getContext('2d')!;
        const pixels = overlayContext.createImageData(overlay.width, overlay.height);
        for (let i = 0; i < learnedMask.values.length; i++) {
          if (learnedMask.values[i] < .5) continue;
          const offset = i * 4;
          pixels.data[offset] = 34;
          pixels.data[offset + 1] = 211;
          pixels.data[offset + 2] = 238;
          pixels.data[offset + 3] = 55;
        }
        overlayContext.putImageData(pixels, 0, 0);
        cachedOverlayMask = learnedMask;
        cachedOverlay = overlay;
      }
      ctx.drawImage(cachedOverlay, 0, 0, w, h);
    }
    const showSketch = sketch.length > 0 && (pointer?.kind === 'sketch' || targets.length === 0);
    if (showSketch) {
      ctx.beginPath();
      sketch.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h));
      if (!pointer || pointer.kind !== 'sketch') ctx.closePath();
      ctx.fillStyle = 'rgba(236,72,153,.17)';
      if (!pointer || pointer.kind !== 'sketch') ctx.fill();
      ctx.strokeStyle = '#fb7185';
      ctx.lineWidth = Math.max(2, w / 150);
      ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (contour.length) {
      ctx.beginPath();
      contour.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(34,211,238,.85)';
      ctx.lineWidth = Math.max(1.3, w / 270);
      ctx.stroke();
    }
    corrections.forEach(({ point, positive }) => {
      ctx.beginPath(); ctx.arc(point.x * w, point.y * h, 6, 0, 2 * Math.PI);
      ctx.fillStyle = positive ? '#22c55e' : '#ef4444'; ctx.fill();
    });
    targets.forEach((target, i) => {
      ctx.beginPath();
      ctx.moveTo(target.start.x * w, target.start.y * h);
      ctx.lineTo(target.end.x * w, target.end.y * h);
      ctx.strokeStyle = i === selected ? '#facc15' : '#a78bfa';
      ctx.lineWidth = i === selected ? 4 : Math.max(2, w / 130);
      ctx.lineCap = 'round'; ctx.stroke();
      if (selected === i) {
        for (const p of [target.start, target.end]) {
          ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 5, 0, 2 * Math.PI);
          ctx.fillStyle = '#fff'; ctx.fill();
        }
      }
    });
    if (pointer?.kind === 'add' && pointer.start && pointer.last) {
      ctx.beginPath(); ctx.moveTo(pointer.start.x * w, pointer.start.y * h);
      ctx.lineTo(pointer.last.x * w, pointer.last.y * h);
      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
  function updateButtons(): void {
    traceButton.disabled = frames.length === 0 || sketch.length < 3;
    aiButton.disabled = frames.length === 0 || sketch.length < 3 || aiBusy;
    aiButton.textContent = aiBusy ? t('custom.aiLoading') : learnedMask ? t('custom.aiActive') : t('custom.ai');
    deleteButton.disabled = selected < 0 || !targets.length;
    $('#custom-target-count').textContent = t('custom.count', { n: targets.length });
    $('#custom-canvas-help').textContent =
      tool === 'sketch' ? t('custom.helpSketch')
      : tool === 'edit' ? t('custom.helpEdit')
      : tool === 'add' ? t('custom.helpAdd')
      : tool === 'include' ? t('custom.helpInclude')
      : t('custom.helpExclude');
    for (const mode of ['sketch', 'edit', 'add', 'include', 'exclude'] as const) {
      $('#custom-' + mode).classList.toggle('active', tool === mode);
    }
  }
  function emitEdited(): void {
    targets.forEach((t, i) => { t.id = 't' + i; t.order = i; });
    callbacks.edited(targets.map((t) => ({
      ...t, start: { ...t.start }, end: { ...t.end },
    })));
    updateButtons(); render();
  }
  function trace(): void {
    if (!frames[inFrame] || sketch.length < 3) return;
    try {
      const options: TraceOptions = {
        precision: Number(precisionInput.value),
        maximumSegments: clamp(Math.round(Number(maxInput.value) || 42), 3, 200),
        mode: modeInput.value as TraceMode,
      };
      const result = learnedMask
        ? traceSegmentationMask(frames[inFrame].imageData, learnedMask.values, learnedMask.width, learnedMask.height, options, sketch)
        : traceSelectedRegion(frames[inFrame].imageData, sketch, options);
      contour = result.contour;
      targets = result.segments;
      selected = -1;
      callbacks.generated(targets.map((target) => ({ ...target })));
      callbacks.message(result.note);
      updateButtons(); render();
    } catch (error) {
      callbacks.message(error instanceof Error ? error.message : String(error), true);
    }
  }
  function scheduleTrace(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (sketch.length >= 3 && frames[inFrame]) trace();
    }, 120);
  }
  function reset(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    frames = []; inFrame = 0; outExclusive = 0; sourceDescription = 'GIF'; sketch = []; contour = []; targets = []; selected = -1;
    aiRequestId++; learnedMask = null; aiBusy = false; corrections = [];
    inRange.disabled = true; outRange.disabled = true;
    $('#custom-file-label').textContent = t('custom.none');
    $('#custom-clip-time').textContent = t('custom.choose');
    $('#custom-in-value').textContent = '–'; $('#custom-out-value').textContent = '–';
    updateButtons(); render();
  }
  function setSource(next: DecodedFrame[], start: number, endExclusive: number, description = 'GIF'): void {
    sourceDescription = description;
    const changed = frames !== next || inFrame !== start;
    frames = next;
    inFrame = clamp(start, 0, Math.max(0, frames.length - 1));
    outExclusive = clamp(endExclusive, inFrame + 1, Math.max(inFrame + 1, frames.length));
    if (changed) { sketch = []; contour = []; targets = []; selected = -1; learnedMask = null; aiRequestId++; aiBusy = false; corrections = []; }
    if (frames.length) {
      canvas.width = frames[0].imageData.width;
      canvas.height = frames[0].imageData.height;
    }
    inRange.disabled = !frames.length; outRange.disabled = !frames.length;
    inRange.max = String(Math.max(0, frames.length - 1));
    outRange.max = String(Math.max(1, frames.length));
    outRange.min = '1'; inRange.value = String(inFrame); outRange.value = String(outExclusive);
    $('#custom-in-value').textContent = frames.length ? '#' + inFrame : '–';
    $('#custom-out-value').textContent = frames.length ? '#' + (outExclusive - 1) : '–';
    const startTime = frames.slice(0, inFrame).reduce((a, f) => a + f.delaySec, 0);
    const duration = frames.slice(inFrame, outExclusive).reduce((a, f) => a + f.delaySec, 0);
    $('#custom-clip-time').textContent = frames.length
      ? t('custom.clip', {
          kind: sourceDescription,
          start: startTime.toFixed(2),
          end: (startTime + duration).toFixed(2),
          clip: duration.toFixed(2),
          frames: outExclusive - inFrame,
        })
      : t('custom.choose');
    updateButtons(); render();
  }
  function setTargets(next: TargetSegment[]): void {
    targets = next.map((t) => ({ ...t, start: { ...t.start }, end: { ...t.end } }));
    selected = -1;
    updateButtons(); render();
  }

  $('#custom-upload-btn').addEventListener('click', () => $<HTMLInputElement>('#custom-gif-file').click());
  $<HTMLInputElement>('#custom-gif-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    $('#custom-file-label').textContent = file.name;
    callbacks.upload(file);
  });
  const updateClip = () => {
    if (!frames.length) return;
    let start = Number(inRange.value), end = Number(outRange.value);
    if (start >= end) {
      if (document.activeElement === inRange) end = Math.min(frames.length, start + 1);
      else start = Math.max(0, end - 1);
    }
    callbacks.clip(start, end);
  };
  inRange.addEventListener('input', updateClip);
  outRange.addEventListener('input', updateClip);
  for (const t of ['sketch', 'edit', 'add', 'include', 'exclude'] as const) {
    $('#custom-' + t).addEventListener('click', () => {
      tool = t; pointer = null; selected = -1; updateButtons(); render();
    });
  }
  $('#custom-clear').addEventListener('click', () => {
    sketch = []; contour = []; learnedMask = null; aiRequestId++; corrections = [];
    updateButtons(); render();
  });
  $('#custom-undo-prompt').addEventListener('click', () => {
    if (corrections.length) { corrections.pop(); learnedMask = null; aiRequestId++; updateButtons(); render(); }
  });
  $('#custom-delete').addEventListener('click', () => {
    if (selected < 0) return;
    targets.splice(selected, 1); selected = -1; emitEdited();
  });
  traceButton.addEventListener('click', () => {
    learnedMask = null;
    trace();
  });
  aiButton.addEventListener('click', async () => {
    const frame = frames[inFrame];
    if (!frame || sketch.length < 3 || aiBusy) return;
    const request = ++aiRequestId;
    aiBusy = true;
    updateButtons();
    callbacks.message(t('custom.aiStart'));
    try {
      // Yield to paint the loading state before model loading and inference.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      const mask = await segmentObjectFromSketch(frame.imageData, sketch, corrections);
      if (request !== aiRequestId || frames[inFrame] !== frame) return;
      learnedMask = mask;
      trace();
    } catch (error) {
      if (request !== aiRequestId) return;
      learnedMask = null;
      callbacks.message(t('custom.aiFail', {
        message: error instanceof Error ? error.message : String(error),
      }), true);
    } finally {
      if (request === aiRequestId) {
        aiBusy = false;
        updateButtons();
      }
    }
  });
  precisionInput.addEventListener('input', () => {
    $('#custom-detail-value').textContent = precisionInput.value + '%';
    scheduleTrace();
  });
  maxInput.addEventListener('change', scheduleTrace);
  modeInput.addEventListener('change', scheduleTrace);

  canvas.addEventListener('pointerdown', (event) => {
    if (!frames.length || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const p = pos(event);
    if (tool === 'sketch') {
      sketch = [p]; contour = []; learnedMask = null; aiRequestId++; corrections = [];
      pointer = { kind: 'sketch' }; render();
    } else if (tool === 'add') {
      pointer = { kind: 'add', start: p, last: p };
    } else if (tool === 'include' || tool === 'exclude') {
      corrections.push({ point: p, positive: tool === 'include' });
      learnedMask = null; aiRequestId++; updateButtons(); render();
    } else {
      let hit = -1, best = 16;
      for (let i = 0; i < targets.length; i++) {
        const d = segmentDistance(p, targets[i].start, targets[i].end);
        if (d < best) { hit = i; best = d; }
      }
      selected = hit;
      if (hit >= 0) {
        const segment = targets[hit];
        const which = normalizedDistance(p, segment.start) < 12 ? 'start'
          : normalizedDistance(p, segment.end) < 12 ? 'end' : null;
        pointer = which ? { kind: 'endpoint', index: hit, which } : { kind: 'move', index: hit, last: p };
      } else pointer = null;
      updateButtons(); render();
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer) return;
    const p = pos(event);
    if (pointer.kind === 'sketch') {
      const last = sketch[sketch.length - 1];
      if (normalizedDistance(last, p) > 2.5) sketch.push(p);
    } else if (pointer.kind === 'add') {
      pointer.last = p;
    } else if (pointer.index !== undefined) {
      const target = targets[pointer.index];
      if (!target) return;
      if (pointer.kind === 'endpoint' && pointer.which) target[pointer.which] = p;
      else if (pointer.kind === 'move' && pointer.last) {
        const dx = p.x - pointer.last.x, dy = p.y - pointer.last.y;
        target.start = { x: clamp(target.start.x + dx, 0, 1), y: clamp(target.start.y + dy, 0, 1) };
        target.end = { x: clamp(target.end.x + dx, 0, 1), y: clamp(target.end.y + dy, 0, 1) };
        pointer.last = p;
      }
    }
    render();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!pointer) return;
    const p = pos(event), kind = pointer.kind;
    if (kind === 'sketch') {
      if (sketch.length >= 3) scheduleTrace();
      else callbacks.message(t('custom.larger'), true);
    } else if (kind === 'add' && pointer.start && normalizedDistance(pointer.start, p) >= 4) {
      targets.push({ id: 't' + targets.length, order: targets.length, start: pointer.start, end: p });
      emitEdited();
    } else if (kind === 'endpoint' || kind === 'move') emitEdited();
    pointer = null; updateButtons(); render();
  });
  canvas.addEventListener('pointercancel', () => {
    pointer = null; updateButtons(); render();
  });
  function refreshCopy(): void {
    applyI18n(root);
    updateButtons();
    if (frames.length) setSource(frames, inFrame, outExclusive, sourceDescription);
    else {
      $('#custom-file-label').textContent = t('custom.none');
      $('#custom-clip-time').textContent = t('custom.choose');
    }
    render();
  }
  reset();
  applyI18n(root);
  return { reset, setSource, setTargets, refreshCopy };
}
