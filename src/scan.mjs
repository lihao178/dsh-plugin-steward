// 插件扫描: 清单收集 / 来源分类 / 能力分组 / 体积统计
import fs from 'node:fs';
import path from 'node:path';
import {
  readJson, readText, exists, isDir, isFile, listDir, dirSize,
  profileDir, PROFILES_DIR, DEFAULT_PROFILE, listProfiles,
} from './util.mjs';
import { hostPackageSet } from './host.mjs';
import { readHoisted, readWorkspace } from './pnpmmeta.mjs';
import { readPatchState } from './patch.mjs';

export const ORIGIN_LABEL = {
  self: '我自己做的',
  market: '市场装的',
  builtin: '系统自带',
  missing: '找不到（没装上）',
  unknown: '不知道哪来的',
};
export const SOURCE_LABEL = {
  link: '本地目录（自己在改）',
  file: '打包在 profile 里',
  local: '本地包（@local）',
  registry: '从网上市场下的',
  builtin: '软件自带',
  host: '软件内置',
  missing: '没装上',
  unknown: '不清楚',
};

const CAP_RULES = [
  { key: 'market',  label: '插件与市场管理', re: /插件管理|插件市场|市场|market|dshmarket|plugin-manager|plugin-market|版本检查|更新检查|依赖管理/i },
  { key: 'memory',  label: '记忆与知识',     re: /记忆|回忆|知识库|memory|hindsight|recall/i },
  { key: 'vision',  label: '图像与视觉',     re: /图片|图像|视觉|识别|画图|绘图|ocr|image|vision|modlens|screenshot/i },
  { key: 'docs',    label: '文档与办公',     re: /文档|表格|演示|幻灯|ppt|docx|xlsx|univer|office|excel|word|pdf|deck/i },
  { key: 'search',  label: '搜索与联网',     re: /搜索|联网|抓取|网页|浏览器|search|exa|scrape|browse/i },
  { key: 'context', label: '上下文与费用',   re: /上下文|压缩|费用|计量|预算|省着|token|context|cost|compact|thrift|usage/i },
  { key: 'ui',      label: '界面与交互',     re: /侧边栏|界面|看板|面板|中心|主题|sidebar|board|panel|explorer|theme|ui-/i },
  { key: 'auto',    label: '任务与自动化',   re: /定时|计划|任务|自动化|流程|schedule|cron|automation|workflow|task/i },
  { key: 'dev',     label: '开发与可视化',   re: /架构|代码|调试|图表|思维导图|diagram|arch|code|mermaid|codemirror/i },
  { key: 'media',   label: '语音与音频',     re: /语音|音频|朗读|录音|speech|audio|voice|tts/i },
  { key: 'control', label: '系统与桌面控制', re: /桌面|键鼠|进程|desktop|mouse|keyboard|control|截屏|bgui/i },
  { key: 'quant',   label: '数据与量化',     re: /量化|回测|交易|行情|quant|backtest|trading/i },
  { key: 'model',   label: '模型与推理',     re: /模型|推理|路由|额度|余额|model|provider|router|balance|quota/i },
  { key: 'base',    label: '宿主基础能力',   re: /宿主|基础|核心|运行时|会话|存储|web-app|base|core|runtime|session|storage|bundle/i },
];

export function bundleName(b) {
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object') return b.id || b.name || b.package || JSON.stringify(b);
  return String(b);
}
function nmPath(root, name) { return path.join(root, 'node_modules', ...String(name).split('/')); }
function readlinkSafe(p) { try { return fs.readlinkSync(p); } catch (e) { return null; } }

function resolveDir(root, name) {
  const p = nmPath(root, name);
  let st = null;
  try { st = fs.lstatSync(p); } catch (e) {
    return { dir: p, realPath: null, kind: 'missing', broken: false, target: null };
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSafe(p);
    let real = null;
    try { real = fs.realpathSync(p); } catch (e) { real = null; }
    if (!real || !isDir(real) || !isFile(path.join(real, 'package.json'))) {
      return { dir: p, realPath: null, kind: 'broken', broken: true, target };
    }
    return { dir: p, realPath: real, kind: 'link', broken: false, target };
  }
  if (st.isDirectory()) return { dir: p, realPath: p, kind: 'dir', broken: false, target: null };
  return { dir: p, realPath: null, kind: 'file', broken: true, target: null };
}

