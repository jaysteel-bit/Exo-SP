/**
 * Message protocol between the panel iframe (index.html) and plugin.js.
 * The panel holds no credentials and makes no network calls itself: every
 * Flow OS read/write goes through plugin.js (`plugin.onMessage`).
 *
 * TYPE-ONLY module: the panel must import it with `import type` so no runtime
 * code is shared between the two bundles (a shared chunk would put an
 * `import` statement into plugin.js, which the host runs via `new Function`).
 */
import type { DiffRow } from './diff';
import type { DriftEntry } from './tasks';

export interface PendingPlanRequest {
  diffId: number | null;
  requestedAt: number;
}

export interface PanelState {
  connected: boolean;
  configSource: 'override' | 'build' | 'none';
  override: { url: string | null; hasKey: boolean };
  allowedHost: string;
  today: string;
  openTodayTaskCount: number;
  drift: DriftEntry[];
  plan: DiffRow | null;
  planError: string | null;
  handoffs: DiffRow[];
  handoffsError: string | null;
  pendingPlanRequest: PendingPlanRequest | null;
}

export type PanelMessage =
  | { type: 'exo:getState' }
  | { type: 'exo:requestPlan'; payload: { availableMinutes: number } }
  | { type: 'exo:pollPlan' }
  | { type: 'exo:saveConfig'; payload: { url: string; anonKey: string } };

export type RequestPlanResult =
  | { ok: true; request: PendingPlanRequest; taskCount: number }
  | { ok: false; error: string };

export interface PollPlanResult {
  plan: DiffRow | null;
  isNew: boolean;
  expired: boolean;
  error: string | null;
}

export type SaveConfigResult =
  | { ok: true; connected: boolean }
  | { ok: false; error: string };
