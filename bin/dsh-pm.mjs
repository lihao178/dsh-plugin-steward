#!/usr/bin/env node
// DSH 插件管家 CLI. 不带参数运行会进交互菜单.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { profileDir, listProfiles, VERSION, humanSize, nowIso, ensureDir, REPORT_DIR, isFile, DEFAULT_PROFILE, shortPath } from '../src/util.mjs';
import { scanProfile, ORIGIN_LABEL } from '../src/scan.mjs';
import { checkProfile } from '../src/check.mjs';
import { doctorProfile, doctorSummaryLine } from '../src/doctor.mjs';
import { dupeReport } from '../src/dupes.mjs';
import { cleanPlan, cleanApply, cleanSummary } from '../src/clean.mjs';
import { fixPlan, fixApply } from '../src/fix.mjs';
import { createSnapshot, listSnapshots, restoreSnapshot, pruneSnapshots, diffSnapshot } from '../src/snapshot.mjs';
import { updatePlan, updateApply } from '../src/apply.mjs';
import { autoRun, readAutoConfig, writeAutoConfig, readAutoLog, AUTO_CONFIG, AUTO_NDJSON } from '../src/auto.mjs';
import { installSchedule, scheduleStatus, removeSchedule, setTime, readDailyLog, DEFAULT_TIME, DAILY_NDJSON, DAILY_CMD } from '../src/schedule.mjs';
import { LABEL_FILE, loadLabels, setLabel, saveLabels, expectedTitle, BASE } from '../src/labels.mjs';
import * as RPT from '../src/report.mjs';
import { rowDefs } from '../src/patch.mjs';

const ESC = String.fromCharCode(27);
const PLAIN = !!(process.env.NO_COLOR || process.env.DSH_PM_PLAIN === '1' || !process.stdout.isTTY);
const paint = (n, s) => (PLAIN ? String(s) : ESC + '[' + n + 'm' + String(s) + ESC + '[0m');
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const gray = (s) => paint('90', s);
const bold = (s) => paint('1', s);

function w(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}
const padw = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));
function tbl(headers, rows) {
  const all = [headers].concat(rows.map((r) => r.map((c) => String(c == null ? '' : c))));
  const wid = headers.map((_, i) => Math.max.apply(null, all.map((r) => w(r[i] || ''))));
  const line = (r) => '  ' + r.map((c, i) => padw(c == null ? '' : c, wid[i])).join('  ');
  const out = [gray(line(headers))];
  for (const r of rows) out.push(line(r.map((c) => String(c == null ? '' : c))));
  return out.join(String.fromCharCode(10));
}
const H1 = (t) => bold(cyan(t));
const H2 = (t) => bold(t);
function bullet(k, v) { return '  ' + gray(padw(k, 12)) + v; }

