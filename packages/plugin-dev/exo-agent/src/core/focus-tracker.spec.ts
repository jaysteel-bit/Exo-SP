import { describe, expect, it } from 'vitest';
import { FocusTracker, normalizeFocusMode } from './focus-tracker';
import { mapFocusCompleted } from './mappers';
import { ACTION, isRelevantActionType, toNgrxAction } from './ngrx-actions';

const T0 = new Date(2026, 9, 26, 9, 5).getTime();
const MIN = 60_000;

describe('normalizeFocusMode', () => {
  it('maps SP FocusModeMode values', () => {
    expect(normalizeFocusMode('Pomodoro')).toBe('pomodoro');
    expect(normalizeFocusMode('Flowtime')).toBe('flowtime');
    expect(normalizeFocusMode('Countdown')).toBe('countdown');
    expect(normalizeFocusMode('Other')).toBeNull();
    expect(normalizeFocusMode(null)).toBeNull();
  });
});

describe('toNgrxAction / isRelevantActionType', () => {
  it('accepts the runtime shape { action: {type,...} } and the typed shape', () => {
    expect(toNgrxAction({ action: { type: 'X', a: 1 } })).toEqual({ type: 'X', a: 1 });
    expect(toNgrxAction({ action: 'Y', payload: { b: 2 } })).toEqual({ type: 'Y', b: 2 });
    expect(toNgrxAction({ action: { nope: 1 } })).toBeNull();
    expect(toNgrxAction(null)).toBeNull();
  });

  it('filters ticks and unrelated actions', () => {
    expect(isRelevantActionType(ACTION.FOCUS_TICK)).toBe(false);
    expect(isRelevantActionType('[Task] Update Task')).toBe(false);
    expect(isRelevantActionType(ACTION.FOCUS_START_SESSION)).toBe(true);
    expect(isRelevantActionType(ACTION.METRIC_LOG_FOCUS_SESSION)).toBe(true);
  });
});

describe('FocusTracker', () => {
  it('pomodoro session: start -> complete -> log emits one focus=completed', () => {
    const ft = new FocusTracker(null);
    expect(
      ft.handle({ type: ACTION.FOCUS_SET_MODE, mode: 'Pomodoro' }, T0 - 1000, null),
    ).toBeNull();
    expect(
      ft.handle({ type: ACTION.FOCUS_START_SESSION, duration: 25 * MIN }, T0, 'task-1'),
    ).toBeNull();
    expect(
      ft.handle(
        { type: '[FocusMode] Complete Session', isManual: false },
        T0 + 25 * MIN,
        'task-1',
      ),
    ).toBeNull();
    const c = ft.handle(
      { type: ACTION.METRIC_LOG_FOCUS_SESSION, day: '2026-10-26', duration: 25 * MIN },
      T0 + 25 * MIN,
      null,
    );
    expect(c).toEqual({
      mode: 'pomodoro',
      durationMs: 25 * MIN,
      plannedMs: 25 * MIN,
      taskId: 'task-1',
      startedAt: T0,
    });
    const ev = mapFocusCompleted(c!, { id: 'task-1', title: 'Deep work' });
    expect(ev.entityId).toBe('focus_2026-10-26-0905');
    expect(ev.valueAfter).toMatchObject({
      mode: 'pomodoro',
      minutes: 25,
      planned_minutes: 25,
    });

    // the same session cannot complete twice
    expect(
      ft.handle(
        { type: ACTION.METRIC_LOG_FOCUS_SESSION, day: '2026-10-26', duration: 0 },
        T0,
        null,
      ),
    ).toBeNull();
  });

  it('cancelled sessions emit nothing (no Log Focus Session follows)', () => {
    const ft = new FocusTracker('countdown');
    ft.handle(
      { type: ACTION.FOCUS_START_SESSION, duration: 30 * MIN, taskId: 'x' },
      T0,
      null,
    );
    expect(
      ft.handle({ type: ACTION.FOCUS_CANCEL_SESSION }, T0 + 5 * MIN, null),
    ).toBeNull();
  });

  it('flowtime (duration 0) has no planned minutes; action taskId wins', () => {
    const ft = new FocusTracker('flowtime');
    ft.handle(
      { type: ACTION.FOCUS_START_SESSION, duration: 0, taskId: 'act' },
      T0,
      'current',
    );
    const c = ft.handle(
      { type: ACTION.METRIC_LOG_FOCUS_SESSION, day: '2026-10-26', duration: 41 * MIN },
      T0 + 41 * MIN,
      null,
    );
    expect(c).toMatchObject({
      mode: 'flowtime',
      plannedMs: null,
      taskId: 'act',
      startedAt: T0,
    });
  });

  it('session started before the plugin loaded: start back-computed, initial mode used', () => {
    const ft = new FocusTracker(null); // SP default countdown
    const c = ft.handle(
      { type: ACTION.METRIC_LOG_FOCUS_SESSION, day: '2026-10-26', duration: 20 * MIN },
      T0 + 20 * MIN,
      'current',
    );
    expect(c).toEqual({
      mode: 'countdown',
      durationMs: 20 * MIN,
      plannedMs: null,
      taskId: 'current',
      startedAt: T0,
    });
  });

  it('restore session re-adopts a running work timer', () => {
    const ft = new FocusTracker('countdown');
    ft.handle(
      {
        type: ACTION.FOCUS_RESTORE_SESSION,
        mode: 'Pomodoro',
        timer: { purpose: 'work', elapsed: 10 * MIN, duration: 25 * MIN, startedAt: 1 },
      },
      T0 + 10 * MIN,
      'cur',
    );
    const c = ft.handle(
      { type: ACTION.METRIC_LOG_FOCUS_SESSION, day: '2026-10-26', duration: 25 * MIN },
      T0 + 25 * MIN,
      null,
    );
    expect(c).toMatchObject({
      mode: 'pomodoro',
      plannedMs: 25 * MIN,
      startedAt: T0,
      taskId: 'cur',
    });
  });
});
