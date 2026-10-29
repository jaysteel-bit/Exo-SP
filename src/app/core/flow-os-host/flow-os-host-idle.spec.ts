import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { flowOsHostIdleTime$ } from './flow-os-host-idle';

describe('flowOsHostIdleTime$', () => {
  it('samples on the interval and forwards only periods over the 60 s floor', fakeAsync(() => {
    const answers = [30_000, 60_000, 61_000, 95_000];
    const seen: number[] = [];
    const sub = flowOsHostIdleTime$(async () => answers.shift() ?? null, 1000).subscribe(
      (ms) => seen.push(ms),
    );
    tick(0);
    expect(seen).toEqual([]); // nothing before the first interval, like Electron
    for (let i = 0; i < 4; i++) {
      tick(1000);
      flushMicrotasks();
    }
    expect(seen).toEqual([61_000, 95_000]);
    sub.unsubscribe();
  }));

  it('keeps sampling after the host fails or cannot tell', fakeAsync(() => {
    const answers: (() => Promise<number | null>)[] = [
      () => Promise.reject(new Error('host gone')),
      async () => null,
      async () => 120_000,
    ];
    const seen: number[] = [];
    const sub = flowOsHostIdleTime$(() => answers.shift()!(), 1000).subscribe((ms) =>
      seen.push(ms),
    );
    for (let i = 0; i < 3; i++) {
      tick(1000);
      flushMicrotasks();
    }
    expect(seen).toEqual([120_000]);
    sub.unsubscribe();
  }));

  it('skips a tick instead of stacking requests while the host is slow', fakeAsync(() => {
    let calls = 0;
    const sub = flowOsHostIdleTime$(() => {
      calls++;
      return new Promise<number>((resolve) => setTimeout(() => resolve(90_000), 2500));
    }, 1000).subscribe();
    tick(3000);
    flushMicrotasks();
    expect(calls).toBe(1);
    tick(1000);
    flushMicrotasks();
    expect(calls).toBe(2);
    sub.unsubscribe();
    tick(5000);
  }));
});