function parseArgs(argv) {
  const o = { _: [] };
  const takesValue = ['profile', 'only', 'time', 'keep', 'id', 'name', 'format', 'origin', 'group', 'concurrency', 'reason', 'at', 'hours', 'days', 'limit', 'out'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const eq = a.indexOf('=');
      if (eq > 0) { o[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      const nx = argv[i + 1];
      if (takesValue.indexOf(k) >= 0 && nx && nx.slice(0, 2) !== '--') { o[k] = nx; i++; } else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const write = (flags) => flags.write === true || flags.apply === true || flags.yes === true;
const jsonOut = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + String.fromCharCode(10));

function ctx(flags) {
  const profile = flags.profile || DEFAULT_PROFILE;
  if (listProfiles().indexOf(profile) < 0) return { profile, error: '没有这个配置: ' + profile + ' (现有: ' + listProfiles().join(', ') + ')' };
  return { profile, root: profileDir(profile) };
}

// ---------- 命令 ----------

function cmdStatus(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const s = scanProfile(c.profile);
  const d = doctorProfile(c.profile, { scan: s });
  const cnt = s.counts || {};
  const self = s.plugins.filter((p) => p.origin === 'self');
  const market = s.plugins.filter((p) => p.origin === 'market');
  const noName = s.plugins.filter((p) => !p.title || p.title === p.name);

  if (flags.json) { jsonOut({ profile: c.profile, root: c.root, host: s.host, counts: cnt, doctor: d.summary, self: self.map((p) => p.name), market: market.map((p) => p.name) }); return 0; }

  console.log('');
  console.log(H1('DSH 插件管家  v' + VERSION));
  console.log(bullet('插件目录', shortPath(c.root)));
  console.log(bullet('宿主版本', (s.host && s.host.version) || '未知'));
  console.log(bullet('插件总数', String(cnt.total) + ' 个 (' + green('市场 ' + cnt.market) + ' / ' + cyan('自创 ' + cnt.self) + ' / ' + gray('宿主自带 ' + cnt.builtin) + (cnt.missing ? ' / ' + red('缺失 ' + cnt.missing) : '') + ')'));
  console.log(bullet('宿主自带包', (s.hostPayloadCount || 0) + ' 个 (打包在 app.asar 里, 跟宿主一起升级)'));
  console.log(bullet('占用空间', humanSize(s.plugins.reduce((a, p) => a + (p.sizeBytes || 0), 0))));
  console.log(bullet('未命名', noName.length ? yellow(noName.length + ' 个还没中文名: ' + noName.map((p) => p.name).join(', ')) : green('全部有中文名')));
  console.log(bullet('体检结论', (d.summary.errors ? red('严重 ' + d.summary.errors) : green('严重 0')) + ' / ' + (d.summary.warns ? yellow('警告 ' + d.summary.warns) : green('警告 0')) + ' / ' + gray('提示 ' + d.summary.infos) + (d.summary.fixable ? '  ' + yellow('可自动修 ' + d.summary.fixable + ' 项') : '')));
  const top = d.findings.filter((f) => f.severity !== 'info').slice(0, 5);
  if (top.length) {
    console.log('');
    for (const f of top) console.log('  ' + (f.severity === 'error' ? red('[严重]') : yellow('[警告]')) + ' ' + f.subject + ' :: ' + f.message);
    console.log(gray('  (完整清单: dsh-pm doctor)'));
  }
  console.log('');
  return 0;
}

function cmdList(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  let ps = scanProfile(c.profile).plugins;
  if (flags.origin) ps = ps.filter((p) => p.origin === flags.origin);
  if (flags.group) ps = ps.filter((p) => (p.capabilities && p.capabilities.primary) === flags.group);
  if (flags.json) { jsonOut(ps); return 0; }
  const byOrigin = { self: [], market: [], builtin: [], missing: [] };
  for (const p of ps) (byOrigin[p.origin] || (byOrigin[p.origin] = [])).push(p);
  const label = { self: '自创插件 (你自己写的, 不跟市场更新)', market: '市场插件 (从插件市场装的, 需要更新)', builtin: '宿主自带 (跟 DeepSeek Harness 一起升级)', missing: '缺失 (配置里引用了但磁盘上没有)' };
  for (const key of ['self', 'market', 'builtin', 'missing']) {
    const list = byOrigin[key] || [];
    if (!list.length) continue;
    console.log('');
    console.log(H2(label[key] + '  (' + list.length + ')'));
    const rows = list.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name, 'zh')).map((p) => [
      (p.title || p.name) + (p.disabled ? gray(' [已禁用]') : ''),
      p.version || '-',
      (p.capabilities && (p.capabilities.primaryLabel || p.capabilities.primary)) || '-',
      p.source === 'link' ? '软链' : (p.source === 'file' ? '本地目录' : (p.source === 'host' ? '宿主' : 'registry')),
      humanSize(p.sizeBytes || 0),
      p.inBundles ? '是' : gray('否'),
    ]);
    console.log(tbl(['名称', '版本', '功能', '类型', '占用', '已加载'], rows));
  }
  console.log('');
  return 0;
}

async function cmdCheck(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const res = await checkProfile(c.profile, { refresh: flags.refresh === true, concurrency: flags.concurrency ? Number(flags.concurrency) : undefined });
  if (flags.json) { jsonOut({ profile: c.profile, hostVersion: res.hostVersion || res.host, summary: res.summary, rows: res.rows }); return 0; }
  const s = res.summary;
  console.log('');
  console.log(H2('更新检查  ' + gray('宿主 ' + (res.hostVersion || res.host || '?'))));
  console.log(bullet('检查', String(s.checked) + ' 个 (跳过自创 ' + s.local + (s.offline ? ', 离线 ' + s.offline : '') + ')'));
  console.log(bullet('可更新', s.updatable ? yellow(String(s.updatable) + ' 个') : green('全部已是最新')));
  const up = res.rows.filter((r) => r.updatable);
  if (up.length) {
    console.log('');
    console.log(tbl(['名称', '当前', '可以升到', '幅度', '兼容'], up.map((r) => [
      r.title || r.name, r.current, green(r.target),
      r.kind === 'major' ? red('主版本') : (r.kind === 'minor' ? yellow('次版本') : '补丁'),
      r.compat && r.compat.ok ? green('OK') : (r.compat && r.compat.notes && r.compat.notes.length ? yellow('预发布门控') : green('OK')),
    ])));
    console.log('');
    console.log('  ' + gray('执行更新: dsh-pm update --write'));
  }
  console.log('');
  return 0;
}

async function cmdUpdate(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const plan = await updatePlan(c.profile, { refresh: flags.refresh === true, only: flags.only ? String(flags.only).split(',') : null });
  const res = await updateApply(plan, { write: write(flags), forceIncompatible: flags.force === true });
  if (flags.json) { jsonOut({ profile: c.profile, dryRun: res.dryRun, snapshot: res.snapshot, results: res.results, ok: res.ok, failed: res.failed, rollback: res.rollback }); return res.failed ? 1 : 0; }
  console.log('');
  console.log(H2('更新  ' + (res.dryRun ? yellow('预演 (没有改动任何东西)') : green('实际执行'))));
  if (!res.results.length) { console.log('  没有可更新的插件。'); console.log(''); return 0; }
  const rows = res.results.map((r) => [r.title || r.name, r.from || '-', r.to || '-', r.skipped ? yellow('跳过') : (r.ok ? green('成功') : (r.simulated ? gray('待执行') : red('失败'))), r.reason || r.error || (r.versionAfter ? '现在是 ' + r.versionAfter : '')]);
  console.log(tbl(['名称', '当前', '目标', '结果', '说明'], rows));
  if (res.dryRun) console.log(String.fromCharCode(10) + '  ' + gray('真正执行请加 --write (会自动先备份)'));
  if (res.snapshot) console.log('  ' + gray('改动前的备份: ' + res.snapshot));
  if (res.rollback) console.log('  ' + yellow('全部失败, 已自动还原: ' + JSON.stringify(res.rollback.restored)));
  console.log('');
  return res.failed ? 1 : 0;
}

function cmdDoctor(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const d = doctorProfile(c.profile);
  if (flags.json) { jsonOut({ profile: c.profile, summary: d.summary, findings: d.findings }); return d.summary.errors ? 1 : 0; }
  console.log('');
  console.log(H2(doctorSummaryLine(d)));
  for (const sev of ['error', 'warn', 'info']) {
    const list = d.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    console.log('');
    console.log('  ' + (sev === 'error' ? red('严重') : (sev === 'warn' ? yellow('警告') : gray('提示'))) + gray(' (' + list.length + ')'));
    for (const f of list) {
      console.log('   ' + (f.severity === 'error' ? red('-') : (f.severity === 'warn' ? yellow('-') : gray('-'))) + ' ' + bold(f.subject) + ' :: ' + f.message);
      if (f.fixable) console.log('     ' + green('可修复: ') + gray(f.fix));
    }
  }
  if (d.summary.fixable) console.log(String.fromCharCode(10) + '  ' + gray('执行修复: dsh-pm fix --write   (先看: dsh-pm fix)'));
  console.log('');
  return d.summary.errors ? 1 : 0;
}

function cmdFix(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const plan = fixPlan(c.profile);
  const res = fixApply(plan, { dryRun: !write(flags), only: flags.only ? String(flags.only).split(',') : null });
  if (flags.json) { jsonOut({ profile: c.profile, dryRun: res.dryRun, ops: plan.ops.map((o) => ({ kind: o.kind, subject: o.subject })), done: res.done, failed: res.failed, snapshot: res.snapshot }); return res.failed.length ? 1 : 0; }
  console.log('');
  console.log(H2('自动修复  ' + (res.dryRun ? yellow('预演 (没有改动任何东西)') : green('实际执行'))));
  if (!plan.ops.length) { console.log('  没有需要修的问题。'); console.log(''); return 0; }
  console.log(tbl(['动作', '对象', '说明'], plan.ops.map((o) => [o.kind, o.subject, o.description])));
  if (res.dryRun) console.log(String.fromCharCode(10) + '  ' + gray('真正执行请加 --write (会自动先备份)'));
  for (const f of res.failed) console.log('  ' + red('失败: ') + f.subject + ' :: ' + f.error);
  if (res.snapshot) console.log('  ' + gray('改动前的备份: ' + res.snapshot));
  console.log('');
  return res.failed.length ? 1 : 0;
}

function cmdDupes(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const d = dupeReport(c.profile);
  if (flags.json) { jsonOut(d); return 0; }
  const s = d.summary;
  console.log('');
  console.log(H2('重复与重叠分析'));
  console.log(bullet('插件', String(s.plugins) + ' 个 / 总占用 ' + humanSize(s.totalBytes || 0)));
  console.log(bullet('同名多版本', s.multiVersion ? yellow(String(s.multiVersion)) : green('无')));
  console.log(bullet('功能重叠', s.capability ? yellow(s.capability + ' 组') : green('无')));
  console.log(bullet('id 冲突', s.cordis ? red(String(s.cordis)) : green('无')));
  console.log(bullet('共用插槽', String(s.inject) + ' 个'));
  console.log('');
  for (const f of d.findings) {
    console.log('  ' + bold(f.title || f.subject || f.code) + gray('  [' + f.code + ']'));
    console.log('    ' + gray(f.message || ''));
    if (f.list && f.list.length) {
      console.log(tbl(f.headers || ['项'], f.list.map((r) => r.map((x) => String(x)))));
    }
    console.log('');
  }
  return 0;
}

function cmdClean(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const plan = cleanPlan(c.profile);
  const res = cleanApply(plan, { dryRun: !write(flags), includeUnsafe: flags.all === true });
  if (flags.json) { jsonOut({ profile: c.profile, summary: cleanSummary(plan), dryRun: res.dryRun, deleted: res.deleted, skipped: res.skipped, failed: res.failed, freedBytes: res.freedBytes }); return 0; }
  console.log('');
  console.log(H2('清理  ') + gray(cleanSummary(plan)));
  const groups = {};
  for (const it of plan.items) (groups[it.kind] = groups[it.kind] || []).push(it);
  const kindLabel = { 'orphan-pkg': '残留包', 'transitive-dep': '传递依赖(建议保留)', 'zero-op-log': '空的安装记录', 'cache-dir': '缓存', 'old-market-snapshot': '旧的市场快照', 'own-cache': '本工具缓存' };
  for (const k of Object.keys(groups)) {
    const list = groups[k];
    console.log('');
    console.log('  ' + bold(kindLabel[k] || k) + gray(' (' + list.length + ')'));
    console.log(tbl(['路径', '大小', '安全'], list.slice(0, 30).map((it) => [it.path.replace(/^.*node_modules/, 'node_modules').replace(/^.*profiles/, 'profiles'), humanSize(it.sizeBytes || 0), it.safe ? green('是') : yellow('需确认')])));
    if (list.length > 30) console.log(gray('    ...还有 ' + (list.length - 30) + ' 项'));
  }
  console.log('');
  console.log('  ' + (res.dryRun ? gray('预演: 将删除 ' + res.deleted.length + ' 项, 释放 ' + humanSize(res.freedBytes)) : green('已删除 ' + res.deleted.length + ' 项, 释放 ' + humanSize(res.freedBytes))));
  if (res.dryRun) console.log('  ' + gray('真正执行请加 --write, 连"需确认"的一起清加 --all'));
  for (const f of res.failed) console.log('  ' + red('失败: ') + f.path + ' :: ' + f.error);
  console.log('');
  return 0;
}

function cmdSnapshot(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const sub = flags._[1] || 'list';
  if (sub === 'create') {
    const m = createSnapshot(c.profile, flags.reason || '手动创建');
    if (flags.json) { jsonOut(m); return 0; }
    console.log(green('已创建快照 ') + m.id + gray(' (' + m.files.length + ' 个文件)'));
    return 0;
  }
  if (sub === 'restore') {
    const id = flags.id || flags._[2];
    const r = restoreSnapshot(c.profile, id, { dryRun: !write(flags) });
    if (flags.json) { jsonOut(r); return r.ok ? 0 : 1; }
    if (!r.ok) { console.log(red(r.error)); return 1; }
    if (r.dryRun) { console.log('将还原: ' + r.wouldRestore.join(', ')); console.log(gray('真正还原请加 --write')); return 0; }
    console.log(green('已还原 ') + r.id + gray(' (还原前自动存了 ' + r.pre + ')'));
    return 0;
  }
  if (sub === 'diff') {
    const d = diffSnapshot(c.profile, flags.id || flags._[2]);
    if (flags.json) { jsonOut(d); return 0; }
    for (const f of d.files) {
      console.log((f.changed ? yellow('改动 ') : gray('未变 ')) + f.rel);
      for (const l of f.added || []) console.log('  ' + green('+ ' + l));
      for (const l of f.removed || []) console.log('  ' + red('- ' + l));
    }
    return 0;
  }
  if (sub === 'prune') {
    const r = pruneSnapshots(c.profile, flags.keep ? Number(flags.keep) : 20);
    console.log('保留 ' + r.kept + ' 份, 删除 ' + r.removed.length + ' 份');
    return 0;
  }
  const list = listSnapshots(c.profile);
  if (flags.json) { jsonOut(list); return 0; }
  console.log('');
  console.log(H2('快照 (本工具的备份)'));
  if (!list.length) console.log('  ' + gray('还没有快照。dsh-pm snapshot create 可以手动建一份'));
  else console.log(tbl(['编号', '时间', '原因', '文件'], list.map((m) => [m.id, m.createdAt, m.reason || '-', String(m.files.length)])));
  const mk = scanProfile(c.profile).snapshots || [];
  console.log('');
  console.log(H2('插件市场自己的快照 (' + mk.length + ')') + gray('  用于市场面板一键回滚'));
  for (const s of mk) console.log('  ' + s);
  console.log('');
  return 0;
}

function cmdSchedule(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const sub = flags._[1] || 'status';
  if (sub === 'install' || sub === 'on') {
    const hours = flags.hours ? Number(flags.hours) : 0;
    const r = installSchedule({ time: flags.time || DEFAULT_TIME, hours, profile: c.profile, write: write(flags) });
    if (flags.json) { jsonOut(r); return r.ok ? 0 : 1; }
    const every = r.hours ? ('每 ' + r.hours + ' 小时') : ('每天 ' + r.time);
    if (r.dryRun) {
      console.log('将创建计划任务: ' + r.taskName);
      console.log('  频率: ' + every);
      console.log('  执行: ' + r.wrapper + gray('  (auto --write: 有新版本就装)'));
      console.log(gray('真正创建请加 --write'));
      return 0;
    }
    console.log(r.ok ? green('已创建计划任务 ') + r.taskName + ' (' + every + ', 有新版本自动装)' : red('创建失败: ' + r.stderr));
    return r.ok ? 0 : 1;
  }
  if (sub === 'remove' || sub === 'off') {
    const r = removeSchedule();
    if (flags.json) { jsonOut(r); return r.ok ? 0 : 1; }
    console.log(r.ok ? green('已删除计划任务') : red('删除失败: ' + r.stderr));
    return 0;
  }
  if (sub === 'time') {
    const r = setTime(flags.time || DEFAULT_TIME, { profile: c.profile });
    console.log(r.ok ? green('已改成每天 ' + r.time) : red('修改失败: ' + r.stderr));
    return 0;
  }
  const s = scheduleStatus();
  if (flags.json) { jsonOut(s); return 0; }
  console.log('');
  console.log(H2('定时任务'));
  console.log(bullet('任务名', s.taskName));
  console.log(bullet('状态', s.installed ? green('已安装') : gray('未安装')));
  if (s.installed) {
    console.log(bullet('下次运行', s.nextRun || '-'));
    const raw = String(s.lastResult == null ? '' : s.lastResult).trim();
    const code = /^0x/.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
    let resTxt;
    if (raw === '') resTxt = '';
    else if (code === 267011) resTxt = gray(' (从未运行)');
    else if (code === 267009) resTxt = gray(' (正在运行)');
    else if (code === 0) resTxt = green(' (成功)');
    else resTxt = red(' (结果 ' + raw + ')');
    const neverRun = code === 267011 || /1999/.test(String(s.lastRun || ''));
    console.log(bullet('上次运行', neverRun ? gray('从未运行过') : (s.lastRun || '-') + resTxt));
  }
  console.log(bullet('脚本', s.wrapperExists ? shortPath(DAILY_CMD) : yellow('还没生成, 安装时会自动写')));
  console.log(bullet('日志', shortPath(DAILY_NDJSON)));
  const log = readDailyLog(3);
  if (log.length) {
    console.log('');
    console.log('  ' + gray('最近的自动检查记录:'));
    for (const e of log) console.log('   ' + (e.at || '?') + '  ' + (e.text || JSON.stringify(e).slice(0, 100)));
  }
  console.log('');
  console.log('  ' + gray('安装: dsh-pm schedule install --write    改时间: dsh-pm schedule time 08:00    删除: dsh-pm schedule remove'));
  console.log('');
  return 0;
}

async function cmdReport(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const s = scanProfile(c.profile);
  const d = doctorProfile(c.profile, { scan: s });
  const q = dupeReport(c.profile, { scan: s });
  const files = [];
  files.push(RPT.writeReport('scan', RPT.renderScan(s)));
  files.push(RPT.writeReport('doctor', RPT.renderDoctor(d)));
  files.push(RPT.writeReport('dupes', RPT.renderDupes(q)));
  let res = null;
  if (flags.net !== false) {
    res = await checkProfile(c.profile);
    files.push(RPT.writeReport('check', RPT.renderCheck(res)));
  }
  if (flags.json) { jsonOut({ profile: c.profile, files }); return 0; }
  console.log('');
  console.log(H2('报告已生成'));
  for (const f of files) console.log('  ' + green('- ') + shortPath(f));
  console.log('');
  console.log('  ' + gray('目录: ' + shortPath(REPORT_DIR)));
  console.log('');
  return 0;
}

async function cmdDaily(flags) {
  const c = ctx(flags);
  if (c.error) { console.error(c.error); return 1; }
  const at = nowIso();
  const s = scanProfile(c.profile);
  const d = doctorProfile(c.profile, { scan: s });
  const q = dupeReport(c.profile, { scan: s });
  const clean = cleanPlan(c.profile);
  let chk = null, chkErr = null;
  try { chk = await checkProfile(c.profile, { timeoutMs: 8000 }); } catch (e) { chkErr = String((e && e.message) || e); }
  const summary = {
    at, profile: c.profile,
    plugins: s.counts.total, self: s.counts.self, market: s.counts.market, builtin: s.counts.builtin, missing: s.counts.missing,
    updatable: chk ? chk.summary.updatable : null,
    updates: chk ? chk.rows.filter((r) => r.updatable).map((r) => r.name + ' ' + r.current + ' -> ' + r.target) : [],
    errors: d.summary.errors, warns: d.summary.warns, dupes: q.summary.capability, cleanable: clean.safeCount, cleanBytes: clean.safeBytes,
    checkError: chkErr,
    text: '插件 ' + s.counts.total + ' (自创 ' + s.counts.self + ' / 市场 ' + s.counts.market + '), 可更新 ' + (chk ? chk.summary.updatable : '?') + ', 严重 ' + d.summary.errors + ', 警告 ' + d.summary.warns + ', 可清理 ' + clean.safeCount + ' 项 ' + humanSize(clean.safeBytes),
  };
  ensureDir(REPORT_DIR);
  const md = [RPT.renderScan(s), '', RPT.renderDoctor(d), '', RPT.renderDupes(q), ''].join(String.fromCharCode(10));
  const mdFile = RPT.writeReport('daily', md);
  if (flags.json) { process.stdout.write(JSON.stringify(summary) + String.fromCharCode(10)); return d.summary.errors ? 1 : 0; }
  console.log('');
  console.log(H2('每日检查  ' + at));
  console.log('  ' + summary.text);
  if (summary.updates.length) { console.log(''); for (const u of summary.updates) console.log('  ' + yellow('可更新: ') + u); }
  if (chkErr) console.log('  ' + gray('(更新检查失败: ' + chkErr + ')'));
  console.log('');
  console.log('  ' + gray('报告: ' + shortPath(mdFile)));
  console.log('');
  return d.summary.errors ? 1 : 0;
}

function cmdLabel(flags) {
  const c = ctx(flags);
  const sub = flags._[1] || "list";
  const table = loadLabels();
  if (sub === "set") {
    const name = flags._[2];
    const title = flags._.slice(3).join(" ");
    if (!name || !title) { console.log(red("用法: dsh-pm label set <包名> <中文名>")); return 2; }
    setLabel(name, title, flags.desc);
    console.log(green("已登记: " + name + " -> " + title));
    console.log(gray("  记在 " + shortPath(LABEL_FILE)));
    return 0;
  }
  if (sub === "sync") {
    const s = scanProfile(c.profile);
    const mine = {};
    for (const p of s.plugins) {
      if (!p.title || p.title === p.name) continue;
      mine[p.name] = { zh: { title: p.title } };
    }
    saveLabels(mine);
    console.log(green("已把当前 " + Object.keys(mine).length + " 个插件的中文名记进登记表"));
    console.log(gray("  以后谁的名字被升级冲掉了, 体检就会报出来"));
    return 0;
  }
  const s = scanProfile(c.profile);
  const rows = [];
  for (const p of s.plugins) {
    const want = expectedTitle(p.name);
    if (!want) continue;
    const cur = p.title && p.title !== p.name ? p.title : null;
    const state = !cur ? red("丢了") : (cur === want ? green("正常") : yellow("被改成 " + cur));
    rows.push([p.name, want, state]);
  }
  if (flags.json) { jsonOut({ profile: c.profile, count: rows.length, rows }); return 0; }
  console.log("");
  console.log(H2("中文名登记表"));
  console.log(bullet("登记", rows.length + " 个 (出厂自带 " + Object.keys(BASE).length + " 个)  " + shortPath(LABEL_FILE)));
  console.log("");
  if (rows.length) console.log(tbl(["包名", "应该叫", "现状"], rows));
  console.log("");
  console.log(gray("  改名: dsh-pm label set <包名> <中文名>     记下现状: dsh-pm label sync --write"));
  console.log(gray("  名字丢了的修法: dsh-pm fix --write"));
  console.log("");
  return 0;
}

function cmdWhere(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 2; }
  const key = String(flags._[1] || flags.name || "").toLowerCase();
  if (!key) { console.log(red("用法: dsh-pm where <插件包名 / 中文名 / 关键字>")); return 2; }
  const s = scanProfile(c.profile);
  const hits = s.plugins.filter((p) => ((p.name || "") + " " + (p.title || "") + " " + (p.titleEn || "") + " " + (p.cordisIds || []).join(" ")).toLowerCase().indexOf(key) >= 0);
  if (!hits.length) { console.log(red("没找到匹配 " + key + " 的插件")); return 1; }
  for (const p of hits) {
    console.log("");
    console.log(H1(p.title && p.title !== p.name ? p.title : p.name));
    console.log(bullet("包名", p.name));
    console.log(bullet("版本", (p.version || "?") + "   " + (ORIGIN_LABEL[p.origin] || p.origin) + (p.installed ? "" : "  (磁盘上没有)")));
    console.log(bullet("目录", shortPath(p.realPath || p.dir)));
    if (p.hasLocale) console.log(bullet("中文名", shortPath((p.realPath || p.dir) + "\\locale\\zh.json") + "  ->  " + (p.title || "?")));
    else console.log(bullet("中文名", gray("没有 locale 目录 (界面上会显示包名)")));
    let rows = [];
    const pf = p.bundlePatch ? path.join(p.realPath || p.dir, p.bundlePatch) : null;
    if (pf && fs.existsSync(pf)) {
      try { rows = rowDefs(fs.readFileSync(pf, "utf8")).filter((r) => r.id); } catch (e) {}
      console.log(bullet("配置文件", shortPath(pf)));
    } else {
      console.log(bullet("配置文件", gray("这个插件没有自己的 patch 文件 (纯前端插件常见)")));
    }
    if (!rows.length) { console.log(""); continue; }
    console.log("");
    console.log("  " + bold("它在宿主里的配置行") + gray("  (想在 profile 的 cordis.patch.yml 里给它写配置, 就按这个 id 找)"));
    for (const r of rows) {
      console.log("    - id: " + r.id + (r.name ? "\n      name: " + r.name : gray("\n      name: (没写, 写不写都行)")));
      if (r.keys.length) console.log(gray("      该行设置过: " + r.keys.join(", ")));
    }
    const first = rows[0];
    console.log("");
    console.log("  " + bold("要改它的配置, 把下面这段加到") + " " + gray(shortPath(c.root + "\\cordis.patch.yml")));
    console.log("    - id: " + first.id);
    if (first.name) console.log("      name: " + first.name);
    console.log("      config:");
    console.log(gray("        # config 是整块替换, 不是深层合并: 原来那份要全抄过来再改"));
    console.log("");
  }
  return 0;
}