function exportsCoverLocale(pkg) {
  const ex = pkg.exports;
  if (ex === undefined || ex === null) return true;
  if (typeof ex === 'string') return false;
  if (typeof ex !== 'object') return true;
  return Object.keys(ex).some(k => k === './locale' || k.startsWith('./locale/') || k.startsWith('./locale*'));
}

function readLocale(realPath) {
  const res = { hasDir: false, files: [], zh: null, en: null, title: null, titleEn: null, desc: null };
  for (const sub of ['locale', 'locales']) {
    const d = path.join(realPath, sub);
    if (!isDir(d)) continue;
    res.hasDir = true;
    for (const f of listDir(d)) if (f.isFile() && /\.json$/i.test(f.name)) res.files.push(sub + '/' + f.name);
    const zh = readJson(path.join(d, 'zh.json'), null) || readJson(path.join(d, 'zh-CN.json'), null);
    const en = readJson(path.join(d, 'en.json'), null) || readJson(path.join(d, 'en-US.json'), null);
    if (zh && zh.meta) { res.zh = zh; res.title = zh.meta.title || null; res.desc = zh.meta.description || null; }
    if (en && en.meta) { res.en = en; res.titleEn = en.meta.title || null; }
    break;
  }
  return res;
}

const NOISE_KW = /^(dsh|dsh-?plugins?|plugin|plugins|deepseek|deepseek-harness|dsh-harness|harness|ai|tool|tools|skill|skills|extension|extensions|addon|addons|bundle|bundles|electron|cordis|typescript|node|nodejs|esm|cjs)$/i;
function countHits(re, text) {
  const out = new Set();
  if (!text) return out;
  const g = new RegExp(re.source, 'gi');
  let m;
  while ((m = g.exec(text))) { out.add(m[0].toLowerCase()); if (g.lastIndex === m.index) g.lastIndex++; }
  return out;
}
function groupFor(textCore, textDesc) {
  const scored = [];
  CAP_RULES.forEach((rule, order) => {
    const a = countHits(rule.re, textCore);
    const b = countHits(rule.re, textDesc);
    const score = a.size * 2 + b.size;
    if (score > 0) scored.push({ rule, score, order, tokens: Array.from(a).concat(Array.from(b)) });
  });
  scored.sort((x, y) => (y.score - x.score) || (x.order - y.order));
  return {
    tags: scored.map(s => s.rule.key),
    labels: scored.map(s => s.rule.label),
    primary: scored.length ? scored[0].rule.key : null,
    primaryLabel: scored.length ? scored[0].rule.label : null,
    primaryScore: scored.length ? scored[0].score : 0,
    matched: scored.slice(0, 3).map(s => s.rule.key + ':' + s.score + ':' + s.tokens.slice(0, 4).join(',')),
  };
}

function originFor(name, spec, res) {
  const s = String(spec || '');
  let source = 'registry';
  if (s.startsWith('link:')) source = 'link';
  else if (s.startsWith('file:')) source = 'file';
  else if (s.startsWith('workspace:') || s.startsWith('portal:')) source = 'link';
  else if (name.startsWith('@local/')) source = 'local';
  else if (name.startsWith('@deepseek-ai/')) source = 'builtin';
  else if (!s) source = 'registry';
  let origin;
  if (source === 'builtin' || name.startsWith('@deepseek-ai/')) origin = 'builtin';
  else if (source === 'link' || source === 'file' || source === 'local') origin = 'self';
  else if (res.realPath && !res.realPath.toLowerCase().includes('node_modules')) origin = 'self';
  else origin = 'market';
  if (res.broken) origin = origin === 'self' ? 'self' : origin;
  return { source, origin };
}

