import { DiffEvent, SOURCE } from './diff';
import { localDateStr, localMinuteStamp, msToMinutes, toIso } from './dates';
import { dueOf, openTasksForDay, ProjectNames, projectNameOf, SpTask } from './tasks';

export const taskEntityId = (taskId: string): string => `task_sp-${taskId}`;

// ---------------------------------------------------------------- task=completed

export const mapTaskCompleted = (
  task: SpTask,
  projectName: string | null,
  now: number,
): DiffEvent => ({
  entityId: taskEntityId(task.id),
  event: 'task=completed',
  valueBefore: { status: 'open' },
  valueAfter: {
    status: 'done',
    date: localDateStr(typeof task.doneOn === 'number' ? task.doneOn : now),
    title: task.title,
    time_spent_minutes: msToMinutes(task.timeSpent),
    time_estimate_minutes: msToMinutes(task.timeEstimate),
    project: projectName,
    source: SOURCE,
  },
});

/** Dedupe key for one completion: the task plus its doneOn (or the day). */
export const completionKey = (task: SpTask, now: number): string =>
  `${task.id}|${typeof task.doneOn === 'number' ? task.doneOn : localDateStr(now)}`;

/**
 * Session-scoped "emit once" set. taskComplete fires for every updateTask with
 * isDone:true, so re-saving an already-done task must not emit a second diff;
 * un-doing and re-completing it produces a new doneOn and therefore a new key.
 */
export class OnceSet {
  private readonly _seen = new Set<string>();

  constructor(private readonly _maxSize = 2000) {}

  /** True the first time `key` is seen, false afterwards. */
  claim(key: string): boolean {
    if (this._seen.has(key)) {
      return false;
    }
    if (this._seen.size >= this._maxSize) {
      // Drop the oldest entry (Set preserves insertion order).
      const oldest = this._seen.values().next().value;
      if (oldest !== undefined) {
        this._seen.delete(oldest);
      }
    }
    this._seen.add(key);
    return true;
  }

  /** Forget a key, e.g. when the emit failed and a retry should be allowed. */
  release(key: string): void {
    this._seen.delete(key);
  }
}

// ---------------------------------------------------------------- task=handed_off

export const HANDOFF_NOTES_MAX = 4000;

export const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

export const mapTaskHandedOff = (
  task: SpTask,
  projectName: string | null,
): DiffEvent => ({
  entityId: taskEntityId(task.id),
  event: 'task=handed_off',
  valueBefore: null,
  valueAfter: {
    sp_task_id: task.id,
    title: task.title,
    notes: task.notes ? truncate(task.notes, HANDOFF_NOTES_MAX) : null,
    time_estimate_minutes: msToMinutes(task.timeEstimate),
    time_spent_minutes: msToMinutes(task.timeSpent),
    project: projectName,
    due: dueOf(task),
    source: SOURCE,
  },
});

// ---------------------------------------------------------------- plan=requested

export const DEFAULT_AVAILABLE_MINUTES = 360;

/** Coerce user input to whole minutes in 1..1440, falling back to the default. */
export const normalizeAvailableMinutes = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_AVAILABLE_MINUTES;
  }
  return Math.min(1440, Math.max(1, Math.round(n)));
};

export const mapPlanRequested = (
  day: string,
  availableMinutes: unknown,
  allTasks: readonly SpTask[],
  projectNames: ProjectNames,
): DiffEvent => ({
  entityId: `plan_${day}`,
  event: 'plan=requested',
  valueBefore: null,
  valueAfter: {
    date: day,
    available_minutes: normalizeAvailableMinutes(availableMinutes),
    tasks: openTasksForDay(allTasks, day).map((t) => ({
      sp_task_id: t.id,
      title: t.title,
      time_estimate_minutes: msToMinutes(t.timeEstimate),
      time_spent_minutes: msToMinutes(t.timeSpent),
      due: dueOf(t),
      project: projectNameOf(t, projectNames),
    })),
  },
});

// ---------------------------------------------------------------- focus=completed

export type FocusMode = 'pomodoro' | 'flowtime' | 'countdown';

export interface FocusCompletion {
  mode: FocusMode;
  durationMs: number;
  plannedMs: number | null;
  taskId: string | null;
  startedAt: number;
}

export const mapFocusCompleted = (
  c: FocusCompletion,
  task: { id: string; title: string } | null,
): DiffEvent => ({
  entityId: `focus_${localMinuteStamp(c.startedAt)}`,
  event: 'focus=completed',
  valueBefore: null,
  valueAfter: {
    mode: c.mode,
    minutes: msToMinutes(c.durationMs),
    planned_minutes: c.plannedMs && c.plannedMs > 0 ? msToMinutes(c.plannedMs) : null,
    task: task ? { sp_task_id: task.id, title: task.title } : null,
    started_at: toIso(c.startedAt),
    source: SOURCE,
  },
});

// ---------------------------------------------------------------- day=finished

/** The fields of SP's MetricCopy (features/metric/metric.model.ts) we read. */
export interface DayMetric {
  id?: string;
  focusSessions?: number[];
  impactOfWork?: number | null;
  energyCheckin?: number | null;
  reflections?: { text: string; created?: number }[];
  totalWorkMinutes?: number | null;
  completedTasks?: number | null;
  plannedTasks?: number | null;
}

const intInRange = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

const nonNegInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

export const mapDayFinished = (
  day: string,
  metric: DayMetric | undefined,
  stats: { planned: number; completed: number; totalWorkMinutes: number } | null,
): DiffEvent => {
  const sessions = metric
    ? (metric.focusSessions ?? []).filter((ms) => typeof ms === 'number' && ms > 0)
    : null;
  const reflections = metric
    ? (metric.reflections ?? [])
        .map((r) => (typeof r?.text === 'string' ? r.text.trim() : ''))
        .filter((t) => t.length > 0)
    : null;
  return {
    entityId: `day_${day}`,
    event: 'day=finished',
    valueBefore: null,
    valueAfter: {
      date: day,
      focus_sessions_minutes: sessions ? sessions.map((ms) => msToMinutes(ms)) : null,
      focus_minutes_total: sessions
        ? msToMinutes(sessions.reduce((acc, ms) => acc + ms, 0))
        : null,
      impact_of_work: intInRange(metric?.impactOfWork, 1, 4),
      energy_checkin: intInRange(metric?.energyCheckin, 1, 3),
      reflections,
      planned_tasks: nonNegInt(metric?.plannedTasks) ?? stats?.planned ?? null,
      completed_tasks: nonNegInt(metric?.completedTasks) ?? stats?.completed ?? null,
      total_work_minutes:
        nonNegInt(metric?.totalWorkMinutes) ?? stats?.totalWorkMinutes ?? null,
      source: SOURCE,
    },
  };
};
