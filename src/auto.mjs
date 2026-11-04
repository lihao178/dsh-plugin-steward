// 自动更新: 只要上游出了新版本就装上, 全程带备份与失败还原
//
// 一次 auto 的完整闭环:
//   联网查版本 -> 挑出可更新的 -> 体检基线 -> 快照备份 -> pnpm 装新版
//   -> 复检 (版本 + 体检) -> 变差就自动还原 -> 追加一行记录到 reports\auto.ndjson
//
// 默认只预演, {write:true} 才真装. 排除规则写在 .state\auto.json:
//   { "enabled": true, "allowMajor": true, "skip": ["某个包名"] }
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_DIR, STATE_DIR, ensureDir, nowIso, readJson, writeJson } from './util.mjs';
import { checkProfile } from './check.mjs';
import { updatePlan, updateApply } from './apply.mjs';
import { restoreSnapshot } from './snapshot.mjs';
import { doctorProfile } from './doctor.mjs';

export const AUTO_CONFIG = path.join(STATE_DIR, 'auto.json');
export const AUTO_NDJSON = path.join(REPORT_DIR, 'auto.ndjson');

const DEFAULTS = { enabled: true, allowMajor: true, respectPolicy: true, skip: [] };

export function readAutoConfig() {
  const raw = readJson(AUTO_CONFIG, null);
  const cfg = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  if (!Array.isArray(cfg.skip)) cfg.skip = [];
  return cfg;
}

export function writeAutoConfig(patch) {
  const next = Object.assign(readAutoConfig(), patch || {});
  ensureDir(STATE_DIR);
  writeJson(AUTO_CONFIG, next);
  return next;
}

/** 这一条到底该不该自动升; null 表示该升, 字符串表示不升的理由. */
export function skipReason(row, cfg) {
  if (!row || !row.updatable || !row.target) return '没有可用新版本';
  const skip = new Set((cfg.skip || []).map((s) => String(s).toLowerCase()));
  if (skip.has(String(row.name).toLowerCase())) return '在 skip 名单里';
  if (row.title && skip.has(String(row.title).toLowerCase())) return '在 skip 名单里';
  // 面板「设置 → 自动安装」勾着的插件才自动装; 没勾的只在列表里提示可更新.
  // .state/auto.json 里写 "respectPolicy": false 可以退回「全部都装」的老行为.
  if (cfg.respectPolicy !== false && row.autoInstall !== true) return '未勾选「自动安装」(去 设置 → 全选自动安装)';
  if (cfg.allowMajor === false && row.kind === 'major') return '主版本升级已被关闭 (allowMajor=false)';
  if (row.ignored) return '已被标记忽略';
  if (row.deferred) return '被延后';
  if (row.compat && row.compat.ok === false) {
    const why = (row.compat.reasons || []).join('; ');
    return '兼容性检查未通过' + (why ? ': ' + why : '');
  }
  return null;
}

export function selectCandidates(rows, cfg) {
  const picked = [];
  const held = [];
  for (const row of rows || []) {
    if (!row || !row.updatable || !row.target) continue;
    const why = skipReason(row, cfg);
    if (why) held.push({ name: row.name, title: row.title, from: row.current, to: row.target, why });
    else picked.push(row);
  }
  return { picked, held };
}

function appendRecord(rec) {
  ensureDir(REPORT_DIR);
  try { fs.appendFileSync(AUTO_NDJSON, JSON.stringify(rec) + String.fromCharCode(10), 'utf8'); } catch (e) {}
}

function describe(rows) {
  return rows.map((r) => ({ name: r.name, title: r.title, from: r.current, to: r.target, kind: r.kind }));
}

/**
 * 跑一轮自动更新.
 * @param {string} profile - profile 名
 * @param {object} opts - { write, refresh, only, forceIncompatible, allowRollback }
 */
export async function autoRun(profile, opts) {
  const o = opts || {};
  const write = o.write === true;
  const cfg = readAutoConfig();
  const at = nowIso();

  if (cfg.enabled === false) {
    const rec = { at, profile, skippedAll: '自动更新已关闭 (.state/auto.json enabled=false)', updated: [], failed: 0 };
    appendRecord(rec);
    return Object.assign({ dryRun: !write, disabled: true }, rec);
  }

  const check = await checkProfile(profile, { refresh: o.refresh !== false });
  const rows = (check.rows || []).filter((r) => r.updatable && r.target);
  const { picked, held } = selectCandidates(
    o.only ? rows.filter((r) => (o.only || []).indexOf(r.name) >= 0) : rows,
    cfg,
  );

  const base = {
    at, profile, dryRun: !write,
    checked: check.summary ? check.summary.checked : null,
    updatable: check.summary ? check.summary.updatable : rows.length,
    candidates: describe(picked),
    held,
    hostVersion: check.hostVersion || check.host || null,
  };

  if (!picked.length) {
    const rec = Object.assign(base, { updated: [], ok: 0, failed: 0, note: '没有需要装的更新' });
    appendRecord(rec);
    return rec;
  }

  const plan = await updatePlan(profile, { only: picked.map((r) => r.name) });

  if (!write) {
    const preview = await updateApply(plan, { write: false });
    const rec = Object.assign(base, {
      preview: preview.results.map((r) => ({ name: r.name, title: r.title, from: r.from, to: r.to, argv: r.argv })),
      ok: 0, failed: 0, note: '预演, 没有改动任何文件 (加 write:true 才真装)',
    });
    appendRecord(rec);
    return rec;
  }

  const errorsBefore = doctorProfile(profile).summary.errors;
  const applied = await updateApply(plan, { write: true, forceIncompatible: o.forceIncompatible === true, rollback: false });
  const errorsAfter = doctorProfile(profile).summary.errors;

  let rollback = null;
  let verdict = 'ok';
  if (applied.failed > 0 && applied.ok === 0) verdict = '全部失败, 已还原';
  else if (errorsAfter > errorsBefore) verdict = '体检严重项变多, 已还原';

  if (verdict !== 'ok' && o.allowRollback !== false && applied.snapshot) {
    try { rollback = restoreSnapshot(profile, applied.snapshot); } catch (e) { rollback = { error: String((e && e.message) || e) }; }
  }

  const rec = Object.assign(base, {
    snapshot: applied.snapshot || null,
    results: applied.results.map((r) => ({
      name: r.name, title: r.title, from: r.from, to: r.to, kind: r.kind,
      ok: !!r.ok, versionAfter: r.versionAfter || null, error: r.error || null, skipped: !!r.skipped, reason: r.reason || null,
    })),
    updated: applied.results.filter((r) => r.ok).map((r) => r.name + ' ' + r.from + ' -> ' + r.versionAfter),
    ok: applied.ok, failed: applied.failed,
    doctorErrors: { before: errorsBefore, after: errorsAfter },
    verdict, rollback,
    needsRestart: applied.ok > 0,
    note: applied.ok > 0 ? '新版本已落盘, 重启 Harness 后生效' : '没有装成功的更新',
  });
  appendRecord(rec);
  return rec;
}

export function readAutoLog(limit) {
  const n = limit || 10;
  if (!fs.existsSync(AUTO_NDJSON)) return [];
  let text = '';
  try { text = fs.readFileSync(AUTO_NDJSON, 'utf8'); } catch (e) { return []; }
  return text.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith('{')).slice(-n)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
}
