import { FlowOsConfig } from './config';
import {
  buildEmitDiffBody,
  DiffEvent,
  DiffRow,
  FLOW_OS_CLIENT_ID,
  isEmittableEvent,
  isReadableEvent,
  ReadableEvent,
} from './diff';

/** Same shape as PluginAPI.request (injected so tests never hit the network). */
export type RequestFn = (
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;
  },
) => Promise<unknown>;

export type EmitResult =
  | { ok: true; id: number }
  | { ok: false; error: string; notConnected?: boolean };

const REQUEST_TIMEOUT_MS = 15_000;

const errorText = (e: unknown): string => {
  if (e && typeof e === 'object') {
    const body = (e as { error?: unknown }).error;
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      const msg = b.message ?? b.error ?? b.hint ?? b.details;
      if (typeof msg === 'string' && msg) return msg;
    }
    if (typeof body === 'string' && body) return body;
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(e);
};

/**
 * Interpret the emit_diff RPC result: the new diff id (a number, possibly
 * serialized as a string) on success, or a JSON error object.
 */
export const parseEmitResponse = (res: unknown): EmitResult => {
  if (typeof res === 'number' && Number.isFinite(res)) {
    return { ok: true, id: res };
  }
  if (typeof res === 'string' && /^\d+$/.test(res.trim())) {
    return { ok: true, id: Number(res.trim()) };
  }
  if (res && typeof res === 'object') {
    const r = res as Record<string, unknown>;
    const msg = r.error ?? r.message ?? r.hint;
    return {
      ok: false,
      error: typeof msg === 'string' && msg ? msg : JSON.stringify(res).slice(0, 300),
    };
  }
  return { ok: false, error: `Unexpected emit_diff response: ${String(res)}` };
};

export class FlowOsClient {
  constructor(
    private readonly _getConfig: () => FlowOsConfig,
    private readonly _request: RequestFn,
    private readonly _pluginVersion: string,
  ) {}

  isConnected(): boolean {
    return this._getConfig().source !== 'none';
  }

  private _headers(cfg: FlowOsConfig): Record<string, string> {
    return {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      'Content-Type': 'application/json',
    };
  }

  async emit(ev: DiffEvent): Promise<EmitResult> {
    const cfg = this._getConfig();
    if (cfg.source === 'none') {
      return { ok: false, error: 'Not connected to Flow OS', notConnected: true };
    }
    if (!isEmittableEvent(ev.event)) {
      return { ok: false, error: `Event "${String(ev.event)}" may not be emitted` };
    }
    try {
      const res = await this._request(`${cfg.url}/rest/v1/rpc/emit_diff`, {
        method: 'POST',
        headers: this._headers(cfg),
        body: buildEmitDiffBody(ev, this._pluginVersion),
        timeout: REQUEST_TIMEOUT_MS,
      });
      return parseEmitResponse(res);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  /**
   * Can this connection read back a diff it just wrote? Row security answers an
   * unreadable row with an empty list, not an error, so without this check the
   * panel would wait for a reply it can never see.
   */
  async canRead(diffId: number): Promise<boolean> {
    const cfg = this._getConfig();
    if (cfg.source === 'none') return false;
    const url =
      `${cfg.url}/rest/v1/diffs` +
      `?client_id=eq.${FLOW_OS_CLIENT_ID}&id=eq.${Math.floor(diffId)}&select=id&limit=1`;
    const res = await this._request(url, {
      method: 'GET',
      headers: this._headers(cfg),
      timeout: REQUEST_TIMEOUT_MS,
    }).catch((e: unknown) => {
      throw new Error(errorText(e));
    });
    return Array.isArray(res) && res.length > 0;
  }

  /** Latest diffs of one server-written event for this client, newest first. */
  async latest(event: ReadableEvent, limit: number): Promise<DiffRow[]> {
    const cfg = this._getConfig();
    if (cfg.source === 'none' || !isReadableEvent(event)) {
      return [];
    }
    const url =
      `${cfg.url}/rest/v1/diffs` +
      `?client_id=eq.${FLOW_OS_CLIENT_ID}` +
      `&event=${encodeURIComponent(`eq.${event}`)}` +
      `&order=created_at.desc&limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`;
    const res = await this._request(url, {
      method: 'GET',
      headers: this._headers(cfg),
      timeout: REQUEST_TIMEOUT_MS,
    }).catch((e: unknown) => {
      throw new Error(errorText(e));
    });
    return Array.isArray(res)
      ? res.filter((r): r is DiffRow => !!r && typeof r === 'object')
      : [];
  }
}

/**
 * Is `row` a plan proposed after the request? Prefer the monotonic diff id the
 * request returned; fall back to created_at (server clock) vs the local
 * request time, with a small skew allowance.
 */
export const isPlanNewerThanRequest = (
  row: DiffRow | null | undefined,
  request: { diffId: number | null; requestedAt: number },
  skewMs = 10_000,
): boolean => {
  if (!row) return false;
  const rowId = typeof row.id === 'string' ? Number(row.id) : row.id;
  if (request.diffId !== null && typeof rowId === 'number' && Number.isFinite(rowId)) {
    return rowId > request.diffId;
  }
  const created = row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(created) && created >= request.requestedAt - skewMs;
};
