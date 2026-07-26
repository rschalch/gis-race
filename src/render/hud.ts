import type { CarState, Incident } from '../types';
import type { RouteSample } from '../route';
import { resolveLeader, remainingDistance } from '../sim';
import { formatDistance, formatElapsed, carDot } from '../format';

const MAX_INCIDENT_FEED_ROWS = 20;

function severityLabel(severity: Incident['severity']): string {
  switch (severity) {
    case 'slide':
      return 'Slide';
    case 'spin':
      return 'Spin';
    case 'off-road':
      return 'Off-road (retired)';
    case 'mechanical':
      return 'Mechanical failure (retired)';
  }
}

export type CameraMode = 'overview' | 'follow' | 'free';

export interface CameraState {
  mode: CameraMode;
  target: string | 'leader' | null; // §8.1's cameraTarget field
}

export interface HudCallbacks {
  onSelectCar: (carId: string) => void;
  onFollowLeader: () => void;
  onOverview: () => void;
  onFree: () => void;
}

export interface HudInstance {
  render(cars: CarState[], camera: CameraState, samples: Map<string, RouteSample>): void;
  /** Called from sim.onIncident (wired in main.ts) — see B10/R5. */
  pushIncident(car: CarState, incident: Incident): void;
}

function formatStatus(car: CarState): string {
  switch (car.status) {
    case 'spinning':
      return `Spinning (${car.recoveryRemaining.toFixed(0)}s)`;
    case 'retired':
      return 'Retired';
    case 'finished':
      return 'Finished';
    default:
      return '';
  }
}

interface RowDom {
  tr: HTMLTableRowElement;
  pos: HTMLTableCellElement;
  speed: HTMLTableCellElement;
  gap: HTMLTableCellElement;
  traveled: HTMLTableCellElement;
  remaining: HTMLTableCellElement;
  elevation: HTMLTableCellElement;
  status: HTMLTableCellElement;
}

interface HudDom {
  carsRef: CarState[]; // identity check: a new array means a new race (reset/route switch)
  cameraButtons: Map<string, HTMLButtonElement>;
  tbody: HTMLTableSectionElement;
  rows: Map<string, RowDom>;
  finishBoard: HTMLElement;
  finishList: HTMLOListElement;
  finishedIds: Set<string>;
  incidentFeed: HTMLElement;
  incidentList: HTMLOListElement;
}

/**
 * Builds the HUD once and wires delegated click handling — bound to the
 * stable outer container, so it survives regardless of what changes inside.
 * Returns an instance closing over its own DOM state (R1): a module-level
 * singleton would mean exactly one HUD could ever exist and would force
 * module resets between unit tests.
 */
