import type { CarState, RaceEvent } from '../types';
import type { Sim } from '../sim';
import { raceRank, projectedTime } from '../sim';
import { formatDistance, formatElapsed, carDot } from '../format';

/**
 * F4: the post-race summary.
 *
 * Until this existed, `sim.events` was written by the simulation on every
 * overtake, incident, start and finish — and read by nothing outside the
 * tests. `Sim.raceSeed` and `Sim.engineVersion` were likewise retained with a
 * comment saying they were kept "so a future summary/replay/share feature has
 * the seed to show", and that feature was never built: the seed was never
 * displayed anywhere in the UI, and a race simply stopped when it ended.
 *
 * This is that consumer. It classifies the field on own running time (see
 * sim.ts's projectedTime — under an interval start, road order is not
 * results order), lists what happened from the event log, and shows the
 * `seed @ vN` pair that makes a race reproducible.
 */

export interface SummaryCallbacks {
  /** Re-run the race exactly as it was just run. */
  onReplaySeed: (seed: number) => void;
  onClose: () => void;
}

export interface SummaryInstance {
  /** Call each frame; shows itself the first time it sees a finished race and
   * stays put until dismissed. Cheap when there is nothing to do. */
  update(sim: Sim): void;
  /** Drop any "already shown for this race" state — call when a new race is
   * built, or the summary would never appear again. */
  reset(): void;
  open(sim: Sim): void;
}

function severityLabel(severity: string): string {
  switch (severity) {
    case 'slide':
      return 'slid';
    case 'spin':
      return 'spun';
    case 'off-road':
      return 'went off';
    case 'mechanical':
      return 'stopped (mechanical)';
    default:
      return severity;
  }
}

/** One line per event, newest last, in race-clock order. */
function describeEvent(event: RaceEvent, nameOf: (carId: string) => string): string | null {
  switch (event.type) {
    case 'incident':
      return `${nameOf(event.carId)} ${severityLabel(event.data.severity)} at ${formatDistance(event.data.s)}`;
    case 'overtake':
      return `${nameOf(event.carId)} passed ${nameOf(event.data.passedId)}`;
    case 'finish':
      return `${nameOf(event.carId)} finished`;
    // Starts are deliberately not listed: with an interval start there is one
    // per car and they would swamp everything that actually happened. The
    // turnaround stop is the same shape of event — one per car, all identical
    // — but it *is* listed, because it is minutes of every finishing time and
    // a log that hides it makes the results look wrong.
    case 'turnaround':
      return `${nameOf(event.carId)} turned around (${Math.round(event.data.pauseS / 60)} min stop)`;
    case 'start':
      return null;
  }
}