function cmdHelp() {
  console.log('');
  console.log(H1('DSH 插件管家  v' + VERSION));
  console.log('');
  console.log('  dsh-pm                     进交互菜单');
  console.log('  dsh-pm status              总览');
  console.log('  dsh-pm list                插件清单 (按自创/市场/宿主分组)');
  console.log('  dsh-pm check               查有没有新版');
  console.log('  dsh-pm update [--write]    更新插件 (默认只看不动)');
  console.log('  dsh-pm auto [--write]      自动更新: 有新版本就装 (备份 + 失败还原)');
  console.log('  dsh-pm auto on|off         开关自动更新');
  console.log('  dsh-pm auto skip <包名>    某个插件不自动升 (unskip 撤销)');
  console.log('  dsh-pm auto log            看最近几次自动更新记录');
  console.log('  dsh-pm doctor              健康体检');
  console.log('  dsh-pm fix [--write]       自动修复');
  console.log('  dsh-pm dupes               重复与功能重叠');
  console.log('  dsh-pm clean [--write]     清理垃圾');
  console.log('  dsh-pm snapshot [create|restore|diff|prune]');
  console.log('  dsh-pm schedule [install|remove|time|status]');
  console.log('  dsh-pm report              导出 Markdown 报告');
  console.log('  dsh-pm daily               每日检查 (只看不升)');
  console.log('  dsh-pm label [list|set|sync]  中文名登记表 (升级冲掉名字后靠它修)');
  console.log('  dsh-pm where <关键字>          这个插件在宿主里的配置行长什么样 (写配置时抄它)');
  console.log('');
  console.log(gray('  通用参数: --profile <名字>  --json  --write(真改)  --only <名字,名字>'));
  console.log('');
  return 0;
}

