import { formatElapsed } from '../format';
import { KEYBOARD_HELP } from './keyboard';

export interface RaceState {
  simTime: number;
  timeScale: number;
  paused: boolean;
  raceOver: boolean;
}

export interface RaceControlsCallbacks {
  onSetTimeScale: (scale: number) => void;
  onTogglePause: () => void;
  onReset: () => void;
}

export interface RaceControlsInstance {
  render(race: RaceState): void;
}

export const TIME_SCALES = [1, 2, 5, 10];

/**
 * Build once and wire the delegated click handler, returning an instance
 * closing over its own DOM refs (R1) instead of a module-level singleton.
 * Rebuilding via innerHTML every frame would swallow real (non-instant)
 * clicks on Start/Stop/Reset — confirmed by reproduction when the
 * leaderboard had the same bug.
 */
export function initRaceControls(container: HTMLElement, callbacks: RaceControlsCallbacks): RaceControlsInstance {
  container.innerHTML = `
    <span class="elapsed-time"></span>
    <div class="time-scale-buttons">
      ${TIME_SCALES.map((scale) => `<button data-time-scale="${scale}">${scale}×</button>`).join('')}
    </div>
    <button data-action="pause"></button>
    <button data-action="reset">Reset</button>
    <!-- Shortcuts are useless if nobody knows they exist; the list is built
         from the same KEYBOARD_HELP the handler is documented by, so the two
         cannot drift apart. -->
    <div class="shortcut-hint" tabindex="0" aria-label="Keyboard shortcuts">
      <span class="shortcut-hint-icon">⌨</span>
      <div class="shortcut-list">
        ${KEYBOARD_HELP.map((h) => `<div><kbd>${h.keys}</kbd><span>${h.description}</span></div>`).join('')}
      </div>
    </div>`;

  const timeScaleButtons = new Map<number, HTMLButtonElement>();
  container.querySelectorAll<HTMLButtonElement>('[data-time-scale]').forEach((btn) => {
    timeScaleButtons.set(Number(btn.dataset.timeScale), btn);
  });

  const elapsed = container.querySelector<HTMLElement>('.elapsed-time')!;
  const pauseButton = container.querySelector<HTMLButtonElement>('[data-action="pause"]')!;

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const timeScaleButton = target.closest<HTMLElement>('[data-time-scale]');
    if (timeScaleButton) {
      callbacks.onSetTimeScale(Number(timeScaleButton.dataset.timeScale));
      return;
    }
    const actionButton = target.closest<HTMLElement>('[data-action]');
    if (actionButton) {
      if (actionButton.dataset.action === 'pause') callbacks.onTogglePause();
      else if (actionButton.dataset.action === 'reset') callbacks.onReset();
    }
  });

  // This runs every animation frame, and assigning textContent replaces the
  // element's text node even when the string is identical — 60 pointless DOM
  // mutations a second, each one dirtying layout while the map may be mid-drag.
  let lastElapsed = '';
  let lastPauseLabel = '';

  return {
    render(race: RaceState): void {
      const elapsedText = formatElapsed(race.simTime);
      if (elapsedText !== lastElapsed) {
        elapsed.textContent = elapsedText;
        lastElapsed = elapsedText;
      }
      for (const [scale, btn] of timeScaleButtons) {
        btn.classList.toggle('active', race.timeScale === scale);
      }
      pauseButton.disabled = race.raceOver;
      const pauseLabel = race.raceOver
        ? 'Race Over'
        : race.paused
          ? race.simTime === 0
            ? 'Start'
            : 'Resume'
          : 'Stop';
      if (pauseLabel !== lastPauseLabel) {
        pauseButton.textContent = pauseLabel;
        lastPauseLabel = pauseLabel;
      }
    },
  };
}
