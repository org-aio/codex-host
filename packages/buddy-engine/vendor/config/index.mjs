import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { command, readJson } from '../runtime/index.mjs';

export function homePath(value = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  return resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}

export function modelUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Provider base_url must be an HTTP(S) URL without embedded credentials.');
  }
  const prefix = url.pathname.replace(/\/+$/, '') || '/v1';
  url.pathname = prefix + '/models';
  url.hash = '';
  return url;
}

export async function readConnection(home, env = process.env) {
  const configFile = join(home, 'config.toml');
  const source = await readFile(configFile, 'utf8');
  let config;
  try { config = parse(source); } catch { throw new Error('Cannot parse Codex config.toml.'); }
  const providerId = config.model_provider || 'openai';
  const provider = config.model_providers?.[providerId] || {};
  const base = provider.base_url || (providerId === 'openai' && (env.OPENAI_BASE_URL || 'https://api.openai.com/v1'));
  if (!base) throw new Error(`Provider ${providerId} has no base_url.`);
  let headers;
  try {
    headers = new Headers(provider.http_headers || {});
    for (const [name, variable] of Object.entries(provider.env_http_headers || {})) {
      if (env[variable]) headers.set(name, env[variable]);
    }
  } catch { throw new Error('Invalid configured HTTP headers.'); }
  if (!headers.has('Authorization')) {
    let key;
    if (provider.env_key) {
      key = env[provider.env_key];
      if (!key) throw new Error(`Required credential environment variable ${provider.env_key} is not set.`);
    } else if (provider.auth?.command) {
      key = (await command(provider.auth.command, provider.auth.args || [], {
        cwd: provider.auth.cwd ? resolve(home, provider.auth.cwd) : home,
        env, timeout: provider.auth.timeout_ms || 5000,
      })).trim();
    } else {
      key = provider.experimental_bearer_token || env.OPENAI_API_KEY;
      if (!key) key = (await readJson(join(home, 'auth.json'), {})).OPENAI_API_KEY;
    }
    if (!key || typeof key !== 'string') {
      throw new Error('No API key found. Configure env_key, provider.auth, or auth.json OPENAI_API_KEY. ChatGPT OAuth tokens are not provider API keys.');
    }
    try { headers.set('Authorization', `Bearer ${key}`); }
    catch { throw new Error('Invalid provider credential format.'); }
  }
  headers.set('Accept', 'application/json');
  const url = modelUrl(base);
  for (const [key, value] of Object.entries(provider.query_params || {})) url.searchParams.set(key, value);
  const catalogPath = config.model_catalog_json
    ? resolve(home, config.model_catalog_json) : undefined;
  return { config, source, configFile, providerId, url, headers, catalogPath };
}

// 逐个尝试根键候选，解析前后只允许目标键变化，避免误改多行字符串或嵌套表。
export function editCatalogSetting(source, value) {
  const before = parse(source);
  const expected = { ...before };
  if (value === undefined) delete expected.model_catalog_json;
  else expected.model_catalog_json = value;
  const replacement = value === undefined ? '' : `model_catalog_json = ${JSON.stringify(value)}\n`;
  if (!Object.hasOwn(before, 'model_catalog_json')) return replacement + source;
  const pattern = /^(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=.*(?:\r?\n|$)/gm;
  for (const match of source.matchAll(pattern)) {
    const candidate = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
    try { if (isDeepStrictEqual(parse(candidate), expected)) return candidate; } catch { /* Try next candidate. */ }
  }
  throw new Error('Cannot safely edit model_catalog_json; use a single-line root setting.');
}
