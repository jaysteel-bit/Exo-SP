import { describe, expect, it } from 'vitest';
import { buildEmitDiffBody, EMITTABLE_EVENTS, EmittableEvent } from './diff';
import {
  completionKey,
  DEFAULT_AVAILABLE_MINUTES,
  HANDOFF_NOTES_MAX,
  mapDayFinished,
  mapFocusCompleted,
  mapPlanRequested,
  mapTaskCompleted,
  mapTaskHandedOff,
  normalizeAvailableMinutes,
  OnceSet,
} from './mappers';
import { SpTask, toProjectNames } from './tasks';

const at = (h: number, m = 0, day = 26): number => new Date(2026, 9, day, h, m).getTime();
const MIN = 60_000;

const task = (over: Partial<SpTask> = {}): SpTask => ({
  id: 't1',
  title: 'Write proposal',
  timeEstimate: 90 * MIN,
  timeSpent: 47 * MIN + 20_000,
  isDone: true,
  projectId: 'p1',
  doneOn: at(15, 30),
  ...over,
});

describe('mapTaskCompleted', () => {
  it('maps a done task to task=completed', () => {
    const ev = mapTaskCompleted(task(), 'Exo', at(16));
    expect(ev).toEqual({
      entityId: 'task_sp-t1',
      event: 'task=completed',
      valueBefore: { status: 'open' },
      valueAfter: {
        status: 'done',
        date: '2026-10-26',
        title: 'Write proposal',
        time_spent_minutes: 47,
        time_estimate_minutes: 90,
        project: 'Exo',
        source: 'super-productivity',
      },
    });
  });

  it('falls back to now for the date and null project / 0 minutes', () => {
    const ev = mapTaskCompleted(
      task({ doneOn: null, timeEstimate: 0, timeSpent: undefined }),
      null,
      at(23, 59, 25),
    );
    expect(ev.valueAfter).toMatchObject({
      date: '2026-10-25',
      time_spent_minutes: 0,
      time_estimate_minutes: 0,
      project: null,
    });
  });
});

describe('completion dedupe', () => {
  it('emits once per taskId + doneOn', () => {
    const once = new OnceSet();
    const now = at(16);
    expect(once.claim(completionKey(task(), now))).toBe(true);
    expect(once.claim(completionKey(task(), now))).toBe(false);
    // re-completed later -> new doneOn -> new completion
    expect(once.claim(completionKey(task({ doneOn: at(17) }), now))).toBe(true);
    // other task, same doneOn
    expect(once.claim(completionKey(task({ id: 't2' }), now))).toBe(true);
  });

  it('uses the day when doneOn is missing and can release a key', () => {
    const once = new OnceSet();
    const key = completionKey(task({ doneOn: undefined }), at(9));
    expect(key).toBe('t1|2026-10-26');
    expect(once.claim(key)).toBe(true);
    once.release(key);
    expect(once.claim(key)).toBe(true);
  });

  it('is bounded', () => {
    const once = new OnceSet(2);
    once.claim('a');
    once.claim('b');
    once.claim('c'); // evicts a
    expect(once.claim('a')).toBe(true);
    expect(once.claim('c')).toBe(false);
  });
});

describe('mapTaskHandedOff', () => {
  it('maps the task and truncates notes to 4000 chars', () => {
    const notes = 'x'.repeat(HANDOFF_NOTES_MAX + 50);
    const ev = mapTaskHandedOff(
      task({ notes, isDone: false, dueDay: '2026-10-27' }),
      'Exo',
    );
    expect(ev.entityId).toBe('task_sp-t1');
    expect(ev.event).toBe('task=handed_off');
    expect(ev.valueBefore).toBeNull();
    expect((ev.valueAfter.notes as string).length).toBe(HANDOFF_NOTES_MAX);
    expect(ev.valueAfter).toMatchObject({
      sp_task_id: 't1',
      title: 'Write proposal',
      time_estimate_minutes: 90,
      time_spent_minutes: 47,
      project: 'Exo',
      due: '2026-10-27',
      source: 'super-productivity',
    });
  });

  it('prefers dueWithTime (ISO) and null notes when empty', () => {
    const due = at(14);
    const ev = mapTaskHandedOff(
      task({ notes: '', dueWithTime: due, dueDay: '2026-10-01' }),
      null,
    );
    expect(ev.valueAfter.due).toBe(new Date(due).toISOString());
    expect(ev.valueAfter.notes).toBeNull();
  });
});

describe('mapPlanRequested', () => {
  const tasks: SpTask[] = [
    {
      id: 'a',
      title: 'Today open',
      dueDay: '2026-10-26',
      timeEstimate: 30 * MIN,
      projectId: 'p1',
    },
    { id: 'b', title: 'Today done', dueDay: '2026-10-26', isDone: true },
    { id: 'c', title: 'Tomorrow', dueDay: '2026-10-27' },
    { id: 'd', title: 'Timed today', dueWithTime: at(13) },
    { id: 'e', title: 'Sub of a', dueDay: '2026-10-26', parentId: 'a' },
    {
      id: 'f',
      title: 'Timed tomorrow, stale dueDay',
      dueWithTime: at(9, 0, 27),
      dueDay: '2026-10-26',
    },
  ];

  it('lists only open TODAY tasks', () => {
    const ev = mapPlanRequested(
      '2026-10-26',
      240,
      tasks,
      toProjectNames([{ id: 'p1', title: 'Exo' }]),
    );
    expect(ev.entityId).toBe('plan_2026-10-26');
    expect(ev.event).toBe('plan=requested');
    expect(ev.valueAfter.date).toBe('2026-10-26');
    expect(ev.valueAfter.available_minutes).toBe(240);
    const list = ev.valueAfter.tasks as { sp_task_id: string }[];
    expect(list.map((t) => t.sp_task_id)).toEqual(['a', 'd']);
    expect(list[0]).toEqual({
      sp_task_id: 'a',
      title: 'Today open',
      time_estimate_minutes: 30,
      time_spent_minutes: 0,
      due: '2026-10-26',
      project: 'Exo',
    });
  });

  it('normalizes available minutes', () => {
    expect(normalizeAvailableMinutes(undefined)).toBe(DEFAULT_AVAILABLE_MINUTES);
    expect(normalizeAvailableMinutes('abc')).toBe(360);
    expect(normalizeAvailableMinutes(-5)).toBe(360);
    expect(normalizeAvailableMinutes('120')).toBe(120);
    expect(normalizeAvailableMinutes(99999)).toBe(1440);
    expect(normalizeAvailableMinutes(44.6)).toBe(45);
  });
});

