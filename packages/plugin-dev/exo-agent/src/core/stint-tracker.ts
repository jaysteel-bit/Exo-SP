import { DiffEvent, SOURCE } from './diff';
import { msToMinutes, toIso } from './dates';

export const MIN_STINT_MS = 60_000;

export interface StintTask {
  id: string;
  title: string;
}

interface Stint {
  task: StintTask;
  startedAt: number;
  startEmitted: boolean;
}

export const trackingEntityId = (taskId: string): string => `tracking_sp-${taskId}`;

const taskRef = (task: StintTask): Record<string, unknown> => ({
  sp_task_id: task.id,
  title: task.title,
});

export const mapTrackingStarted = (task: StintTask, startedAt: number): DiffEvent => ({
  entityId: trackingEntityId(task.id),
  event: 'tracking=started',
  valueBefore: null,
  valueAfter: { task: taskRef(task), started_at: toIso(startedAt), source: SOURCE },
});

export const mapTrackingStopped = (
  task: StintTask,
  startedAt: number,
  stoppedAt: number,
): DiffEvent => ({
  entityId: trackingEntityId(task.id),
  event: 'tracking=stopped',
  valueBefore: null,
  valueAfter: {
    task: taskRef(task),
    minutes: msToMinutes(stoppedAt - startedAt),
    started_at: toIso(startedAt),
    stopped_at: toIso(stoppedAt),
    source: SOURCE,
  },
});

/**
 * Turns currentTaskChange transitions into tracking diffs.
 *
 * Short stints are dropped entirely: `tracking=started` is BUFFERED until the
 * stint has lasted MIN_STINT_MS (the caller schedules `tick()` for
 * `startDueAt`), so a stint under one minute produces neither a start nor a
 * stop. If a stop arrives after the threshold but before the tick ran, the
 * start is emitted together with the stop, so the pair is always complete.
 *
 * A stop for a task whose start this tracker never saw (e.g. tracking was
 * already running when the plugin loaded) is skipped: its minutes are unknown.
 */
export class StintTracker {
  private _stint: Stint | null = null;

  constructor(private readonly _minMs = MIN_STINT_MS) {}

  get currentTaskId(): string | null {
    return this._stint?.task.id ?? null;
  }

  change(
    current: StintTask | null,
    previous: StintTask | null,
    now: number,
  ): { emits: DiffEvent[]; startDueAt: number | null } {
    const emits: DiffEvent[] = [];
    const stint = this._stint;

    if (stint && stint.task.id !== current?.id) {
      // Prefer the host's latest snapshot of the task (title may have changed).
      const task =
        previous && previous.id === stint.task.id
          ? { id: previous.id, title: previous.title }
          : stint.task;
      if (now - stint.startedAt >= this._minMs) {
        if (!stint.startEmitted) {
          emits.push(mapTrackingStarted(task, stint.startedAt));
        }
        emits.push(mapTrackingStopped(task, stint.startedAt, now));
      }
      this._stint = null;
    }

    if (current && this._stint?.task.id !== current.id) {
      this._stint = {
        task: { id: current.id, title: current.title },
        startedAt: now,
        startEmitted: false,
      };
      return { emits, startDueAt: now + this._minMs };
    }
    return { emits, startDueAt: null };
  }

  /** Emit the buffered start once the running stint reached the threshold. */
  tick(now: number): DiffEvent[] {
    const stint = this._stint;
    if (!stint || stint.startEmitted || now - stint.startedAt < this._minMs) {
      return [];
    }
    stint.startEmitted = true;
    return [mapTrackingStarted(stint.task, stint.startedAt)];
  }
}
