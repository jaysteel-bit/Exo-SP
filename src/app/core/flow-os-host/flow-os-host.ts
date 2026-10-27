/**
 * Flow OS host bridge (fork-only).
 *
 * Flow OS embeds this web build in a Tauri child webview served from
 * `http://flowstate.localhost/` and injects `window.__FLOW_OS_HOST__` before the
 * app boots. The host answers a few same-origin `/__host/*` requests itself, which
 * gives the web build the one desktop capability it lacks for plugin OAuth: a
 * loopback redirect listener plus the system browser. With it, desktop-only OAuth
 * clients (e.g. the bundled Google Calendar provider) work exactly as in Electron:
 * the desktop client id + secret, PKCE, and a `http://127.0.0.1:<port>` redirect.
 *
 * It also has no system idle time (Electron reads it from powerMonitor), so the host
 * answers `/__host/idle`, which feeds the idle dialog the same way IPC.IDLE_TIME does.
 *
 * Every request carries the per-launch token the host injected, so another page or
 * local process cannot drive the host.
 */

import { EMPTY, from, Observable, timer } from 'rxjs';
import { catchError, exhaustMap, filter, map } from 'rxjs/operators';
import {
  IDLE_MIN_IDLE_TIME_MS,
  IDLE_PING_INTERVAL_MS,
} from '../../../../electron/shared-with-frontend/idle.const';

interface FlowOsHostInfo {
  token: string;
  version: number;
}

declare global {
  interface Window {
    // The host picks this global's name; it is not ours to rename.
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __FLOW_OS_HOST__?: FlowOsHostInfo;
  }
}

const HOST_ORIGIN_HOSTNAME = 'flowstate.localhost';
const HOST_TOKEN_HEADER = 'x-flow-os-host';
const CONTENT_TYPE_HEADER = 'content-type';

/** Bundled plugins that start enabled inside Flowstate (until the user toggles them). */
export const FLOW_OS_DEFAULT_ENABLED_PLUGINS: ReadonlySet<string> = new Set([
  'exo-agent',
  'google-calendar-provider',
]);

export const IS_FLOW_OS_HOST =
  typeof window !== 'undefined' &&
  !!window.__FLOW_OS_HOST__?.token &&
  window.location.hostname === HOST_ORIGIN_HOSTNAME;

export interface FlowOsOAuthResult {
  code?: string;
  state?: string;
  error?: string;
}

const callHost = async <T>(path: string, body: unknown = {}): Promise<T> => {
  const info = window.__FLOW_OS_HOST__;
  if (!IS_FLOW_OS_HOST || !info) {
    throw new Error('Flow OS host is not available');
  }
  const res = await fetch(`/__host/${path}`, {
    method: 'POST',
    headers: {
      [CONTENT_TYPE_HEADER]: 'application/json',
      [HOST_TOKEN_HEADER]: info.token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Flow OS host ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
};

/** Start (or reuse) the host's loopback listener; resolves with its port. */
export const flowOsHostOAuthPrepare = (port?: number): Promise<{ port: number }> =>
  callHost('oauth/prepare', { port: port || null });

/** Open the authorization URL in the system browser (Google blocks embedded sign-in). */
export const flowOsHostOAuthStart = (url: string): Promise<{ ok: true }> =>
  callHost('oauth/start', { url });

/** Long-poll the loopback result: the redirect's code/state, or an error/timeout. */
export const flowOsHostOAuthWait = (): Promise<FlowOsOAuthResult> =>
  callHost('oauth/wait');

/**
 * System idle time in the shape Electron's IDLE_TIME events have: polled every
 * `intervalMs`, emitted only above `minIdleMs`. A failed poll is skipped, never fatal.
 */
export const hostIdleTime$ = (
  readIdle: () => Promise<{ idleMs: number | null }>,
  intervalMs: number = IDLE_PING_INTERVAL_MS,
  minIdleMs: number = IDLE_MIN_IDLE_TIME_MS,
): Observable<number> =>
  timer(intervalMs, intervalMs).pipe(
    exhaustMap(() => from(readIdle()).pipe(catchError(() => EMPTY))),
    map((res) => res.idleMs),
    filter((ms): ms is number => typeof ms === 'number' && ms > minIdleMs),
  );

/** Milliseconds since the last keyboard or mouse input on the machine (null if unknown). */
export const flowOsHostIdleTime$: Observable<number> = hostIdleTime$(() =>
  callHost<{ idleMs: number | null }>('idle'),
);
