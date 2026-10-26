import { DayMetric } from './mappers';
import { ACTION, NgrxAction } from './ngrx-actions';

const KEEP_DAYS = 3;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const pickMetric = (src: Record<string, unknown>): DayMetric => {
  const m: DayMetric = {};
  if (Array.isArray(src.focusSessions)) {
    m.focusSessions = src.focusSessions.filter((n): n is number => typeof n === 'number');
  }
  if ('impactOfWork' in src) m.impactOfWork = src.impactOfWork as number | null;
  if ('energyCheckin' in src) m.energyCheckin = src.energyCheckin as number | null;
  if (Array.isArray(src.reflections)) {
    m.reflections = src.reflections
      .filter(isObj)
      .map((r) => ({ text: String(r.text ?? ''), created: r.created as number }));
  }
  if ('totalWorkMinutes' in src) {
    m.totalWorkMinutes = src.totalWorkMinutes as number | null;
  }
  if ('completedTasks' in src) m.completedTasks = src.completedTasks as number | null;
  if ('plannedTasks' in src) m.plannedTasks = src.plannedTasks as number | null;
  return m;
};

/**
 * Mirror of the host's per-day metric records, rebuilt from `[Metric] *`
 * actions seen through the `action` hook (the finishDay hook only carries
 * `{ date }` and plugins cannot read the metric store). Mirrors the reducer:
 * upsert/add replace the day, update merges, log-focus-session appends.
 *
 * Limitation: a day's values set before the plugin loaded (and not in the
 * persisted snapshot) are unknown until the next upsert — the daily summary's
 * evaluation/reflection inputs upsert the FULL record, which fixes that.
 */
export class MetricCache {
  private _days = new Map<string, DayMetric>();

  get(day: string): DayMetric | undefined {
    return this._days.get(day);
  }

  /** Apply one NgRx action. Returns true when the cache changed. */
  apply(action: NgrxAction): boolean {
    switch (action.type) {
      case ACTION.METRIC_ADD:
      case ACTION.METRIC_UPSERT: {
        const metric = action.metric;
        if (!isObj(metric) || typeof metric.id !== 'string') return false;
        this._set(metric.id, pickMetric(metric));
        return true;
      }
      case ACTION.METRIC_UPDATE: {
        const upd = action.metric;
        if (!isObj(upd) || typeof upd.id !== 'string' || !isObj(upd.changes)) {
          return false;
        }
        this._set(upd.id, {
          ...(this._days.get(upd.id) ?? {}),
          ...pickMetric(upd.changes),
        });
        return true;
      }
      case ACTION.METRIC_DELETE: {
        return typeof action.id === 'string' && this._days.delete(action.id);
      }
      case ACTION.METRIC_LOG_FOCUS_SESSION: {
        const { day, duration } = action;
        if (typeof day !== 'string' || typeof duration !== 'number') return false;
        const existing = this._days.get(day) ?? {};
        this._set(day, {
          ...existing,
          focusSessions: [...(existing.focusSessions ?? []), duration],
        });
        return true;
      }
      default:
        return false;
    }
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this._days));
  }

  /** Merge a persisted snapshot UNDER what this session already saw. */
  hydrate(serialized: string | null): void {
    if (!serialized) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return;
    }
    if (!isObj(parsed)) return;
    for (const [day, metric] of Object.entries(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && isObj(metric) && !this._days.has(day)) {
        this._days.set(day, pickMetric(metric));
      }
    }
    this._prune();
  }

  private _set(day: string, metric: DayMetric): void {
    this._days.set(day, metric);
    this._prune();
  }

  private _prune(): void {
    const days = [...this._days.keys()].sort();
    while (days.length > KEEP_DAYS) {
      this._days.delete(days.shift() as string);
    }
  }
}