describe('mapFocusCompleted', () => {
  it('maps a completion with task and planned minutes', () => {
    const startedAt = at(9, 5);
    const ev = mapFocusCompleted(
      {
        mode: 'pomodoro',
        durationMs: 25 * MIN,
        plannedMs: 25 * MIN,
        taskId: 't1',
        startedAt,
      },
      { id: 't1', title: 'Write proposal' },
    );
    expect(ev).toEqual({
      entityId: 'focus_2026-10-26-0905',
      event: 'focus=completed',
      valueBefore: null,
      valueAfter: {
        mode: 'pomodoro',
        minutes: 25,
        planned_minutes: 25,
        task: { sp_task_id: 't1', title: 'Write proposal' },
        started_at: new Date(startedAt).toISOString(),
        source: 'super-productivity',
      },
    });
  });

  it('flowtime has no planned minutes; task may be null', () => {
    const ev = mapFocusCompleted(
      {
        mode: 'flowtime',
        durationMs: 52 * MIN + 31_000,
        plannedMs: null,
        taskId: null,
        startedAt: at(14, 0),
      },
      null,
    );
    expect(ev.valueAfter).toMatchObject({
      mode: 'flowtime',
      minutes: 53,
      planned_minutes: null,
      task: null,
    });
  });
});

describe('mapDayFinished', () => {
  it('maps the metric record', () => {
    const ev = mapDayFinished(
      '2026-10-26',
      {
        id: '2026-10-26',
        focusSessions: [25 * MIN, 25 * MIN, 50 * MIN + 20_000],
        impactOfWork: 3,
        energyCheckin: 2,
        reflections: [{ text: '  Shipped the plugin ', created: 1 }, { text: '   ' }],
      },
      { planned: 6, completed: 4, totalWorkMinutes: 312 },
    );
    expect(ev).toEqual({
      entityId: 'day_2026-10-26',
      event: 'day=finished',
      valueBefore: null,
      valueAfter: {
        date: '2026-10-26',
        focus_sessions_minutes: [25, 25, 50],
        focus_minutes_total: 100,
        impact_of_work: 3,
        energy_checkin: 2,
        reflections: ['Shipped the plugin'],
        planned_tasks: 6,
        completed_tasks: 4,
        total_work_minutes: 312,
        source: 'super-productivity',
      },
    });
  });

  it('prefers metric task counts when the host filled them; rejects out-of-range ratings', () => {
    const ev = mapDayFinished(
      '2026-10-26',
      {
        plannedTasks: 9,
        completedTasks: 7,
        totalWorkMinutes: 400,
        impactOfWork: 5,
        energyCheckin: 0,
      },
      { planned: 1, completed: 1, totalWorkMinutes: 1 },
    );
    expect(ev.valueAfter).toMatchObject({
      planned_tasks: 9,
      completed_tasks: 7,
      total_work_minutes: 400,
      impact_of_work: null,
      energy_checkin: null,
      focus_sessions_minutes: [],
      focus_minutes_total: 0,
      reflections: [],
    });
  });

  it('unknown metric -> null focus/rating/reflection fields; no stats -> null counts', () => {
    const ev = mapDayFinished('2026-10-26', undefined, null);
    expect(ev.valueAfter).toMatchObject({
      focus_sessions_minutes: null,
      focus_minutes_total: null,
      impact_of_work: null,
      energy_checkin: null,
      reflections: null,
      planned_tasks: null,
      completed_tasks: null,
      total_work_minutes: null,
    });
  });
});

describe('buildEmitDiffBody', () => {
  it('wraps a diff in the emit_diff RPC body', () => {
    const body = buildEmitDiffBody(mapTaskCompleted(task(), null, at(16)), '1.0.0');
    expect(body).toMatchObject({
      p_client_id: 'e0000000-0000-4000-8000-000000000001',
      p_namespace: 'ops',
      p_entity_id: 'task_sp-t1',
      p_event: 'task=completed',
      p_value_before: { status: 'open' },
      p_actor: 'app:super-productivity',
      p_metadata: { bridge: 'exo-agent', plugin_version: '1.0.0' },
    });
  });

  it('refuses events outside the vocabulary', () => {
    expect(EMITTABLE_EVENTS).not.toContain('plan=proposed');
    expect(() =>
      buildEmitDiffBody(
        {
          entityId: 'x',
          event: 'plan=proposed' as unknown as EmittableEvent,
          valueBefore: null,
          valueAfter: {},
        },
        '1',
      ),
    ).toThrow(/vocabulary/);
  });
});
