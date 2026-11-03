// 重复检测: 同名多版本 / 功能重复 / 运行时 id 冲突 / 名字过于相似
import path from 'node:path';
import { scanProfile } from './scan.mjs';
import { listDir, humanSize } from './util.mjs';

export function lev(a, b) {
  const s = String(a), t = String(b);
  const m = s.length, n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}

export function normName(n) {
  let x = String(n || '').toLowerCase();
  x = x.replace(/^@[^/]+\//, '');
  x = x.replace(/^(dsh-plugin-|dsh-client-ui-|dsh-|plugin-)/, '');
  x = x.replace(/(-plugin|-dsh|-mcp|-bundle|-exa|-pro)$/, '');
  x = x.replace(/[0-9]+/g, '');
  x = x.replace(/[^a-z\u4e00-\u9fa5]+/g, '-');
  return x.replace(/^-+|-+$/g, '');
}

export function dupeReport(profile, opts) {
  const o = opts || {};
  const s = scanProfile(profile, o);
  const plugins = s.plugins.filter((p) => p.installed);
  const names = new Set(s.plugins.map((p) => p.name));
  const findings = [];
  const add = (sev, code, subject, message, extra) => {
    findings.push(Object.assign({ severity: sev, code, subject, message }, extra || {}));
  };

  // 1) 同一个包装了多个版本 (.modules.yaml 的 hoistedLocations 是权威清单)
  const hoistedByName = (s.hoisted && s.hoisted.byName) || {};
  const multiVersion = [];
  for (const name of Object.keys(hoistedByName)) {
    const list = hoistedByName[name];
    if (list.length < 2) continue;
    const isPlugin = names.has(name);
    if (!isPlugin && !/dsh/i.test(name)) continue;
    const vers = list.map((x) => x.version).sort();
    multiVersion.push({ name, versions: vers, count: vers.length, isPlugin, paths: list.map((x) => x.paths.join(' , ')) });
  }
  multiVersion.sort((a, b) => b.count - a.count);
  for (const mv of multiVersion) {
    add(mv.isPlugin ? 'warn' : 'info', 'multi-version', mv.name, '磁盘上有 ' + mv.count + ' 份副本: ' + mv.versions.join(' , ') + (mv.isPlugin ? ' (这是已装入的插件)' : ' (只是依赖, 可为别的插件带的)'), { versions: mv.versions, plugin: mv.isPlugin, title: '同名多版本: ' + mv.name });
  }

  // 2) 功能重复: 同一个功能组里有多个市场/自创插件
  const byCap = new Map();
  for (const p of plugins) {
    if (p.origin === 'builtin' || p.origin === 'missing') continue;
    const k = (p.capabilities && p.capabilities.primary) || 'other';
    if (!byCap.has(k)) byCap.set(k, []);
    byCap.get(k).push(p);
  }
  const capability = [];
  for (const [k, list] of byCap) {
    if (list.length < 2) continue;
    const first = (list[0].capabilities && list[0].capabilities.primaryLabel) || k;
    capability.push({ key: k, label: first, plugins: list.map((p) => ({ name: p.name, title: p.title, origin: p.origin, sizeBytes: p.sizeBytes })) });
  }
  for (const c of capability) {
    add('info', 'capability-overlap', c.label, '这一组里有 ' + c.plugins.length + ' 个插件功能相近: ' + c.plugins.map((x) => x.name).join(', ') + ' (可能只需要留一个)', { group: c.key, plugins: c.plugins.map((x) => x.name), title: '功能重叠: ' + c.label, headers: ['插件', '中文名', '占用'], list: c.plugins.map((x) => [x.name, x.title || '', humanSize(x.sizeBytes || 0)]) });
  }

  // 3) 运行时 id 冲突
  const idMap = new Map();
  for (const p of s.plugins) {
    if (!p.installed) continue;
    for (const id of p.cordisIds || []) {
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push(p.name);
    }
  }
  const cordis = [];
  for (const [id, owners] of idMap) {
    const uniq = Array.from(new Set(owners));
    if (uniq.length > 1) {
      cordis.push({ id, owners: uniq });
      add('error', 'cordis-id-conflict', id, '两个插件抢同一个运行时 id: ' + uniq.join(', '), { owners: uniq, title: '运行时 id 冲突: ' + id, headers: ['插件'], list: uniq.map((n) => [n]) });
    }
  }

  // 4) client inject 冲突
  const injectMap = new Map();
  for (const p of plugins) {
    for (const k of p.inject || []) {
      if (!injectMap.has(k)) injectMap.set(k, []);
      injectMap.get(k).push(p.name);
    }
  }
  const inject = [];
  for (const [k, owners] of injectMap) {
    const uniq = Array.from(new Set(owners));
    if (uniq.length > 1) inject.push({ key: k, owners: uniq });
  }
  for (const x of inject) {
    add('info', 'ui-inject-shared', x.key, '多个插件往同一个界面插槽注入: ' + x.owners.join(', ') + ' (视觉上可能重叠)', { owners: x.owners, title: '共用插槽: ' + x.key, headers: ['插件'], list: x.owners.map((n) => [n]) });
  }

  // 5) 名称过于相似
  const similar = [];
  const normed = plugins.map((p) => ({ p, n: normName(p.name) })).filter((x) => x.n.length >= 3);
  for (let i = 0; i < normed.length; i++) {
    for (let j = i + 1; j < normed.length; j++) {
      const a = normed[i], b = normed[j];
      let why = null;
      if (a.n === b.n) why = '名字归一化后完全相同';
      else {
        const d = lev(a.n, b.n);
        if (d <= 2 && Math.min(a.n.length, b.n.length) >= 5) why = '名字只差 ' + d + ' 个字符';
      }
      if (why) {
        similar.push({ a: a.p.name, b: b.p.name, why });
        add('info', 'similar-name', a.p.name + ' ~ ' + b.p.name, why + ', 注意别搞混', { title: '名字相似: ' + a.p.name + ' ~ ' + b.p.name });
      }
    }
  }

  // 6) 磁盘占用与同版本多路径
  const biggest = plugins.slice().sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 8).map((p) => ({ name: p.name, title: p.title, sizeBytes: p.sizeBytes, origin: p.origin }));
  for (let i = 0; i < 3 && i < biggest.length; i++) {
    add('info', 'disk-heavy', biggest[i].name, '占 ' + humanSize(biggest[i].sizeBytes), { sizeBytes: biggest[i].sizeBytes, title: '占用偏大: ' + biggest[i].name });
  }
  const totalBytes = plugins.reduce((a, p) => a + (p.sizeBytes || 0), 0);
  const split = [];
  for (const name of Object.keys(hoistedByName)) {
    for (const x of hoistedByName[name]) if (x.paths.length > 1) split.push({ name, version: x.version, paths: x.paths });
  }
  for (const sp of split) {
    add('info', 'split-install', sp.name + '@' + sp.version, '同一个版本装在 ' + sp.paths.length + ' 个位置: ' + sp.paths.join(' , ') + ' (pnpm 对等依赖导致的重复落盘)', { title: '同版本多路径: ' + sp.name + '@' + sp.version });
  }
  const summary = { plugins: plugins.length, multiVersion: multiVersion.length, capability: capability.length, cordis: cordis.length, inject: inject.length, similar: similar.length, split: split.length, totalBytes, findings: findings.length };
  return { profile, root: s.root, scan: s, multiVersion, capability, cordis, inject, similar, split, biggest, totalBytes, findings, summary };
}