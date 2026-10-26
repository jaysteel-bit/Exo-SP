// Exo AI plugin for Super Productivity.
//
// Event-driven (no polling): host hooks are mapped to Flow OS `ops` diffs and
// sent through the `emit_diff` RPC. All behaviour lives in core/agent.ts; this
// file only wires it to the host. NOTE: plugin.js is executed by the host via
// `new Function`, so this entry must not share runtime modules with the panel
// bundle (a shared chunk would add an `import` statement here).
import type { PluginAPI } from '@super-productivity/plugin-api';
import { AgentDeps, ExoAgent, HostApi } from './core/agent';
import { normalizeFocusMode } from './core/focus-tracker';

declare const plugin: PluginAPI;

// SP's focus-mode reducer reads its initial mode from this localStorage key
// (core/persistence/storage-keys.const.ts LS.FOCUS_MODE_MODE) and defaults to
// Countdown; mirror that so sessions get the right mode before any Set Mode.
const readInitialFocusMode = (): AgentDeps['initialFocusMode'] => {
  try {
    return normalizeFocusMode(globalThis.localStorage?.getItem('FOCUS_MODE_MODE'));
  } catch {
    return null;
  }
};

const host: HostApi = {
  getTasks: () => plugin.getTasks(),
  getAllProjects: () => plugin.getAllProjects(),
  showSnack: (cfg) => plugin.showSnack(cfg),
  persistDataSynced: (data, key) => plugin.persistDataSynced(data, key),
  loadSyncedData: (key) => plugin.loadSyncedData(key),
  request: (url, options) => plugin.request(url, options),
  log: {
    info: (...a) => plugin.log.info(...a),
    warn: (...a) => plugin.log.warn(...a),
    err: (...a) => plugin.log.err(...a),
  },
};

const agent = new ExoAgent(host, {
  build: { url: __FLOW_OS_SUPABASE_URL__, anonKey: __FLOW_OS_SUPABASE_ANON_KEY__ },
  pluginVersion: __EXO_AGENT_VERSION__,
  initialFocusMode: readInitialFocusMode(),
});

// Hooks. Handlers return quickly: the host awaits each one sequentially.
plugin.registerHook(plugin.Hooks.TASK_COMPLETE, (payload) => {
  void agent.onTaskComplete(payload);
});
plugin.registerHook(plugin.Hooks.CURRENT_TASK_CHANGE, (payload) => {
  agent.onCurrentTaskChange(payload);
});
plugin.registerHook(plugin.Hooks.ACTION, (payload) => {
  agent.onAction(payload);
});
// Awaited by the host before it archives the day (reads tasks, then sends).
plugin.registerHook(plugin.Hooks.FINISH_DAY, (payload) => agent.onFinishDay(payload));

// Task context menu: hand the task off to the Exo AI worker.
if (typeof plugin.registerTaskContextMenuEntry === 'function') {
  plugin.registerTaskContextMenuEntry({
    id: 'send-to-exo-ai',
    label: 'Send to Exo AI',
    icon: 'smart_toy',
    onClick: async ({ taskId }) => {
      await agent.sendTaskToExoAi(taskId);
    },
  });
}

// The side panel button is registered by the host from manifest "sidePanel":
// true (plugin-runner calls registerSidePanelButton with the manifest name and
// icon). Plugins cannot dispatch the layout action that toggles that panel, so
// the header button opens the same index.html as a full view.
plugin.registerHeaderButton({
  label: 'Exo AI',
  icon: 'auto_awesome',
  onClick: () => plugin.showIndexHtmlAsView(),
});

// Panel iframe -> plugin.js bridge (all Flow OS reads/writes happen here).
plugin.onMessage?.((message) => agent.handlePanelMessage(message));

plugin.onUnload?.(() => agent.dispose());

const start = (): Promise<void> =>
  agent.init().catch((e: unknown) => plugin.log.err('Exo AI: init failed', e));

if (typeof plugin.onReady === 'function') {
  plugin.onReady(start);
} else {
  void start();
}
