import type { CarSpec, RouteIndexEntry, Weather } from '../types';
import { CRANK_TO_WHEEL } from '../cars';
import { carDot } from '../format';
import { GLOBAL_CAP } from '../tuning';
import {
  MAX_FIELD_SIZE,
  PERFORMANCE_TIERS,
  buildFairField,
  fieldLike,
  groupByMake,
  paceIndex,
  sortByPace,
  tierOf,
} from '../roster';
import type { RouteStore } from './route-store';

/** One car, one route slug — any route in the index is pickable, not just
 * variants of a single course. `onApply` re-derives the full assignment from
 * this plus the selected-car list; anyone whose pick has since been deleted
 * falls back to the first route in the index. */
export interface ConfigApplyResult {
  carAssignments: Array<{ carId: string; routeSlug: string }>;
  globalCapEnabled: boolean;
  weather: Weather;
  /** Seconds between cars leaving the line; 0 is a mass start. */
  startIntervalS: number;
}

/** Interval-start choices. 0 is offered because a mass start is a legitimate
 * format, not because it is the sensible default — with a full grid it puts
 * every car on the same point of road (see START_INTERVAL_S in tuning.ts). */
const START_INTERVAL_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Mass start' },
  { value: 15, label: 'Interval — 15 s' },
  { value: 30, label: 'Interval — 30 s' },
  { value: 60, label: 'Interval — 60 s' },
];

const WEATHER_LABELS: Record<Weather, string> = { dry: 'Dry', damp: 'Damp', wet: 'Wet' };

export interface ConfigPanelCallbacks {
  onApply: (result: ConfigApplyResult) => void;
}

export interface ConfigPanelHandle {
  showError(message: string): void;
}

const MIN_CARS = 2;
const WATTS_PER_HP = 745.7;

/** Master-picker sentinel: shown when the per-car picks disagree. It is a real
 * (disabled) option so the select has something to display — `select.value = x`
 * still selects a disabled option, it only blocks the *user* from picking it. */
const MIXED_VALUE = '__mixed';
/** Master-picker option that hands out a multi-variant course's alternates
 * round-robin down the grid, rather than putting everyone on one variant. */
const SPREAD_PREFIX = 'spread:';
/** Filter sentinels for "don't narrow by this". */
const ALL_TIERS = '__all';
const ALL_MAKES = '__all';
const ALL_TYPES = '__all';

/** M1: motorcycles sit in the same roster as cars (a Honda group holds both a
 * Civic and a Fireblade), so each row needs a mark saying which it is. A glyph
 * rather than a column: it is a two-value fact on one row in twenty. */
const MOTORCYCLE_GLYPH = '\u{1F3CD}';

/**
 * Built once — this is a modal opened/closed by the user, not a per-frame live
 * view, so there's no DOM-churn/click-swallowing concern here.
 *
 * ## Layout
 *
 * Two panes, side by side: **browse** on the left (one manufacturer at a time,
 * picked from the chip row above it) and **the grid you are building** on the
 * right. Nothing but those two lists scrolls, and each shows ~10–20 short rows,
 * so configuring a race never means scrolling a 197-row page.
 *
 * That is the whole reason for the split. An earlier version stacked the full
 * roster vertically with the rules below it; every interaction (pick a car,
 * check what you'd picked, change the weather) meant scrolling somewhere else.
 * Here the two things you alternate between — the roster and your grid — are
 * visible at the same time, and the rules sit on one line under both.
 *
 * Routes live in the *grid* pane, not the browse table: only the ~20 cars that
 * are actually racing need one. Routes themselves are owned by the Routes
 * panel; this panel only reads them (via the shared store).
 */
