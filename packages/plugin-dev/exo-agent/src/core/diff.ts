/**
 * Flow OS diff vocabulary (namespace "ops") and the emit_diff RPC body.
 *
 * Only EMITTABLE_EVENTS may be written by this plugin. The READABLE_EVENTS are
 * written by the server-side Exo AI worker; the panel only reads them.
 */

export const FLOW_OS_CLIENT_ID = 'e0000000-0000-4000-8000-000000000001';
export const FLOW_OS_NAMESPACE = 'ops';
export const FLOW_OS_ACTOR = 'app:super-productivity';
export const BRIDGE_NAME = 'exo-agent';
export const SOURCE = 'super-productivity';

export const EMITTABLE_EVENTS = [
  'task=completed',
  'focus=completed',
  'tracking=started',
  'tracking=stopped',
  'day=finished',
  'task=handed_off',
  'plan=requested',
] as const;

export type EmittableEvent = (typeof EMITTABLE_EVENTS)[number];

export const READABLE_EVENTS = [
  'plan=proposed',
  'task=agent_completed',
  'agent_run=completed',
] as const;

export type ReadableEvent = (typeof READABLE_EVENTS)[number];

export const isEmittableEvent = (event: string): event is EmittableEvent =>
  (EMITTABLE_EVENTS as readonly string[]).includes(event);

export const isReadableEvent = (event: string): event is ReadableEvent =>
  (READABLE_EVENTS as readonly string[]).includes(event);

/** A diff this plugin wants to emit, before it is wrapped in the RPC body. */
export interface DiffEvent {
  entityId: string;
  event: EmittableEvent;
  valueBefore: Record<string, unknown> | null;
  valueAfter: Record<string, unknown>;
}

export interface EmitDiffBody {
  p_client_id: string;
  p_namespace: string;
  p_entity_id: string;
  p_event: EmittableEvent;
  p_value_before: Record<string, unknown> | null;
  p_value_after: Record<string, unknown>;
  p_actor: string;
  p_metadata: { bridge: string; plugin_version: string };
}

export const buildEmitDiffBody = (ev: DiffEvent, pluginVersion: string): EmitDiffBody => {
  if (!isEmittableEvent(ev.event)) {
    throw new Error(`Exo AI: event "${String(ev.event)}" is not in the ops vocabulary`);
  }
  return {
    p_client_id: FLOW_OS_CLIENT_ID,
    p_namespace: FLOW_OS_NAMESPACE,
    p_entity_id: ev.entityId,
    p_event: ev.event,
    p_value_before: ev.valueBefore,
    p_value_after: ev.valueAfter,
    p_actor: FLOW_OS_ACTOR,
    p_metadata: { bridge: BRIDGE_NAME, plugin_version: pluginVersion },
  };
};

/** One row of the Flow OS `diffs` table, as far as the panel relies on it. */
export interface DiffRow {
  id?: number | string;
  entity_id?: string;
  event?: string;
  value_before?: unknown;
  value_after?: unknown;
  actor?: string;
  created_at?: string;
}
