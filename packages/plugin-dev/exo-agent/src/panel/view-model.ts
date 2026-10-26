/**
 * Pure, defensive view models for server-written diffs whose value_after shape
 * is not under this plugin's control (plan=proposed, task=agent_completed).
 * Panel-only: must not import runtime code from ../core (see core/messages.ts).
 */
import type { DiffRow } from '../core/diff';

export interface PlanQueueItem {
  title: string;
  minutes: number | null;
  start: string | null;
  note: string | null;
}

export interface PlanView {
  date: string | null;
  texts: { label: string; text: string }[];
  queue: PlanQueueItem[];
  flags: string[];
  extras: { label: string; value: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const firstStr = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) {
    const s = str(o[k]);
    if (s) return s;
  }
  return null;
};

const firstNum = (o: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) return n;
  }
  return null;
};

const humanize = (key: string): string => {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const TEXT_KEYS = [
  'summary',
  'recommendation',
  'reasoning',
  'rationale',
  'message',
  'notes',
  'note',
] as const;
const QUEUE_KEYS = [
  'queue',
  'tasks',
  'plan',
  'order',
  'schedule',
  'items',
  'blocks',
] as const;
const FLAG_KEYS = ['drift', 'drift_flags', 'flags', 'warnings', 'risks'] as const;
const ITEM_TITLE_KEYS = [
  'title',
  'name',
  'task_title',
  'label',
  'sp_task_id',
  'id',
] as const;
const ITEM_MINUTES_KEYS = [
  'minutes',
  'planned_minutes',
  'time_estimate_minutes',
  'estimate_minutes',
  'duration_minutes',
  'duration',
] as const;
const ITEM_START_KEYS = ['start', 'start_time', 'starts_at', 'at', 'time'] as const;
const ITEM_NOTE_KEYS = ['reason', 'reasoning', 'note', 'why', 'recommendation'] as const;

const toQueueItem = (item: unknown): PlanQueueItem | null => {
  if (typeof item === 'string') {
    return item.trim()
      ? { title: item.trim(), minutes: null, start: null, note: null }
      : null;
  }
  if (!isObj(item)) return null;
  const nested = isObj(item.task) ? item.task : null;
  const title =
    firstStr(item, ITEM_TITLE_KEYS) ??
    (nested ? firstStr(nested, ITEM_TITLE_KEYS) : null) ??
    '(untitled)';
  return {
    title,
    minutes:
      firstNum(item, ITEM_MINUTES_KEYS) ??
      (nested ? firstNum(nested, ITEM_MINUTES_KEYS) : null),
    start: firstStr(item, ITEM_START_KEYS),
    note: firstStr(item, ITEM_NOTE_KEYS),
  };
};

const toFlag = (f: unknown): string | null => {
  if (typeof f === 'string') return str(f);
  if (!isObj(f)) return null;
  const title = firstStr(f, ['title', 'task', 'name', 'sp_task_id']);
  const msg = firstStr(f, ['message', 'flag', 'reason', 'detail', 'note', 'type']);
  if (title && msg) return `${title}: ${msg}`;
  return title ?? msg ?? JSON.stringify(f).slice(0, 200);
};

export const toPlanView = (valueAfter: unknown): PlanView => {
  const view: PlanView = { date: null, texts: [], queue: [], flags: [], extras: [] };
  if (typeof valueAfter === 'string') {
    if (valueAfter.trim()) view.texts.push({ label: 'Plan', text: valueAfter.trim() });
    return view;
  }
  if (Array.isArray(valueAfter)) {
    view.queue = valueAfter.map(toQueueItem).filter((q): q is PlanQueueItem => !!q);
    return view;
  }
  if (!isObj(valueAfter)) return view;

  const used = new Set<string>(['date', 'source']);
  view.date = str(valueAfter.date);

  for (const k of TEXT_KEYS) {
    const s = str(valueAfter[k]);
    if (s) {
      view.texts.push({ label: humanize(k), text: s });
      used.add(k);
    }
  }
  for (const k of QUEUE_KEYS) {
    const v = valueAfter[k];
    if (Array.isArray(v)) {
      view.queue = v.map(toQueueItem).filter((q): q is PlanQueueItem => !!q);
      used.add(k);
      break;
    }
  }
  for (const k of FLAG_KEYS) {
    const v = valueAfter[k];
    if (Array.isArray(v)) {
      view.flags.push(...v.map(toFlag).filter((f): f is string => !!f));
      used.add(k);
    } else if (str(v)) {
      view.flags.push(str(v) as string);
      used.add(k);
    }
  }
  for (const [k, v] of Object.entries(valueAfter)) {
    if (used.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      view.extras.push({ label: humanize(k), value: String(v) });
    }
  }
  return view;
};

export interface HandoffView {
  title: string;
  status: string | null;
  text: string | null;
  createdAt: string | null;
}

export const toHandoffView = (row: DiffRow): HandoffView => {
  const va = isObj(row.value_after) ? row.value_after : {};
  const nested = [va.task, va.original_task, va.source_task].find(isObj) as
    | Record<string, unknown>
    | undefined;
  const title =
    firstStr(va, ['title', 'task_title']) ??
    (nested ? firstStr(nested, ['title', 'name']) : null) ??
    firstStr(va, ['sp_task_id']) ??
    row.entity_id ??
    '(unknown task)';
  return {
    title,
    status: firstStr(va, ['status', 'outcome', 'result_status', 'state']),
    text: firstStr(va, [
      'recommendation',
      'reasoning',
      'summary',
      'result',
      'output',
      'answer',
      'message',
      'notes',
    ]),
    createdAt: str(row.created_at),
  };
};

/** "1h 05m" / "45m" for minute counts. */
export const formatMinutes = (minutes: number): string => {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
