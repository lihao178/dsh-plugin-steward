// 插件市场的目录数据源: 直接读 dsh-plugin-catalog 包里的 plugins.json.
//
// 为什么不用 awesome-dsh-plugin.com/plugins.json:
//   那是 GitHub Pages, 国内直连经常挂; 市场自己也优先走 npm 包(dshmarket 的
//   lib/regions.js 里 CATALOG_PACKAGE = 'dsh-plugin-catalog', 中国区先读包再回源).
//   我们照它的路子走, 但只拿目录, 不碰它的安装逻辑 —— 安装还是走 pnpm add.
//
// 目录结构从 plugins.json 里自适应: 条目可能是数组或对象映射,
// 字段可能是 npm 名也可能是 github 仓库, 都摊平成统一形状.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { STATE_DIR, ensureDir, writeJson, readJson, nowIso } from './util.mjs';
import { REGISTRY, fetchPackument } from './registry.mjs';

export const CATALOG_PKG = 'dsh-plugin-catalog';
export const CATALOG_FILE = path.join(STATE_DIR, 'market', 'plugins.json');
export const CATALOG_TTL_MS = 30 * 60 * 1000;
/** 国内镜像, 直连 npmjs 慢或不通时自动降级. */
export const CATALOG_MIRRORS = [
  REGISTRY,
  'https://registry.npmmirror.com',
];

function loadLocal() {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    if (j && (Array.isArray(j.raw) || Array.isArray(j.plugins))) return j;
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 缓存落盘有两种形态: schema 2 存目录原文(raw), schema 1 存的是当时 normalize 出来的条目.
 * 统一在这里还原成最新字段的条目 —— 这样加了新字段(能力清单/收录时间/截图)之后,
 * 老缓存不用等 30 分钟过期也能立刻带上新字段.
 */
function rehydrate(doc) {
  if (!doc) return null;
  if (Array.isArray(doc.raw)) return normalizeEntries(doc.raw);
  if (Array.isArray(doc.plugins)) {
    return normalizeEntries(doc.plugins.map((p) => (p && p.raw) || p).filter(Boolean));
  }
  return null;
}

/** 从 packument 里挑最新版的 tarball 地址. */
function pickTarball(pack) {
  if (!pack || pack.error) return null;
  const latest = pack.latest || (pack.versions && pack.versions[pack.versions.length - 1]);
  const m = (pack.meta && pack.meta[latest]) || null;
  return m && m.tarball ? { version: latest, tarball: m.tarball, integrity: m.integrity || null } : null;
}

/** 极简 untar, 只为取出 package/plugins.json. */
function extractFile(gz, wanted) {
  let off = 0;
  let longName = null;
  while (off + 512 <= gz.length) {
    const header = gz.subarray(off, off + 512);
    let zero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { zero = false; break; }
    if (zero) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const bodyOff = off + 512;
    const body = gz.subarray(bodyOff, Math.min(bodyOff + size, gz.length));
    off = bodyOff + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/, ''); continue; }
    if (type === 'x' || type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    else if (prefix) name = prefix + '/' + name;
    const rel = name.replace(/^[^/]+\//, '');
    if (rel === wanted) return body.toString('utf8');
  }
  return null;
}

/** 下载某个 registry 上的 catalog 包并取出 plugins.json. */
async function fetchFromRegistry(registry) {
  const url = registry.replace(/\/+$/, '') + '/' + CATALOG_PKG;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const pack = await res.json();
    const latest = (pack['dist-tags'] && pack['dist-tags'].latest) || null;
    const meta = latest && pack.versions && pack.versions[latest];
    const tb = meta && meta.dist && meta.dist.tarball;
    if (!tb) throw new Error('packument 里没有 tarball');
    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), 40000);
    try {
      const r2 = await fetch(tb, { signal: ac2.signal });
      if (!r2.ok) throw new Error('tarball HTTP ' + r2.status);
      const gz = zlib.gunzipSync(Buffer.from(await r2.arrayBuffer()));
      const text = extractFile(gz, 'plugins.json');
      if (!text) throw new Error('包里没有 plugins.json');
      const j = JSON.parse(text);
      return { raw: j, registry, version: latest };
    } finally { clearTimeout(t2); }
  } finally { clearTimeout(timer); }
}

