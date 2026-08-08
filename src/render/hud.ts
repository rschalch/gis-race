import type { CarState, Incident } from '../types';
import type { RouteSample } from '../route';
import { resolveLeader, remainingDistance, raceRank } from '../sim';
import { formatDistance, formatElapsed, carDot } from '../format';

const MAX_INCIDENT_FEED_ROWS = 20;

/** Assigning textContent replaces the text node even when the string is
 * unchanged, so a settled leaderboard (staged cars, a finished race) would
 * still churn ~8 cells × N rows of DOM on every HUD tick. Most cells hold the
 * same string tick to tick; comparing first is far cheaper than rewriting. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

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

export type CameraMode = 'overview' | 'follow' | 'free' | 'tv';

export interface CameraState {
  mode: CameraMode;
  target: string | 'leader' | null; // §8.1's cameraTarget field
}

export interface HudCallbacks {
  onSelectCar: (carId: string) => void;
  onFollowLeader: () => void;
  onOverview: () => void;
  onFree: () => void;
  onTv: () => void;
  onCameraPreset: (preset: string) => void;
}

export interface HudInstance {
  render(cars: CarState[], camera: CameraState, samples: Map<string, RouteSample>, simTime: number): void;
  /** Called from sim.onIncident (wired in main.ts) — see B10/R5. */
  pushIncident(car: CarState, incident: Incident): void;
}

