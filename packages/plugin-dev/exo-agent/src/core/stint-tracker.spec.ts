import { describe, expect, it } from 'vitest';
import { StintTracker } from './stint-tracker';

const T0 = new Date(2026, 9, 26, 9, 0).getTime();
const MIN = 60_000;
const a = { id: 'a', title: 'Task A' };
const b = { id: 'b', title: 'Task B' };

describe('StintTracker', () => {
  it('buffers the start until the stint reaches one minute', () => {
    const tr = new StintTracker();
    const r = tr.change(a, null, T0);
    expect(r.emits).toEqual([]);
    expect(r.startDueAt).toBe(T0 + MIN);
    expect(tr.currentTaskId).toBe('a');

    expect(tr.tick(T0 + 30_000)).toEqual([]);
    const started = tr.tick(T0 + MIN);
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      entityId: 'tracking_sp-a',
      event: 'tracking=started',
      valueBefore: null,
      valueAfter: {
        task: { sp_task_id: 'a', title: 'Task A' },
        started_at: new Date(T0).toISOString(),
        source: 'super-productivity',
      },
    });
    // a second tick does not re-emit
    expect(tr.tick(T0 + 2 * MIN)).toEqual([]);
  });

  it('emits stopped with rounded minutes when tracking moves to null', () => {
    const tr = new StintTracker();
    tr.change(a, null, T0);
    tr.tick(T0 + MIN);
    const stop = T0 + 25 * MIN + 31_000;
    const r = tr.change(null, { id: 'a', title: 'Task A (renamed)' }, stop);
    expect(r.startDueAt).toBeNull();
    expect(r.emits).toEqual([
      {
        entityId: 'tracking_sp-a',
        event: 'tracking=stopped',
        valueBefore: null,
        valueAfter: {
          task: { sp_task_id: 'a', title: 'Task A (renamed)' },
          minutes: 26,
          started_at: new Date(T0).toISOString(),
          stopped_at: new Date(stop).toISOString(),
          source: 'super-productivity',
        },
      },
    ]);
    expect(tr.currentTaskId).toBeNull();
  });

  it('skips both start and stop for stints under one minute', () => {
    const tr = new StintTracker();
    tr.change(a, null, T0);
    const r = tr.change(b, a, T0 + 59_000);
    expect(r.emits).toEqual([]);
    // b's stint started
    expect(r.startDueAt).toBe(T0 + 59_000 + MIN);
    expect(tr.currentTaskId).toBe('b');
  });

  it('emits the buffered start together with the stop if the tick has not run', () => {
    const tr = new StintTracker();
    tr.change(a, null, T0);
    const r = tr.change(b, a, T0 + 90_000);
    expect(r.emits.map((e) => e.event)).toEqual(['tracking=started', 'tracking=stopped']);
    expect(r.emits[1].valueAfter.minutes).toBe(2);
  });

  it('switching tasks stops the previous stint and starts a new one', () => {
    const tr = new StintTracker();
    tr.change(a, null, T0);
    tr.tick(T0 + MIN);
    const r = tr.change(b, a, T0 + 10 * MIN);
    expect(r.emits.map((e) => `${e.event} ${e.entityId}`)).toEqual([
      'tracking=stopped tracking_sp-a',
    ]);
    expect(tr.tick(T0 + 11 * MIN)[0].entityId).toBe('tracking_sp-b');
  });

  it('skips a stop whose start it never saw and ignores same-task re-emits', () => {
    const tr = new StintTracker();
    expect(tr.change(null, a, T0).emits).toEqual([]);
    tr.change(a, null, T0);
    expect(tr.change(a, null, T0 + 5 * MIN)).toEqual({ emits: [], startDueAt: null });
  });
});
