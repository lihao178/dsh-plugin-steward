// 更新执行: 真正调用 pnpm 装新版本. 默认只预演, 加 {write:true} 才动手, 动手前自动快照
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileDir, REPORT_DIR, ensureDir, nowIso, stamp, isFile } from './util.mjs';
import { checkProfile } from './check.mjs';
import { createSnapshot, restoreSnapshot } from './snapshot.mjs';
import { satisfies } from './semver.mjs';

export function pnpmBin() {
  if (process.env.DSH_PM_PNPM) return process.env.DSH_PM_PNPM;
  const deps = path.resolve(path.dirname(process.execPath), '..', '..');
  return path.join(deps, 'pnpm', 'bin', 'pnpm.mjs');
}

export function readInstalled(profile, name) {
  const root = profileDir(profile);
  const pkgFile = path.join(root, 'node_modules', name, 'package.json');
  if (!isFile(pkgFile)) return null;
  try { return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || null; } catch (e) { return null; }
}

export async function updatePlan(profile, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const res = await checkProfile(profile, o);
  const ops = [];
  for (const row of res.rows || []) {
    if (!row.updatable || !row.target) continue;
    if (o.only && !(o.only.indexOf(row.name) >= 0 || o.only.indexOf(row.title) >= 0)) continue;
    const spec = String(row.spec || '');
    const exact = /^\d/.test(spec);
    const argv = ['add', row.name + '@' + row.target];
    if (exact) argv.push('--save-exact');
    ops.push({
      name: row.name, title: row.title, from: row.current, to: row.target, kind: row.kind,
      spec, exact, argv, compat: row.compat, blocked: !!(row.compat && row.compat.ok === false),
    });
  }
  const align = (res.rows || []).filter((r) => r.alignToHost && r.origin === 'builtin');
  return { profile, root, hostVersion: res.hostVersion || res.host, check: res, ops, align, argv0: pnpmBin() };
}

export function runPnpm(root, argv, opts) {
  const o = opts || {};
  const bin = pnpmBin();
  if (!isFile(bin)) return { ok: false, status: null, stdout: '', stderr: '找不到 pnpm: ' + bin, bin };
  ensureDir(REPORT_DIR);
  const r = spawnSync(process.execPath, [bin].concat(argv), {
    cwd: root,
    encoding: 'utf8',
    timeout: o.timeoutMs || 600000,
    env: Object.assign({}, process.env, { CI: '1' }),
  });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const logFile = path.join(REPORT_DIR, 'pnpm-' + stamp() + '.log');
  try { fs.writeFileSync(logFile, '$ pnpm ' + argv.join(' ') + String.fromCharCode(10, 10) + stdout + String.fromCharCode(10, 10) + stderr, 'utf8'); } catch (e) {}
  return { ok: r.status === 0, status: r.status, stdout, stderr, log: logFile, bin };
}

export function updateApply(plan, opts) {
  const o = opts || {};
  const write = o.write === true;
  const results = [];
  if (!write) {
    return {
      dryRun: true, write: false, snapshot: null,
      results: plan.ops.map((op) => ({ name: op.name, title: op.title, from: op.from, to: op.to, kind: op.kind, simulated: true, argv: ['pnpm'].concat(op.argv).join(' ') })),
      ok: 0, failed: 0,
    };
  }
  const snapshot = createSnapshot(plan.profile, '更新前自动备份');
  let ok = 0, failed = 0;
  for (const op of plan.ops) {
    if (op.blocked && !o.forceIncompatible) {
      results.push({ name: op.name, skipped: true, reason: '兼容性检查未通过: ' + ((op.compat && op.compat.reasons) || []).join('; ') });
      continue;
    }
    const r = runPnpm(plan.root, op.argv, { timeoutMs: o.timeoutMs });
    const after = readInstalled(plan.profile, op.name);
    const good = r.ok && after === op.to;
    if (good) ok++; else failed++;
    results.push({
      name: op.name, title: op.title, from: op.from, to: op.to, kind: op.kind,
      ok: good, status: r.status, log: r.log, versionAfter: after,
      error: good ? null : (after && after !== op.to ? '装完版本是 ' + after + ', 期望 ' + op.to : (r.stderr || '').split(String.fromCharCode(10)).filter(Boolean).slice(-3).join(' | ')),
    });
  }
  let rollback = null;
  if (failed && ok === 0 && o.rollback !== false) {
    rollback = restoreSnapshot(plan.profile, snapshot.id);
  }
  return { dryRun: false, write: true, snapshot: snapshot.id, results, ok, failed, rollback };
}

export function reinstallPlugin(profile, name, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const argv = ['install'];
  if (o.write !== true) return { dryRun: true, argv: argv.join(' '), name };
  const snapshot = createSnapshot(profile, '重装 ' + name + ' 前自动备份');
  const r = runPnpm(root, argv, { timeoutMs: o.timeoutMs });
  return { dryRun: false, name, ok: r.ok, status: r.status, log: r.log, snapshot: snapshot.id, stderr: (r.stderr || '').slice(-600) };
}