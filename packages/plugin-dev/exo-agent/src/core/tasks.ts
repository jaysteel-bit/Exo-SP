import { localDateStr, msToMinutes, toIso } from './dates';

/**
 * The subset of Super Productivity's `Task` this plugin reads. Kept structural
 * (all optional beyond id/title) so mapping functions are trivial to test and
 * tolerate older/newer host task shapes.
 */
export interface SpTask {
  id: string;
  title: string;
  notes?: string;
  timeEstimate?: number;
  timeSpent?: number;
  isDone?: boolean;
  projectId?: string | null;
  parentId?: string | null;
  subTaskIds?: string[];
  timeSpentOnDay?: { [day: string]: number };
  doneOn?: number | null;
  dueDay?: string | null;
  dueWithTime?: number | null;
}

export interface SpProject {
  id: string;
  title: string;
}

export type ProjectNames = ReadonlyMap<string, string>;

export const toProjectNames = (projects: readonly SpProject[]): ProjectNames =>
  new Map(projects.map((p) => [p.id, p.title]));

export const projectNameOf = (task: SpTask, names: ProjectNames): string | null =>
  (task.projectId && names.get(task.projectId)) || null;

/** `due` as a plain value: ISO timestamp when time-scheduled, else the due day. */
export const dueOf = (task: SpTask): string | null => {
  if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) {
    return toIso(task.dueWithTime);
  }
  return task.dueDay || null;
};

export const hasSubTasks = (task: SpTask): boolean =>
  Array.isArray(task.subTaskIds) && task.subTaskIds.length > 0;

/**
 * Mirrors SP's TODAY tag semantics (work-context.selectors
 * computeOrderedTaskIdsForToday): `dueWithTime` wins when set and must fall on
 * the day; otherwise `dueDay` must equal it. The host's "start of next day"
 * offset is not applied (not exposed to plugins).
 */
export const isScheduledForDay = (task: SpTask, day: string): boolean => {
  if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) {
    return localDateStr(task.dueWithTime) === day;
  }
  return task.dueDay === day;
};

/**
 * Tasks on the TODAY list for `day`: scheduled for that day, with subtasks
 * dropped when their parent is also listed (SP nests them under the parent).
 */
export const tasksForDay = (tasks: readonly SpTask[], day: string): SpTask[] => {
  const scheduled = tasks.filter((t) => isScheduledForDay(t, day));
  const ids = new Set(scheduled.map((t) => t.id));
  return scheduled.filter((t) => !t.parentId || !ids.has(t.parentId));
};

export const openTasksForDay = (tasks: readonly SpTask[], day: string): SpTask[] =>
  tasksForDay(tasks, day).filter((t) => !t.isDone);

export interface DayTaskStats {
  planned: number;
  completed: number;
  totalWorkMinutes: number;
}

/**
 * Task-derived day stats, used when the day's metric record does not carry
 * them (SP never fills metric.plannedTasks/completedTasks/totalWorkMinutes).
 *  - planned:   tasks on the TODAY list for the day (done or not)
 *  - completed: leaf tasks (no subtasks) whose doneOn falls on the day
 *  - totalWorkMinutes: sum of leaf tasks' timeSpentOnDay[day] (parents carry
 *    their subtasks' aggregate, so they are skipped to avoid double counting)
 */
export const computeDayTaskStats = (
  tasks: readonly SpTask[],
  day: string,
): DayTaskStats => {
  const leaves = tasks.filter((t) => !hasSubTasks(t));
  const completed = leaves.filter(
    (t) => t.isDone && typeof t.doneOn === 'number' && localDateStr(t.doneOn) === day,
  ).length;
  const workMs = leaves.reduce((acc, t) => acc + (t.timeSpentOnDay?.[day] ?? 0), 0);
  return {
    planned: tasksForDay(tasks, day).length,
    completed,
    totalWorkMinutes: msToMinutes(workMs),
  };
};

export interface DriftEntry {
  sp_task_id: string;
  title: string;
  spent_minutes: number;
  estimate_minutes: number;
  /** spent / estimate, e.g. 1.25 = 25 % over. */
  ratio: number;
  status: 'over' | 'near';
}

export const DRIFT_NEAR_RATIO = 0.8;

/**
 * Open tasks whose time spent exceeds their estimate ("over") or has used more
 * than 80 % of it ("near"), worst first. Parents with subtasks are skipped:
 * their numbers are aggregates of the subtasks, which are listed themselves.
 */
export const computeEstimateDrift = (tasks: readonly SpTask[]): DriftEntry[] =>
  tasks
    .filter(
      (t) =>
        !t.isDone &&
        !hasSubTasks(t) &&
        typeof t.timeEstimate === 'number' &&
        t.timeEstimate > 0,
    )
    .map((t) => {
      const estimate = t.timeEstimate as number;
      const spent = t.timeSpent ?? 0;
      const ratio = spent / estimate;
      return { t, spent, estimate, ratio };
    })
    .filter(({ ratio }) => ratio > DRIFT_NEAR_RATIO)
    .sort((a, b) => b.ratio - a.ratio)
    .map(({ t, spent, estimate, ratio }) => ({
      sp_task_id: t.id,
      title: t.title,
      spent_minutes: msToMinutes(spent),
      estimate_minutes: msToMinutes(estimate),
      ratio: Math.round(ratio * 100) / 100,
      status: ratio > 1 ? 'over' : 'near',
    }));
