/**
 * System idle time inside Flowstate (fork-only).
 *
 * Upstream gets idle time from Electron's main process or from the Chrome
 * extension; the Flow OS pane has neither. This stream stands in for Electron's
 * loop in start-app.ts with the same constants: sample every
 * IDLE_PING_INTERVAL_MS, forward only periods over IDLE_MIN_IDLE_TIME_MS.
 * Everything after that (threshold, "only when tracking", focus-mode
 * suppression, the dialog) stays upstream's IdleEffects.
 */

import { from, Observable, of, timer } from 'rxjs';
import { catchError, exhaustMap, filter, share } from 'rxjs/operators';
import {
  IDLE_MIN_IDLE_TIME_MS,
  IDLE_PING_INTERVAL_MS,
} from '../../../../electron/shared-with-frontend/idle.const';
import { flowOsHostIdleMs } from './flow-os-host';

export const flowOsHostIdleTime$ = (
  readIdleMs: () => Promise<number | null> = flowOsHostIdleMs,
  intervalMs: number = IDLE_PING_INTERVAL_MS,
): Observable<number> =>
  timer(intervalMs, intervalMs).pipe(
    // A slow host answer skips a tick instead of stacking requests.
    exhaustMap(() => from(readIdleMs()).pipe(catchError(() => of(null)))),
    filter((ms): ms is number => ms !== null && ms > IDLE_MIN_IDLE_TIME_MS),
    share(),
  );