async function cmdAuto(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const sub = String(flags._[1] || '');

  if (sub === 'on' || sub === 'off') {
    const cfg = writeAutoConfig({ enabled: sub === 'on' });
    console.log('');
    console.log(green('自动更新: ' + (cfg.enabled ? '已开启' : '已关闭')));
    console.log(gray('  记在 ' + shortPath(AUTO_CONFIG)));
    console.log('');
    return 0;
  }
  if (sub === 'skip' || sub === 'unskip') {
    const name = flags._[2];
    if (!name) { console.log(red('用法: dsh-pm auto skip <包名>    撤销: dsh-pm auto unskip <包名>')); return 2; }
    const cfg = readAutoConfig();
    const list = cfg.skip.filter((s) => String(s).toLowerCase() !== String(name).toLowerCase());
    if (sub === 'skip') list.push(name);
    const next = writeAutoConfig({ skip: list });
    console.log('');
    console.log(green('skip 名单: ' + (next.skip.join(', ') || '(空)')));
    console.log('');
    return 0;
  }
  if (sub === 'log') {
    const log = readAutoLog(5);
    console.log('');
    console.log(H2('最近的自动更新记录'));
    if (!log.length) console.log('  ' + gray('还没有记录'));
    for (const r of log) {
      console.log('  ' + (r.at || '?') + '  ' + (r.note || '') + (r.updated && r.updated.length ? '  ' + r.updated.join(', ') : ''));
    }
    console.log('');
    console.log(gray('  完整记录: ' + shortPath(AUTO_NDJSON)));
    console.log('');
    return 0;
  }

  const res = await autoRun(c.profile, {
    write: write(flags),
    refresh: flags.cached !== true,
    only: flags.only ? String(flags.only).split(',') : null,
    forceIncompatible: flags.force === true,
  });
  if (flags.json) { jsonOut(res); return res.failed ? 1 : 0; }

  console.log('');
  console.log(H2('自动更新  ' + (res.dryRun ? yellow('预演 (没有改动任何东西)') : green('实际执行'))));
  if (res.disabled) {
    console.log('  ' + yellow('自动更新已关闭') + gray('  —  开启: dsh-pm auto on'));
    console.log('');
    return 0;
  }
  console.log(bullet('检查', String(res.checked || 0) + ' 个插件, 可更新 ' + (res.updatable || 0) + ' 个'));
  if (!res.candidates.length && !res.held.length) {
    console.log(bullet('结果', green('全部已是最新, 什么都没做')));
    console.log('');
    return 0;
  }
  if (res.candidates.length) {
    console.log('');
    console.log(tbl(['待装', '当前', '升到', '幅度'], res.candidates.map((r) => [
      r.title || r.name, r.from || '-', green(r.to), r.kind === 'major' ? red('主版本') : (r.kind === 'minor' ? yellow('次版本') : '补丁'),
    ])));
  }
  if (res.held && res.held.length) {
    console.log('');
    console.log('  ' + yellow('没自动升的') + gray(' (' + res.held.length + ')'));
    for (const h of res.held) console.log('   - ' + (h.title || h.name) + ' ' + (h.from || '') + ' -> ' + (h.to || '') + '  ' + gray(h.why));
  }
  if (res.results && res.results.length) {
    console.log('');
    console.log(tbl(['装了', '从', '到', '结果'], res.results.map((r) => [
      r.title || r.name, r.from || '-', r.to || '-',
      r.ok ? green('成功') : (r.skipped ? yellow('跳过') : red('失败') + ' ' + (r.error || '')),
    ])));
  }
  if (res.snapshot) console.log('  ' + gray('改动前的备份: ' + res.snapshot));
  if (res.rollback) console.log('  ' + yellow('体检变差或全失败, 已自动还原'));
  if (res.doctorErrors) console.log('  ' + gray('体检严重项: ' + res.doctorErrors.before + ' -> ' + res.doctorErrors.after));
  if (res.note) console.log('  ' + (res.verdict && res.verdict !== 'ok' ? yellow(res.note) : gray(res.note)));
  console.log('');
  console.log('  ' + gray('记录: ' + shortPath(AUTO_NDJSON)));
  console.log('');
  return res.failed ? 1 : 0;
}

