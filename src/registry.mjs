// npm registry 客户端: 带磁盘缓存的 packument 抓取, 零依赖
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './util.mjs';

export const REGISTRY = process.env.DSH_PM_REGISTRY || 'https://registry.npmjs.org';
export const CACHE_FILE = path.join(STATE_DIR, 'registry-cache.json');
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const META_KEEP = 30;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && j.entries) return j;
  } catch (e) {}
  return { schema: 1, entries: {} };
}
function save(c) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c), 'utf8');
  } catch (e) {}
}
export function packumentUrl(name) {
  return REGISTRY.replace(/[/]+$/, '') + '/' + String(name).replace('/', '%2f');
}
export function cacheInfo() {
  const c = load();
  const names = Object.keys(c.entries);
  let newest = 0;
  for (const n of names) newest = Math.max(newest, c.entries[n].fetchedAt || 0);
  return { count: names.length, file: CACHE_FILE, newest };
}
export function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); return true; } catch (e) { return false; }
}

export async function fetchPackument(name, opts) {
  const o = opts || {};
  const cache = load();
  const hit = cache.entries[name];
  const now = Date.now();
  if (!o.refresh && hit && hit.fetchedAt && (now - hit.fetchedAt) < (o.maxAgeMs || DEFAULT_TTL_MS)) {
    return Object.assign({}, hit, { fromCache: true });
  }
  const url = packumentUrl(name);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || 20000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const all = Object.keys(j.versions || {});
    const meta = {};
    for (const v of all.slice(-META_KEEP)) {
      const m = j.versions[v] || {};
      meta[v] = {
        deprecated: m.deprecated || null,
        engines: m.engines || null,
        peerDependencies: m.peerDependencies || null,
        dsh: m.dsh || null,
        license: m.license || null,
        integrity: (m.dist && m.dist.integrity) || null,
        tarball: (m.dist && m.dist.tarball) || null,
        unpackedSize: (m.dist && m.dist.unpackedSize) || null,
      };
    }
    const out = {
      name,
      fetchedAt: now,
      registry: REGISTRY,
      distTags: j['dist-tags'] || {},
      versions: all,
      meta,
      latest: (j['dist-tags'] && j['dist-tags'].latest) || all[all.length - 1] || null,
      homepage: j.homepage || null,
      modified: (j.time && j.time.modified) || null,
    };
    cache.entries[name] = out;
    save(cache);
    return Object.assign({}, out, { fromCache: false });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (hit) return Object.assign({}, hit, { fromCache: true, stale: true, error: msg });
    return { name, error: msg, versions: [], meta: {}, distTags: {}, latest: null, fromCache: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit || 4, list.length || 1));
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  const runners = [];
  for (let k = 0; k < n; k++) runners.push(run());
  await Promise.all(runners);
  return out;
}