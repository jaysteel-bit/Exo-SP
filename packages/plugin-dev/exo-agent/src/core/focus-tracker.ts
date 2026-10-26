import { FocusCompletion, FocusMode } from './mappers';
import { ACTION, NgrxAction } from './ngrx-actions';

/** SP's FocusModeMode enum values ('Pomodoro' | 'Flowtime' | 'Countdown'). */
export const normalizeFocusMode = (value: unknown): FocusMode | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const v = value.toLowerCase();
  return v === 'pomodoro' || v === 'flowtime' || v === 'countdown' ? v : null;
};

interface FocusSession {
  mode: FocusMode;
  startedAt: number;
  plannedMs: number | null;
  taskId: string | null;
}

/**
 * Tracks focus-mode context from NgRx actions and yields one FocusCompletion
 * per `[Metric] Log Focus Session` (see ngrx-actions.ts for why that action is
 * the completion signal). If the session started before the plugin loaded, the
 * start time is back-computed from the logged duration and planned is null.
 */
export class FocusTracker {
  private _mode: FocusMode;
  private _session: FocusSession | null = null;

  /** @param initialMode the host's mode at load time (SP default: countdown) */
  constructor(initialMode: FocusMode | null) {
    this._mode = initialMode ?? 'countdown';
  }

  handle(
    action: NgrxAction,
    now: number,
    currentTaskId: string | null,
  ): FocusCompletion | null {
    switch (action.type) {
      case ACTION.FOCUS_SET_MODE: {
        this._mode = normalizeFocusMode(action.mode) ?? this._mode;
        return null;
      }
      case ACTION.FOCUS_START_SESSION: {
        const duration = typeof action.duration === 'number' ? action.duration : null;
        this._session = {
          mode: this._mode,
          startedAt: now,
          plannedMs: duration && duration > 0 ? duration : null,
          taskId: typeof action.taskId === 'string' ? action.taskId : currentTaskId,
        };
        return null;
      }
      case ACTION.FOCUS_RESTORE_SESSION: {
        const mode = normalizeFocusMode(action.mode);
        if (mode) {
          this._mode = mode;
        }
        const timer = (action.timer ?? {}) as {
          startedAt?: unknown;
          duration?: unknown;
          purpose?: unknown;
          elapsed?: unknown;
        };
        if (timer.purpose === 'work') {
          const elapsed = typeof timer.elapsed === 'number' ? timer.elapsed : 0;
          this._session = {
            mode: this._mode,
            startedAt: now - elapsed,
            plannedMs:
              typeof timer.duration === 'number' && timer.duration > 0
                ? timer.duration
                : null,
            taskId: currentTaskId,
          };
        }
        return null;
      }
      case ACTION.FOCUS_CANCEL_SESSION: {
        this._session = null;
        return null;
      }
      case ACTION.METRIC_LOG_FOCUS_SESSION: {
        const durationMs = typeof action.duration === 'number' ? action.duration : 0;
        if (durationMs <= 0) {
          return null;
        }
        const s = this._session;
        this._session = null;
        return {
          mode: s?.mode ?? this._mode,
          durationMs,
          plannedMs: s?.plannedMs ?? null,
          taskId: s?.taskId ?? currentTaskId,
          startedAt: s?.startedAt ?? now - durationMs,
        };
      }
      default:
        return null;
    }
  }
}