async function cmdMenu(flags) {
  const c = ctx(flags);
  if (c.error) { console.log(red(c.error)); return 1; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const pause = () => ask(String.fromCharCode(10) + gray('  按回车回到菜单...'));
  const items = [
    ['1', '总览', '一眼看完插件状态', () => cmdStatus({ profile: c.profile })],
    ['2', '插件清单', '自创 / 市场 / 宿主 分组列出', () => cmdList({ profile: c.profile })],
    ['3', '更新检查', '查有没有新版, 能不能升', () => cmdCheck({ profile: c.profile })],
    ['4', '更新插件', '把可更新的装上 (会先备份, 需确认)', () => cmdUpdate({ profile: c.profile })],
    ['5', '健康体检', '查损坏 / 冲突 / 配置问题', () => cmdDoctor({ profile: c.profile })],
    ['6', '自动修复', '修掉能自动修的问题', () => cmdFix({ profile: c.profile })],
    ['7', '重复分析', '同名多版本 / 功能重叠 / 插槽冲突', () => cmdDupes({ profile: c.profile })],
    ['8', '清理垃圾', '残留包 / 空日志 / 缓存', () => cmdClean({ profile: c.profile })],
    ['9', '备份与回滚', '快照列表 / 新建 / 还原', () => cmdSnapshot({ profile: c.profile, _: ['snapshot', 'list'] })],
    ['10', '定时任务', '每天自动检查一次', () => cmdSchedule({ profile: c.profile, _: ['schedule', 'status'] })],
    ['11', '导出报告', '生成 Markdown 报告文件', () => cmdReport({ profile: c.profile })],
    ['0', '退出', '', null],
  ];
  for (;;) {
    const s = scanProfile(c.profile);
    const d = doctorProfile(c.profile, { scan: s });
    console.log('');
    console.log(bold(cyan('  ============================================================')));
    console.log('  ' + bold('DSH 插件管家') + '  v' + VERSION + gray('    配置: ' + c.profile + '   宿主: ' + ((s.host && s.host.version) || '?')));
    console.log(bold(cyan('  ============================================================')));
    console.log('  ' + gray('插件 ' + s.counts.total + ' 个 (自创 ' + s.counts.self + ' / 市场 ' + s.counts.market + ' / 宿主 ' + s.counts.builtin + (s.counts.missing ? ' / 缺失 ' + s.counts.missing : '') + ')') + '   ' + (d.summary.errors ? red('严重 ' + d.summary.errors) : green('严重 0')) + '  ' + (d.summary.warns ? yellow('警告 ' + d.summary.warns) : green('警告 0')) + (d.summary.fixable ? '  ' + yellow('可修 ' + d.summary.fixable) : ''));
    console.log('');
    for (const it of items) {
      if (it[0] === '0') continue;
      console.log('   ' + bold(it[0].length === 1 ? ' ' + it[0] : it[0]) + ')  ' + padw(it[1], 12) + gray(it[2]));
    }
    console.log('    ' + bold('0') + ')  ' + padw('退出', 12) + gray(''));
    console.log('');
    const a = (await ask('  选一个 (0-11): ')).trim();
    const hit = items.find((x) => x[0] === a);
    if (!hit) { console.log(gray('  没有这个选项')); continue; }
    if (a === '0') break;
    console.log('');
    if (a === '4') {
      const p = (await ask('  只看不改 / 真更新? 输入 w 真更新, 直接回车只看: ')).trim().toLowerCase();
      try { await cmdUpdate({ profile: c.profile, write: p === 'w' }); } catch (e) { console.log(red('出错: ' + e.message)); }
      await pause();
      continue;
    }
    if (a === '6' || a === '8') {
      const p = (await ask('  预演 / 真执行? 输入 w 真执行, 直接回车预演: ')).trim().toLowerCase();
      const runner = a === '6' ? cmdFix : cmdClean;
      try { await runner({ profile: c.profile, write: p === 'w' }); } catch (e) { console.log(red('出错: ' + e.message)); }
      await pause();
      continue;
    }
    if (a === '9') {
      console.log(H2('备份与回滚'));
      const list = listSnapshots(c.profile);
      console.log('  本工具快照: ' + (list.length ? list.length + ' 份' : '无'));
      for (const m of list.slice(0, 8)) console.log('   ' + m.id + '  ' + gray(m.reason || ''));
      const p = (await ask('  回车返回 / 输入 c 新建快照 / 输入 r 还原某个快照: ')).trim().toLowerCase();
      if (p === 'c') { const m = createSnapshot(c.profile, '手动创建'); console.log(green('已建 ') + m.id); }
      if (p === 'r') {
        const id = (await ask('  输入快照编号: ')).trim();
        const r = restoreSnapshot(c.profile, id, { dryRun: false });
        console.log(r.ok ? green('已还原') + gray(' (还原前的状态存为 ' + r.pre + ')') : red(r.error));
      }
      await pause();
      continue;
    }
    if (a === '10') {
      const st = scheduleStatus();
      console.log(H2('定时任务'));
      console.log('  当前: ' + (st.installed ? green('已安装') : gray('未安装')) + (st.nextRun ? gray('  下次 ' + st.nextRun) : ''));
      const p = (await ask('  输入 i 安装 (每天 ' + DEFAULT_TIME + ') / 输入 d 删除 / 回车返回: ')).trim().toLowerCase();
      if (p === 'i') { const r = installSchedule({ time: DEFAULT_TIME, profile: c.profile, write: true }); console.log(r.ok ? green('已安装, 每天 ' + r.time) : red(r.stderr)); }
      if (p === 'd') { const r = removeSchedule(); console.log(r.ok ? green('已删除') : red(r.stderr)); }
      await pause();
      continue;
    }
    try { await hit[4](); } catch (e) { console.log(red('出错: ' + e.message)); }
    await pause();
  }
  rl.close();
  console.log(gray('  再见'));
  return 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0] || '';
  if (cmd === 'help' || flags.help === true) return cmdHelp();
  if (!cmd) return cmdMenu(flags);
  const table = {
    status: cmdStatus, list: cmdList, ls: cmdList, check: cmdCheck, update: cmdUpdate, up: cmdUpdate,
    doctor: cmdDoctor, health: cmdDoctor, fix: cmdFix, repair: cmdFix, dupes: cmdDupes, dup: cmdDupes,
    clean: cmdClean, gc: cmdClean, snapshot: cmdSnapshot, snap: cmdSnapshot, backup: cmdSnapshot,
    schedule: cmdSchedule, task: cmdSchedule, report: cmdReport, daily: cmdDaily, label: cmdLabel, labels: cmdLabel, where: cmdWhere, info: cmdWhere,
    auto: cmdAuto, autoupdate: cmdAuto,
  };
  const fn = table[cmd];
  if (!fn) { console.log(red('不认识的命令: ' + cmd)); return cmdHelp(); }
  return await fn(flags);
}

main().then((code) => { process.exitCode = code || 0; }).catch((e) => { console.error('崩溃: ' + ((e && e.stack) || e)); process.exitCode = 2; });