export function hostVersion(root) {
  for (const probe of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-schedule']) {
    const p = path.join(nmPath(root, probe), 'package.json');
    const j = readJson(p, null);
    if (j && j.version) return { version: j.version, from: probe };
  }
  try {
    const rtRoot = path.join(root, '..', '..', 'dsh-runtimes');
    for (const rt of fs.readdirSync(rtRoot)) {
      const j = readJson(path.join(rtRoot, rt, 'runtime.json'), null);
      if (j && j.desktopVersion) return { version: j.desktopVersion, from: 'runtime.json:' + rt };
    }
  } catch (e) {}
  return { version: null, from: null };
}

function readCordisIds(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const out = [];
    const re = /^[ 	]*-?[ 	]*id:[ 	]*(.+?)[ 	]*$/gm;
    let m;
    while ((m = re.exec(txt))) {
      let v = m[1].trim();
      const hash = v.indexOf('#');
      if (hash >= 0) v = v.slice(0, hash).trim();
      if (v.length && (v.charCodeAt(0) === 39 || v.charCodeAt(0) === 34)) v = v.slice(1);
      if (v.length && (v.charCodeAt(v.length - 1) === 39 || v.charCodeAt(v.length - 1) === 34)) v = v.slice(0, -1);
      if (v && out.indexOf(v) < 0) out.push(v);
    }
    return out;
  } catch (e) { return []; }
}

