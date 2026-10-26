/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { superProductivityPlugin } from '@super-productivity/vite-plugin';

// Flow OS connection is injected at BUILD time and never committed:
//   FLOW_OS_SUPABASE_URL       (optional, defaults to the Exo Flow OS project)
//   FLOW_OS_SUPABASE_ANON_KEY  (required for emits; without it the plugin loads,
//                               shows "Exo AI: not connected to Flow OS" once and
//                               skips all emits)
// A runtime override (url + anonKey) can also be saved from the Exo AI panel; it
// is stored with persistDataSynced and wins over the build-time values.
// The URL host must stay in manifest.json "allowedHosts" or requests are blocked.
const DEFAULT_FLOW_OS_SUPABASE_URL = 'https://jdjyiyeddpfzpgrqffav.supabase.co';

const manifest = JSON.parse(
  readFileSync(new URL('./src/manifest.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  base: './',
  // The SP plugin's closeBundle hook also fires under vitest; skip it there so
  // a test run never copies a half-built plugin into src/assets.
  plugins: process.env.VITEST
    ? []
    : [
        superProductivityPlugin({
          copyTo: '../../../src/assets/bundled-plugins/exo-agent',
        }),
      ],
  define: {
    __FLOW_OS_SUPABASE_URL__: JSON.stringify(
      process.env.FLOW_OS_SUPABASE_URL || DEFAULT_FLOW_OS_SUPABASE_URL,
    ),
    __FLOW_OS_SUPABASE_ANON_KEY__: JSON.stringify(
      process.env.FLOW_OS_SUPABASE_ANON_KEY || '',
    ),
    __EXO_AGENT_VERSION__: JSON.stringify(manifest.version),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
