// npm registry 客户端: 带磁盘缓存的 packument 抓取, 零依赖
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './util.mjs';

export const REGISTRY = process.env.DSH_PM_REGISTRY || 'https://registry.npmjs.org';
/**
 * 主源不通时的回退源. 国内市场装 packument 时 npmjs 常常 20 秒超时,
 * 而 npmmirror 是同一份数据的镜像, 因此按顺序试: 环境变量/主源 → 镜像.
 */
export const REGISTRY_MIRRORS = (process.env.DSH_PM_REGISTRY_MIRRORS || 'https://registry.npmmirror.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
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

/** 单个源的 packument 抓取(带自身的超时中止). */
async function fetchPackumentFrom(base, name, timeoutMs, outerSignal) {
  const url = base.replace(/[/]+$/, '') + '/' + String(name).replace('/', '%2f');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (outerSignal) {
    if (outerSignal.aborted) ac.abort();
    else outerSignal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { base, json: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPackument(name, opts) {
  const o = opts || {};
  const cache = load();
  const hit = cache.entries[name];
  const now = Date.now();
  if (!o.refresh && hit && hit.fetchedAt && (now - hit.fetchedAt) < (o.maxAgeMs || DEFAULT_TTL_MS)) {
    return Object.assign({}, hit, { fromCache: true });
  }
  // 并发竞速: 镜像通常 2~3 秒就回, npmjs 在同一台机器上要 18 秒以上,
  // 顺序回退等于先白等一个超时. 谁先回用谁, 其余立刻中止.
  const bases = REGISTRY_MIRRORS.concat([REGISTRY]).filter((b, i, a) => a.indexOf(b) === i);
  const ctrls = bases.map(() => new AbortController());
  const grabbed = await new Promise((resolve) => {
    let pending = bases.length;
    const errs = [];
    bases.forEach((base, i) => {
      fetchPackumentFrom(base, name, o.timeoutMs || 15000, ctrls[i].signal)
        .then((r) => {
          ctrls.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve({ ok: true, got: r });
        })
        .catch((e) => {
          errs.push(base + ': ' + String((e && e.message) || e));
          if (--pending === 0) resolve({ ok: false, errors: errs });
        });
    });
    if (!bases.length) resolve({ ok: false, errors: ['没有可用的 registry'] });
  });
  if (grabbed.ok) {
    const base = grabbed.got.base;
    const j = grabbed.got.json;
    const all = Object.keys(j.versions || {});
    const latest = (j['dist-tags'] && j['dist-tags'].latest) || all[all.length - 1] || null;
    // 注意: versions 的键顺序不等于版本顺序(有的包 7873 个版本, latest 不在末尾),
    // 所以必须显式把 latest 塞进保留集, 否则 pickTarball 拿不到 tarball.
    const keep = new Set(all.slice(-META_KEEP));
    if (latest) keep.add(latest);
    const meta = {};
    for (const v of keep) {
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
      fetchedAt: Date.now(),
      registry: base,
      distTags: j['dist-tags'] || {},
      versions: all,
      meta,
      latest,
      homepage: j.homepage || null,
      modified: (j.time && j.time.modified) || null,
    };
    cache.entries[name] = out;
    save(cache);
    return Object.assign({}, out, { fromCache: false, error: null });
  }
  const msg = (grabbed.errors || []).join(' | ') || '取不到 packument';
  if (hit) return Object.assign({}, hit, { fromCache: true, stale: true, error: msg });
  return { name, error: msg, versions: [], meta: {}, distTags: {}, latest: null, fromCache: false };
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