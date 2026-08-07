/**
 * Keyboard control for the race view.
 *
 * The app was entirely mouse-driven: pausing, changing speed, or switching
 * which car the camera follows all meant finding and clicking a specific
 * control, which is poor for the one thing people actually do a lot here —
 * watching a long race and flicking between cars.
 *
 * Everything here maps onto an existing control rather than introducing new
 * behaviour, so the keyboard is a second route to the same actions and never
 * the only way to reach something.
 */

export interface KeyboardHandlers {
  onTogglePause(): void;
  /** Step the time scale by one position in the available list. */
  onStepTimeScale(direction: -1 | 1): void;
  onReset(): void;
  onOverview(): void;
  onFollowLeader(): void;
  onFree(): void;
  /** Move the camera to the next/previous car in current race order. */
  onCycleCar(direction: -1 | 1): void;
}

export interface KeyboardHelpEntry {
  keys: string;
  description: string;
}

/** Single source of truth for the bindings, so the on-screen help can never
 * drift from what the handler actually does. */
export const KEYBOARD_HELP: readonly KeyboardHelpEntry[] = [
  { keys: 'Space', description: 'Start / pause' },
  { keys: '[  ]', description: 'Slower / faster' },
  { keys: '← →', description: 'Previous / next car' },
  { keys: 'L', description: 'Follow leader' },
  { keys: 'O', description: 'Overview' },
  { keys: 'F', description: 'Free camera' },
  { keys: 'R', description: 'Reset race' },
];

/**
 * True when the event should be ignored because the user is typing or
 * operating a form control — the Routes panel has a text field for naming a
 * route, and stealing Space from it would be maddening.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION';
}

/**
 * True when a modal is open. Shortcuts stay out of the way entirely while the
 * config, routes or summary dialogs are up: those own the keyboard (Escape to
 * close, Tab between fields) and a stray `r` restarting the race from under an
 * open dialog would be a genuine surprise.
 */
function isModalOpen(): boolean {
  return ['config-panel', 'routes-panel', 'summary'].some((id) => {
    const el = document.getElementById(id);
    return el !== null && !el.hidden;
  });
}

export function initKeyboard(handlers: KeyboardHandlers): void {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || isTypingTarget(e.target) || isModalOpen()) return;
    // Let browser and OS chords through untouched — Cmd+R must still reload.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ':
        // Space scrolls the page by default, and the map container is
        // scrollable in some layouts.
        e.preventDefault();
        handlers.onTogglePause();
        return;
      case '[':
        handlers.onStepTimeScale(-1);
        return;
      case ']':
        handlers.onStepTimeScale(1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        handlers.onCycleCar(-1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        handlers.onCycleCar(1);
        return;
      default:
        break;
    }

    // Letters are matched case-insensitively but only without Shift, so
    // Shift-modified chords stay available for anything added later.
    if (e.shiftKey) return;
    switch (e.key.toLowerCase()) {
      case 'l':
        handlers.onFollowLeader();
        break;
      case 'o':
        handlers.onOverview();
        break;
      case 'f':
        handlers.onFree();
        break;
      case 'r':
        handlers.onReset();
        break;
      default:
        break;
    }
  });
}
