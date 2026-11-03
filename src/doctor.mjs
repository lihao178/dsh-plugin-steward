// 体检: 找出插件的问题(损坏/缺失/配置错), 并标出哪些能自动修复
import fs from 'node:fs';
import path from 'node:path';
import { scanProfile } from './scan.mjs';
import { listDir, isFile, humanSize } from './util.mjs';
import { hostVersions } from './host.mjs';
import { parsePatchIds, parseInserts } from './pnpmmeta.mjs';
import { titleDrift, expectedTitle } from './labels.mjs';

export const FIX_HINTS = {
  'add-locale-export': '给 package.json 的 exports 补上 ./locale/*.json 导出',
  'init-locale': '生成 locale/zh.json + en.json 骨架并写好导出',
  'relabel': '重新套用登记表里的中文名 (插件升级会覆盖掉中文名)',
  'init-locale': '生成 locale/zh.json + en.json 骨架并写好导出',
  'remove-from-bundles': '从 dsh.profile.bundles 里移除这条无效引用',
  'dedupe-bundles': '去掉 dsh.profile.bundles 里重复的条目',
  'relink': '重建 node_modules 里坏掉的软链',
  'reinstall': '重新安装该插件',
  'add-to-bundles': '把它加进 dsh.profile.bundles 以启用',
  'remove-orphan': '删除 node_modules 里的残留包',
  'enable': '在 cordis.patch.yml 里取消禁用',
  'disable': '在 cordis.patch.yml 里禁用',
  'clean-logs': '清掉失败/中断的安装日志',
};

function label(p) { return p.title && p.title !== p.name ? p.name + ' / ' + p.title : p.name; }

/** 同一个 id 在多条 patch 里重复设置同一个键时, 后者会静默盖掉前者 (真问题).
 *  只是同一个 id 被拆成多条、各自只设置不同的键, 是宿主支持的正常写法, 不算问题.
 *  依据: 宿主 applyEntryPatches 是按 id 找到条目后逐键赋值 target[key] = value. */
function patchKeyConflicts(text) {
  const lines = String(text).split(String.fromCharCode(10));
  const entries = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const top = raw.match(/^-\s*(.*)$/);
    if (top) {
      if (cur) entries.push(cur);
      const idm = top[1].match(/^id:\s*["']?([^"'\s]+)["']?/);
      cur = { id: idm ? idm[1] : null, isInsert: /^insert:/.test(top[1]), keys: new Map() };
      continue;
    }
    if (!cur) continue;
    const km = raw.match(/^  ([A-Za-z_$][\w$-]*):\s*(.*)$/);
    if (km && km[1] !== 'id') cur.keys.set(km[1], km[2].trim());
  }
  if (cur) entries.push(cur);
  const byId = new Map();
  for (const e of entries) {
    if (!e.id || e.isInsert) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const out = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const allKeys = [];
    for (const e of list) for (const k of e.keys.keys()) if (allKeys.indexOf(k) < 0) allKeys.push(k);
    const conflicts = [];
    for (const key of allKeys) {
      const holders = list.filter((e) => e.keys.has(key));
      if (holders.length > 1) conflicts.push(key + ' (' + holders.map((e) => e.keys.get(key) || '(整块)').join(' -> ') + ')');
    }
    out.push({ id, count: list.length, conflicts });
  }
  return out;
}

