import { fakeAsync, flush, tick } from '@angular/core/testing';
import { hostIdleTime$ } from './flow-os-host';

describe('hostIdleTime$', () => {
  it('polls on the interval and emits only idle times above the minimum', fakeAsync(() => {
    const answers = [30_000, 61_000, null, 120_000];
    const seen: number[] = [];
    const sub = hostIdleTime$(
      () => Promise.resolve({ idleMs: answers.shift() ?? null }),
      1000,
      60_000,
    ).subscribe((ms) => seen.push(ms));

    tick(999);
    expect(seen).toEqual([]);
    tick(1);
    expect(seen).toEqual([]); // 30 s: below the minimum
    tick(1000);
    expect(seen).toEqual([61_000]);
    tick(1000);
    expect(seen).toEqual([61_000]); // the host could not say
    tick(1000);
    expect(seen).toEqual([61_000, 120_000]);
    sub.unsubscribe();
    flush();
  }));

  it('skips a failed poll and keeps polling', fakeAsync(() => {
    let calls = 0;
    const seen: number[] = [];
    const sub = hostIdleTime$(
      () =>
        ++calls === 1
          ? Promise.reject(new Error('down'))
          : Promise.resolve({ idleMs: 90_000 }),
      1000,
      60_000,
    ).subscribe((ms) => seen.push(ms));

    tick(1000);
    expect(seen).toEqual([]);
    tick(1000);
    expect(seen).toEqual([90_000]);
    sub.unsubscribe();
    flush();
  }));
});