export function initConfigPanel(
  triggerButton: HTMLElement,
  panelContainer: HTMLElement,
  store: RouteStore,
  allCars: CarSpec[],
  initialRouteSlug: string,
  initialCarIds: Set<string>,
  initialGlobalCapEnabled: boolean,
  initialWeather: Weather,
  initialStartIntervalS: number,
  callbacks: ConfigPanelCallbacks,
): ConfigPanelHandle {
  panelContainer.innerHTML = `
    <div class="config-backdrop"></div>
    <div class="config-modal cars-modal" role="dialog" aria-modal="true" aria-label="Configure race">
      <header class="config-header">
        <h3>Configure race</h3>
        <button type="button" class="config-close" aria-label="Close">&times;</button>
      </header>
      <div class="config-body cars-body">
        <div class="config-grid-toolbar">
          <input type="text" class="config-car-search" placeholder="Search all ${allCars.length} vehicles…" autocomplete="off" />
          <select class="config-type-filter" aria-label="Filter by vehicle type">
            <option value="${ALL_TYPES}">Cars &amp; bikes</option>
            <option value="car">Cars only</option>
            <option value="motorcycle">Motorcycles only</option>
          </select>
          <select class="config-class-filter" aria-label="Filter by performance class">
            <option value="${ALL_TIERS}">All classes</option>
            ${PERFORMANCE_TIERS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}
          </select>
          <button type="button" data-grid-action="fill" title="Pick a competitive ${MAX_FIELD_SIZE}-car grid from the cars currently listed">Fill grid</button>
        </div>
        <div class="config-make-chips" role="tablist" aria-label="Manufacturer"></div>
        <div class="config-two-pane">
          <section class="config-browse" aria-label="Roster">
            <div class="config-pane-head">
              <span class="config-browse-title"></span>
              <button type="button" data-visible-action="add">Add</button>
              <button type="button" data-visible-action="remove">Remove</button>
            </div>
            <div class="config-cars-header">
              <button type="button" data-sort="name">Car</button>
              <button type="button" data-sort="hp">hp</button>
              <button type="button" data-sort="speed">Top speed</button>
              <button type="button" data-sort="mass">Weight</button>
              <button type="button" data-sort="pace">Class</button>
            </div>
            <ul class="config-cars"></ul>
          </section>
          <section class="config-grid-pane" aria-label="Grid">
            <div class="config-pane-head">
              <span class="config-pane-title">Grid</span>
              <span class="config-count" aria-live="polite"></span>
              <button type="button" data-grid-action="clear">Clear</button>
            </div>
            <label class="config-route-all">
              <span>Route</span>
              <select class="config-route-master"></select>
            </label>
            <ul class="config-grid-list"></ul>
          </section>
        </div>
        <div class="config-rules-row">
          <label class="config-checkbox" title="Off lets each car use its real top speed on open road">
            <input type="checkbox" class="config-global-cap" ${initialGlobalCapEnabled ? 'checked' : ''} />
            <span>Obey speed limits <span class="config-hint">(else ${Math.round(GLOBAL_CAP * 3.6)} km/h)</span></span>
          </label>
          <label class="config-rule" title="Wet/damp roads cut grip and widen the margin for error, for everyone">
            Weather
            <select class="config-weather">
              ${(Object.keys(WEATHER_LABELS) as Weather[])
                .map((w) => `<option value="${w}" ${w === initialWeather ? 'selected' : ''}>${WEATHER_LABELS[w]}</option>`)
                .join('')}
            </select>
          </label>
          <label class="config-rule" title="Cars are classified on their own elapsed time, so starting later costs nothing">
            Start
            <select class="config-start-interval">
              ${START_INTERVAL_CHOICES.map(
                (c) =>
                  `<option value="${c.value}" ${c.value === initialStartIntervalS ? 'selected' : ''}>${c.label}</option>`,
              ).join('')}
            </select>
          </label>
        </div>
      </div>
      <footer class="config-actions">
        <p class="config-error" hidden></p>
        <button data-config-action="cancel">Cancel</button>
        <button data-config-action="apply">Apply &amp; Restart</button>
      </footer>
    </div>`;

  const backdrop = panelContainer.querySelector<HTMLElement>('.config-backdrop')!;
  const closeButton = panelContainer.querySelector<HTMLButtonElement>('.config-close')!;
  const carsList = panelContainer.querySelector<HTMLUListElement>('.config-cars')!;
  const gridList = panelContainer.querySelector<HTMLUListElement>('.config-grid-list')!;
  const chipRow = panelContainer.querySelector<HTMLElement>('.config-make-chips')!;
  const browseTitle = panelContainer.querySelector<HTMLElement>('.config-browse-title')!;
  const routeMaster = panelContainer.querySelector<HTMLSelectElement>('.config-route-master')!;
  const countEl = panelContainer.querySelector<HTMLElement>('.config-count')!;
  const classFilter = panelContainer.querySelector<HTMLSelectElement>('.config-class-filter')!;
  const typeFilter = panelContainer.querySelector<HTMLSelectElement>('.config-type-filter')!;
  const carSearchInput = panelContainer.querySelector<HTMLInputElement>('.config-car-search')!;
  const errorEl = panelContainer.querySelector<HTMLElement>('.config-error')!;

  const carById = new Map(allCars.map((c) => [c.id, c]));
  const carsByMake = groupByMake(allCars);
  /** The grid. Selection state lives here, not in the checkboxes, because two
   * views (browse rows and grid rows) render the same fact. */
  const selected = new Set([...initialCarIds].filter((id) => carById.has(id)));
  /** Which route slug each car is assigned to. Sticky across route-index
   * changes: a car keeps its pick unless that route was deleted, in which
   * case it falls back to the first route in the index. Held for every car,
   * not just selected ones, so a car keeps its route across removal/re-add. */
  const carRouteAssignment = new Map(allCars.map((c) => [c.id, initialRouteSlug]));

  let activeMake: string = ALL_MAKES;

  // ------------------------------------------------------------- routes

  /** What the master picker last applied, so it can keep showing "spread" —
   * an intent the per-car values alone can't be read back as. Cleared to null
   * (⇒ "Mixed") the moment a per-car pick diverges from it. */
  let masterSelection: string | null = null;

  function optionLabel(v: RouteIndexEntry, single: boolean): string {
    return single
      ? `${v.name} · ${Math.round(v.distanceKm)} km`
      : `${v.variantLabel} · ${Math.round(v.distanceKm)} km`;
  }

  /** Route/course names embed user-typed text — build options via textContent,
   * never innerHTML (B7). */
  function fillRouteSelect(select: HTMLSelectElement, chosen: string): void {
    select.innerHTML = '';
    for (const [, variants] of store.courses()) {
      const single = variants.length === 1;
      const parent: HTMLSelectElement | HTMLOptGroupElement = single ? select : document.createElement('optgroup');
      if (parent instanceof HTMLOptGroupElement) parent.label = variants[0]!.name;
      for (const v of variants) {
        const option = document.createElement('option');
        option.value = v.slug;
        option.textContent = optionLabel(v, single);
        option.selected = v.slug === chosen;
        parent.appendChild(option);
      }
      if (parent instanceof HTMLOptGroupElement) select.appendChild(parent);
    }
  }

  /** Drops assignments whose route was deleted onto the first route that still
   * exists, so the panel can never hand `onApply` a dead slug. */
  function normaliseAssignments(): void {
    const entries = store.entries();
    if (entries.length === 0) return; // dev API refuses to delete the last course
    const valid = new Set(entries.map((e) => e.slug));
    for (const [carId, slug] of carRouteAssignment) {
      if (!valid.has(slug)) carRouteAssignment.set(carId, entries[0]!.slug);
    }
  }

  /** The master picker mirrors the per-car options, plus a "spread" entry for
   * any course that has alternates (F1: cars may run different variants of the
   * same course simultaneously). */
  function rebuildMasterSelect(): void {
    routeMaster.innerHTML = '';

    const mixed = document.createElement('option');
    mixed.value = MIXED_VALUE;
    mixed.textContent = 'Mixed — set per car';
    mixed.disabled = true; // selectable in code, not by the user
    routeMaster.appendChild(mixed);

    for (const [courseId, variants] of store.courses()) {
      const single = variants.length === 1;
      const parent: HTMLSelectElement | HTMLOptGroupElement = single
        ? routeMaster
        : document.createElement('optgroup');
      if (parent instanceof HTMLOptGroupElement) parent.label = variants[0]!.name;
      if (!single) {
        const spread = document.createElement('option');
        spread.value = `${SPREAD_PREFIX}${courseId}`;
        spread.textContent = `Spread all ${variants.length} variants across the grid`;
        parent.appendChild(spread);
      }
      for (const v of variants) {
        const option = document.createElement('option');
        option.value = v.slug;
        option.textContent = optionLabel(v, single);
        parent.appendChild(option);
      }
      if (parent instanceof HTMLOptGroupElement) routeMaster.appendChild(parent);
    }
  }

  /** Master shows the common slug when every car on the grid agrees, the
   * remembered spread while it still holds, and "Mixed" otherwise. */
  function syncMasterSelect(): void {
    const onGrid = [...selected].map((id) => carRouteAssignment.get(id)!);
    const distinct = new Set(onGrid);
    if (distinct.size === 1) masterSelection = [...distinct][0]!;
    else if (masterSelection !== null && !masterSelection.startsWith(SPREAD_PREFIX)) masterSelection = null;
    routeMaster.value = masterSelection ?? MIXED_VALUE;
  }

  /** Applies a master pick to every car in the roster — not just the grid, so
   * a car added later inherits the same route instead of silently arriving on
   * a different one. Spread walks the grid in its displayed order, which is
   * deterministic (fastest first), and parks everyone else on variant 1. */
  function applyMasterRoute(value: string): void {
    if (value === MIXED_VALUE) return;

    if (value.startsWith(SPREAD_PREFIX)) {
      const variants = store.courses().get(value.slice(SPREAD_PREFIX.length));
      if (!variants || variants.length === 0) return;
      for (const carId of carRouteAssignment.keys()) carRouteAssignment.set(carId, variants[0]!.slug);
      gridCars().forEach((car, i) => carRouteAssignment.set(car.id, variants[i % variants.length]!.slug));
    } else {
      for (const carId of carRouteAssignment.keys()) carRouteAssignment.set(carId, value);
    }

    masterSelection = value;
    renderGrid();
  }

  routeMaster.addEventListener('change', () => {
    applyMasterRoute(routeMaster.value);
    syncMasterSelect();
  });

  // -------------------------------------------------------- browse pane

  interface BrowseRow {
    car: CarSpec;
    li: HTMLLIElement;
    checkbox: HTMLInputElement;
  }
  const browseRows = new Map<string, BrowseRow>();

  /** Motorcycles get a mark; cars get an empty placeholder so both grids stay
   * aligned. */
  function vehicleGlyph(car: CarSpec): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'config-vehicle-glyph';
    if (car.type === 'motorcycle') {
      span.textContent = MOTORCYCLE_GLYPH;
      span.title = 'Motorcycle';
    }
    return span;
  }

  function numberCell(text: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'config-car-num';
    span.textContent = text;
    return span;
  }

  for (const car of allCars) {
    const hp = Math.round(car.power / CRANK_TO_WHEEL / WATTS_PER_HP);
    const topSpeed = Math.round(car.vMax * 3.6);
    const tier = tierOf(car);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = car.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'config-car-name';
    nameSpan.textContent = car.name;

    const label = document.createElement('label');
    label.className = 'config-car-label';
    label.append(checkbox, carDot(car.colour), vehicleGlyph(car), nameSpan);

    // Clicking a class chip builds a grid of the cars that can actually race
    // this one — the shortest path from "I want to drive the F-150" to a race
    // that isn't decided in the first kilometre.
    const classButton = document.createElement('button');
    classButton.type = 'button';
    classButton.className = 'config-car-class';
    classButton.dataset.gridLike = car.id;
    classButton.textContent = tier.label;
    classButton.title = `${tier.label} class — click to fill the grid with cars that can race the ${car.name}`;

    const li = document.createElement('li');
    li.dataset.carId = car.id;
    // 'motorcycle'/'bike' are searchable words, so typing either narrows the
    // list the same way a make does.
    li.dataset.searchText =
      `${car.name} ${car.make} ${car.type === 'motorcycle' ? 'motorcycle bike' : 'car'}`.toLowerCase();
    li.dataset.tier = tier.id;
    li.dataset.vtype = car.type;
    li.dataset.make = car.make;
    // Sort keys — read back by the column-header sorter.
    li.dataset.name = car.name;
    li.dataset.hp = String(hp);
    li.dataset.speed = String(topSpeed);
    li.dataset.mass = String(car.mass);
    li.dataset.pace = String(paceIndex(car));
    li.append(label, numberCell(`${hp}`), numberCell(`${topSpeed} km/h`), numberCell(`${car.mass} kg`), classButton);

    carsList.appendChild(li);
    browseRows.set(car.id, { car, li, checkbox });
  }

  // Manufacturer chips — the roster's primary axis. One click swaps the whole
  // browse list, which is what keeps it ten rows long instead of 197.
  const chipByMake = new Map<string, { chip: HTMLButtonElement; badge: HTMLElement }>();

  function addChip(make: string, label: string): void {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'config-make-chip';
    chip.dataset.make = make;
    chip.setAttribute('role', 'tab');
    const name = document.createElement('span');
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'config-chip-badge';
    chip.append(name, badge);
    chipRow.appendChild(chip);
    chipByMake.set(make, { chip, badge });
  }

  addChip(ALL_MAKES, 'All makes');
  for (const make of carsByMake.keys()) addChip(make, make);

  chipRow.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.config-make-chip');
    if (!chip) return;
    activeMake = chip.dataset.make!;
    applyFilters();
  });

  // --------------------------------------------------------- grid pane

  /** The grid, fastest first — a stable, meaningful order that doesn't jump
   * around as cars are added. */
  function gridCars(): CarSpec[] {
    return sortByPace([...selected].map((id) => carById.get(id)!));
  }

  function renderGrid(): void {
    gridList.innerHTML = '';
    const cars = gridCars();

    if (cars.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'config-grid-empty';
      empty.textContent = 'No cars yet — pick from the left, or press Fill grid.';
      gridList.appendChild(empty);
    }

    for (const car of cars) {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'config-grid-name';
      nameSpan.textContent = car.name;
      nameSpan.title = car.name;

      const routeSelect = document.createElement('select');
      routeSelect.className = 'config-car-route';
      routeSelect.setAttribute('aria-label', `Route for ${car.name}`);
      fillRouteSelect(routeSelect, carRouteAssignment.get(car.id)!);
      routeSelect.addEventListener('change', () => {
        carRouteAssignment.set(car.id, routeSelect.value);
        // A per-car override invalidates whatever the master last applied.
        masterSelection = null;
        syncMasterSelect();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'config-grid-remove';
      remove.dataset.removeCar = car.id;
      remove.textContent = '×';
      remove.title = `Remove the ${car.name} from the grid`;

      const li = document.createElement('li');
      li.dataset.carId = car.id;
      li.append(carDot(car.colour), vehicleGlyph(car), nameSpan, routeSelect, remove);
      gridList.appendChild(li);
    }

    syncMasterSelect();
  }

  gridList.addEventListener('click', (e) => {
    const remove = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-car]');
    if (!remove) return;
    selected.delete(remove.dataset.removeCar!);
    clearError();
    refresh();
  });

  // --------------------------------------------------- shared refreshers

  function refreshCounts(): void {
    const total = selected.size;
    countEl.textContent = `${total} / ${MAX_FIELD_SIZE}`;
    countEl.classList.toggle('config-count-full', total >= MAX_FIELD_SIZE);
    countEl.classList.toggle('config-count-short', total < MIN_CARS);

    for (const [make, { chip, badge }] of chipByMake) {
      const cars = make === ALL_MAKES ? allCars : carsByMake.get(make)!;
      const picked = cars.filter((c) => selected.has(c.id)).length;
      badge.textContent = picked > 0 ? `${picked}/${cars.length}` : String(cars.length);
      badge.classList.toggle('config-chip-badge-active', picked > 0);
      chip.classList.toggle('config-make-chip-active', make === activeMake);
      chip.setAttribute('aria-selected', String(make === activeMake));
    }

    for (const row of browseRows.values()) {
      row.checkbox.checked = selected.has(row.car.id);
      row.li.classList.toggle('config-car-picked', selected.has(row.car.id));
    }
  }

  /** Every path that changes the selection ends here. */
  function refresh(): void {
    refreshCounts();
    renderGrid();
  }

  /** The footer line doubles as feedback for the grid actions, which are not
   * errors — "picked 20 cars" in red would read as a failure. */
  function flash(message: string, kind: 'error' | 'info' = 'error'): void {
    errorEl.textContent = message;
    errorEl.classList.toggle('config-error-info', kind === 'info');
    errorEl.hidden = false;
  }

  function clearError(): void {
    errorEl.hidden = true;
  }

  function setSelection(cars: CarSpec[]): void {
    selected.clear();
    for (const car of cars.slice(0, MAX_FIELD_SIZE)) selected.add(car.id);
    refresh();
  }

  // A tick that would exceed the cap is refused rather than silently dropping
  // someone else — the user chose this car, so tell them what to do.
  carsList.addEventListener('change', (e) => {
    const checkbox = (e.target as HTMLElement).closest<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) return;
    if (!checkbox.checked) {
      selected.delete(checkbox.value);
      clearError();
    } else if (selected.size >= MAX_FIELD_SIZE) {
      checkbox.checked = false;
      flash(`A grid holds at most ${MAX_FIELD_SIZE} cars — remove one first.`);
    } else {
      selected.add(checkbox.value);
      clearError();
    }
    refresh();
  });

  carsList.addEventListener('click', (e) => {
    const likeButton = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-grid-like]');
    if (!likeButton) return;
    const anchor = carById.get(likeButton.dataset.gridLike!)!;
    const field = fieldLike(anchor, allCars, MAX_FIELD_SIZE);
    setSelection(field);
    flash(`Grid built around the ${anchor.name} — ${field.length} cars of comparable pace.`, 'info');
  });

  // Column sorting: click a header to sort by that stat, click again to flip
  // direction. Numeric columns start descending (biggest first — that's what
  // a "sort by hp" click is asking for); the name column starts ascending.
  // Sorting reorders the existing <li> nodes, so filter-hiding travels with
  // its row.
  type SortKey = 'name' | 'hp' | 'speed' | 'mass' | 'pace';
  const sortButtons = panelContainer.querySelectorAll<HTMLButtonElement>('.config-cars-header [data-sort]');
  const baseLabels = new Map<HTMLButtonElement, string>();
  sortButtons.forEach((btn) => baseLabels.set(btn, btn.textContent ?? ''));
  let sortKey: SortKey | null = null;
  let sortDir = 1;

  function applySort(key: SortKey): void {
    if (sortKey === key) sortDir = -sortDir;
    else {
      sortKey = key;
      sortDir = key === 'name' ? 1 : -1;
    }
    const rows = Array.from(carsList.children) as HTMLLIElement[];
    rows.sort((a, b) =>
      key === 'name'
        ? sortDir * a.dataset.name!.localeCompare(b.dataset.name!)
        : sortDir * (Number(a.dataset[key]) - Number(b.dataset[key])),
    );
    for (const row of rows) carsList.appendChild(row);
    sortButtons.forEach((btn) => {
      const active = btn.dataset.sort === sortKey;
      btn.textContent = active ? `${baseLabels.get(btn)} ${sortDir === 1 ? '▲' : '▼'}` : baseLabels.get(btn)!;
      btn.classList.toggle('config-sort-active', active);
    });
  }

  sortButtons.forEach((btn) => {
    btn.addEventListener('click', () => applySort(btn.dataset.sort as SortKey));
  });

  /** Make chip, search text and performance class all narrow the same list.
   * Searching deliberately drops back to All makes — a hit inside a make you
   * aren't looking at is a hit you'd never see. */
  function applyFilters(): void {
    const query = carSearchInput.value.trim().toLowerCase();
    const tier = classFilter.value;
    const vtype = typeFilter.value;
    if (query.length > 0 && activeMake !== ALL_MAKES) activeMake = ALL_MAKES;

    let visible = 0;
    for (const row of browseRows.values()) {
      const hidden =
        (activeMake !== ALL_MAKES && row.li.dataset.make !== activeMake) ||
        (query.length > 0 && !row.li.dataset.searchText!.includes(query)) ||
        (vtype !== ALL_TYPES && row.li.dataset.vtype !== vtype) ||
        (tier !== ALL_TIERS && row.li.dataset.tier !== tier);
      row.li.hidden = hidden;
      if (!hidden) visible += 1;
    }

    const scope = activeMake === ALL_MAKES ? 'All makes' : activeMake;
    const narrowed = query.length > 0 || tier !== ALL_TIERS || vtype !== ALL_TYPES;
    browseTitle.textContent = `${scope} — ${visible} vehicle${visible === 1 ? '' : 's'}${narrowed ? ' matching' : ''}`;
    carsList.scrollTop = 0;
    refreshCounts();
  }

  /** The cars the filters are currently showing — the pool every grid action
   * draws from, so "Sport class + Fill grid" means what it looks like. */
  function visibleCars(): CarSpec[] {
    return [...browseRows.values()].filter((r) => !r.li.hidden).map((r) => r.car);
  }

  carSearchInput.addEventListener('input', applyFilters);
  classFilter.addEventListener('change', applyFilters);
  typeFilter.addEventListener('change', applyFilters);

  // Add/Remove act on exactly what the browse pane is showing — one make, or
  // whatever the search and class filter left standing.
  panelContainer.querySelectorAll<HTMLButtonElement>('[data-visible-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pool = visibleCars();
      if (btn.dataset.visibleAction === 'remove') {
        for (const car of pool) selected.delete(car.id);
        clearError();
      } else {
        let skipped = 0;
        for (const car of pool) {
          if (selected.has(car.id)) continue;
          if (selected.size >= MAX_FIELD_SIZE) skipped += 1;
          else selected.add(car.id);
        }
        if (skipped > 0) flash(`Grid is full at ${MAX_FIELD_SIZE} cars — ${skipped} not added.`);
        else clearError();
      }
      refresh();
    });
  });

  panelContainer.querySelectorAll<HTMLButtonElement>('[data-grid-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.gridAction === 'clear') {
        setSelection([]);
        clearError();
        return;
      }
      const pool = visibleCars();
      if (pool.length < MIN_CARS) {
        flash('Not enough cars match the current filters to build a grid.');
        return;
      }
      const field = buildFairField(pool, MAX_FIELD_SIZE);
      setSelection(field);
      flash(
        `Picked ${field.length} cars of comparable pace${pool.length > field.length ? ` from the ${pool.length} listed` : ''}.`,
        'info',
      );
    });
  });

  store.subscribe(() => {
    normaliseAssignments();
    rebuildMasterSelect();
    renderGrid();
  });
  normaliseAssignments();
  rebuildMasterSelect();
  applyFilters();
  refresh();

  const globalCapCheckbox = panelContainer.querySelector<HTMLInputElement>('.config-global-cap')!;
  const weatherSelect = panelContainer.querySelector<HTMLSelectElement>('.config-weather')!;
  const startIntervalSelect = panelContainer.querySelector<HTMLSelectElement>('.config-start-interval')!;

  function open() {
    panelContainer.hidden = false;
    errorEl.hidden = true;
  }

  function close() {
    panelContainer.hidden = true;
  }

  triggerButton.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelContainer.hidden) close();
  });

  panelContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionButton = target.closest<HTMLElement>('[data-config-action]');
    if (!actionButton) return;

    if (actionButton.dataset.configAction === 'cancel') {
      close();
      return;
    }

    if (actionButton.dataset.configAction === 'apply') {
      if (selected.size < MIN_CARS) {
        flash(`Pick at least ${MIN_CARS} cars.`);
        return;
      }
      if (selected.size > MAX_FIELD_SIZE) {
        flash(`A grid holds at most ${MAX_FIELD_SIZE} cars.`);
        return;
      }
      if (store.entries().length === 0) {
        flash('No routes exist — create one in the Routes panel first.');
        return;
      }
      normaliseAssignments();
      callbacks.onApply({
        carAssignments: gridCars().map((car) => ({ carId: car.id, routeSlug: carRouteAssignment.get(car.id)! })),
        globalCapEnabled: globalCapCheckbox.checked,
        weather: weatherSelect.value as Weather,
        startIntervalS: Number(startIntervalSelect.value),
      });
      close();
    }
  });

  return {
    // Surfaces a failed onApply (e.g. loadRoute rejecting) by reopening the
    // panel with an error line — otherwise the panel has already closed and
    // the user sees no explanation at all while the old race keeps running.
    showError(message: string): void {
      open();
      flash(message);
    },
  };
}
