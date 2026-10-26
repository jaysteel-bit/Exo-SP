import { describe, expect, it } from 'vitest';
import {
  computeDayTaskStats,
  computeEstimateDrift,
  isScheduledForDay,
  SpTask,
} from './tasks';

const MIN = 60_000;
const at = (h: number, day = 26): number => new Date(2026, 9, day, h).getTime();

describe('isScheduledForDay', () => {
  it('dueWithTime wins over dueDay', () => {
    expect(
      isScheduledForDay({ id: '1', title: '', dueDay: '2026-10-26' }, '2026-10-26'),
    ).toBe(true);
    expect(
      isScheduledForDay({ id: '1', title: '', dueWithTime: at(10) }, '2026-10-26'),
    ).toBe(true);
    expect(
      isScheduledForDay(
        { id: '1', title: '', dueWithTime: at(10, 27), dueDay: '2026-10-26' },
        '2026-10-26',
      ),
    ).toBe(false);
  });
});

describe('computeEstimateDrift', () => {
  const tasks: SpTask[] = [
    { id: 'over', title: 'Over', timeEstimate: 60 * MIN, timeSpent: 90 * MIN },
    { id: 'near', title: 'Near', timeEstimate: 60 * MIN, timeSpent: 50 * MIN },
    { id: 'fine', title: 'Fine', timeEstimate: 60 * MIN, timeSpent: 30 * MIN },
    { id: 'exact80', title: '80%', timeEstimate: 100 * MIN, timeSpent: 80 * MIN },
    {
      id: 'done',
      title: 'Done',
      timeEstimate: 10 * MIN,
      timeSpent: 50 * MIN,
      isDone: true,
    },
    { id: 'noest', title: 'No estimate', timeEstimate: 0, timeSpent: 50 * MIN },
    {
      id: 'parent',
      title: 'Parent',
      timeEstimate: 10 * MIN,
      timeSpent: 50 * MIN,
      subTaskIds: ['x'],
    },
  ];

  it('lists open tasks over or above 80 % of their estimate, worst first', () => {
    expect(computeEstimateDrift(tasks)).toEqual([
      {
        sp_task_id: 'over',
        title: 'Over',
        spent_minutes: 90,
        estimate_minutes: 60,
        ratio: 1.5,
        status: 'over',
      },
      {
        sp_task_id: 'near',
        title: 'Near',
        spent_minutes: 50,
        estimate_minutes: 60,
        ratio: 0.83,
        status: 'near',
      },
    ]);
  });
});

describe('computeDayTaskStats', () => {
  it('counts planned TODAY tasks, leaf completions and leaf time on the day', () => {
    const tasks: SpTask[] = [
      {
        id: 'p',
        title: 'Parent',
        dueDay: '2026-10-26',
        subTaskIds: ['s1', 's2'],
        timeSpentOnDay: { '2026-10-26': 50 * MIN },
      },
      {
        id: 's1',
        title: 'Sub 1',
        parentId: 'p',
        isDone: true,
        doneOn: at(11),
        timeSpentOnDay: { '2026-10-26': 20 * MIN },
      },
      {
        id: 's2',
        title: 'Sub 2',
        parentId: 'p',
        timeSpentOnDay: { '2026-10-26': 30 * MIN },
      },
      {
        id: 'a',
        title: 'A',
        dueDay: '2026-10-26',
        isDone: true,
        doneOn: at(15),
        timeSpentOnDay: { '2026-10-26': 45 * MIN, '2026-10-25': 99 * MIN },
      },
      { id: 'b', title: 'B', isDone: true, doneOn: at(15, 25) },
    ];
    expect(computeDayTaskStats(tasks, '2026-10-26')).toEqual({
      planned: 2,
      completed: 2,
      totalWorkMinutes: 95,
    });
  });
});
