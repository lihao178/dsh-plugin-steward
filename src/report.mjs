// 报告: 把各种检查结果渲染成 Markdown / JSON 存档到 reports/
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_DIR, ensureDir, listDir, isFile, humanSize, nowIso, stamp } from './util.mjs';

export const SEV_LABEL = { error: '严重', warn: '警告', info: '提示' };

function table(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => ' --- ').join('|') + '|'];
  for (const r of rows) out.push('| ' + r.map((c) => String(c == null ? '' : c).split('|').join('\\|').split(String.fromCharCode(10)).join(' ')).join(' | ') + ' |');
  return out.join(String.fromCharCode(10));
}
function h(level, text) { return String.fromCharCode(35).repeat(level) + ' ' + text; }

export function renderScan(scan) {
  const L = [];
  L.push(h(1, 'DSH 插件清单 — ' + scan.profile));
  L.push('');
  L.push('- 生成时间: ' + nowIso());
  L.push('- 插件目录: ' + scan.root);
  L.push('- 宿主版本: ' + ((scan.host && scan.host.version) || '未知') + (scan.host && scan.host.from ? ' (来自 ' + scan.host.from + ')' : ''));
  L.push('- 宿主自带包: ' + (scan.hostPayloadCount || 0) + ' 个');
  const c = scan.counts || {};
  L.push('- 统计: 共 ' + c.total + ' / 自创 ' + c.self + ' / 市场 ' + c.market + ' / 宿主自带 ' + c.builtin + ' / 缺失 ' + c.missing + ' / 已装 ' + c.installed);
  L.push('');
  L.push(h(2, '全部插件'));
  const rows = (scan.plugins || []).map((p) => [
    p.title || p.name, p.version || '-', p.origin === 'self' ? '自创' : (p.origin === 'builtin' ? '宿主' : (p.origin === 'missing' ? '缺失' : '市场')),
    p.source === 'link' ? '软链' : (p.source === 'file' ? '本地目录' : (p.source === 'host' ? '宿主' : 'registry')),
    (p.capabilities && p.capabilities.primaryLabel) || '-', humanSize(p.sizeBytes || 0), p.disabled ? '已禁用' : '',
  ]);
  L.push(table(['名称', '版本', '来源', '类型', '功能', '占用', '状态'], rows));
  L.push('');
  if ((scan.orphans || []).length) {
    L.push(h(2, '残留包 (不在清单也不在 pnpm 映射里)'));
    L.push(table(['包名', '版本', '占用'], scan.orphans.map((o) => [o.name, o.version || '-', humanSize(o.sizeBytes || 0)])));
    L.push('');
  }
  return L.join(String.fromCharCode(10));
}

export function renderCheck(res) {
  const L = [];
  L.push(h(1, 'DSH 插件更新检查 — ' + res.profile));
  L.push('');
  L.push('- 生成时间: ' + nowIso());
  L.push('- 宿主版本: ' + (res.hostVersion || res.host || '未知'));
  const s = res.summary || {};
  L.push('- 统计: 检查 ' + s.checked + ' / 可更新 ' + s.updatable + ' (主版本 ' + s.major + ' 次版本 ' + s.minor + ' 补丁 ' + s.patch + ' 预发布 ' + s.prerelease + ') / 兼容性拦截 ' + s.blockedCompat + ' / 本地 ' + s.local + ' / 离线 ' + s.offline);
  L.push('');
  const up = (res.rows || []).filter((r) => r.updatable);
  L.push(h(2, '可更新 (' + up.length + ')'));
  if (!up.length) L.push('全部已是最新。');
  else L.push(table(['名称', '当前', '可更新到', '幅度', '兼容'], up.map((r) => [r.title || r.name, r.current, r.target, r.kind, r.compat && r.compat.ok ? 'OK' : ((r.compat && r.compat.reasons) || []).join('; ')])));
  L.push('');
  const rest = (res.rows || []).filter((r) => !r.updatable);
  L.push(h(2, '其余 (' + rest.length + ')'));
  L.push(table(['名称', '当前', '最新', '说明'], rest.map((r) => [r.title || r.name, r.current || '-', r.latest || '-', r.skipped ? ({ local: '自创插件, 不查市场', 'policy-off': '策略已关闭检查', offline: '连接市场失败' }[r.skipped] || r.skipped) : (r.reason || '已是最新')])));
  return L.join(String.fromCharCode(10));
}

