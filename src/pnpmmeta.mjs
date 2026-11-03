// 读 pnpm 元数据: .modules.yaml (权威安装映射) / pnpm-workspace.yaml / cordis 配置层里的声明
import fs from 'node:fs';
import path from 'node:path';

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

/** .modules.yaml 的 hoistedLocations: 包名@版本 -> 实际落盘路径 */
export function readHoisted(root) {
  const raw = readTextSafe(path.join(root, 'node_modules', '.modules.yaml'));
  let my = {};
  try { my = raw ? JSON.parse(raw) : {}; } catch (e) { my = {}; }
  const loc = my.hoistedLocations || {};
  const byName = {};
  let unparsed = 0;
  for (const k of Object.keys(loc)) {
    const m = k.match(/^(.+?)@(\d[^@(]*)/);
    if (!m) { unparsed++; continue; }
    const arr = byName[m[1]] || (byName[m[1]] = []);
    arr.push({ version: m[2], paths: loc[k] || [] });
  }
  const multiNames = Object.keys(byName).filter((n) => byName[n].length > 1);
  return {
    exists: !!raw,
    keys: Object.keys(loc).length,
    unparsed,
    byName,
    multiNames,
    layoutVersion: my.layoutVersion || null,
    hoistPattern: my.hoistPattern || null,
    injectedDeps: my.injectedDeps || {},
  };
}

/** 同 name@version 落在多个路径的条目 */
export function splitEntries(hoisted) {
  const out = [];
  const byName = (hoisted && hoisted.byName) || {};
  for (const name of Object.keys(byName)) {
    for (const x of byName[name]) {
      if (x.paths.length > 1) out.push({ name, version: x.version, paths: x.paths });
    }
  }
  return out;
}

/** pnpm-workspace.yaml 里关心的几项 */
export function readWorkspace(root) {
  const p = path.join(root, 'pnpm-workspace.yaml');
  const t = readTextSafe(p);
  if (t === null) return { path: p, exists: false, nodeLinker: null, minimumReleaseAge: null, minimumReleaseAgeExclude: [], autoInstallPeers: null };
  const exclude = [];
  let inEx = false;
  for (const line of t.split(String.fromCharCode(10))) {
    if (/^minimumReleaseAgeExclude:/.test(line)) { inEx = true; continue; }
    if (inEx) {
      const m = line.match(/^[ \t]+-[ \t]*(.+?)[ \t]*$/);
      if (m) { exclude.push(m[1].replace(/['"]/g, '')); continue; }
      if (line.trim()) inEx = false;
    }
  }
  const pick = (key) => {
    const m = t.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'));
    return m ? m[1].trim() : null;
  };
  return {
    path: p,
    exists: true,
    nodeLinker: pick('nodeLinker'),
    minimumReleaseAge: pick('minimumReleaseAge'),
    minimumReleaseAgeExclude: exclude,
    autoInstallPeers: pick('autoInstallPeers'),
    storeDir: pick('storeDir'),
  };
}

/** 从 cordis 配置层文本里抽出所有 id: 行 (含 insert 里缩进声明的) */
export function parsePatchIds(text) {
  const out = [];
  if (!text) return out;
  const re = /^[ \t]*-?[ \t]*id:[ \t]*(.+?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    let v = m[1];
    if (v.charCodeAt(0) === 39 || v.charCodeAt(0) === 34) v = v.slice(1);
    if (v.length) {
      const c = v.charCodeAt(v.length - 1);
      if (c === 39 || c === 34) v = v.slice(0, -1);
    }
    out.push(v);
  }
  return out;
}

/** 抽出 `- insert:` 块里声明的 name/id (手工插进来的插件) */
export function parseInserts(text) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/^\s*#.*$/, '');
    if (!/^[ \t]*-[ \t]*insert:[ \t]*$/.test(stripped)) continue;
    const base = (stripped.match(/^[ \t]*/) || [''])[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.indexOf('#') === 0) continue;
      if (!l.trim()) continue;
      const ind = (l.match(/^[ \t]*/) || [''])[0].length;
      if (ind <= base) break;
      const mn = l.match(/name:[ \t]*(.+?)[ \t]*$/);
      if (mn) out.push(mn[1].replace(/['"]/g, ''));
      const mi = l.match(/^[ \t]*-?[ \t]*id:[ \t]*(.+?)[ \t]*$/);
      if (mi) out.push(mi[1].replace(/['"]/g, ''));
    }
  }
  return out;
}