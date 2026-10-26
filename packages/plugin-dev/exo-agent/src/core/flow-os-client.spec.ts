import { describe, expect, it, vi } from 'vitest';
import { FlowOsConfig } from './config';
import { DiffEvent, EmittableEvent } from './diff';
import {
  FlowOsClient,
  isPlanNewerThanRequest,
  parseEmitResponse,
} from './flow-os-client';

const CFG: FlowOsConfig = {
  url: 'https://jdjyiyeddpfzpgrqffav.supabase.co',
  anonKey: 'test-anon-key',
  source: 'build',
};
const EV: DiffEvent = {
  entityId: 'task_sp-1',
  event: 'task=completed',
  valueBefore: { status: 'open' },
  valueAfter: { status: 'done' },
};

describe('FlowOsClient.emit', () => {
  it('POSTs the emit_diff RPC with anon headers and returns the diff id', async () => {
    const request = vi.fn().mockResolvedValue(4711);
    const client = new FlowOsClient(() => CFG, request, '1.2.3');
    await expect(client.emit(EV)).resolves.toEqual({ ok: true, id: 4711 });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, opts] = request.mock.calls[0];
    expect(url).toBe('https://jdjyiyeddpfzpgrqffav.supabase.co/rest/v1/rpc/emit_diff');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({
      apikey: 'test-anon-key',
      Authorization: 'Bearer test-anon-key',
      'Content-Type': 'application/json',
    });
    expect(opts.body).toEqual({
      p_client_id: 'e0000000-0000-4000-8000-000000000001',
      p_namespace: 'ops',
      p_entity_id: 'task_sp-1',
      p_event: 'task=completed',
      p_value_before: { status: 'open' },
      p_value_after: { status: 'done' },
      p_actor: 'app:super-productivity',
      p_metadata: { bridge: 'exo-agent', plugin_version: '1.2.3' },
    });
  });

  it('skips the network when not connected', async () => {
    const request = vi.fn();
    const client = new FlowOsClient(
      () => ({ url: CFG.url, anonKey: '', source: 'none' }),
      request,
      '1',
    );
    await expect(client.emit(EV)).resolves.toMatchObject({
      ok: false,
      notConnected: true,
    });
    expect(client.isConnected()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses non-vocabulary events without a request', async () => {
    const request = vi.fn();
    const client = new FlowOsClient(() => CFG, request, '1');
    const res = await client.emit({
      ...EV,
      event: 'task=agent_completed' as unknown as EmittableEvent,
    });
    expect(res.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('reports JSON errors and HTTP errors', async () => {
    const jsonErr = new FlowOsClient(
      () => CFG,
      vi.fn().mockResolvedValue({ error: 'unknown event' }),
      '1',
    );
    await expect(jsonErr.emit(EV)).resolves.toEqual({
      ok: false,
      error: 'unknown event',
    });

    const httpErr = new FlowOsClient(
      () => CFG,
      vi.fn().mockRejectedValue(
        Object.assign(new Error('[PluginHttp] Request failed with status 400'), {
          status: 400,
          error: { message: 'event not allowed', code: 'P0001' },
        }),
      ),
      '1',
    );
    await expect(httpErr.emit(EV)).resolves.toEqual({
      ok: false,
      error: 'event not allowed',
    });
  });
});

describe('parseEmitResponse', () => {
  it('accepts numbers and numeric strings only', () => {
    expect(parseEmitResponse(12)).toEqual({ ok: true, id: 12 });
    expect(parseEmitResponse('13')).toEqual({ ok: true, id: 13 });
    expect(parseEmitResponse({ message: 'nope' })).toEqual({ ok: false, error: 'nope' });
    expect(parseEmitResponse(null).ok).toBe(false);
  });
});

describe('FlowOsClient.latest', () => {
  it('GETs diffs filtered by client and event, newest first', async () => {
    const rows = [{ id: 9, event: 'plan=proposed', value_after: {} }];
    const request = vi.fn().mockResolvedValue(rows);
    const client = new FlowOsClient(() => CFG, request, '1');
    await expect(client.latest('plan=proposed', 1)).resolves.toEqual(rows);
    expect(request.mock.calls[0][0]).toBe(
      'https://jdjyiyeddpfzpgrqffav.supabase.co/rest/v1/diffs' +
        '?client_id=eq.e0000000-0000-4000-8000-000000000001' +
        '&event=eq.plan%3Dproposed&order=created_at.desc&limit=1',
    );
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('returns [] when not connected or the response is not an array; throws readable errors', async () => {
    const off = new FlowOsClient(
      () => ({ ...CFG, anonKey: '', source: 'none' }),
      vi.fn(),
      '1',
    );
    await expect(off.latest('task=agent_completed', 10)).resolves.toEqual([]);
    const weird = new FlowOsClient(() => CFG, vi.fn().mockResolvedValue({}), '1');
    await expect(weird.latest('task=agent_completed', 10)).resolves.toEqual([]);
    const failing = new FlowOsClient(
      () => CFG,
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('x'), { error: { message: 'JWT expired' } }),
        ),
      '1',
    );
    await expect(failing.latest('plan=proposed', 1)).rejects.toThrow('JWT expired');
  });
});

describe('isPlanNewerThanRequest', () => {
  const requestedAt = Date.parse('2026-10-26T08:00:00Z');
  it('uses the diff id when both sides have one', () => {
    expect(isPlanNewerThanRequest({ id: 11 }, { diffId: 10, requestedAt })).toBe(true);
    expect(isPlanNewerThanRequest({ id: '9' }, { diffId: 10, requestedAt })).toBe(false);
  });
  it('falls back to created_at with skew allowance', () => {
    const req = { diffId: null, requestedAt };
    expect(isPlanNewerThanRequest({ created_at: '2026-10-26T08:00:30Z' }, req)).toBe(
      true,
    );
    expect(isPlanNewerThanRequest({ created_at: '2026-10-26T07:59:55Z' }, req)).toBe(
      true,
    );
    expect(isPlanNewerThanRequest({ created_at: '2026-10-26T07:50:00Z' }, req)).toBe(
      false,
    );
    expect(isPlanNewerThanRequest(null, req)).toBe(false);
  });
});