export function renderDoctor(d) {
  const L = [];
  L.push(h(1, 'DSH 插件体检 — ' + d.profile));
  L.push('');
  L.push('- 生成时间: ' + nowIso());
  const s = d.summary || {};
  L.push('- 结论: ' + s.total + ' 项 (严重 ' + s.error + ' / 警告 ' + s.warn + ' / 提示 ' + s.info + '), 可自动修复 ' + s.fixable + ', 可清理 ' + s.cleanable);
  L.push('');
  for (const sev of ['error', 'warn', 'info']) {
    const list = (d.findings || []).filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(h(2, SEV_LABEL[sev] + ' (' + list.length + ')'));
    L.push(table(['对象', '问题', '说明', '可修'], list.map((f) => [f.subject, f.code, f.message, f.fixable ? '是 (' + f.fix + ')' : (f.cleanable ? '可清理' : '')])));
    L.push('');
  }
  return L.join(String.fromCharCode(10));
}

export function renderDupes(d) {
  const L = [];
  L.push(h(1, 'DSH 插件重复与重叠 — ' + d.profile));
  L.push('');
  L.push('- 生成时间: ' + nowIso());
  const s = d.summary || {};
  L.push('- 统计: 插件 ' + s.plugins + ' / 同名多版本 ' + s.multiVersion + ' / 功能重叠组 ' + s.capability + ' / cordis id 冲突 ' + s.cordis + ' / 共用插槽 ' + s.inject + ' / 名字相似 ' + s.similar + ' / 总占用 ' + humanSize(s.totalBytes || 0));
  L.push('');
  for (const f of d.findings || []) {
    L.push(h(2, f.title || f.code));
    L.push(f.message || '');
    if (f.list && f.list.length) L.push('', table(f.headers || ['项'], f.list));
    if (f.note) L.push('', '说明: ' + f.note);
    L.push('');
  }
  return L.join(String.fromCharCode(10));
}

export function renderClean(plan, applied) {
  const L = [];
  L.push(h(1, 'DSH 插件清理 — ' + plan.profile));
  L.push('');
  L.push('- 生成时间: ' + nowIso());
  L.push('- 合计 ' + plan.items.length + ' 项 / ' + humanSize(plan.totalBytes) + ', 其中安全项 ' + plan.safeCount + ' 个 / ' + humanSize(plan.safeBytes));
  if (applied) L.push('- 本次执行: ' + (applied.dryRun ? '仅预演' : '已删除 ' + applied.deleted.length + ' 项, 释放 ' + humanSize(applied.freedBytes)) + (applied.failed.length ? ', 失败 ' + applied.failed.length : ''));
  L.push('');
  const groups = {};
  for (const it of plan.items) (groups[it.kind] = groups[it.kind] || []).push(it);
  for (const k of Object.keys(groups)) {
    const list = groups[k];
    L.push(h(2, k + ' (' + list.length + ')'));
    L.push(table(['路径', '大小', '安全', '原因'], list.map((it) => [it.path.replace(/^.*node_modules/, 'node_modules'), humanSize(it.sizeBytes || 0), it.safe ? '是' : '需确认', it.reason])));
    L.push('');
  }
  return L.join(String.fromCharCode(10));
}

export function reportPath(name, opts) {
  const o = opts || {};
  ensureDir(REPORT_DIR);
  const ext = o.ext || 'md';
  return path.join(REPORT_DIR, name + '-' + stamp() + '.' + ext);
}

export function writeReport(name, text, opts) {
  const p = reportPath(name, opts);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

export function listReports() {
  return listDir(REPORT_DIR).filter((d) => d.isFile()).map((d) => ({ name: d.name, path: path.join(REPORT_DIR, d.name), size: d.size }));
}

export function latestReport(prefix) {
  const all = listReports().filter((r) => !prefix || r.name.indexOf(prefix) === 0);
  if (!all.length) return null;
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all[all.length - 1];
}