export function initSummary(container: HTMLElement, callbacks: SummaryCallbacks): SummaryInstance {
  container.innerHTML = `
    <div class="summary-backdrop"></div>
    <div class="summary-modal" role="dialog" aria-modal="true" aria-label="Race results">
      <header class="summary-header">
        <h3>Race results</h3>
        <button type="button" class="summary-close" aria-label="Close">&times;</button>
      </header>
      <div class="summary-body">
        <table class="summary-results">
          <thead>
            <tr><th>Pos</th><th>Car</th><th>Time</th><th>Gap</th><th>Avg</th><th>Result</th></tr>
          </thead>
          <tbody></tbody>
        </table>
        <section class="summary-log-section">
          <h4>Race log</h4>
          <ol class="summary-log"></ol>
        </section>
      </div>
      <footer class="summary-actions">
        <span class="summary-seed" title="A seed reproduces this exact race, but only on the engine version that ran it"></span>
        <button type="button" data-summary-action="copy">Copy seed</button>
        <button type="button" data-summary-action="replay">Replay this seed</button>
        <button type="button" data-summary-action="close">Close</button>
      </footer>
    </div>`;

  const tbody = container.querySelector('tbody')!;
  const log = container.querySelector<HTMLOListElement>('.summary-log')!;
  const seedEl = container.querySelector<HTMLElement>('.summary-seed')!;
  container.hidden = true;

  // Which race is currently rendered, so `update` can tell "the race just
  // ended" from "the race ended a while ago and the user closed this".
  let shownFor: Sim | null = null;
  let currentSeed = 0;

  function close(): void {
    container.hidden = true;
    callbacks.onClose();
  }

  container.querySelector('.summary-close')!.addEventListener('click', close);
  container.querySelector('.summary-backdrop')!.addEventListener('click', close);
  container.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-summary-action]')?.dataset.summaryAction;
    if (action === 'close') close();
    else if (action === 'replay') {
      container.hidden = true;
      callbacks.onReplaySeed(currentSeed);
    } else if (action === 'copy') {
      // Clipboard access can be denied (insecure context, permissions) — a
      // failed copy must not take the whole summary down with it.
      void navigator.clipboard?.writeText(String(currentSeed)).catch(() => {});
    }
  });

  function render(sim: Sim): void {
    currentSeed = sim.raceSeed;
    const nameById = new Map(sim.cars.map((c) => [c.spec.id, c.spec.name]));
    const nameOf = (carId: string) => nameById.get(carId) ?? carId;

    const ranked = raceRank(sim.cars, sim.simTime);
    const winnerTime = ranked.length > 0 ? projectedTime(ranked[0]!, sim.simTime) : 0;

    tbody.replaceChildren();
    ranked.forEach((car: CarState, i) => {
      const finished = car.status === 'finished' && car.finishTime !== null;
      const cells: Array<string | Node> = [];

      cells.push(finished ? String(i + 1) : '—');

      const carCell = document.createElement('span');
      carCell.append(carDot(car.spec.colour), document.createTextNode(car.spec.name));
      cells.push(carCell);

      cells.push(finished ? formatElapsed(car.finishTime!) : '—');
      cells.push(
        finished && i > 0 ? `+${(car.finishTime! - winnerTime).toFixed(1)}s` : finished ? '—' : '—',
      );
      cells.push(
        finished ? `${Math.round((car.route.totalDistance / car.finishTime!) * 3.6)} km/h` : '—',
      );

      // Why a car is not classified is the most interesting thing about it.
      const lastIncident = car.incidents[car.incidents.length - 1];
      cells.push(
        finished
          ? car.incidents.length > 0
            ? `finished (${car.incidents.length} incident${car.incidents.length > 1 ? 's' : ''})`
            : 'finished'
          : car.status === 'retired' && lastIncident
            ? `DNF — ${severityLabel(lastIncident.severity)} at ${formatDistance(lastIncident.s)}`
            : car.status === 'retired'
              ? 'DNF'
              : 'did not finish',
      );

      const tr = document.createElement('tr');
      for (const cell of cells) {
        const td = document.createElement('td');
        if (typeof cell === 'string') td.textContent = cell;
        else td.appendChild(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    log.replaceChildren();
    for (const event of sim.events) {
      const text = describeEvent(event, nameOf);
      if (text === null) continue;
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 'summary-log-time';
      t.textContent = formatElapsed(event.time);
      li.append(t, document.createTextNode(text));
      log.appendChild(li);
    }
    if (log.children.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Nothing eventful happened.';
      log.appendChild(li);
    }

    // §0.1: seed and engine version travel together, always. A seed alone is
    // not enough to reproduce a race, and showing it alone would quietly
    // promise otherwise.
    seedEl.textContent = `seed ${sim.raceSeed} @ engine v${sim.engineVersion}`;
  }

  return {
    update(sim: Sim): void {
      if (!sim.raceOver || shownFor === sim) return;
      shownFor = sim;
      render(sim);
      container.hidden = false;
    },
    open(sim: Sim): void {
      shownFor = sim;
      render(sim);
      container.hidden = false;
    },
    reset(): void {
      shownFor = null;
      container.hidden = true;
    },
  };
}
