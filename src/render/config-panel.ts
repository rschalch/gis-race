import type { CarSpec, Weather } from '../types';
import { CRANK_TO_WHEEL } from '../cars';
import { carDot } from '../format';
import { GLOBAL_CAP } from '../tuning';
import type { RouteStore } from './route-store';

/** One car, one route slug — any route in the index is pickable, not just
 * variants of a single course. `onApply` re-derives the full assignment from
 * this plus the checked-car list; anyone whose pick has since been deleted
 * falls back to the first route in the index. */
export interface ConfigApplyResult {
  carAssignments: Array<{ carId: string; routeSlug: string }>;
  globalCapEnabled: boolean;
  weather: Weather;
}

const WEATHER_LABELS: Record<Weather, string> = { dry: 'Dry', damp: 'Damp', wet: 'Wet' };

export interface ConfigPanelCallbacks {
  onApply: (result: ConfigApplyResult) => void;
}

export interface ConfigPanelHandle {
  showError(message: string): void;
}

const MIN_CARS = 2;
const WATTS_PER_HP = 745.7;

/** Built once — this is a modal opened/closed by the user, not a per-frame
 * live view, so there's no DOM-churn/click-swallowing concern here. Routes
 * are owned by the Routes panel; this panel only reads them (via the shared
 * store) to populate each car's route picker. */
