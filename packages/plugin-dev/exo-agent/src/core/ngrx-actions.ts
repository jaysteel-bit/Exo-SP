/**
 * NgRx action types this plugin listens to through the generic `action` hook.
 * Sources (host repo):
 *   src/app/features/focus-mode/store/focus-mode.actions.ts
 *   src/app/features/metric/store/metric.actions.ts
 *
 * Signal for a COMPLETED work session: `[Metric] Log Focus Session`. The
 * focus-mode effect `logFocusSession$` dispatches it (via MetricService) once
 * per `[FocusMode] Complete Session` with a duration >= 1 s — for Pomodoro,
 * Countdown and Flowtime alike — and never for `[FocusMode] Cancel Session`,
 * so interrupted sessions are not emitted. The FocusMode actions only add
 * context (mode, planned duration, start time, task).
 */
export const ACTION = {
  FOCUS_SET_MODE: '[FocusMode] Set Mode',
  FOCUS_START_SESSION: '[FocusMode] Start Session',
  FOCUS_CANCEL_SESSION: '[FocusMode] Cancel Session',
  FOCUS_RESTORE_SESSION: '[FocusMode] Restore Session',
  FOCUS_TICK: '[FocusMode] Timer Tick',
  METRIC_ADD: '[Metric] Add Metric',
  METRIC_UPDATE: '[Metric] Update Metric',
  METRIC_UPSERT: '[Metric] Upsert Metric',
  METRIC_DELETE: '[Metric] Delete Metric',
  METRIC_LOG_FOCUS_SESSION: '[Metric] Log Focus Session',
} as const;

export interface NgrxAction {
  type: string;
  [key: string]: unknown;
}

/**
 * The host dispatches the `action` hook with `{ action }` where `action` is the
 * full NgRx action object (plugin-hooks.effects.ts anyAction$), although the
 * published ActionPayload type says `action: string` + `payload`. Accept both.
 */
export const toNgrxAction = (hookPayload: unknown): NgrxAction | null => {
  if (!hookPayload || typeof hookPayload !== 'object') {
    return null;
  }
  const p = hookPayload as { action?: unknown; payload?: unknown };
  if (p.action && typeof p.action === 'object') {
    const a = p.action as { type?: unknown };
    return typeof a.type === 'string' ? (p.action as NgrxAction) : null;
  }
  if (typeof p.action === 'string') {
    const extra =
      p.payload && typeof p.payload === 'object'
        ? (p.payload as Record<string, unknown>)
        : {};
    return { ...extra, type: p.action };
  }
  return null;
};

/** Cheap pre-filter: the action hook fires for every action, incl. 1 s ticks. */
export const isRelevantActionType = (type: string): boolean =>
  type !== ACTION.FOCUS_TICK &&
  (type.startsWith('[FocusMode] ') || type.startsWith('[Metric] '));