export function initHud(container: HTMLElement, callbacks: HudCallbacks): HudInstance {
  // Rebuilding the whole panel's innerHTML every frame (60/s) destroys and
  // recreates every button and row. A real click's mousedown and mouseup can
  // straddle two different DOM instances of the "same" button — when that
  // happens the browser never fires a click event at all, since its original
  // mousedown target is no longer in the document. Building the structure
  // once and updating only text/classes/row-order in place keeps every
  // interactive element's identity stable across frames.
  let dom: HudDom | null = null;

  // Incidents (B10) arrive via sim.onIncident, fired synchronously from
  // tick() — which can run before this frame's render() call has (re)built
  // dom for a brand-new race. Buffering here instead of writing straight to
  // `dom` means an incident is never lost or misattributed to a stale DOM;
  // render() flushes this every frame, so the buffer never holds more than
  // one frame's worth.
  let pendingIncidents: Array<{ car: CarState; incident: Incident }> = [];

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const row = target.closest<HTMLElement>('[data-car-id]');
    if (row) {
      callbacks.onSelectCar(row.dataset.carId!);
      return;
    }
    const cameraButton = target.closest<HTMLElement>('[data-camera-mode]');
    if (cameraButton) {
      const mode = cameraButton.dataset.cameraMode;
      if (mode === 'overview') callbacks.onOverview();
      else if (mode === 'leader') callbacks.onFollowLeader();
      else if (mode === 'free') callbacks.onFree();
    }
  });

  function buildDom(cars: CarState[]): HudDom {
    container.innerHTML = `
    <div class="camera-controls">
      <button data-camera-mode="overview">Overview</button>
      <button data-camera-mode="leader">Follow Leader</button>
      <button data-camera-mode="free">Free</button>
    </div>
    <div class="leaderboard-scroll">
      <table class="leaderboard">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Car</th>
            <th>Speed</th>
            <th>Gap</th>
            <th>Traveled</th>
            <th>Remaining</th>
            <th>Elevation</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="finish-board" hidden>
      <h4>Finished</h4>
      <ol></ol>
    </div>
    <div class="incident-feed" hidden>
      <h4>Incidents</h4>
      <ol></ol>
    </div>`;

    const cameraButtons = new Map<string, HTMLButtonElement>();
    container.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach((btn) => {
      cameraButtons.set(btn.dataset.cameraMode!, btn);
    });

    const tbody = container.querySelector('tbody')!;
    const rows = new Map<string, RowDom>();
    for (const car of cars) {
      const tr = document.createElement('tr');
      tr.dataset.carId = car.spec.id;

      const pos = document.createElement('td');
      const carCell = document.createElement('td');
      carCell.append(carDot(car.spec.colour), document.createTextNode(car.spec.name));
      const speed = document.createElement('td');
      const gap = document.createElement('td');
      const traveled = document.createElement('td');
      const remaining = document.createElement('td');
      const elevation = document.createElement('td');
      const status = document.createElement('td');

      tr.append(pos, carCell, speed, gap, traveled, remaining, elevation, status);
      tbody.appendChild(tr);
      rows.set(car.spec.id, { tr, pos, speed, gap, traveled, remaining, elevation, status });
    }

    pendingIncidents = []; // new race — discard anything attributed to the previous one

    return {
      carsRef: cars,
      cameraButtons,
      tbody,
      rows,
      finishBoard: container.querySelector('.finish-board')!,
      finishList: container.querySelector('.finish-board ol')!,
      finishedIds: new Set(),
      incidentFeed: container.querySelector('.incident-feed')!,
      incidentList: container.querySelector('.incident-feed ol')!,
    };
  }

  function render(cars: CarState[], camera: CameraState, samples: Map<string, RouteSample>): void {
    if (!dom || dom.carsRef !== cars) {
      dom = buildDom(cars);
    }
    const d = dom;

    d.cameraButtons.get('overview')!.classList.toggle('active', camera.mode === 'overview');
    d.cameraButtons
      .get('leader')!
      .classList.toggle('active', camera.mode === 'follow' && camera.target === 'leader');
    d.cameraButtons.get('free')!.classList.toggle('active', camera.mode === 'free');

    // F1: `s` isn't comparable across cars on different routes — rank and
    // gap by remaining distance instead (see sim.ts's remainingDistance).
    // A retired car still shows where it got to (position column), but
    // "leader" for the Gap column baseline and the Follow-Leader highlight
    // excludes retired cars — see sim.ts's resolveLeader.
    const sorted = [...cars].sort((a, b) => remainingDistance(a) - remainingDistance(b));
    const leader = cars.length > 0 ? resolveLeader(cars) : null;
    const leaderRemaining = leader ? remainingDistance(leader) : 0;
    const leaderId = leader?.spec.id ?? null;
    const isSelected = (carId: string) =>
      camera.mode === 'follow' && (camera.target === carId || (camera.target === 'leader' && carId === leaderId));

    sorted.forEach((car, i) => {
      const row = d.rows.get(car.spec.id)!;
      const { ele } = samples.get(car.spec.id)!;
      const gap = remainingDistance(car) - leaderRemaining;
      const remaining = remainingDistance(car);

      row.pos.textContent = String(i + 1);
      row.speed.textContent = `${(car.v * 3.6).toFixed(0)} km/h`;
      row.gap.textContent = car.spec.id === leaderId ? '—' : formatDistance(gap);
      row.traveled.textContent = formatDistance(car.s);
      row.remaining.textContent = formatDistance(remaining);
      row.elevation.textContent = `${ele.toFixed(0)} m`;
      row.status.textContent = formatStatus(car);
      row.tr.classList.toggle('selected', isSelected(car.spec.id));

      // appendChild on a node that's *already* the last child still removes
      // and reinserts it per the DOM spec — an unconditional call here would
      // disconnect/reconnect every row every frame even when nothing moved,
      // which is enough to break a real click's mousedown→mouseup tracking
      // (confirmed by reproduction). Only touch the DOM when order changed.
      if (d.tbody.children[i] !== row.tr) {
        d.tbody.insertBefore(row.tr, d.tbody.children[i] ?? null);
      }
    });

    const newlyFinished = cars
      .filter((c): c is CarState & { finishTime: number } => c.status === 'finished' && c.finishTime !== null)
      .filter((c) => !d.finishedIds.has(c.spec.id))
      .sort((a, b) => a.finishTime - b.finishTime);

    for (const car of newlyFinished) {
      d.finishedIds.add(car.spec.id);

      const rank = document.createElement('span');
      rank.className = 'finish-rank';
      rank.textContent = `${d.finishedIds.size}.`;

      const name = document.createElement('span');
      name.className = 'finish-name';
      name.textContent = car.spec.name;

      const time = document.createElement('span');
      time.className = 'finish-time';
      time.textContent = formatElapsed(car.finishTime);

      // Whole-route average — each car's OWN route (F1: routes differ per
      // car), so averages stay honest when the field is split across variants.
      const avg = document.createElement('span');
      avg.className = 'finish-avg';
      avg.textContent = `${Math.round((car.route.totalDistance / car.finishTime) * 3.6)} km/h avg`;

      const li = document.createElement('li');
      li.append(rank, carDot(car.spec.colour), name, time, avg);
      d.finishList.appendChild(li);
      d.finishBoard.hidden = false;
    }

    for (const { car, incident } of pendingIncidents) {
      const li = document.createElement('li');
      li.append(
        carDot(car.spec.colour),
        document.createTextNode(
          `${car.spec.name} — ${severityLabel(incident.severity)} at ${formatDistance(incident.s)} (t=${formatElapsed(incident.time)})`,
        ),
      );
      d.incidentList.prepend(li); // newest first
      d.incidentFeed.hidden = false;
      while (d.incidentList.children.length > MAX_INCIDENT_FEED_ROWS) d.incidentList.lastElementChild?.remove();
    }
    pendingIncidents = [];
  }

  return {
    render,
    pushIncident(car: CarState, incident: Incident): void {
      pendingIncidents.push({ car, incident });
    },
  };
}
