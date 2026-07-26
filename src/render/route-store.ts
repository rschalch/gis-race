import type { RouteIndexEntry } from '../types';

/** Shared, mutable view of the route index. The Routes panel writes to it
 * (create/delete courses); the race-config panel subscribes so its per-car
 * route pickers always reflect what actually exists on disk. */
export interface RouteStore {
  entries(): RouteIndexEntry[];
  /** F1: courseId -> that course's variants, in baked order. */
  courses(): Map<string, RouteIndexEntry[]>;
  addCourse(variants: RouteIndexEntry[]): void;
  removeCourse(courseId: string): void;
  /** Display-name only — slugs and files are untouched. */
  renameCourse(courseId: string, name: string): void;
  subscribe(listener: () => void): void;
}

export function createRouteStore(initial: RouteIndexEntry[]): RouteStore {
  let entries = [...initial];
  const listeners: Array<() => void> = [];

  function notify(): void {
    for (const l of listeners) l();
  }

  return {
    entries: () => entries,
    courses() {
      const map = new Map<string, RouteIndexEntry[]>();
      for (const e of entries) {
        const variants = map.get(e.courseId);
        if (variants) variants.push(e);
        else map.set(e.courseId, [e]);
      }
      return map;
    },
    addCourse(variants) {
      if (variants.length === 0) return;
      // Re-baking an existing course id replaces it rather than duplicating.
      entries = [...entries.filter((e) => e.courseId !== variants[0]!.courseId), ...variants];
      notify();
    },
    removeCourse(courseId) {
      entries = entries.filter((e) => e.courseId !== courseId);
      notify();
    },
    renameCourse(courseId, name) {
      entries = entries.map((e) => (e.courseId === courseId ? { ...e, name } : e));
      notify();
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
