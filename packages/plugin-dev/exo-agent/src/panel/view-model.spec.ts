import { describe, expect, it } from 'vitest';
import { formatMinutes, toHandoffView, toPlanView } from './view-model';

describe('toPlanView', () => {
  it('extracts readable fields from an object plan', () => {
    const view = toPlanView({
      date: '2026-10-26',
      summary: 'Front-load the proposal.',
      reasoning: 'Highest impact first.',
      queue: [
        { title: 'Write proposal', minutes: 90, start: '09:00', reason: 'due today' },
        { task: { title: 'Inbox zero', time_estimate_minutes: 20 } },
        'Walk',
        42,
      ],
      drift_flags: [
        { title: 'Refactor', message: '150 % of estimate' },
        'Too much planned',
      ],
      available_minutes: 360,
      nested: { ignored: true },
    });
    expect(view.date).toBe('2026-10-26');
    expect(view.texts).toEqual([
      { label: 'Summary', text: 'Front-load the proposal.' },
      { label: 'Reasoning', text: 'Highest impact first.' },
    ]);
    expect(view.queue).toEqual([
      { title: 'Write proposal', minutes: 90, start: '09:00', note: 'due today' },
      { title: 'Inbox zero', minutes: 20, start: null, note: null },
      { title: 'Walk', minutes: null, start: null, note: null },
    ]);
    expect(view.flags).toEqual(['Refactor: 150 % of estimate', 'Too much planned']);
    expect(view.extras).toEqual([{ label: 'Available minutes', value: '360' }]);
  });

  it('tolerates strings, arrays and junk', () => {
    expect(toPlanView('Just do it').texts).toEqual([
      { label: 'Plan', text: 'Just do it' },
    ]);
    expect(toPlanView(['a', { name: 'b' }]).queue.map((q) => q.title)).toEqual([
      'a',
      'b',
    ]);
    expect(toPlanView(null)).toEqual({
      date: null,
      texts: [],
      queue: [],
      flags: [],
      extras: [],
    });
    expect(toPlanView(7).texts).toEqual([]);
  });
});

describe('toHandoffView', () => {
  it('reads title, status and result text from value_after', () => {
    expect(
      toHandoffView({
        entity_id: 'task_sp-1',
        created_at: '2026-10-26T10:00:00Z',
        value_after: {
          original_task: { title: 'Draft email' },
          status: 'done',
          recommendation: 'Send it.',
        },
      }),
    ).toEqual({
      title: 'Draft email',
      status: 'done',
      text: 'Send it.',
      createdAt: '2026-10-26T10:00:00Z',
    });
  });

  it('falls back to the entity id', () => {
    expect(toHandoffView({ entity_id: 'task_sp-9', value_after: 'x' })).toEqual({
      title: 'task_sp-9',
      status: null,
      text: null,
      createdAt: null,
    });
  });
});

describe('formatMinutes', () => {
  it('formats minutes', () => {
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(65)).toBe('1h 05m');
    expect(formatMinutes(-3)).toBe('0m');
  });
});
