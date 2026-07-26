import type { RouteIndexEntry } from '../types';
import type { RouteStore } from './route-store';

const AUTOCOMPLETE_DEBOUNCE_MS = 400;

interface PlaceSuggestion {
  label: string;
  lon: number;
  lat: number;
}

interface BakeResponse {
  entries: RouteIndexEntry[];
  warnings: string[];
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

interface AutocompleteHandle {
  /** The coordinate of the suggestion the user actually clicked, or null if
   * they haven't picked one (or have typed since picking one). */
  getPickedCoord(): { lon: number; lat: number } | null;
}

/** Wires a text input to live Nominatim-backed suggestions (proxied through
 * the dev-server API — the browser can't call Nominatim directly and stay
 * policy-compliant, since it can't set a custom User-Agent). */
function setupAutocomplete(input: HTMLInputElement, list: HTMLUListElement): AutocompleteHandle {
  let pickedCoord: { lon: number; lat: number } | null = null;
  let inFlight: AbortController | null = null;

  function renderSuggestions(results: PlaceSuggestion[]): void {
    list.innerHTML = '';
    for (const r of results) {
      const li = document.createElement('li');
      li.textContent = r.label; // never innerHTML: labels are external (Nominatim) data
      li.dataset.lon = String(r.lon);
      li.dataset.lat = String(r.lat);
      list.appendChild(li);
    }
    list.hidden = results.length === 0;
  }

  const fetchSuggestions = debounce(async (query: string) => {
    // Abort whatever's still in flight before starting or skipping a new
    // request — otherwise a stale response arriving later (out-of-order, or
    // after the query shrank below the 3-char floor) can repopulate/reshow
    // the list after it was meant to be cleared or hidden.
    inFlight?.abort();
    if (query.trim().length < 3) {
      list.hidden = true;
      list.innerHTML = '';
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    try {
      const res = await fetch(`/api/routes/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      const results = (await res.json()) as PlaceSuggestion[];
      renderSuggestions(results);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      list.hidden = true;
    }
  }, AUTOCOMPLETE_DEBOUNCE_MS);

  input.addEventListener('input', () => {
    pickedCoord = null; // typing invalidates a previously picked suggestion
    fetchSuggestions(input.value);
  });

  // mousedown (not click) fires before the input's blur event, so a
  // suggestion can be selected before blur would otherwise hide the list.
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (!li) return;
    e.preventDefault();
    input.value = li.textContent ?? ''; // programmatic — does not fire 'input', so pickedCoord survives
    pickedCoord = { lon: Number(li.dataset.lon), lat: Number(li.dataset.lat) };
    list.hidden = true;
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      list.hidden = true;
    }, 150);
  });

  return { getPickedCoord: () => pickedCoord };
}

/** The Routes panel: create and delete courses. Every change goes straight
 * to the dev API (files on disk) and then into the shared store, so the
 * Cars panel's per-car route pickers update the moment a course appears or
 * disappears — no Apply step here. */
export function initRoutesPanel(triggerButton: HTMLElement, panelContainer: HTMLElement, store: RouteStore): void {
  panelContainer.innerHTML = `
    <div class="config-backdrop"></div>
    <div class="config-modal routes-modal" role="dialog" aria-modal="true" aria-label="Manage routes">
      <header class="config-header">
        <h3>Routes</h3>
        <button type="button" class="config-close" aria-label="Close">&times;</button>
      </header>
      <div class="config-body routes-body">
        <section class="config-section">
          <h4>Courses <span class="config-hint">— every road here is pickable per car in Configure Race</span></h4>
          <ul class="routes-course-list"></ul>
          <p class="routes-delete-status" hidden></p>
        </section>

        <section class="config-section config-new-course">
          <h4>New course</h4>
          <p class="config-new-course-intro">
            Any two places with a road between them — traced from OpenStreetMap.
          </p>
          <div class="autocomplete-field">
            <label>From</label>
            <input type="text" class="config-origin-input" placeholder="e.g. Curitiba, PR" autocomplete="off" />
            <ul class="autocomplete-suggestions" hidden></ul>
          </div>
          <div class="autocomplete-field">
            <label>To</label>
            <input type="text" class="config-dest-input" placeholder="e.g. Florianópolis, SC" autocomplete="off" />
            <ul class="autocomplete-suggestions" hidden></ul>
          </div>
          <label class="config-checkbox">
            <input type="checkbox" class="config-bake-alternatives" checked />
            <span class="config-checkbox-text">Find alternate roads too
              <span class="config-hint">— up to 3 routes, so cars can split between them</span></span>
          </label>
          <button type="button" class="config-bake-button">Create course</button>
          <p class="config-bake-status" hidden></p>
        </section>
      </div>
    </div>`;

  const backdrop = panelContainer.querySelector<HTMLElement>('.config-backdrop')!;
  const closeButton = panelContainer.querySelector<HTMLButtonElement>('.config-close')!;
  const courseList = panelContainer.querySelector<HTMLUListElement>('.routes-course-list')!;
  const deleteStatus = panelContainer.querySelector<HTMLElement>('.routes-delete-status')!;
  const originInput = panelContainer.querySelector<HTMLInputElement>('.config-origin-input')!;
  const destInput = panelContainer.querySelector<HTMLInputElement>('.config-dest-input')!;
  const alternativesCheckbox = panelContainer.querySelector<HTMLInputElement>('.config-bake-alternatives')!;
  const [originSuggestions, destSuggestions] =
    panelContainer.querySelectorAll<HTMLUListElement>('.autocomplete-suggestions');
  const bakeButton = panelContainer.querySelector<HTMLButtonElement>('.config-bake-button')!;
  const bakeStatus = panelContainer.querySelector<HTMLElement>('.config-bake-status')!;

  const originAutocomplete = setupAutocomplete(originInput, originSuggestions!);
  const destAutocomplete = setupAutocomplete(destInput, destSuggestions!);

  // At most one delete in flight — the buttons all disable together, so the
  // last-course guard can't be raced from the UI.
  let deleting = false;

  function setDeleteStatus(message: string, isError: boolean): void {
    deleteStatus.textContent = message;
    deleteStatus.classList.toggle('config-bake-status-error', isError);
    deleteStatus.hidden = message.length === 0;
  }

  // Course names embed user-typed origin/destination text (from the bake
  // flow) — build rows via textContent, never innerHTML (B7).
  function renderCourseList(): void {
    const courses = store.courses();
    courseList.innerHTML = '';
    for (const [courseId, variants] of courses) {
      const name = document.createElement('span');
      name.className = 'routes-course-name';
      name.textContent = variants[0]!.name;

      const meta = document.createElement('span');
      meta.className = 'routes-course-meta';
      meta.textContent = variants
        .map((v) => `${v.variantLabel}: ${v.distanceKm} km · ↑ ${v.elevationGainM} m`)
        .join('  ·  ');

      const textDiv = document.createElement('div');
      textDiv.className = 'routes-course-text';
      textDiv.append(name, meta);

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'routes-course-rename';
      renameButton.textContent = '✎';
      renameButton.title = `Rename ${variants[0]!.name}`;
      renameButton.setAttribute('aria-label', `Rename ${variants[0]!.name}`);
      renameButton.addEventListener('click', () => {
        startRename(courseId, name, variants[0]!.name);
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'routes-course-delete';
      deleteButton.textContent = 'Delete';
      const lastCourse = courses.size <= 1;
      deleteButton.disabled = lastCourse || deleting;
      deleteButton.title = lastCourse ? 'At least one course must remain.' : `Delete ${variants[0]!.name}`;
      deleteButton.addEventListener('click', () => {
        void deleteCourse(courseId, variants[0]!.name);
      });

      const li = document.createElement('li');
      li.append(textDiv, renameButton, deleteButton);
      courseList.appendChild(li);
    }
  }

  /** Swaps the course's name span for an inline text input. Enter or blur
   * commits, Escape cancels; an unchanged or empty name is a cancel too. */
  function startRename(courseId: string, nameSpan: HTMLElement, currentName: string): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'routes-course-rename-input';
    input.value = currentName;
    input.maxLength = 120;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    function finish(commit: boolean): void {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      if (!commit || newName.length === 0 || newName === currentName) {
        renderCourseList(); // restores the plain name span
        return;
      }
      void renameCourse(courseId, newName);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        // Would otherwise bubble to the document listener and close the
        // whole panel instead of just cancelling the rename.
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function renameCourse(courseId: string, name: string): Promise<void> {
    try {
      const res = await fetch(`/api/routes/courses/${encodeURIComponent(courseId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json()) as { name: string } | { error: string };
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : 'Rename failed.');
      }
      setDeleteStatus('', false);
      store.renameCourse(courseId, name); // notifies subscribers — including this panel's own re-render
    } catch (err) {
      setDeleteStatus(err instanceof Error ? err.message : 'Rename failed.', true);
      renderCourseList();
    }
  }

  async function deleteCourse(courseId: string, name: string): Promise<void> {
    if (deleting) return;
    if (!window.confirm(`Delete "${name}" and its route file(s)? This cannot be undone.`)) return;
    deleting = true;
    renderCourseList(); // repaint with every delete button disabled
    try {
      const res = await fetch(`/api/routes/courses/${encodeURIComponent(courseId)}`, { method: 'DELETE' });
      const body = (await res.json()) as { removedSlugs: string[] } | { error: string };
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : 'Deletion failed.');
      }
      setDeleteStatus(`Deleted ${name}.`, false);
      deleting = false;
      store.removeCourse(courseId); // notifies subscribers — including this panel's own re-render
    } catch (err) {
      deleting = false;
      setDeleteStatus(err instanceof Error ? err.message : 'Deletion failed.', true);
      renderCourseList();
    }
  }

  function setBakeStatus(message: string, isError: boolean): void {
    bakeStatus.textContent = message;
    bakeStatus.classList.toggle('config-bake-status-error', isError);
    bakeStatus.hidden = false;
  }

  function setBakeBusy(busy: boolean): void {
    bakeButton.disabled = busy;
    bakeButton.textContent = busy ? 'Creating…' : 'Create course';
    originInput.disabled = busy;
    destInput.disabled = busy;
    alternativesCheckbox.disabled = busy;
  }

  bakeButton.addEventListener('click', () => {
    const from = originInput.value.trim();
    const to = destInput.value.trim();
    if (!from || !to) {
      setBakeStatus('Enter both a starting place and a destination.', true);
      return;
    }

    setBakeBusy(true);
    const alternatives = alternativesCheckbox.checked;
    setBakeStatus(
      `Tracing ${from} → ${to}… elevation sampling takes a minute or two${alternatives ? ' per road found' : ''}.`,
      false,
    );

    // If the user picked a suggestion (and hasn't typed since), send its
    // coordinates so the bake skips re-geocoding free text — faster, and
    // guaranteed to bake the place actually clicked (B6).
    const fromCoord = originAutocomplete.getPickedCoord() ?? undefined;
    const toCoord = destAutocomplete.getPickedCoord() ?? undefined;

    fetch('/api/routes/bake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, fromCoord, toCoord, alternatives }),
    })
      .then(async (res) => {
        const body = (await res.json()) as BakeResponse | { error: string };
        if (!res.ok || 'error' in body) {
          throw new Error('error' in body ? body.error : 'Course creation failed.');
        }
        if (body.entries.length === 0) throw new Error('No usable road found between those places.');

        store.addCourse(body.entries);

        const warningNote = body.warnings.length > 0 ? ` (${body.warnings.join(' ')})` : '';
        const variantNote =
          body.entries.length > 1
            ? ` with ${body.entries.length} routes`
            : alternatives
              ? ' — only one road exists between these places'
              : '';
        setBakeStatus(
          `Created: ${body.entries[0]!.name}, ${body.entries[0]!.distanceKm} km${variantNote}.${warningNote}`,
          false,
        );
        originInput.value = '';
        destInput.value = '';
      })
      .catch((err: unknown) => {
        setBakeStatus(err instanceof Error ? err.message : 'Course creation failed.', true);
      })
      .finally(() => setBakeBusy(false));
  });

  store.subscribe(renderCourseList);
  renderCourseList();

  function open(): void {
    panelContainer.hidden = false;
    setDeleteStatus('', false);
  }

  function close(): void {
    panelContainer.hidden = true;
  }

  triggerButton.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panelContainer.hidden) close();
  });
}
