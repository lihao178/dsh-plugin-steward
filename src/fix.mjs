// 自动修复: 把体检发现的问题变成可执行的修复动作, 默认只预演, 加 --write 才真改
import fs from 'node:fs';
import path from 'node:path';
import { profileDir, readJson, isDir, isFile, ensureDir } from './util.mjs';
import { doctorProfile } from './doctor.mjs';
import { readPatchState, writePatchText, setDisabledText } from './patch.mjs';
import { createSnapshot } from './snapshot.mjs';
import { applyLabel } from './labels.mjs';

function detectIndent(text) {
  const m = String(text || '').match(/^[ \t]+/m);
  return m ? m[0] : '  ';
}
function writePkg(file, obj, originalText) {
  const indent = detectIndent(originalText);
  let out = JSON.stringify(obj, null, indent);
  if (String(originalText || '').endsWith(String.fromCharCode(10))) out += String.fromCharCode(10);
  fs.writeFileSync(file, out, 'utf8');
}

function bundleList(pkg) {
  const d = pkg && pkg.dsh && pkg.dsh.profile;
  if (!d || !Array.isArray(d.bundles)) return null;
  return d.bundles;
}

export function fixPlan(profile, opts) {
  const o = opts || {};
  const d = doctorProfile(profile, o);
  const root = profileDir(profile);
  const pkgPath = path.join(root, 'package.json');
  const pkgText = (() => { try { return fs.readFileSync(pkgPath, 'utf8'); } catch (e) { return null; } })();
  const pkg = (() => { try { return JSON.parse(pkgText); } catch (e) { return null; } })();
  const ops = [];
  const add = (kind, subject, description, fn, extra) => {
    ops.push(Object.assign({ kind, subject, description, apply: fn }, extra || {}));
  };
  const seen = new Set();
  const once = (key, fn) => { if (seen.has(key)) return false; seen.add(key); return true; };

  for (const f of d.findings) {
    if (!f.fixable || !f.fix) continue;
    const name = f.plugin || null;

    if (f.fix === 'remove-from-bundles' && once('rm:' + name, true)) {
      add('remove-from-bundles', name, '从 dsh.profile.bundles 移除 ' + name + ' (它引用的包不存在)', (ctx) => {
        if (!pkg || !bundleList(pkg)) return { ok: false, note: 'package.json 里没有 dsh.profile.bundles' };
        const before = bundleList(pkg).length;
        pkg.dsh.profile.bundles = bundleList(pkg).filter((b) => String(b).indexOf(name) < 0);
        if (pkg.dsh.profile.bundles.length === before) return { ok: false, note: '没找到匹配条目' };
        writePkg(pkgPath, pkg, pkgText);
        return { ok: true, note: 'bundles: ' + before + ' -> ' + pkg.dsh.profile.bundles.length };
      }, { path: pkgPath, severity: f.severity });
    }

    if (f.fix === 'dedupe-bundles' && once('dedupe', true)) {
      add('dedupe-bundles', 'dsh.profile.bundles', '去掉 bundles 里重复的条目 (宿主会重复加载)', (ctx) => {
        if (!pkg || !bundleList(pkg)) return { ok: false, note: '没有 bundles' };
        const before = bundleList(pkg).slice();
        const seenB = new Set();
        pkg.dsh.profile.bundles = before.filter((b) => { const k = String(b); if (seenB.has(k)) return false; seenB.add(k); return true; });
        if (pkg.dsh.profile.bundles.length === before.length) return { ok: false, note: '没有重复' };
        writePkg(pkgPath, pkg, pkgText);
        return { ok: true, note: before.length + ' -> ' + pkg.dsh.profile.bundles.length };
      }, { path: pkgPath, severity: 'error' });
    }

    if (f.fix === 'enable' || f.fix === 'disable') {
      const wantEnable = f.fix === 'enable';
      if (once(f.fix + ':' + name, true)) {
        add(f.fix, name, wantEnable ? '取消禁用 ' + name : '禁用 ' + name, (ctx) => {
          const ps = readPatchState(root);
          const p = d.scan.plugins.find((x) => x.name === name);
          const id = (p && p.cordisIds && p.cordisIds[0]) || name;
          const next = setDisabledText(ps.text, id, !wantEnable);
          if (next === null) return { ok: false, note: 'cordis.patch.yml 里找不到 id ' + id };
          writePatchText(root, next);
          return { ok: true, note: 'cordis.patch.yml: ' + id + ' disabled=' + (!wantEnable) };
        }, { path: path.join(root, 'cordis.patch.yml'), severity: f.severity });
      }
    }

    if (f.fix === 'add-to-bundles' && once('addb:' + name, true)) {
      add('add-to-bundles', name, '把 ' + name + ' 加进 dsh.profile.bundles 让它生效', (ctx) => {
        if (!pkg || !bundleList(pkg)) return { ok: false, note: '没有 bundles' };
        if (bundleList(pkg).some((b) => String(b).indexOf(name) >= 0)) return { ok: false, note: '已经在 bundles 里' };
        pkg.dsh.profile.bundles.push(name);
        writePkg(pkgPath, pkg, pkgText);
        return { ok: true, note: '已追加到 bundles 末尾' };
      }, { path: pkgPath, severity: f.severity });
    }

    if (f.fix === 'add-locale-export' && once('loc:' + name, true)) {
      add('add-locale-export', name, '给它的 package.json 补上 ./locale/*.json 导出 (否则宿主读不到中文名)', (ctx) => {
        const p = d.scan.plugins.find((x) => x.name === name);
        if (!p || !p.realPath) return { ok: false, note: '找不到插件目录' };
        const file = path.join(p.realPath, 'package.json');
        const text = fs.readFileSync(file, 'utf8');
        const obj = JSON.parse(text);
        if (!obj.exports || typeof obj.exports !== 'object' || Array.isArray(obj.exports)) return { ok: false, note: 'exports 不是对象, 需要手工改' };
        obj.exports['./locale/*.json'] = './locale/*.json';
        writePkg(file, obj, text);
        return { ok: true, note: 'exports 已加 ./locale/*.json' };
      }, { path: null, severity: f.severity });
    }

    if (f.fix === 'relabel' && once('relabel:' + name, true)) {
      add('relabel', name, '把登记表里的中文名重新写回插件目录 (升级覆盖掉了)', (ctx) => {
        const p = d.scan.plugins.find((x) => x.name === name);
        if (!p || !p.realPath) return { ok: false, note: '找不到插件目录' };
        return applyLabel(p);
      }, { path: null, severity: f.severity });
    }

    if (f.fix === 'init-locale' && once('initloc:' + name, true)) {
      add('init-locale', name, '生成 locale/zh.json + en.json 骨架 (标题先填包名, 之后你自己改)', (ctx) => {
        const p = d.scan.plugins.find((x) => x.name === name);
        if (!p || !p.realPath) return { ok: false, note: '找不到插件目录' };
        const dir = path.join(p.realPath, 'locale');
        ensureDir(dir);
        const zh = path.join(dir, 'zh.json');
        const en = path.join(dir, 'en.json');
        const created = [];
        if (!isFile(zh)) { fs.writeFileSync(zh, JSON.stringify({ meta: { title: p.name, description: p.description || '' } }, null, 2) + String.fromCharCode(10), 'utf8'); created.push('zh.json'); }
        if (!isFile(en)) { fs.writeFileSync(en, JSON.stringify({ meta: { title: p.name, description: p.description || '' } }, null, 2) + String.fromCharCode(10), 'utf8'); created.push('en.json'); }
        const file = path.join(p.realPath, 'package.json');
        const text = fs.readFileSync(file, 'utf8');
        const obj = JSON.parse(text);
        if (obj.exports && typeof obj.exports === 'object' && !Array.isArray(obj.exports) && !obj.exports['./locale/*.json']) {
          obj.exports['./locale/*.json'] = './locale/*.json';
          writePkg(file, obj, text);
          created.push('exports');
        }
        return { ok: true, note: '生成: ' + (created.length ? created.join(', ') : '无(已存在)') };
      }, { path: null, severity: f.severity });
    }

    if (f.fix === 'remove-orphan' && once('orph:' + name, true)) {
      add('remove-orphan', name, '删除残留包目录 ' + (f.path || ''), (ctx) => {
        if (!f.path) return { ok: false, note: '没有路径' };
        if (!isDir(f.path)) return { ok: false, note: '目录已不存在' };
        fs.rmSync(f.path, { recursive: true, force: true });
        return { ok: true, note: '已删除' };
      }, { path: f.path, severity: f.severity });
    }
  }

  return { profile, root, doctor: d, ops, planCount: ops.length };
}

export function fixApply(plan, opts) {
  const o = opts || {};
  const dryRun = o.dryRun !== false;
  const only = o.only ? new Set(o.only) : null;
  let snapshot = null;
  const touchedProfileFiles = plan.ops.some((op) => op.path && op.path.indexOf(plan.root) === 0);
  if (!dryRun && touchedProfileFiles && o.snapshot !== false) {
    snapshot = createSnapshot(plan.profile, 'fix 前自动备份');
  }
  const done = [], failed = [], skipped = [];
  for (const op of plan.ops) {
    if (only && !only.has(op.kind)) { skipped.push({ kind: op.kind, subject: op.subject, reason: '未选中' }); continue; }
    if (dryRun) { done.push({ kind: op.kind, subject: op.subject, description: op.description, simulated: true }); continue; }
    try {
      const r = op.apply({ dryRun });
      if (r && r.ok) done.push({ kind: op.kind, subject: op.subject, note: r.note });
      else failed.push({ kind: op.kind, subject: op.subject, error: (r && r.note) || '未修改' });
    } catch (e) {
      failed.push({ kind: op.kind, subject: op.subject, error: String((e && e.message) || e) });
    }
  }
  return { dryRun, snapshot: snapshot ? snapshot.id : null, done, failed, skipped };
}