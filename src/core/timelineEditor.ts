/**
 * Interactive six-phase storyboard timeline.
 * Dragging a phase's right handle changes ONLY that phase's duration;
 * later phases shift in absolute time but keep their own durations.
 */
import { t } from './i18n';

export type PhaseId = 'reveal' | 'before' | 'after' | 'motion' | 'final' | 'meme';

export interface PhaseSpec {
  id: PhaseId;
  label: string;
  shortLabel: string;
  color: string;
  duration: number;
  min: number;
  max: number;
}

export interface TimelineEditorConfig {
  phases(): PhaseSpec[];
  playhead(): number;
  changeDuration(id: PhaseId, seconds: number): void;
  seek(time: number): void;
  drawThumbnail(time: number, canvas: HTMLCanvasElement): void;
}

export interface TimelineEditor {
  refresh(): void;
  setPlayhead(time: number): void;
  hideHover(): void;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
const timeText = (seconds: number) => seconds.toFixed(2) + 's';

export function mountTimelineEditor(
  root: HTMLElement,
  config: TimelineEditorConfig,
): TimelineEditor {
  root.innerHTML =
    '<div class="tl-heading"><strong data-i18n="tl.heading">Full GIF timeline</strong>' +
      '<span class="tl-total" aria-live="polite"></span></div>' +
    '<p class="tl-instruction" data-i18n="tl.help">Hover for a frame preview. Drag the edge of a color block to resize only that phase. Click to seek.</p>' +
    '<div class="tl-track" aria-label="Interactive animation timeline">' +
      '<div class="tl-playhead" aria-hidden="true"></div></div>' +
    '<div class="tl-legend"></div>' +
    '<div class="tl-hover" role="status" aria-live="off" hidden>' +
      '<canvas class="tl-hover-frame" width="220" height="124"></canvas>' +
      '<div class="tl-hover-caption"></div>' +
    '</div>';

  const track = root.querySelector('.tl-track') as HTMLDivElement;
  const playhead = root.querySelector('.tl-playhead') as HTMLDivElement;
  const totalLabel = root.querySelector('.tl-total') as HTMLSpanElement;
  const legend = root.querySelector('.tl-legend') as HTMLDivElement;
  const hoverCard = root.querySelector('.tl-hover') as HTMLDivElement;
  const hoverFrame = root.querySelector('.tl-hover-frame') as HTMLCanvasElement;
  const hoverCaption = root.querySelector('.tl-hover-caption') as HTMLDivElement;
  const bars = new Map<PhaseId, HTMLDivElement>();
  const legendTimes = new Map<PhaseId, HTMLSpanElement>();
  let activeDrag: { id: PhaseId; pointerId: number; x: number; duration: number; secPerPx: number } | null = null;

  function currentPhases(): PhaseSpec[] {
    return config.phases();
  }

  function totalLength(phases = currentPhases()): number {
    return phases.reduce((sum, phase) => sum + phase.duration, 0);
  }

  function hideHover(): void {
    if (!activeDrag) hoverCard.hidden = true;
  }

  function showHover(phaseId: PhaseId, clientX: number): void {
    const phases = currentPhases();
    const phase = phases.find((candidate) => candidate.id === phaseId);
    const bar = bars.get(phaseId);
    if (!bar || !phase) return;

    const barRect = bar.getBoundingClientRect();
    const fraction = barRect.width > 0
      ? clamp((clientX - barRect.left) / barRect.width, 0, 1)
      : 0;
    let time = 0;
    for (const item of phases) {
      if (item.id === phaseId) break;
      time += item.duration;
    }
    const total = totalLength(phases);
    time = clamp(time + fraction * phase.duration, 0, Math.max(0, total - 0.001));
    const rootRect = root.getBoundingClientRect();
    hoverCard.style.left = clamp(clientX - rootRect.left, 110, Math.max(110, rootRect.width - 110)) + 'px';
    hoverCaption.textContent = phase.label + ' · ' + timeText(time) + ' / ' + timeText(total);
    config.drawThumbnail(time, hoverFrame);
    hoverCard.hidden = false;
  }

  function setPlayhead(seconds: number): void {
    const total = totalLength();
    playhead.style.left = (total > 0 ? clamp(seconds / total, 0, 1) * 100 : 0) + '%';
  }

  for (const spec of currentPhases()) {
    const bar = document.createElement('div');
    bar.className = 'tl-phase';
    bar.dataset.phase = spec.id;
    bar.style.setProperty('--phase-color', spec.color);
    bar.title = spec.label;

    const text = document.createElement('span');
    text.className = 'tl-phase-label';
    text.textContent = spec.shortLabel;
    bar.appendChild(text);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'tl-resize';
    handle.title = 'Drag to resize ' + spec.label + ' only';
    handle.setAttribute('aria-label', 'Resize ' + spec.label + ' duration');
    handle.setAttribute('aria-valuemin', String(spec.min));
    handle.setAttribute('aria-valuemax', String(spec.max));
    bar.appendChild(handle);

    bar.addEventListener('pointermove', (event) => {
      if (!activeDrag) showHover(spec.id, event.clientX);
    });
    bar.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.tl-resize')) return;
      const rect = bar.getBoundingClientRect();
      const pct = rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
      let time = 0;
      for (const part of currentPhases()) {
        if (part.id === spec.id) {
          time += part.duration * pct;
          break;
        }
        time += part.duration;
      }
      config.seek(time);
    });

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || handle.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const selected = currentPhases().find((p) => p.id === spec.id);
      if (!selected) return;
      activeDrag = {
        id: spec.id,
        pointerId: event.pointerId,
        x: event.clientX,
        duration: selected.duration,
        secPerPx: totalLength() / Math.max(1, track.getBoundingClientRect().width),
      };
      handle.setPointerCapture(event.pointerId);
      root.classList.add('tl-dragging');
      showHover(spec.id, event.clientX);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!activeDrag || activeDrag.pointerId !== event.pointerId || activeDrag.id !== spec.id) return;
      const phase = currentPhases().find((p) => p.id === spec.id);
      if (!phase) return;
      const delta = (event.clientX - activeDrag.x) * activeDrag.secPerPx;
      config.changeDuration(spec.id, clamp(activeDrag.duration + delta, phase.min, phase.max));
      showHover(spec.id, event.clientX);
    });
    const stopResize = (event: PointerEvent) => {
      if (activeDrag?.pointerId !== event.pointerId) return;
      activeDrag = null;
      root.classList.remove('tl-dragging');
      hoverCard.hidden = true;
    };
    handle.addEventListener('pointerup', stopResize);
    handle.addEventListener('pointercancel', stopResize);
    handle.addEventListener('lostpointercapture', () => {
      activeDrag = null;
      root.classList.remove('tl-dragging');
      hoverCard.hidden = true;
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const phase = currentPhases().find((p) => p.id === spec.id);
      if (!phase) return;
      const increment = spec.id === 'meme' ? 0.05 : event.shiftKey ? 1 : 0.1;
      const sign = event.key === 'ArrowRight' ? 1 : -1;
      config.changeDuration(spec.id, clamp(phase.duration + sign * increment, phase.min, phase.max));
    });

    track.insertBefore(bar, playhead);
    bars.set(spec.id, bar);

    const item = document.createElement('div');
    item.className = 'tl-legend-item';
    const dot = document.createElement('span');
    dot.className = 'tl-legend-dot';
    dot.style.backgroundColor = spec.color;
    const name = document.createElement('span');
    name.className = 'tl-legend-name';
    name.textContent = spec.label;
    const duration = document.createElement('span');
    duration.className = 'tl-legend-time';
    item.append(dot, name, duration);
    legend.appendChild(item);
    legendTimes.set(spec.id, duration);
  }

  track.addEventListener('pointerleave', hideHover);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      activeDrag = null;
      root.classList.remove('tl-dragging');
      hoverCard.hidden = true;
    }
  });

  function refresh(): void {
    const phases = currentPhases();
    const total = totalLength(phases);
    totalLabel.textContent = t('tl.total', { time: timeText(total) });
    for (const phase of phases) {
      const bar = bars.get(phase.id);
      const caption = legendTimes.get(phase.id);
      if (!bar || !caption) continue;
      bar.style.flex = String(Math.max(0, phase.duration)) + ' 1 0%';
      const short = bar.querySelector('.tl-phase-label');
      if (short) short.textContent = phase.shortLabel;
      const legendName = legendTimes.get(phase.id)?.parentElement?.querySelector('.tl-legend-name');
      if (legendName) legendName.textContent = phase.label;
      bar.title = phase.label + ' · ' + timeText(phase.duration);
      bar.setAttribute('aria-label', phase.label + ', ' + timeText(phase.duration));
      const handle = bar.querySelector('.tl-resize') as HTMLButtonElement;
      handle.disabled = phase.max <= phase.min;
      handle.setAttribute('aria-valuenow', String(phase.duration));
      handle.setAttribute('aria-valuemin', String(phase.min));
      handle.setAttribute('aria-valuemax', String(phase.max));
      caption.textContent = timeText(phase.duration);
    }
    setPlayhead(config.playhead());
  }

  refresh();
  return { refresh, setPlayhead, hideHover };
}
