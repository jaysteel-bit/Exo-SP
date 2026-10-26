/** Must match manifest.json "allowedHosts" (guarded by a unit test). */
export const ALLOWED_HOSTS = ['jdjyiyeddpfzpgrqffav.supabase.co'] as const;

export const CONFIG_STORAGE_KEY = 'config';

export interface FlowOsConfig {
  url: string;
  anonKey: string;
  source: 'override' | 'build' | 'none';
}

export interface ConfigOverride {
  url?: string;
  anonKey?: string;
}

export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

export const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const isAllowedUrl = (url: string): boolean => {
  const host = hostOf(url);
  return (
    !!host &&
    url.trim().toLowerCase().startsWith('https://') &&
    (ALLOWED_HOSTS as readonly string[]).includes(host)
  );
};

/**
 * Override (saved from the panel via persistDataSynced) beats the build-time
 * values, field by field. Connected only when both a URL and a key exist.
 */
export const resolveConfig = (
  build: { url: string; anonKey: string },
  override: ConfigOverride | null,
): FlowOsConfig => {
  const oUrl = override?.url?.trim() ?? '';
  const oKey = override?.anonKey?.trim() ?? '';
  const url = normalizeUrl(oUrl || build.url || '');
  const anonKey = oKey || build.anonKey?.trim() || '';
  if (!url || !anonKey) {
    return { url, anonKey: '', source: 'none' };
  }
  return { url, anonKey, source: oUrl || oKey ? 'override' : 'build' };
};

export const parseStoredOverride = (raw: string | null): ConfigOverride | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const out: ConfigOverride = {};
    if (typeof o.url === 'string' && o.url.trim()) out.url = o.url.trim();
    if (typeof o.anonKey === 'string' && o.anonKey.trim()) out.anonKey = o.anonKey.trim();
    return out.url || out.anonKey ? out : null;
  } catch {
    return null;
  }
};

/** Validate panel input. Empty fields clear that part of the override. */
export const validateOverride = (
  input: ConfigOverride,
): { ok: true; value: ConfigOverride } | { ok: false; error: string } => {
  const url = input.url?.trim() ?? '';
  const anonKey = input.anonKey?.trim() ?? '';
  if (url && !isAllowedUrl(url)) {
    return {
      ok: false,
      error: `URL must be https://${ALLOWED_HOSTS[0]} (the only host this plugin may reach).`,
    };
  }
  const value: ConfigOverride = {};
  if (url) value.url = normalizeUrl(url);
  if (anonKey) value.anonKey = anonKey;
  return { ok: true, value };
};