function formatStatus(car: CarState, simTime: number): string {
  switch (car.status) {
    case 'staged':
      return `Starts in ${Math.max(0, car.startDelay - simTime).toFixed(0)}s`;
    case 'paused':
      return `At turnaround (${car.pauseRemaining.toFixed(0)}s)`;
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
  telemetry: HTMLElement;
  telemetryCar: HTMLElement;
  telemetryBars: Map<string, HTMLElement>;
  telemetryValues: Map<string, HTMLElement>;
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
    const presetButton = target.closest<HTMLElement>('[data-camera-preset]');
    if (presetButton) {
      callbacks.onCameraPreset(presetButton.dataset.cameraPreset!);
      return;
    }
    const cameraButton = target.closest<HTMLElement>('[data-camera-mode]');
    if (cameraButton) {
      const mode = cameraButton.dataset.cameraMode;
      if (mode === 'overview') callbacks.onOverview();
      else if (mode === 'leader') callbacks.onFollowLeader();
      else if (mode === 'tv') callbacks.onTv();
      else if (mode === 'free') callbacks.onFree();
    }
  });

  function buildDom(cars: CarState[]): HudDom {
    container.innerHTML = `
    <div class="camera-controls">
      <button data-camera-mode="overview">Overview</button>
      <button data-camera-mode="leader">Follow Leader</button>
      <button data-camera-mode="tv" title="Broadcast coverage — cuts between tracking shots">TV</button>
      <button data-camera-mode="free">Free</button>
      <span class="camera-presets">
        <button data-camera-preset="onboard" title="Onboard — close and low">Onboard</button>
        <button data-camera-preset="close">Close</button>
        <button data-camera-preset="wide">Wide</button>
        <button data-camera-preset="heli" title="Helicopter — high and looking down">Heli</button>
      </span>
    </div>
    <div class="leaderboard-scroll">
      <table class="leaderboard">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Car</th>
            <th>Speed</th>
            <th title="Road distance still to run compared with the leader. Negative means this car is ahead on the road but behind on time — cars start at intervals and are classified on their own elapsed time.">Gap</th>
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
    </div>
    <!-- Telemetry (R11/R12): throttle, brake, tyre wear and accumulated damage
         are all simulated per step and were, until this existed, invisible —
         CarState.throttle/brake are even typed "for HUD/telemetry". Shown for
         the followed car only; there is nothing useful about 28 cars' worth of
         bars at once. -->
    <div class="telemetry" hidden>
      <h4>Telemetry — <span class="telemetry-car"></span></h4>
      <div class="telemetry-row">
        <span class="telemetry-label">Throttle</span>
        <span class="telemetry-bar"><i data-bar="throttle"></i></span>
        <span class="telemetry-value" data-value="throttle"></span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-label">Brake</span>
        <span class="telemetry-bar"><i data-bar="brake"></i></span>
        <span class="telemetry-value" data-value="brake"></span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-label">Tyres</span>
        <span class="telemetry-bar"><i data-bar="tire"></i></span>
        <span class="telemetry-value" data-value="tire"></span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-label">Engine</span>
        <span class="telemetry-bar"><i data-bar="engine"></i></span>
        <span class="telemetry-value" data-value="engine"></span>
      </div>
      <div class="telemetry-row">
        <span class="telemetry-label">Brakes</span>
        <span class="telemetry-bar"><i data-bar="brakeheat"></i></span>
        <span class="telemetry-value" data-value="brakeheat"></span>
      </div>
      <div class="telemetry-row telemetry-condition">
        <span class="telemetry-label">Condition</span>
        <span class="telemetry-value" data-value="condition"></span>
      </div>
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
      telemetry: container.querySelector('.telemetry')!,
      telemetryCar: container.querySelector('.telemetry-car')!,
      telemetryBars: new Map(
        [...container.querySelectorAll<HTMLElement>('.telemetry [data-bar]')].map((el) => [el.dataset.bar!, el]),
      ),
      telemetryValues: new Map(
        [...container.querySelectorAll<HTMLElement>('.telemetry [data-value]')].map((el) => [el.dataset.value!, el]),
      ),
    };
  }

  function render(
    cars: CarState[],
    camera: CameraState,
    samples: Map<string, RouteSample>,
    simTime: number,
  ): void {
    if (!dom || dom.carsRef !== cars) {
      dom = buildDom(cars);
    }
    const d = dom;

    d.cameraButtons.get('overview')!.classList.toggle('active', camera.mode === 'overview');
    d.cameraButtons
      .get('leader')!
      .classList.toggle('active', camera.mode === 'follow' && camera.target === 'leader');
    d.cameraButtons.get('free')!.classList.toggle('active', camera.mode === 'free');
    d.cameraButtons.get('tv')!.classList.toggle('active', camera.mode === 'tv');

    // Rank by projected own-running-time, not road position: under an
    // interval start the car physically furthest down the road may simply
    // have left the line first (see sim.ts's projectedTime). A retired car
    // still shows where it got to, but "leader" for the Gap baseline and the
    // Follow-Leader highlight excludes retired cars — see resolveLeader.
    const sorted = raceRank(cars, simTime);
    const leader = cars.length > 0 ? resolveLeader(cars, simTime) : null;
    const leaderRemaining = leader ? remainingDistance(leader) : 0;
    const leaderId = leader?.spec.id ?? null;
    // TV mode follows a specific car exactly like follow mode does (main.ts
    // resolves the same target), so both get the highlight and telemetry.
    const followsACar = camera.mode === 'follow' || camera.mode === 'tv';
    const isSelected = (carId: string) =>
      followsACar && (camera.target === carId || (camera.target === 'leader' && carId === leaderId));

    sorted.forEach((car, i) => {
      const row = d.rows.get(car.spec.id)!;
      const { ele } = samples.get(car.spec.id)!;
      const remaining = remainingDistance(car);
      // Gap is road distance to the leader: how much further this car still
      // has to go than the leader does. Signed, because rows are ordered by
      // projected time rather than road position — under an interval start a
      // car that left the line earlier can be physically up the road while
      // ranked below, and that shows here as a negative gap. Measuring the
      // difference in *remaining* distance (rather than in `s`) keeps it
      // meaningful when cars are on different route variants of the same
      // course, whose total lengths differ (F1).
      const gap = remaining - leaderRemaining;

      setText(row.pos, String(i + 1));
      setText(row.speed, `${(car.v * 3.6).toFixed(0)} km/h`);
      setText(row.gap, car.spec.id === leaderId ? '—' : `${gap < 0 ? '−' : '+'}${formatDistance(Math.abs(gap))}`);
      setText(row.traveled, formatDistance(car.s));
      setText(row.remaining, formatDistance(remaining));
      setText(row.elevation, `${ele.toFixed(0)} m`);
      setText(row.status, formatStatus(car, simTime));
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

    const finishers = cars
      .filter((c): c is CarState & { finishTime: number } => c.status === 'finished' && c.finishTime !== null)
      .sort((a, b) => a.finishTime - b.finishTime);

    // Rebuilt whole rather than appended to. Under an interval start, cars
    // cross the line in road order but are classified on their OWN elapsed
    // time, so a car finishing later in absolute terms can still take the
    // win — an append-only list would freeze the first arrival at "1." and
    // never correct it. Only rebuilt when the finisher set actually grows,
    // so a settled board still costs nothing per frame.
    if (finishers.length !== d.finishedIds.size) {
      d.finishedIds = new Set(finishers.map((c) => c.spec.id));
      d.finishList.replaceChildren();

      finishers.forEach((car, i) => {
        const rank = document.createElement('span');
        rank.className = 'finish-rank';
        rank.textContent = `${i + 1}.`;

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
      });
      d.finishBoard.hidden = finishers.length === 0;
    }

    // Telemetry for whoever the camera is on; hidden entirely in overview or
    // free mode, where "the selected car" is not a thing.
    const focus = followsACar ? sorted.find((c) => isSelected(c.spec.id)) : undefined;
    d.telemetry.hidden = focus === undefined;
    if (focus) {
      setText(d.telemetryCar, focus.spec.name);
      const setBar = (key: string, fraction: number, text: string) => {
        const bar = d.telemetryBars.get(key)!;
        const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
        if (bar.style.width !== width) bar.style.width = width;
        setText(d.telemetryValues.get(key)!, text);
      };
      setBar('throttle', focus.throttle, `${Math.round(focus.throttle * 100)}%`);
      setBar('brake', focus.brake, `${Math.round(focus.brake * 100)}%`);
      setBar('tire', focus.tireWear, `${Math.round(focus.tireWear * 100)}% worn`);
      // R15: smoothed engine load — the reliability hazard's stress signal,
      // shown so a sustained flat-out run visibly cooks the motor.
      setBar('engine', focus.engineLoad, `${Math.round(focus.engineLoad * 100)}% load`);
      // R19: brake heat — a held mountain descent visibly cooks the brakes.
      setBar('brakeheat', focus.brakeHeat, `${Math.round(focus.brakeHeat * 100)}% hot`);
      // R12 damage is permanent and small by design, so it reads better as an
      // explicit "none" than as a bar pinned near full.
      const gripLoss = Math.round((1 - focus.condition.grip) * 1000) / 10;
      const dragGain = Math.round((focus.condition.cdA - 1) * 1000) / 10;
      setText(
        d.telemetryValues.get('condition')!,
        gripLoss === 0 && dragGain === 0 ? 'undamaged' : `-${gripLoss}% grip, +${dragGain}% drag`,
      );
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