export function initConfigPanel(
  triggerButton: HTMLElement,
  panelContainer: HTMLElement,
  store: RouteStore,
  allCars: CarSpec[],
  initialRouteSlug: string,
  initialCarIds: Set<string>,
  initialGlobalCapEnabled: boolean,
  initialWeather: Weather,
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
        <section class="config-section config-cars-section">
          <h4>Cars <span class="config-hint">(pick at least ${MIN_CARS} — each car races the route picked next to it)</span></h4>
          <div class="config-cars-toolbar">
            <input type="text" class="config-car-search" placeholder="Search cars…" autocomplete="off" />
            <button type="button" data-select="all">Select all</button>
            <button type="button" data-select="none">Select none</button>
          </div>
          <div class="config-cars-header">
            <button type="button" data-sort="name">Car</button>
            <button type="button" data-sort="hp">hp</button>
            <button type="button" data-sort="speed">Top speed</button>
            <button type="button" data-sort="mass">Weight</button>
            <span class="config-cars-header-route">Route</span>
          </div>
          <ul class="config-cars"></ul>
        </section>

        <section class="config-section">
          <h4>Rules</h4>
          <label class="config-checkbox">
            <input type="checkbox" class="config-global-cap" ${initialGlobalCapEnabled ? 'checked' : ''} />
            <span class="config-checkbox-text">Obey speed limits (posted where tagged, else ${Math.round(GLOBAL_CAP * 3.6)} km/h stand-in)
              <span class="config-hint">— off lets each car use its real top speed on open road</span></span>
          </label>
          <label class="config-select-row">
            Weather
            <select class="config-weather">
              ${(Object.keys(WEATHER_LABELS) as Weather[])
                .map((w) => `<option value="${w}" ${w === initialWeather ? 'selected' : ''}>${WEATHER_LABELS[w]}</option>`)
                .join('')}
            </select>
            <span class="config-hint">— wet/damp roads cut grip and widen the margin for error, for everyone</span>
          </label>
        </section>
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

  // Which route slug each car is assigned to. Sticky across route-index
  // changes: a car keeps its pick unless that route was deleted, in which
  // case it falls back to the first route in the index.
  const carRouteAssignment = new Map<string, string>();

  interface CarRow {
    checkbox: HTMLInputElement;
    routeSelect: HTMLSelectElement;
  }
  const carRows = new Map<string, CarRow>();

  /** Rebuilds every car's route picker from the store: one plain option per
   * single-road course, one optgroup per course with alternates. Route/course
   * names embed user-typed text — build options via textContent, never
   * innerHTML (B7). */
  function rebuildRouteSelects(): void {
    const entries = store.entries();
    if (entries.length === 0) return; // dev API refuses to delete the last course
    const fallbackSlug = entries[0]!.slug;
    const validSlugs = new Set(entries.map((e) => e.slug));

    for (const [carId, row] of carRows) {
      const assigned = carRouteAssignment.get(carId);
      const effective = assigned !== undefined && validSlugs.has(assigned) ? assigned : fallbackSlug;
      carRouteAssignment.set(carId, effective);

      row.routeSelect.innerHTML = '';
      for (const [, variants] of store.courses()) {
        const single = variants.length === 1;
        const parent: HTMLSelectElement | HTMLOptGroupElement = single
          ? row.routeSelect
          : document.createElement('optgroup');
        if (parent instanceof HTMLOptGroupElement) parent.label = variants[0]!.name;
        for (const v of variants) {
          const option = document.createElement('option');
          option.value = v.slug;
          option.textContent = single
            ? `${v.name} · ${Math.round(v.distanceKm)} km`
            : `${v.variantLabel} · ${Math.round(v.distanceKm)} km`;
          option.selected = v.slug === effective;
          parent.appendChild(option);
        }
        if (parent instanceof HTMLOptGroupElement) row.routeSelect.appendChild(parent);
      }
    }
  }

  function checkedCarIds(): string[] {
    return Array.from(carsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(
      (cb) => cb.value,
    );
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

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = car.id;
    checkbox.checked = initialCarIds.has(car.id);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'config-car-name';
    nameSpan.textContent = car.name;

    const label = document.createElement('label');
    label.className = 'config-car-label';
    label.append(checkbox, carDot(car.colour), nameSpan);

    // The select sits OUTSIDE the label on purpose — inside it, picking a
    // route would also toggle the car's checkbox.
    const routeSelectForCar = document.createElement('select');
    routeSelectForCar.className = 'config-car-route';
    routeSelectForCar.setAttribute('aria-label', `Route for ${car.name}`);
    routeSelectForCar.addEventListener('change', () => {
      carRouteAssignment.set(car.id, routeSelectForCar.value);
    });

    const li = document.createElement('li');
    li.dataset.searchText = car.name.toLowerCase();
    // Sort keys — read back by the column-header sorter.
    li.dataset.name = car.name;
    li.dataset.hp = String(hp);
    li.dataset.speed = String(topSpeed);
    li.dataset.mass = String(car.mass);
    li.append(label, numberCell(`${hp}`), numberCell(`${topSpeed} km/h`), numberCell(`${car.mass} kg`), routeSelectForCar);
    carsList.appendChild(li);

    carRouteAssignment.set(car.id, initialRouteSlug);
    carRows.set(car.id, { checkbox, routeSelect: routeSelectForCar });
  }

  // Column sorting: click a header to sort by that stat, click again to flip
  // direction. Numeric columns start descending (biggest first — that's what
  // a "sort by hp" click is asking for); the name column starts ascending.
  // Sorting reorders the existing <li> nodes, so checkbox state, route picks
  // and search-hiding all travel with their rows.
  type SortKey = 'name' | 'hp' | 'speed' | 'mass';
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

  // F2: roster is data now, so it can grow past a glance-able list — search
  // narrows it, select all/none avoids clicking each checkbox individually.
  const carSearchInput = panelContainer.querySelector<HTMLInputElement>('.config-car-search')!;
  carSearchInput.addEventListener('input', () => {
    const query = carSearchInput.value.trim().toLowerCase();
    carsList.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
      li.hidden = query.length > 0 && !li.dataset.searchText!.includes(query);
    });
  });

  panelContainer.querySelectorAll<HTMLButtonElement>('.config-cars-toolbar [data-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const checkAll = btn.dataset.select === 'all';
      carsList.querySelectorAll<HTMLInputElement>('li:not([hidden]) input[type="checkbox"]').forEach((cb) => {
        cb.checked = checkAll;
      });
    });
  });

  store.subscribe(rebuildRouteSelects);
  rebuildRouteSelects();

  const globalCapCheckbox = panelContainer.querySelector<HTMLInputElement>('.config-global-cap')!;
  const weatherSelect = panelContainer.querySelector<HTMLSelectElement>('.config-weather')!;
  const errorEl = panelContainer.querySelector<HTMLElement>('.config-error')!;

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
      const checked = checkedCarIds();
      if (checked.length < MIN_CARS) {
        errorEl.textContent = `Pick at least ${MIN_CARS} cars.`;
        errorEl.hidden = false;
        return;
      }
      const entries = store.entries();
      if (entries.length === 0) {
        errorEl.textContent = 'No routes exist — create one in the Routes panel first.';
        errorEl.hidden = false;
        return;
      }
      const validSlugs = new Set(entries.map((e) => e.slug));
      const fallbackSlug = entries[0]!.slug;
      callbacks.onApply({
        carAssignments: checked.map((carId) => {
          const assigned = carRouteAssignment.get(carId);
          return {
            carId,
            routeSlug: assigned !== undefined && validSlugs.has(assigned) ? assigned : fallbackSlug,
          };
        }),
        globalCapEnabled: globalCapCheckbox.checked,
        weather: weatherSelect.value as Weather,
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
      errorEl.textContent = message;
      errorEl.hidden = false;
    },
  };
}
