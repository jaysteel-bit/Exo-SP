import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS,
  isAllowedUrl,
  parseStoredOverride,
  resolveConfig,
  validateOverride,
} from './config';

const URL_OK = 'https://jdjyiyeddpfzpgrqffav.supabase.co';

describe('manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'),
  ) as { id: string; permissions: string[]; allowedHosts: string[]; hooks: string[] };

  it('declares the http capability and exactly the Flow OS host', () => {
    expect(manifest.id).toBe('exo-agent');
    expect(manifest.permissions).toContain('http');
    expect(manifest.allowedHosts).toEqual([...ALLOWED_HOSTS]);
  });

  it('declares the hooks it registers', () => {
    expect(manifest.hooks).toEqual(
      expect.arrayContaining([
        'taskComplete',
        'currentTaskChange',
        'finishDay',
        'action',
      ]),
    );
  });
});

describe('build-time defines (vitest uses vite.config define)', () => {
  it('defaults the URL to the Flow OS project', () => {
    expect(__FLOW_OS_SUPABASE_URL__).toMatch(/^https:\/\//);
    expect(typeof __FLOW_OS_SUPABASE_ANON_KEY__).toBe('string');
    expect(__EXO_AGENT_VERSION__).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('resolveConfig', () => {
  it('is not connected without a key', () => {
    expect(resolveConfig({ url: URL_OK, anonKey: '' }, null)).toEqual({
      url: URL_OK,
      anonKey: '',
      source: 'none',
    });
  });

  it('uses build values, override wins field by field', () => {
    expect(resolveConfig({ url: `${URL_OK}/`, anonKey: 'b' }, null)).toEqual({
      url: URL_OK,
      anonKey: 'b',
      source: 'build',
    });
    expect(resolveConfig({ url: URL_OK, anonKey: '' }, { anonKey: 'o' })).toEqual({
      url: URL_OK,
      anonKey: 'o',
      source: 'override',
    });
    expect(
      resolveConfig({ url: 'https://other.example', anonKey: 'b' }, { url: URL_OK }).url,
    ).toBe(URL_OK);
  });
});

describe('override storage + validation', () => {
  it('parses stored overrides defensively', () => {
    expect(parseStoredOverride(null)).toBeNull();
    expect(parseStoredOverride('nope')).toBeNull();
    expect(parseStoredOverride('{}')).toBeNull();
    expect(
      parseStoredOverride(JSON.stringify({ url: ` ${URL_OK} `, anonKey: 'k' })),
    ).toEqual({
      url: URL_OK,
      anonKey: 'k',
    });
  });

  it('only allows https on the allowlisted host', () => {
    expect(isAllowedUrl(URL_OK)).toBe(true);
    expect(isAllowedUrl('http://jdjyiyeddpfzpgrqffav.supabase.co')).toBe(false);
    expect(isAllowedUrl('https://evil.supabase.co')).toBe(false);
    expect(validateOverride({ url: 'https://evil.example', anonKey: 'k' }).ok).toBe(
      false,
    );
    expect(validateOverride({ url: `${URL_OK}//`, anonKey: ' k ' })).toEqual({
      ok: true,
      value: { url: URL_OK, anonKey: 'k' },
    });
    expect(validateOverride({ url: '', anonKey: '' })).toEqual({ ok: true, value: {} });
  });
});
