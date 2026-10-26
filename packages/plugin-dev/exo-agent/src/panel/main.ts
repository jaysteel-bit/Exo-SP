// Exo AI panel (index.html). Thin renderer: every Flow OS read/write is done
// by plugin.js through the PLUGIN_MESSAGE bridge; this file holds no secrets.
// Only `import type` from ../core — see core/messages.ts.
import type {
  PanelMessage,
  PanelState,
  PollPlanResult,
  RequestPlanResult,
  SaveConfigResult,
} from '../core/messages';
import type { DriftEntry } from '../core/tasks';
import type { DiffRow } from '../core/diff';
import { formatMinutes, toHandoffView, toPlanView } from './view-model';
import './panel.css';

const POLL_INTERVAL_MS = 5_000;
const MESSAGE_TIMEOUT_MS = 40_000;

// ------------------------------------------------------------------ bridge

const send = <T>(message: PanelMessage): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const messageId = `exo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const cleanup = (): void => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) return;
      const data = event.data as {
        type?: string;
        messageId?: string;
        result?: unknown;
        error?: string;
      };
      if (data?.messageId !== messageId) return;
      if (data.type === 'PLUGIN_MESSAGE_RESPONSE') {
        cleanup();
        resolve(data.result as T);
      } else if (data.type === 'PLUGIN_MESSAGE_ERROR') {
        cleanup();
        reject(new Error(data.error || 'Plugin message failed'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Exo AI did not respond'));
    }, MESSAGE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'PLUGIN_MESSAGE', message, messageId }, '*');
  });

// ------------------------------------------------------------------ dom helpers

type Child = Node | string | null | undefined | false;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

// ------------------------------------------------------------------ rendering

const renderPlan = (plan: DiffRow | null, error: string | null): Node => {
  if (error) return el('p', { class: 'error' }, `Could not load the plan: ${error}`);
  if (!plan) {
    return el('p', { class: 'text-muted' }, 'No plan yet. Ask Exo AI to plan your day.');
  }
  const view = toPlanView(plan.value_after);
  const card = el(
    'div',
    { class: 'card plan' },
    el(
      'div',
      { class: 'meta text-muted' },
      `Proposed ${formatTime(plan.created_at)}${view.date ? ` · for ${view.date}` : ''}`,
    ),
  );
  for (const t of view.texts) {
    card.append(
      el('div', { class: 'label' }, t.label),
      el('p', { class: 'prose' }, t.text),
    );
  }
  if (view.queue.length) {
    const ol = el('ol', { class: 'queue' });
    for (const q of view.queue) {
      const meta = [q.start, q.minutes !== null ? formatMinutes(q.minutes) : null]
        .filter(Boolean)
        .join(' · ');
      ol.append(
        el(
          'li',
          {},
          el('span', { class: 'q-title' }, q.title),
          meta ? el('span', { class: 'q-meta text-muted' }, ` ${meta}`) : null,
          q.note ? el('div', { class: 'q-note text-muted' }, q.note) : null,
        ),
      );
    }
    card.append(el('div', { class: 'label' }, 'Queue'), ol);
  }
  if (view.flags.length) {
    const ul = el('ul', { class: 'flags' });
    view.flags.forEach((f) => ul.append(el('li', {}, f)));
    card.append(el('div', { class: 'label' }, 'Drift flags'), ul);
  }
  if (view.extras.length) {
    const dl = el('dl', { class: 'extras' });
    view.extras.forEach((x) => dl.append(el('dt', {}, x.label), el('dd', {}, x.value)));
    card.append(dl);
  }
  if (
    !view.texts.length &&
    !view.queue.length &&
    !view.flags.length &&
    !view.extras.length
  ) {
    card.append(
      el('pre', { class: 'raw' }, JSON.stringify(plan.value_after, null, 2) ?? 'null'),
    );
  }
  return card;
};

const renderDrift = (drift: DriftEntry[]): Node => {
  if (!drift.length) {
    return el('p', { class: 'text-muted' }, 'No open task is over or near its estimate.');
  }
  const ul = el('ul', { class: 'rows' });
  for (const d of drift) {
    ul.append(
      el(
        'li',
        { class: `row ${d.status}` },
        el('span', { class: 'row-title' }, d.title),
        el(
          'span',
          { class: 'row-meta' },
          `${formatMinutes(d.spent_minutes)} / ${formatMinutes(d.estimate_minutes)}`,
          el(
            'span',
            { class: `badge ${d.status}` },
            d.status === 'over' ? `${Math.round(d.ratio * 100)}%` : 'near',
          ),
        ),
      ),
    );
  }
  return ul;
};

const renderHandoffs = (rows: DiffRow[], error: string | null): Node => {
  if (error)
    return el('p', { class: 'error' }, `Could not load handed-off work: ${error}`);
  if (!rows.length) {
    return el(
      'p',
      { class: 'text-muted' },
      'Nothing finished yet. Use "Send to Exo AI" in a task\'s context menu to hand work off.',
    );
  }
  const list = el('div', { class: 'handoffs' });
  for (const row of rows) {
    const v = toHandoffView(row);
    list.append(
      el(
        'div',
        { class: 'card handoff' },
        el(
          'div',
          { class: 'handoff-head' },
          el('span', { class: 'row-title' }, v.title),
          v.status ? el('span', { class: 'badge' }, v.status) : null,
        ),
        v.text ? el('p', { class: 'prose' }, v.text) : null,
        el('div', { class: 'meta text-muted' }, formatTime(v.createdAt)),
      ),
    );
  }
  return list;
};

// ------------------------------------------------------------------ state

let state: PanelState | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const setPlanStatus = (text: string, kind: '' | 'busy' | 'error' = ''): void => {
  const s = byId<HTMLParagraphElement>('plan-status');
  s.textContent = text;
  s.className = `status ${kind}`;
};

const render = (): void => {
  if (!state) return;
  const pill = byId<HTMLSpanElement>('conn-pill');
  pill.textContent = state.connected
    ? 'Connected to Flow OS'
    : 'Not connected to Flow OS';
  pill.className = `pill ${state.connected ? 'ok' : 'off'}`;

  byId('plan-body').replaceChildren(renderPlan(state.plan, state.planError));
  byId('drift-body').replaceChildren(renderDrift(state.drift));
  byId('handoffs-body').replaceChildren(
    renderHandoffs(state.handoffs, state.handoffsError),
  );
  byId('today-count').textContent = `${state.openTodayTaskCount} open task${
    state.openTodayTaskCount === 1 ? '' : 's'
  } today`;
  byId<HTMLButtonElement>('plan-btn').disabled = !state.connected || pollTimer !== null;

  byId('config-source').textContent =
    state.configSource === 'override'
      ? 'Using the connection saved here.'
      : state.configSource === 'build'
        ? 'Using the connection built into this app.'
        : 'No connection configured.';
  byId('config-host').textContent = `Only https://${state.allowedHost} is allowed.`;
  const urlInput = byId<HTMLInputElement>('cfg-url');
  if (!urlInput.value && state.override.url) urlInput.value = state.override.url;
  byId<HTMLInputElement>('cfg-key').placeholder = state.override.hasKey
    ? '(saved — leave empty to keep)'
    : 'anon key';
};

