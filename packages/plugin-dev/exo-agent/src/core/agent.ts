import {
  ALLOWED_HOSTS,
  CONFIG_STORAGE_KEY,
  ConfigOverride,
  parseStoredOverride,
  resolveConfig,
  validateOverride,
} from './config';
import { localDateStr } from './dates';
import { DiffEvent } from './diff';
import {
  EmitResult,
  FlowOsClient,
  isPlanNewerThanRequest,
  RequestFn,
} from './flow-os-client';
import { FocusTracker } from './focus-tracker';
import {
  completionKey,
  mapDayFinished,
  mapFocusCompleted,
  mapPlanRequested,
  mapTaskCompleted,
  mapTaskHandedOff,
  OnceSet,
} from './mappers';
import type {
  PanelMessage,
  PanelState,
  PendingPlanRequest,
  PollPlanResult,
  RequestPlanResult,
  SaveConfigResult,
} from './messages';
import { MetricCache } from './metric-cache';
import { isRelevantActionType, toNgrxAction } from './ngrx-actions';
import { StintTask, StintTracker } from './stint-tracker';
import {
  computeDayTaskStats,
  computeEstimateDrift,
  openTasksForDay,
  projectNameOf,
  SpProject,
  SpTask,
  toProjectNames,
} from './tasks';
import type { FocusMode } from './mappers';

export const METRIC_CACHE_STORAGE_KEY = 'metric-cache';
export const PLAN_POLL_TIMEOUT_MS = 3 * 60_000;
/** Panel sentinel: "keep the saved anon key" (the panel never reads it back). */
export const KEEP_SAVED_KEY = '__keep__';
const METRIC_PERSIST_DEBOUNCE_MS = 2_000;

export const MSG = {
  NOT_CONNECTED: 'Exo AI: not connected to Flow OS',
  HANDOFF_OK: 'Sent to Exo AI — the result will appear in the Exo AI panel.',
  HANDOFF_FAIL: 'Exo AI: could not send the task',
  TASK_NOT_FOUND: 'Exo AI: task not found',
} as const;