export function scanProfile(profile = DEFAULT_PROFILE, opts = {}) {
  const root = profileDir(profile);
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(pkgPath, null) || {};
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  const bundlesRaw = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const bundleNames = bundlesRaw.map(bundleName);

  const patch = readPatchState(root);
  const updates = readJson(path.join(root, 'stardustlc-plugin-updates.json'), null) || { packages: {} };
  const marketState = readJson(path.join(root, '.dsh-market', 'state.json'), null) || {};
  const snapDir = path.join(root, '.dsh-market', 'snapshots');
  const snapshots = listDir(snapDir).filter(f => f.isFile() && /\.json$/i.test(f.name)).map(f => f.name).sort();

  const universe = [];
  const seen = new Set();
  for (const name of Object.keys(deps)) { universe.push({ name, spec: deps[name], inDeps: true }); seen.add(name); }
  for (let i = 0; i < bundleNames.length; i++) {
    const name = bundleNames[i];
    if (seen.has(name)) continue;
    seen.add(name);
    universe.push({ name, spec: null, inDeps: false });
  }

  const HOST = hostPackageSet(opts);
  const sizeCache = new Map();
  const plugins = universe.map(({ name, spec, inDeps }) => {
    const res = resolveDir(root, name);
    const pkg2 = res.realPath ? readJson(path.join(res.realPath, 'package.json'), null) : null;
    const loc = res.realPath ? readLocale(res.realPath) : { files: [], title: null, desc: null, titleEn: null, hasDir: false };
    let { source, origin } = originFor(name, spec, res);
    const bidx = bundleNames.indexOf(name);
    const hostProvided = HOST.has(name);
    if (!res.realPath && hostProvided) { origin = 'builtin'; source = 'host'; }
    else if (!res.realPath && bidx >= 0) { origin = 'missing'; }
    const p = pkg2 || {};
    const title = (p.meta && p.meta.title) || loc.title || name;
    const desc = loc.desc || p.description || '';
    const kws = (p.keywords || []).filter(k => !NOISE_KW.test(String(k).trim()));
    const capText = [name, title, loc.titleEn || '', kws.join(' ')].join(' ');
    const cap = groupFor(capText, desc);
    let mainFile = null, mainOk = true;
    const cands = [];
    if (typeof p.main === 'string') cands.push(p.main);
    if (typeof p.module === 'string') cands.push(p.module);
    if (typeof p.exports === 'string') cands.push(p.exports);
    else if (p.exports && typeof p.exports === 'object' && typeof p.exports['.'] === 'string') cands.push(p.exports['.']);
    for (const c of cands) {
      const f = path.join(res.realPath || res.dir, c);
      if (isFile(f)) { mainFile = c; mainOk = true; break; }
      if (!mainFile) { mainFile = c; mainOk = false; }
    }
    const bp = p.dsh && p.dsh.bundle && p.dsh.bundle.patch ? p.dsh.bundle.patch : null;
    const bundlePatchOk = bp ? isFile(path.join(res.realPath || res.dir, bp)) : true;
    const cordisIds = bp && res.realPath && isFile(path.join(res.realPath, bp)) ? readCordisIds(path.join(res.realPath, bp)) : [];
    let sizeBytes = 0;
    if (res.realPath && isDir(res.realPath)) {
      if (opts.noSize !== true) {
        if (!sizeCache.has(res.realPath)) sizeCache.set(res.realPath, dirSize(res.realPath));
        sizeBytes = sizeCache.get(res.realPath);
      }
    }
    const policy = (updates.packages && updates.packages[name]) || null;
    return {
      name, spec, inDeps,
      installed: !!res.realPath && !!pkg2,
      version: p.version || null,
      dir: res.dir, realPath: res.realPath, linkKind: res.kind, linkTarget: res.target, broken: res.broken,
      source, origin, hostProvided,
      inBundles: bidx >= 0, bundleIndex: bidx,
      disabled: patch.disabled.has(name) || cordisIds.some(x => patch.disabled.has(x)),
      patchId: patch.ids.includes(name),
      cordisIds,
      marketDisabled: Array.isArray(marketState.disabled) && marketState.disabled.includes(name),
      title, titleEn: loc.titleEn || null, description: desc,
      keywords: (p.keywords || []).slice(0, 20),
      localeFiles: loc.files, hasLocale: loc.files.length > 0,
      localeExportOk: pkg2 ? exportsCoverLocale(p) : null,
      mainFile, mainOk, bundlePatch: bp, bundlePatchOk,
      isClient: !!(p.dsh && p.dsh.client),
      inject: (p.dsh && p.dsh.client && Array.isArray(p.dsh.client.inject)) ? p.dsh.client.inject.slice(0, 12) : [],
      peerDependencies: p.peerDependencies || {},
      updatePolicy: policy,
      sizeBytes,
      capabilities: cap,
      issues: [],
    };
  });

  // 残留: node_modules 里像 dsh 插件但不在任何清单中的包
  const orphans = [];
  const nm = path.join(root, 'node_modules');
  const skip = new Set(['.bin', '.pnpm', '.cache', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.dsh-market']);
  const scanOne = (dir, prefix) => {
    for (const d of listDir(dir)) {
      if (skip.has(d.name)) continue;
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const full = path.join(dir, d.name);
      if (d.name.startsWith('@')) { scanOne(full, d.name + '/'); continue; }
      const nm2 = prefix + d.name;
      if (seen.has(nm2)) continue;
      if (!/dsh/i.test(nm2)) continue;
      const pj = readJson(path.join(full, 'package.json'), null);
      orphans.push({
        name: nm2, dir: full,
        version: pj ? pj.version : null,
        title: (pj && pj.meta && pj.meta.title) || null,
        description: pj ? (pj.description || '') : '',
        sizeBytes: dirSize(full),
      });
    }
  };
  if (opts.orphans !== false) scanOne(nm, '');

  const hoisted = readHoisted(root);
  const workspace = readWorkspace(root);
  const hv = hostVersion(root);
  const counts = { total: plugins.length, self: 0, market: 0, builtin: 0, missing: 0, broken: 0, disabled: 0, installed: 0, hostProvided: 0, updatable: 0 };
  for (const p of plugins) {
    if (p.origin === 'missing') counts.missing++;
    else counts[p.origin] = (counts[p.origin] || 0) + 1;
    if (p.broken) counts.broken++;
    if (p.installed) counts.installed++;
    if (p.hostProvided) counts.hostProvided++;
    if (p.disabled) counts.disabled++;
  }

  return {
    profile, root, pkgPath, pkg, deps, bundlesRaw, bundleNames,
    patch, marketState, snapshots, updates,
    plugins,
    orphans: orphans.filter((o) => !hoisted.byName[o.name]),
    orphansManaged: orphans.filter((o) => !!hoisted.byName[o.name]),
    host: hv, hostPayloadCount: HOST.size, counts,
    hoisted, workspace,
  };
}

export function scanAll(opts = {}) {
  return listProfiles().map(p => {
    try { return scanProfile(p, opts); } catch (e) { return { profile: p, error: String(e && e.message || e) }; }
  });
}