const refresh = async (): Promise<void> => {
  const btn = byId<HTMLButtonElement>('refresh-btn');
  btn.disabled = true;
  try {
    state = await send<PanelState>({ type: 'exo:getState' });
    render();
    if (state.pendingPlanRequest && pollTimer === null) startPolling();
  } catch (e) {
    byId('plan-body').replaceChildren(
      el('p', { class: 'error' }, `Exo AI is unavailable: ${(e as Error).message}`),
    );
  } finally {
    btn.disabled = false;
  }
};

const stopPolling = (): void => {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  if (state) byId<HTMLButtonElement>('plan-btn').disabled = !state.connected;
};

const pollOnce = async (): Promise<void> => {
  let res: PollPlanResult;
  try {
    res = await send<PollPlanResult>({ type: 'exo:pollPlan' });
  } catch {
    return; // transient; next tick retries
  }
  if (res.isNew && state) {
    state.plan = res.plan;
    state.planError = null;
    stopPolling();
    render();
    setPlanStatus('Exo AI proposed a new plan.');
  } else if (res.expired) {
    stopPolling();
    setPlanStatus('Exo AI did not answer within 3 minutes. Try again later.', 'error');
  }
};

function startPolling(): void {
  stopPolling();
  setPlanStatus('Exo AI is planning…', 'busy');
  byId<HTMLButtonElement>('plan-btn').disabled = true;
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

const askForPlan = async (): Promise<void> => {
  const input = byId<HTMLInputElement>('available-minutes');
  const availableMinutes = Number(input.value);
  byId<HTMLButtonElement>('plan-btn').disabled = true;
  setPlanStatus('Sending request…', 'busy');
  try {
    const res = await send<RequestPlanResult>({
      type: 'exo:requestPlan',
      payload: { availableMinutes },
    });
    if (!res.ok) {
      setPlanStatus(`Could not ask Exo AI: ${res.error}`, 'error');
      byId<HTMLButtonElement>('plan-btn').disabled = !state?.connected;
      return;
    }
    startPolling();
  } catch (e) {
    setPlanStatus(`Could not ask Exo AI: ${(e as Error).message}`, 'error');
    byId<HTMLButtonElement>('plan-btn').disabled = !state?.connected;
  }
};

const saveConfig = async (clear = false): Promise<void> => {
  const urlInput = byId<HTMLInputElement>('cfg-url');
  const keyInput = byId<HTMLInputElement>('cfg-key');
  const status = byId<HTMLParagraphElement>('cfg-status');
  if (clear) urlInput.value = '';
  const url = urlInput.value;
  // Keep a saved key when the field is left empty (plugin.js never sends it back).
  const anonKey = clear
    ? ''
    : keyInput.value || (state?.override.hasKey ? '__keep__' : '');
  status.textContent = 'Saving…';
  status.className = 'status busy';
  try {
    const res = await send<SaveConfigResult>({
      type: 'exo:saveConfig',
      payload: { url, anonKey },
    });
    if (!res.ok) {
      status.textContent = res.error;
      status.className = 'status error';
      return;
    }
    keyInput.value = '';
    status.textContent = res.connected
      ? 'Saved. Connected.'
      : 'Saved. Still not connected.';
    status.className = 'status';
    await refresh();
  } catch (e) {
    status.textContent = (e as Error).message;
    status.className = 'status error';
  }
};

byId('refresh-btn').addEventListener('click', () => void refresh());
byId('plan-btn').addEventListener('click', () => void askForPlan());
byId('cfg-save').addEventListener('click', () => void saveConfig());
byId('cfg-clear').addEventListener('click', () => void saveConfig(true));
void refresh();
