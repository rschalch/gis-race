import { formatElapsed } from '../format';

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

const TIME_SCALES = [1, 2, 5, 10];

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
    <button data-action="reset">Reset</button>`;

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

  return {
    render(race: RaceState): void {
      elapsed.textContent = formatElapsed(race.simTime);
      for (const [scale, btn] of timeScaleButtons) {
        btn.classList.toggle('active', race.timeScale === scale);
      }
      pauseButton.disabled = race.raceOver;
      pauseButton.textContent = race.raceOver
        ? 'Race Over'
        : race.paused
          ? race.simTime === 0
            ? 'Start'
            : 'Resume'
          : 'Stop';
    },
  };
}
