// 定时任务: 用 Windows 计划任务每天跑一次检查 (schtasks 数组传参, 不经过 shell 拼字符串)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOL_ROOT, STATE_DIR, REPORT_DIR, ensureDir, writeJson, readJson, isFile, nowIso } from './util.mjs';

export const TASK_NAME = 'DSH-Plugin-Manager-Daily';
export const DAILY_CMD = path.join(TOOL_ROOT, 'bin', 'daily.cmd');
export const SCHEDULE_FILE = path.join(STATE_DIR, 'schedule.json');
export const DAILY_NDJSON = path.join(REPORT_DIR, 'daily.ndjson');
export const DEFAULT_TIME = '09:30';

export function nodePath() { return process.execPath; }
export function cliPath() { return path.join(TOOL_ROOT, 'bin', 'dsh-pm.mjs'); }

export function writeWrapper(opts) {
  const o = opts || {};
  const profile = o.profile || 'desktop';
  ensureDir(path.dirname(DAILY_CMD));
  ensureDir(REPORT_DIR);
  const lines = [
    '@echo off',
    'chcp 65001 > nul',
    'set DSH_PM_PLAIN=1',
    '"' + nodePath() + '" "' + cliPath() + '" auto --write --profile ' + profile + ' --json >> "' + DAILY_NDJSON + '" 2>&1',
  ];
  fs.writeFileSync(DAILY_CMD, lines.join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10), 'utf8');
  return DAILY_CMD;
}

export function installSchedule(opts) {
  const o = opts || {};
  const time = o.time || DEFAULT_TIME;
  // --hours 必须是数字. 注意 Number(true) === 1, 参数没带值时会被误当成「每 1 小时」, 所以这里显式拦掉.
  if (o.hours === true) return { ok: false, error: '--hours 需要一个数字, 例如: schedule install --hours 2 --time 08:00 --write' };
  const rawHours = Number(o.hours || 0);
  if (!Number.isFinite(rawHours) || rawHours < 0) return { ok: false, error: '--hours 不是合法数字: ' + String(o.hours) };
  const hours = rawHours > 0 && rawHours < 1 ? 1 : Math.round(rawHours);
  const profile = o.profile || 'desktop';
  if (o.dryRun !== false && o.write !== true) {
    return { ok: true, dryRun: true, taskName: TASK_NAME, time, hours, wrapper: DAILY_CMD, profile, note: '未改动系统, 加 write:true 才真正创建计划任务' };
  }
  writeWrapper({ profile });
  const argv = hours > 0
    ? ['/Create', '/TN', TASK_NAME, '/TR', DAILY_CMD, '/SC', 'HOURLY', '/MO', String(hours), '/ST', time, '/F']
    : ['/Create', '/TN', TASK_NAME, '/TR', DAILY_CMD, '/SC', 'DAILY', '/ST', time, '/F'];
  const r = spawnSync('schtasks', argv, { encoding: 'utf8' });
  const ok = r.status === 0;
  if (ok) writeJson(SCHEDULE_FILE, { taskName: TASK_NAME, time, hours: hours > 0 ? hours : null, profile, wrapper: DAILY_CMD, autoUpdate: true, installedAt: nowIso(), lastResult: 'ok' });
  return { ok, taskName: TASK_NAME, time, hours: hours > 0 ? hours : null, profile, wrapper: DAILY_CMD, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

export function scheduleStatus() {
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], { encoding: 'utf8' });
  const installed = r.status === 0;
  const fields = {};
  if (installed) {
    for (const line of String(r.stdout || '').split(String.fromCharCode(10))) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k && !(k in fields)) fields[k] = v;
    }
  }
  return {
    installed, taskName: TASK_NAME,
    config: readJson(SCHEDULE_FILE, null),
    wrapperExists: isFile(DAILY_CMD),
    nextRun: fields['Next Run Time'] || fields['下次运行时间'] || null,
    lastRun: fields['Last Run Time'] || fields['上次运行时间'] || null,
    lastResult: fields['Last Result'] || fields['上次结果'] || null,
    status: fields['Status'] || fields['状态'] || null,
    raw: installed ? String(r.stdout || '').trim() : String(r.stderr || '').trim(),
  };
}

export function removeSchedule() {
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (ok && isFile(SCHEDULE_FILE)) { try { fs.unlinkSync(SCHEDULE_FILE); } catch (e) {} }
  return { ok, taskName: TASK_NAME, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}

export function setTime(time, opts) {
  const o = opts || {};
  const r = spawnSync('schtasks', ['/Change', '/TN', TASK_NAME, '/ST', time], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (ok) {
    const cfg = readJson(SCHEDULE_FILE, { taskName: TASK_NAME, profile: o.profile || 'desktop', wrapper: DAILY_CMD });
    cfg.time = time;
    cfg.updatedAt = nowIso();
    writeJson(SCHEDULE_FILE, cfg);
  }
  return { ok, time, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}

export function readDailyLog(limit) {
  const n = limit || 10;
  if (!isFile(DAILY_NDJSON)) return [];
  let text = '';
  try { text = fs.readFileSync(DAILY_NDJSON, 'utf8'); } catch (e) { return []; }
  const lines = text.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith('{'));
  return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
}