import { describe, expect, it } from 'vitest';
import { mapDayFinished } from './mappers';
import { MetricCache } from './metric-cache';
import { ACTION } from './ngrx-actions';

const MIN = 60_000;

describe('MetricCache', () => {
  it('builds the day metric from upsert/update/log actions like the host reducer', () => {
    const c = new MetricCache();
    expect(
      c.apply({
        type: ACTION.METRIC_LOG_FOCUS_SESSION,
        day: '2026-10-26',
        duration: 25 * MIN,
      }),
    ).toBe(true);
    expect(c.get('2026-10-26')).toEqual({ focusSessions: [25 * MIN] });

    // Daily summary evaluation upserts the full record
    c.apply({
      type: ACTION.METRIC_UPSERT,
      metric: {
        id: '2026-10-26',
        focusSessions: [25 * MIN, 30 * MIN],
        impactOfWork: 4,
        energyCheckin: 3,
        reflections: [],
        notes: 'ignored',
      },
    });
    c.apply({
      type: ACTION.METRIC_UPDATE,
      metric: {
        id: '2026-10-26',
        changes: { reflections: [{ text: 'Good day', created: 5 }] },
      },
    });
    c.apply({
      type: ACTION.METRIC_LOG_FOCUS_SESSION,
      day: '2026-10-26',
      duration: 10 * MIN,
    });

    const m = c.get('2026-10-26');
    expect(m).toEqual({
      focusSessions: [25 * MIN, 30 * MIN, 10 * MIN],
      impactOfWork: 4,
      energyCheckin: 3,
      reflections: [{ text: 'Good day', created: 5 }],
    });
    expect(mapDayFinished('2026-10-26', m, null).valueAfter).toMatchObject({
      focus_sessions_minutes: [25, 30, 10],
      focus_minutes_total: 65,
      impact_of_work: 4,
      energy_checkin: 3,
      reflections: ['Good day'],
    });
  });

  it('ignores unrelated and malformed actions; delete removes the day', () => {
    const c = new MetricCache();
    expect(c.apply({ type: '[Task] Update Task' })).toBe(false);
    expect(c.apply({ type: ACTION.METRIC_UPSERT, metric: 'nope' })).toBe(false);
    expect(c.apply({ type: ACTION.METRIC_UPDATE, metric: { id: 'x' } })).toBe(false);
    c.apply({ type: ACTION.METRIC_ADD, metric: { id: '2026-10-26', impactOfWork: 2 } });
    expect(c.apply({ type: ACTION.METRIC_DELETE, id: '2026-10-26' })).toBe(true);
    expect(c.get('2026-10-26')).toBeUndefined();
  });

  it('round-trips through serialize/hydrate without overwriting session data, keeping 3 days', () => {
    const a = new MetricCache();
    for (const d of ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']) {
      a.apply({ type: ACTION.METRIC_UPSERT, metric: { id: d, impactOfWork: 1 } });
    }
    expect(a.get('2026-10-22')).toBeUndefined();

    const b = new MetricCache();
    b.apply({
      type: ACTION.METRIC_UPSERT,
      metric: { id: '2026-10-25', impactOfWork: 4 },
    });
    b.hydrate(a.serialize());
    expect(b.get('2026-10-25')?.impactOfWork).toBe(4);
    expect(b.get('2026-10-24')?.impactOfWork).toBe(1);
    b.hydrate('not json');
    b.hydrate(null);
    expect(b.get('2026-10-24')).toBeDefined();
  });
});
