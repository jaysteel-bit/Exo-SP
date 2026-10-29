import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExoAgent, HostApi, KEEP_SAVED_KEY, MSG, PLAN_POLL_TIMEOUT_MS } from './agent';
import { ACTION } from './ngrx-actions';
import { SpTask } from './tasks';

const MIN = 60_000;
const URL_OK = 'https://jdjyiyeddpfzpgrqffav.supabase.co';
const T0 = new Date(2026, 9, 26, 9, 0).getTime();

const setup = (
  opts: {
    anonKey?: string;
    tasks?: SpTask[];
    stored?: Record<string, string>;
    /** Row security hides what this connection writes (anon key after tenant mapping). */
    unreadable?: boolean;
  } = {},
) => {
  const clock = { now: T0 };
  const timers: { fn: () => void; ms: number }[] = [];
  let nextId = 100;
  const request = vi.fn<(url: string, options?: unknown) => Promise<unknown>>(
    async (url) => {
      if (url.endsWith('/rpc/emit_diff')) return nextId++;
      const readBack = /[?&]id=eq\.(\d+)/.exec(url);
      if (readBack && !opts.unreadable) return [{ id: Number(readBack[1]) }];
      return [];
    },
  );
  const api = {
    getTasks: vi.fn(async () => opts.tasks ?? []),
    getAllProjects: vi.fn(async () => [{ id: 'p1', title: 'Exo' }]),
    showSnack: vi.fn<HostApi['showSnack']>(),
    persistDataSynced: vi.fn<HostApi['persistDataSynced']>(async () => undefined),
    loadSyncedData: vi.fn(async (key?: string) => opts.stored?.[key ?? ''] ?? null),
    request,
    log: { info: vi.fn(), warn: vi.fn(), err: vi.fn() },
  } satisfies HostApi;
  const agent = new ExoAgent(api, {
    build: { url: URL_OK, anonKey: opts.anonKey ?? 'k' },
    pluginVersion: '1.0.0',
    initialFocusMode: null,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const emitted = (): {
    event: string;
    entity: string;
    after: Record<string, unknown>;
  }[] =>
    request.mock.calls
      .filter(([url]) => String(url).endsWith('/rpc/emit_diff'))
      .map(([, o]) => {
        const body = (o as { body: Record<string, unknown> }).body;
        return {
          event: body.p_event as string,
          entity: body.p_entity_id as string,
          after: body.p_value_after as Record<string, unknown>,
        };
      });
  return { agent, api, clock, timers, emitted };
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type Harness = ReturnType<typeof setup>;

describe('ExoAgent', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('taskComplete emits task=completed once per completion (request mocked)', async () => {
    const task: SpTask = {
      id: 't1',
      title: 'Ship',
      isDone: true,
      doneOn: T0,
      projectId: 'p1',
      timeSpent: 30 * MIN,
      timeEstimate: 60 * MIN,
    };
    await h.agent.onTaskComplete({ taskId: 't1', task });
    await h.agent.onTaskComplete({ taskId: 't1', task });
    expect(h.emitted()).toEqual([
      {
        event: 'task=completed',
        entity: 'task_sp-t1',
        after: expect.objectContaining({ project: 'Exo', time_spent_minutes: 30 }),
      },
    ]);
  });

  it('a failed completion emit can be retried', async () => {
    h.api.request.mockResolvedValueOnce({ error: 'boom' });
    const task: SpTask = { id: 't1', title: 'Ship', isDone: true, doneOn: T0 };
    await h.agent.onTaskComplete({ task });
    await h.agent.onTaskComplete({ task });
    expect(h.api.request).toHaveBeenCalledTimes(2);
  });

  it('tracking: buffered start via timer, stop on change, short stints dropped', async () => {
    h.agent.onCurrentTaskChange({ current: { id: 'a', title: 'A' }, previous: null });
    expect(h.timers.at(-1)?.ms).toBe(MIN + 50);
    h.clock.now = T0 + MIN + 50;
    h.timers.at(-1)?.fn();
    h.clock.now = T0 + 10 * MIN;
    h.agent.onCurrentTaskChange({
      current: { id: 'b', title: 'B' },
      previous: { id: 'a', title: 'A' },
    });
    h.clock.now = T0 + 10 * MIN + 20_000;
    h.agent.onCurrentTaskChange({ current: null, previous: { id: 'b', title: 'B' } });
    await flush();
    expect(h.emitted().map((e) => `${e.event} ${e.entity}`)).toEqual([
      'tracking=started tracking_sp-a',
      'tracking=stopped tracking_sp-a',
    ]);
    expect(h.emitted()[1].after.minutes).toBe(10);
  });

  it('focus: one focus=completed per logged session, with the tracked task title', async () => {
    h = setup({ tasks: [{ id: 'a', title: 'Deep work' }] });
    h.agent.onCurrentTaskChange({
      current: { id: 'a', title: 'Deep work' },
      previous: null,
    });
    h.agent.onAction({ action: { type: ACTION.FOCUS_TICK } });
    h.agent.onAction({ action: { type: ACTION.FOCUS_SET_MODE, mode: 'Pomodoro' } });
    h.agent.onAction({
      action: { type: ACTION.FOCUS_START_SESSION, duration: 25 * MIN },
    });
    h.clock.now = T0 + 25 * MIN;
    h.agent.onAction({
      action: { type: '[FocusMode] Complete Session', isManual: false },
    });
    h.agent.onAction({
      action: {
        type: ACTION.METRIC_LOG_FOCUS_SESSION,
        day: '2026-10-26',
        duration: 25 * MIN,
      },
    });
    await flush();
    const focus = h.emitted().filter((e) => e.event === 'focus=completed');
    expect(focus).toEqual([
      {
        event: 'focus=completed',
        entity: 'focus_2026-10-26-0900',
        after: expect.objectContaining({
          mode: 'pomodoro',
          minutes: 25,
          planned_minutes: 25,
          task: { sp_task_id: 'a', title: 'Deep work' },
        }),
      },
    ]);
    // metric snapshot persisted (debounced)
    h.timers.at(-1)?.fn();
    expect(h.api.persistDataSynced).toHaveBeenCalledWith(
      expect.any(String),
      'metric-cache',
    );
  });

  it('finishDay combines captured metric actions with task stats', async () => {
    h = setup({
      tasks: [
        {
          id: 'a',
          title: 'A',
          dueDay: '2026-10-26',
          isDone: true,
          doneOn: T0,
          timeSpentOnDay: { '2026-10-26': 40 * MIN },
        },
        { id: 'b', title: 'B', dueDay: '2026-10-26' },
      ],
    });
    h.agent.onAction({
      action: {
        type: ACTION.METRIC_UPSERT,
        metric: {
          id: '2026-10-26',
          focusSessions: [25 * MIN],
          impactOfWork: 3,
          energyCheckin: 2,
          reflections: [{ text: 'ok', created: 1 }],
        },
      },
    });
    await h.agent.onFinishDay({ date: '2026-10-26' });
    await flush();
    expect(h.emitted()).toEqual([
      {
        event: 'day=finished',
        entity: 'day_2026-10-26',
        after: {
          date: '2026-10-26',
          focus_sessions_minutes: [25],
          focus_minutes_total: 25,
          impact_of_work: 3,
          energy_checkin: 2,
          reflections: ['ok'],
          planned_tasks: 2,
          completed_tasks: 1,
          total_work_minutes: 40,
          source: 'super-productivity',
        },
      },
    ]);
  });

  it('without an anon key: loads fine, one snack, no requests', async () => {
    h = setup({ anonKey: '' });
    await h.agent.init();
    await h.agent.onTaskComplete({
      task: { id: 't', title: 'x', isDone: true, doneOn: T0 },
    });
    h.agent.onCurrentTaskChange({ current: { id: 'a', title: 'A' }, previous: null });
    h.clock.now = T0 + 5 * MIN;
    h.agent.onCurrentTaskChange({ current: null, previous: { id: 'a', title: 'A' } });
    await flush();
    expect(h.api.request).not.toHaveBeenCalled();
    expect(h.api.showSnack).toHaveBeenCalledTimes(1);
    expect(h.api.showSnack).toHaveBeenCalledWith({
      msg: MSG.NOT_CONNECTED,
      type: 'WARNING',
    });
  });

  it('a stored override connects without a rebuild; the key is never sent to the panel', async () => {
    h = setup({
      anonKey: '',
      stored: { config: JSON.stringify({ anonKey: 'override-key' }) },
    });
    await h.agent.init();
    expect(h.agent.isConnected).toBe(true);
    expect(h.api.showSnack).not.toHaveBeenCalled();
    const state = await h.agent.getPanelState();
    expect(state.configSource).toBe('override');
    expect(state.override).toEqual({ url: null, hasKey: true });
    expect(JSON.stringify(state)).not.toContain('override-key');
  });

  it('saveConfig validates the host and keeps a saved key on request', async () => {
    await expect(
      h.agent.saveConfig({ url: 'https://evil.example', anonKey: 'x' }),
    ).resolves.toMatchObject({ ok: false });
    await h.agent.saveConfig({ url: URL_OK, anonKey: 'first' });
    await h.agent.saveConfig({ url: URL_OK, anonKey: KEEP_SAVED_KEY });
    expect(h.api.persistDataSynced).toHaveBeenLastCalledWith(
      JSON.stringify({ url: URL_OK, anonKey: 'first' }),
      'config',
    );
  });

  it('Send to Exo AI emits task=handed_off and shows the success snack', async () => {
    h = setup({ tasks: [{ id: 't1', title: 'Research', notes: 'n', projectId: 'p1' }] });
    await expect(h.agent.sendTaskToExoAi('t1')).resolves.toEqual({ ok: true, id: 100 });
    expect(h.emitted()[0]).toMatchObject({
      event: 'task=handed_off',
      entity: 'task_sp-t1',
    });
    expect(h.api.showSnack).toHaveBeenCalledWith({
      msg: MSG.HANDOFF_OK,
      type: 'SUCCESS',
    });
  });

  it('Send to Exo AI shows an error snack on failure', async () => {
    h = setup({ tasks: [{ id: 't1', title: 'Research' }] });
    h.api.request.mockRejectedValueOnce(new Error('offline'));
    const res = await h.agent.sendTaskToExoAi('t1');
    expect(res.ok).toBe(false);
    expect(h.api.showSnack).toHaveBeenCalledWith({
      msg: `${MSG.HANDOFF_FAIL}: offline`,
      type: 'ERROR',
    });
    await h.agent.sendTaskToExoAi('missing');
    expect(h.api.showSnack).toHaveBeenLastCalledWith({
      msg: MSG.TASK_NOT_FOUND,
      type: 'ERROR',
    });
  });

  it('plan request -> poll finds a newer plan=proposed; expires after 3 minutes', async () => {
    h = setup({ tasks: [{ id: 'a', title: 'A', dueDay: '2026-10-26' }] });
    const req = await h.agent.requestPlan(240);
    expect(req).toEqual({
      ok: true,
      request: { diffId: 100, requestedAt: T0 },
      taskCount: 1,
    });
    expect(h.emitted()[0]).toMatchObject({
      event: 'plan=requested',
      entity: 'plan_2026-10-26',
      after: expect.objectContaining({ available_minutes: 240 }),
    });

    h.api.request.mockResolvedValueOnce([{ id: 99, value_after: { summary: 'old' } }]);
    await expect(h.agent.pollPlan()).resolves.toMatchObject({
      isNew: false,
      expired: false,
    });
    expect((await h.agent.getPanelState()).pendingPlanRequest).not.toBeNull();

    h.api.request.mockResolvedValueOnce([{ id: 101, value_after: { summary: 'new' } }]);
    await expect(h.agent.pollPlan()).resolves.toMatchObject({
      isNew: true,
      plan: { id: 101 },
    });

    await h.agent.requestPlan(undefined);
    h.clock.now = T0 + PLAN_POLL_TIMEOUT_MS + 1;
    await expect(h.agent.pollPlan()).resolves.toMatchObject({
      isNew: false,
      expired: true,
    });
  });

  it('plan request says so at once when replies cannot be read, instead of waiting 3 minutes', async () => {
    h = setup({ unreadable: true });
    await expect(h.agent.requestPlan(240)).resolves.toEqual({
      ok: false,
      error: MSG.REPLIES_UNREADABLE,
    });
    expect(h.emitted()[0]).toMatchObject({ event: 'plan=requested' });
    expect((await h.agent.getPanelState()).pendingPlanRequest).toBeNull();
  });

  it('plan request still waits when the read-back itself fails', async () => {
    h.api.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/rpc/emit_diff')) return 100;
      if (/[?&]id=eq\./.test(url)) throw new Error('network down');
      return [];
    });
    await expect(h.agent.requestPlan(60)).resolves.toMatchObject({ ok: true });
  });

  it('panel state reads the latest plan and 10 handed-off results', async () => {
    h = setup({
      tasks: [{ id: 'x', title: 'X', timeEstimate: 10 * MIN, timeSpent: 20 * MIN }],
    });
    h.api.request.mockImplementation(async (url) =>
      url.includes('plan%3Dproposed')
        ? [{ id: 5, value_after: { summary: 's' } }]
        : [{ id: 6, value_after: { title: 'done' } }],
    );
    const s = await h.agent.handlePanelMessage({ type: 'exo:getState' });
    expect(s).toMatchObject({
      connected: true,
      plan: { id: 5 },
      handoffs: [{ id: 6 }],
      drift: [{ sp_task_id: 'x', status: 'over' }],
    });
    const urls = h.api.request.mock.calls.map(([u]) => String(u));
    expect(
      urls.some(
        (u) => u.includes('event=eq.task%3Dagent_completed') && u.endsWith('limit=10'),
      ),
    ).toBe(true);
    await expect(h.agent.handlePanelMessage({ type: 'bogus' })).resolves.toEqual({
      error: 'Unknown message type',
    });
  });
});