export function doctorProfile(profile, opts) {
  const o = opts || {};
  const s = scanProfile(profile, o);
  const F = [];
  const add = (sev, code, subject, message, extra) => {
    F.push(Object.assign({ severity: sev, code, subject, message }, extra || {}));
  };
  let hostPkgs = {};
  try { hostPkgs = hostVersions().versions || {}; } catch (e) {}
  const patchIds = new Set(parsePatchIds(s.patch.text));
  const insertNames = new Set(parseInserts(s.patch.text));
  const declared = (p) => patchIds.has(p.name) || insertNames.has(p.name) || (p.cordisIds || []).some((id) => patchIds.has(id) || insertNames.has(id));

  const seenB = new Map();
  for (const b of s.bundleNames) seenB.set(b, (seenB.get(b) || 0) + 1);
  for (const [b, n] of seenB) {
    if (n > 1) add('error', 'dup-in-bundles', b, 'dsh.profile.bundles 里出现 ' + n + ' 次, 宿主可能重复加载', { fixable: true, fix: 'dedupe-bundles' });
  }

  for (const c of patchKeyConflicts(s.patch.text)) {
    if (c.conflicts.length) {
      add('warn', 'patch-key-conflict', 'cordis.patch.yml#' + c.id, '同一 id 出现 ' + c.count + ' 次, 其中 ' + c.conflicts.join(' , ') + ' 被重复设置: 后者会静默盖掉前者, 建议合并成一条', {});
    } else {
      add('info', 'patch-split-id', 'cordis.patch.yml#' + c.id, '同一 id 拆成 ' + c.count + ' 条, 各自只设置不同的项(宿主按 id 逐键合并) -> 写法合法, 不用管', {});
    }
  }

  const idOwner = new Map();
  for (const p of s.plugins) {
    for (const id of p.cordisIds || []) {
      if (!idOwner.has(id)) idOwner.set(id, []);
      const arr = idOwner.get(id);
      if (arr.indexOf(p.name) < 0) arr.push(p.name);
    }
  }
  for (const [id, owners] of idOwner) {
    if (owners.length > 1) add('error', 'cordis-id-conflict', id, '多个插件声明了同一个运行时 id: ' + owners.join(', '), { owners });
  }

  for (const p of s.plugins) {
    if (p.origin === 'missing') {
      add('error', 'missing-pkg', label(p), 'dsh.profile.bundles 引用了它, 但磁盘上没有这个包也不是宿主自带: 宿主加载会报错', { plugin: p.name, fixable: true, fix: 'remove-from-bundles' });
    }
    if (p.broken) {
      add('error', 'broken-link', label(p), 'node_modules 里的链接已损坏 -> ' + (p.linkTarget || '?'), { plugin: p.name, fixable: true, fix: 'relink' });
    }
    if (p.installed && p.mainOk === false) {
      add('error', 'main-missing', label(p), '入口文件 ' + p.mainFile + ' 不存在, 加载会失败', { plugin: p.name, fixable: true, fix: 'reinstall' });
    }
    if (p.installed && !p.version) {
      add('warn', 'no-version', label(p), 'package.json 里没有 version 字段', { plugin: p.name });
    }
    if (p.installed && p.hasLocale && p.localeExportOk === false) {
      add('warn', 'locale-not-exported', label(p), '有 locale 目录但 exports 没导出 ./locale/*.json: 宿主读不到中文名', { plugin: p.name, fixable: true, fix: 'add-locale-export' });
    }
    const drift = p.installed ? titleDrift(p) : null;
    if (drift) {
      const msg = drift.kind === 'wiped'
        ? '中文名丢了 (插件升级把 locale 目录整个换掉了), 登记表里它应该叫 "' + drift.expected + '"'
        : '界面上显示的名字变成了 "' + drift.actual + '", 登记表里它应该叫 "' + drift.expected + '"'
      add('warn', drift.kind === 'wiped' ? 'label-wiped' : 'label-drift', label(p), msg, { plugin: p.name, fixable: true, fix: 'relabel', expected: drift.expected, actual: drift.actual });
    }
    if (p.installed && !p.hasLocale && p.origin === 'self') {
      add('info', 'locale-missing', label(p), '自创插件没有 locale/zh.json: 界面上显示英文包名', { plugin: p.name, fixable: true, fix: 'init-locale' });
    }
    if (p.installed && !p.hasLocale && p.origin !== 'self' && !expectedTitle(p.name)) {
      add('info', 'locale-missing', label(p), '没有 locale 文件, 界面显示包名', { plugin: p.name });
    }
    if (p.bundlePatch && !p.bundlePatchOk) {
      add('warn', 'bundle-patch-missing', label(p), 'dsh.bundle.patch 指向的 ' + p.bundlePatch + ' 不存在', { plugin: p.name, fixable: true, fix: 'reinstall' });
    }
    if (p.inDeps && !p.inBundles && p.installed && p.origin !== 'builtin' && !/^@deepseek-ai[/]/.test(p.name) && !declared(p)) {
      add('info', 'not-in-bundles', label(p), '装了但没生效: 既不在 dsh.profile.bundles, 也没在 cordis.patch.yml 里声明', { plugin: p.name, fixable: true, fix: 'add-to-bundles' });
    }
    if (p.installed && p.sizeBytes > 80 * 1024 * 1024) {
      add('info', 'oversize', label(p), '体积 ' + humanSize(p.sizeBytes) + ', 偏大', { plugin: p.name, sizeBytes: p.sizeBytes });
    }
    if (p.disabled) {
      add('info', 'disabled', label(p), '当前被 cordis.patch.yml 禁用', { plugin: p.name, fixable: true, fix: 'enable' });
    }
    if ((p.cordisIds || []).length && !p.disabled && p.inBundles === false && p.installed && !declared(p)) {
      add('info', 'bundle-no-load', label(p), '声明了运行时 id (' + p.cordisIds.join(', ') + ') 但既不在 bundles 也没在配置层出现', { plugin: p.name });
    }
    if (p.installed) {
      for (const k of Object.keys(p.peerDependencies || {})) {
        if (k.indexOf('@deepseek-ai/') !== 0) continue;
        if (hostPkgs[k]) continue;
        if (k.indexOf('client') >= 0) {
          add('info', 'peer-client-bundled', label(p), 'peer ' + k + ' (' + p.peerDependencies[k] + ') 不在宿主 node_modules, 由前端 bundle 提供 (pnpm autoInstallPeers=false, 属正常)', { plugin: p.name });
        } else {
          add('warn', 'peer-missing', label(p), '依赖宿主的 ' + k + ' (' + p.peerDependencies[k] + '), 但宿主 payload 里没有这个包: 宿主升级后可能崩', { plugin: p.name });
        }
      }
    }
  }

  if (s.hoisted) {
    for (const n of s.hoisted.multiNames) {
      if (!/dsh/i.test(n)) continue;
      const list = s.hoisted.byName[n];
      add('info', 'hoisted-dupe', n, '磁盘上有 ' + list.length + ' 个版本: ' + list.map((x) => x.version).join(' , ') + ' (pnpm 允许同一依赖并存多版本)', { versions: list.map((x) => x.version) });
    }
  }
  if (s.workspace && s.workspace.minimumReleaseAgeExclude && s.workspace.minimumReleaseAgeExclude.length) {
    add('info', 'release-age-exempt', 'pnpm-workspace.yaml', '这些版本被豁免了最小发布年龄限制(可立即升级): ' + s.workspace.minimumReleaseAgeExclude.join(' , '), { list: s.workspace.minimumReleaseAgeExclude, nodeLinker: s.workspace.nodeLinker });
  }
  for (const or of s.orphans) {
    add('info', 'orphan-pkg', or.name, 'node_modules 里的残留包(不在 package.json 里), 体积 ' + humanSize(or.sizeBytes), { fixable: true, fix: 'remove-orphan', cleanable: true, path: or.dir, sizeBytes: or.sizeBytes });
  }

  const logsDir = path.join(s.root, '.plugin-manager', 'logs');
  let opTotal = 0, opZero = 0;
  for (const d of listDir(logsDir)) {
    if (!d.isDirectory()) continue;
    opTotal++;
    const lg = path.join(logsDir, d.name, 'pnpm.log');
    if (isFile(lg)) { try { if (fs.statSync(lg).size === 0) opZero++; } catch (e) {} }
  }
  if (opZero > 0) {
    add('info', 'zero-op-log', '.plugin-manager/logs', '共 ' + opTotal + ' 条安装记录, 其中 ' + opZero + ' 条是 0 字节(安装失败或被中断的痕迹)', { cleanable: true, path: logsDir, count: opZero });
  }

  const summary = { errors: 0, warns: 0, infos: 0, fixable: 0, cleanable: 0, total: F.length };
  for (const f of F) {
    if (f.severity === 'error') summary.errors++;
    else if (f.severity === 'warn') summary.warns++;
    else summary.infos++;
    if (f.fixable) summary.fixable++;
    if (f.cleanable) summary.cleanable++;
  }
  const rank = { error: 0, warn: 1, info: 2 };
  F.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.code).localeCompare(String(b.code)));
  return { profile, root: s.root, findings: F, summary, scan: s };
}

export function doctorSummaryLine(d) {
  const s = d.summary;
  return d.profile + ': ' + s.total + ' 项 (错误 ' + s.errors + ' / 警告 ' + s.warns + ' / 提示 ' + s.infos + '), 可自动修 ' + s.fixable + ', 可清理 ' + s.cleanable;
}