/** 把目录条目摊平成统一形状. */
export function normalizeEntries(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    // 可能是 { plugins: [...] } 或 { "name": {...} } 映射
    if (Array.isArray(raw.plugins)) list = raw.plugins;
    else if (Array.isArray(raw.entries)) list = raw.entries;
    else list = Object.keys(raw).map((k) => {
      const v = raw[k];
      return (v && typeof v === 'object') ? Object.assign({ name: k }, v) : { name: k };
    });
  }
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const name = it.name || it.package || it.pkg || it.id || it.npm || null;
    const repo = it.repository
      ? String(typeof it.repository === 'string' ? it.repository : (it.repository.url || '')).replace(/^git\+|\.git$|^https?:\/\/github\.com\//g, '')
      : (it.github || it.repo || null);
    const repoUrl = repo && /^[^/]+\/[^/]+$/.test(String(repo).replace(/^.*github\.com\//, ''))
      ? 'https://github.com/' + String(repo).replace(/^.*github\.com\//, '').replace(/\.git$/, '')
      : (it.homepage || it.url || null);
    // 描述可能是 { en, zh } 双语对象; 平铺一份中文优先的给界面直接用, 原文两份都留着
    const d = it.description || it.desc || '';
    const descZh = (d && typeof d === 'object') ? (d.zh || d['zh-CN'] || null) : (typeof d === 'string' ? d : null);
    const descEn = (d && typeof d === 'object') ? (d.en || null) : null;
    out.push({
      name: name || null,
      title: it.title || it.displayName || (it.meta && it.meta.title) || name || repoUrl || '未命名',
      description: d,
      desc: descZh || descEn || '',
      descZh,
      descEn,
      version: it.version || null,
      author: typeof it.author === 'string' ? it.author : (it.author && (it.author.name || it.author.login)) || it.owner || null,
      category: it.category || it.tag || it.group || null,
      keywords: Array.isArray(it.keywords) ? it.keywords : (Array.isArray(it.tags) ? it.tags : []),
      repo: repoUrl,
      npm: it.npm || (name && !/^github:/i.test(String(name)) ? name : null),
      installSpec: it.install || it.installSpec || it.spec || null,
      icon: it.icon || it.iconUrl || null,
      downloads: Number(it.downloads || it.download || 0) || 0,
      stars: Number(it.stars || it.stargazers || 0) || 0,
      // 官方目录预计算的能力清单: shell / fs-read / fs-write / network / env /
      // credentials / llm / host-runtime / dynamic-code / subagent
      caps: Array.isArray(it.capabilities) ? it.capabilities : [],
      redlines: Array.isArray(it.capabilityRedLines) ? it.capabilityRedLines : [],
      added: it.added || null,
      screens: Array.isArray(it.screenshots) ? it.screenshots.filter(Boolean).slice(0, 3) : [],
      raw: it,
    });
  }
  return out;
}

/** 排序: recent(最近收录) / downloads(下载量) / stars(星数) / name. */
export function sortCatalog(plugins, sort) {
  const list = (plugins || []).slice();
  const s = String(sort || 'recent');
  if (s === 'downloads') return list.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  if (s === 'stars') return list.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  if (s === 'name') return list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  // 默认最近收录: added 是 YYYY-MM-DD; 没日期的排后面, 同日按下载量
  return list.sort((a, b) => {
    const aa = a.added || '';
    const bb = b.added || '';
    if (aa !== bb) return bb.localeCompare(aa);
    return (b.downloads || 0) - (a.downloads || 0);
  });
}

/**
 * 读市场目录. 磁盘缓存 30 分钟; refresh=true 强制重新拉.
 * 返回 { ok, source, version, at, count, plugins, error }
 */
export async function loadCatalog(opts) {
  const o = opts || {};
  const cached = loadLocal();
  const cachedPlugins = rehydrate(cached);
  const fresh = cached && cachedPlugins && cached.at && (Date.now() - Date.parse(cached.at)) < (o.maxAgeMs || CATALOG_TTL_MS);
  if (cached && cachedPlugins && fresh && !o.refresh) {
    return { ok: true, fromCache: true, source: cached.source, version: cached.version, at: cached.at, count: cachedPlugins.length, plugins: cachedPlugins, error: null };
  }
  const errors = [];
  const mirrors = o.registry ? [o.registry].concat(CATALOG_MIRRORS.filter((m) => m !== o.registry)) : CATALOG_MIRRORS;
  for (const reg of mirrors) {
    try {
      const r = await fetchFromRegistry(reg);
      const plugins = normalizeEntries(r.raw);
      if (!plugins.length) throw new Error('目录是空的');
      // schema 2: 存目录原文, 读的时候再 normalize —— 这样新增字段不用重下 8489 条
      const doc = { schema: 2, at: nowIso(), source: reg, version: r.version, raw: r.raw };
      ensureDir(path.dirname(CATALOG_FILE));
      writeJson(CATALOG_FILE, doc);
      return { ok: true, fromCache: false, source: reg, version: r.version, at: doc.at, count: plugins.length, plugins, error: null };
    } catch (error) {
      errors.push(reg + ': ' + String((error && error.message) || error));
    }
  }
  if (cached && cachedPlugins) {
    return { ok: true, fromCache: true, stale: true, source: cached.source, version: cached.version, at: cached.at, count: cachedPlugins.length, plugins: cachedPlugins, error: errors.join(' | ') };
  }
  return { ok: false, fromCache: false, source: null, version: null, at: null, count: 0, plugins: [], error: errors.join(' | ') || '取不到市场目录' };
}

/** 关键词/分类/能力过滤. */
export function filterCatalog(plugins, opts) {
  const o = opts || {};
  const q = String(o.q || '').trim().toLowerCase();
  const cat = o.category && o.category !== 'all' ? String(o.category) : null;
  const noCaps = Array.isArray(o.excludeCaps) ? o.excludeCaps : null;
  let list = plugins || [];
  if (cat) list = list.filter((p) => String(p.category || '') === cat);
  if (noCaps && noCaps.length) list = list.filter((p) => !(p.caps || []).some((c) => noCaps.indexOf(c) >= 0));
  if (q) {
    list = list.filter((p) => {
      const hay = [p.name, p.title, p.descZh, p.descEn, p.desc, (p.keywords || []).join(' '), p.author, p.repo]
        .filter((x) => typeof x === 'string').join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  return list;
}

/** 目录里的分类汇总(给界面做筛选按钮). */
export function categories(plugins) {
  const m = new Map();
  for (const p of plugins || []) {
    const k = p.category || 'other';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Array.from(m.entries()).map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count);
}

/**
 * 装之前把候选插件的解析结果算出来: npm 包名 / 版本 / tarball / 已装状态.
 * 不下载 tarball, 只读 packument(有缓存).
 */
export async function resolveCandidate(item, opts) {
  const o = opts || {};
  const npmName = item && item.npm ? String(item.npm) : null;
  const out = {
    name: npmName, title: item && item.title, category: item && item.category,
    repo: item && item.repo, version: null, tarball: null, integrity: null,
    latest: null, versions: 0, deprecated: null, license: null, homepage: null,
    installSpec: null, error: null,
  };
  if (item && item.installSpec) out.installSpec = item.installSpec;
  if (!npmName) { out.error = '这个条目没有 npm 包名(可能是纯 GitHub 仓库)'; return out; }
  const pack = await fetchPackument(npmName, { refresh: o.refresh, timeoutMs: o.timeoutMs || 20000 });
  if (pack.error) { out.error = pack.error; return out; }
  const tb = pickTarball(pack);
  out.latest = pickTarball(pack) && pickTarball(pack).version;
  out.versions = (pack.versions || []).length;
  if (tb) {
    out.version = tb.version;
    out.tarball = tb.tarball;
    out.integrity = tb.integrity;
    out.installSpec = npmName + '@' + tb.version;
  }
  const meta = (pack.meta && tb && pack.meta[tb.version]) || null;
  if (meta) { out.deprecated = meta.deprecated || null; out.license = meta.license || null; }
  // 兼容性判定原料: engines.dsh / dsh.compatibility.dshReleases / @deepseek-ai peer 依赖
  out.req = meta ? {
    engines: meta.engines || null,
    dsh: meta.dsh || null,
    peerDependencies: meta.peerDependencies || null,
  } : null;
  out.unpackedSize = (meta && meta.unpackedSize) || null;
  out.homepage = pack.homepage || null;
  return out;
}