/** The subset of PluginAPI the agent uses (structural, so tests can mock it). */
export interface HostApi {
  getTasks(): Promise<SpTask[]>;
  getAllProjects(): Promise<SpProject[]>;
  showSnack(cfg: { msg: string; type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO' }): void;
  persistDataSynced(dataStr: string, key?: string): Promise<void>;
  loadSyncedData(key?: string): Promise<string | null>;
  request: RequestFn;
  log: {
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    err(...a: unknown[]): void;
  };
}

export interface AgentDeps {
  build: { url: string; anonKey: string };
  pluginVersion: string;
  initialFocusMode: FocusMode | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface TaskLike {
  id: string;
  title: string;
}

const toStintTask = (t: unknown): StintTask | null => {
  if (!t || typeof t !== 'object') return null;
  const o = t as Partial<TaskLike>;
  return typeof o.id === 'string' ? { id: o.id, title: String(o.title ?? '') } : null;
};

/**
 * All plugin behaviour, independent of the global `plugin` object: plugin.ts
 * only wires host hooks/buttons to these methods.
 */
export class ExoAgent {
  private _override: ConfigOverride | null = null;
  private readonly _client: FlowOsClient;
  private readonly _completions = new OnceSet();
  private readonly _stints: StintTracker;
  private readonly _focus: FocusTracker;
  private readonly _metrics = new MetricCache();
  private _notConnectedWarned = false;
  private _stintTimer: unknown = null;
  private _metricPersistTimer: unknown = null;
  private _pendingPlan: PendingPlanRequest | null = null;
  private readonly _now: () => number;
  private readonly _setTimer: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimer: (handle: unknown) => void;

  constructor(
    private readonly _api: HostApi,
    private readonly _deps: AgentDeps,
  ) {
    this._now = _deps.now ?? (() => Date.now());
    this._setTimer = _deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer =
      _deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this._client = new FlowOsClient(
      () => resolveConfig(_deps.build, this._override),
      _api.request,
      _deps.pluginVersion,
    );
    this._stints = new StintTracker();
    this._focus = new FocusTracker(_deps.initialFocusMode);
  }

  get isConnected(): boolean {
    return this._client.isConnected();
  }

  /** Load persisted override + metric snapshot; warn once if not connected. */
  async init(): Promise<void> {
    try {
      this._override = parseStoredOverride(
        await this._api.loadSyncedData(CONFIG_STORAGE_KEY),
      );
    } catch (e) {
      this._api.log.warn('Exo AI: could not load config override', e);
    }
    try {
      this._metrics.hydrate(await this._api.loadSyncedData(METRIC_CACHE_STORAGE_KEY));
    } catch (e) {
      this._api.log.warn('Exo AI: could not load metric snapshot', e);
    }
    if (!this.isConnected) {
      this._warnNotConnectedOnce();
    }
  }

  dispose(): void {
    if (this._stintTimer !== null) this._clearTimer(this._stintTimer);
    if (this._metricPersistTimer !== null) this._clearTimer(this._metricPersistTimer);
    this._stintTimer = null;
    this._metricPersistTimer = null;
  }

  private _warnNotConnectedOnce(): void {
    if (this._notConnectedWarned) return;
    this._notConnectedWarned = true;
    this._api.showSnack({ msg: MSG.NOT_CONNECTED, type: 'WARNING' });
  }

  async emit(ev: DiffEvent): Promise<EmitResult> {
    if (!this.isConnected) {
      this._warnNotConnectedOnce();
      return { ok: false, error: MSG.NOT_CONNECTED, notConnected: true };
    }
    const res = await this._client.emit(ev);
    if (!res.ok) {
      this._api.log.warn(
        `Exo AI: emit ${ev.event} for ${ev.entityId} failed: ${res.error}`,
      );
    }
    return res;
  }

  private async _projectNames(): Promise<ReadonlyMap<string, string>> {
    try {
      return toProjectNames(await this._api.getAllProjects());
    } catch {
      return new Map();
    }
  }

  // ------------------------------------------------------------------ hooks

  async onTaskComplete(
    payload: { taskId?: string; task?: SpTask } | undefined,
  ): Promise<void> {
    const task = payload?.task;
    if (!task?.id) return;
    const now = this._now();
    const key = completionKey(task, now);
    if (!this._completions.claim(key)) return;
    if (!this.isConnected) {
      this._warnNotConnectedOnce();
      return;
    }
    const names = await this._projectNames();
    const res = await this.emit(mapTaskCompleted(task, projectNameOf(task, names), now));
    if (!res.ok && !res.notConnected) {
      // Allow a later re-save of the done task to retry the emit.
      this._completions.release(key);
    }
  }

  onCurrentTaskChange(
    payload: { current?: unknown; previous?: unknown } | undefined,
  ): void {
    const now = this._now();
    const { emits, startDueAt } = this._stints.change(
      toStintTask(payload?.current),
      toStintTask(payload?.previous),
      now,
    );
    if (this._stintTimer !== null) {
      this._clearTimer(this._stintTimer);
      this._stintTimer = null;
    }
    if (startDueAt !== null) {
      this._stintTimer = this._setTimer(
        () => {
          this._stintTimer = null;
          this._emitAll(this._stints.tick(this._now()));
        },
        Math.max(0, startDueAt - now) + 50,
      );
    }
    this._emitAll(emits);
  }

  onAction(hookPayload: unknown): void {
    const action = toNgrxAction(hookPayload);
    if (!action || !isRelevantActionType(action.type)) return;
    const now = this._now();
    const completion = this._focus.handle(action, now, this._stints.currentTaskId);
    if (this._metrics.apply(action)) {
      this._scheduleMetricPersist();
    }
    if (completion) {
      void this._emitFocus(completion);
    }
  }

  private async _emitFocus(c: Parameters<typeof mapFocusCompleted>[0]): Promise<void> {
    let task: TaskLike | null = null;
    if (c.taskId) {
      try {
        const found = (await this._api.getTasks()).find((t) => t.id === c.taskId);
        task = { id: c.taskId, title: found?.title ?? '' };
      } catch {
        task = { id: c.taskId, title: '' };
      }
    }
    await this.emit(mapFocusCompleted(c, task));
  }

  /**
   * finishDay runs BEFORE the host archives the day's done tasks and is
   * awaited (5 s budget), so read tasks here and send without awaiting.
   */
  async onFinishDay(payload: { date?: string } | undefined): Promise<void> {
    const day =
      typeof payload?.date === 'string' && payload.date
        ? payload.date
        : localDateStr(this._now());
    let stats = null;
    try {
      stats = computeDayTaskStats(await this._api.getTasks(), day);
    } catch (e) {
      this._api.log.warn('Exo AI: could not read tasks for day stats', e);
    }
    void this.emit(mapDayFinished(day, this._metrics.get(day), stats));
  }

  private _emitAll(events: DiffEvent[]): void {
    for (const ev of events) {
      void this.emit(ev);
    }
  }

  private _scheduleMetricPersist(): void {
    if (this._metricPersistTimer !== null) this._clearTimer(this._metricPersistTimer);
    this._metricPersistTimer = this._setTimer(() => {
      this._metricPersistTimer = null;
      this._api
        .persistDataSynced(this._metrics.serialize(), METRIC_CACHE_STORAGE_KEY)
        .catch((e: unknown) =>
          this._api.log.warn('Exo AI: metric snapshot not saved', e),
        );
    }, METRIC_PERSIST_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------ menu action

  async sendTaskToExoAi(taskId: string): Promise<EmitResult> {
    let task: SpTask | undefined;
    try {
      task = (await this._api.getTasks()).find((t) => t.id === taskId);
    } catch {
      task = undefined;
    }
    if (!task) {
      this._api.showSnack({ msg: MSG.TASK_NOT_FOUND, type: 'ERROR' });
      return { ok: false, error: MSG.TASK_NOT_FOUND };
    }
    if (!this.isConnected) {
      this._api.showSnack({ msg: MSG.NOT_CONNECTED, type: 'ERROR' });
      return { ok: false, error: MSG.NOT_CONNECTED, notConnected: true };
    }
    const names = await this._projectNames();
    const res = await this.emit(mapTaskHandedOff(task, projectNameOf(task, names)));
    this._api.showSnack(
      res.ok
        ? { msg: MSG.HANDOFF_OK, type: 'SUCCESS' }
        : { msg: `${MSG.HANDOFF_FAIL}: ${res.error}`, type: 'ERROR' },
    );
    return res;
  }

  // ------------------------------------------------------------ panel bridge

  async handlePanelMessage(message: unknown): Promise<unknown> {
    const m = message as PanelMessage | undefined;
    switch (m?.type) {
      case 'exo:getState':
        return this.getPanelState();
      case 'exo:requestPlan':
        return this.requestPlan(m.payload?.availableMinutes);
      case 'exo:pollPlan':
        return this.pollPlan();
      case 'exo:saveConfig':
        return this.saveConfig(m.payload ?? { url: '', anonKey: '' });
      default:
        return { error: 'Unknown message type' };
    }
  }

  private _livePending(): PendingPlanRequest | null {
    if (
      this._pendingPlan &&
      this._now() - this._pendingPlan.requestedAt > PLAN_POLL_TIMEOUT_MS
    ) {
      this._pendingPlan = null;
    }
    return this._pendingPlan;
  }

  async getPanelState(): Promise<PanelState> {
    const today = localDateStr(this._now());
    const cfg = resolveConfig(this._deps.build, this._override);
    let tasks: SpTask[] = [];
    try {
      tasks = await this._api.getTasks();
    } catch (e) {
      this._api.log.warn('Exo AI: could not read tasks', e);
    }
    const state: PanelState = {
      connected: cfg.source !== 'none',
      configSource: cfg.source,
      override: { url: this._override?.url ?? null, hasKey: !!this._override?.anonKey },
      allowedHost: ALLOWED_HOSTS[0],
      today,
      openTodayTaskCount: openTasksForDay(tasks, today).length,
      drift: computeEstimateDrift(tasks),
      plan: null,
      planError: null,
      handoffs: [],
      handoffsError: null,
      pendingPlanRequest: this._livePending(),
    };
    if (!state.connected) return state;
    const [plan, handoffs] = await Promise.allSettled([
      this._client.latest('plan=proposed', 1),
      this._client.latest('task=agent_completed', 10),
    ]);
    if (plan.status === 'fulfilled') state.plan = plan.value[0] ?? null;
    else state.planError = String((plan.reason as Error)?.message ?? plan.reason);
    if (handoffs.status === 'fulfilled') state.handoffs = handoffs.value;
    else
      state.handoffsError = String(
        (handoffs.reason as Error)?.message ?? handoffs.reason,
      );
    return state;
  }

  async requestPlan(availableMinutes: unknown): Promise<RequestPlanResult> {
    if (!this.isConnected) {
      this._warnNotConnectedOnce();
      return { ok: false, error: MSG.NOT_CONNECTED };
    }
    const now = this._now();
    const day = localDateStr(now);
    let tasks: SpTask[];
    try {
      tasks = await this._api.getTasks();
    } catch (e) {
      return { ok: false, error: `Could not read tasks: ${String(e)}` };
    }
    const ev = mapPlanRequested(day, availableMinutes, tasks, await this._projectNames());
    const res = await this.emit(ev);
    if (!res.ok) return { ok: false, error: res.error };
    this._pendingPlan = { diffId: res.id, requestedAt: now };
    const taskCount = Array.isArray(ev.valueAfter.tasks) ? ev.valueAfter.tasks.length : 0;
    return { ok: true, request: this._pendingPlan, taskCount };
  }

  async pollPlan(): Promise<PollPlanResult> {
    const pending = this._pendingPlan;
    try {
      const plan = (await this._client.latest('plan=proposed', 1))[0] ?? null;
      if (pending && isPlanNewerThanRequest(plan, pending)) {
        this._pendingPlan = null;
        return { plan, isNew: true, expired: false, error: null };
      }
      const expired = !this._livePending();
      return { plan, isNew: false, expired, error: null };
    } catch (e) {
      const expired = !this._livePending();
      return {
        plan: null,
        isNew: false,
        expired,
        error: String((e as Error)?.message ?? e),
      };
    }
  }

  async saveConfig(input: { url?: string; anonKey?: string }): Promise<SaveConfigResult> {
    const anonKey =
      input.anonKey === KEEP_SAVED_KEY ? (this._override?.anonKey ?? '') : input.anonKey;
    const v = validateOverride({ url: input.url, anonKey });
    if (!v.ok) return v;
    const next = v.value.url || v.value.anonKey ? v.value : null;
    try {
      await this._api.persistDataSynced(JSON.stringify(next ?? {}), CONFIG_STORAGE_KEY);
    } catch (e) {
      return { ok: false, error: `Could not save: ${String(e)}` };
    }
    this._override = next;
    if (this.isConnected) this._notConnectedWarned = false;
    return { ok: true, connected: this.isConnected };
  }
}
