// dsh-pm 基础工具层: 路径解析 / 文件读写 / 终端输出 / 表格
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME           = os.homedir();
export const DSH_HOME       = process.env.DSH_HOME || path.join(HOME, '.dsh');
export const PROFILES_DIR   = path.join(DSH_HOME, 'profiles');
export const DEFAULT_PROFILE= process.env.DSH_PROFILE || 'desktop';
export const STATE_DIR      = path.join(TOOL_ROOT, '.state');
export const SNAPSHOT_DIR   = path.join(STATE_DIR, 'snapshots');
export const REPORT_DIR     = path.join(TOOL_ROOT, 'reports');
export const VERSION        = '1.0.0';

const BOM = String.fromCharCode(0xfeff);
const ESC = String.fromCharCode(27);

/* ---------------- 路径 ---------------- */
export function profileDir(profile = DEFAULT_PROFILE) {
  return path.join(PROFILES_DIR, profile);
}
export function listProfiles() {
  return listDir(PROFILES_DIR).filter(d => d.isDirectory()).map(d => d.name);
}
export function shortPath(p) {
  if (!p) return String(p);
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length) : String(p);
}

/* ---------------- 文件读写 ---------------- */
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
export function writeText(p, s) { ensureDir(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }
export function writeJson(p, o) { writeText(p, JSON.stringify(o, null, 2)); }
export function readText(p, def = '') {
  try { return fs.readFileSync(p, 'utf8').split(BOM).join(''); } catch (e) { return def; }
}
const MISS = Symbol('miss');
export function readJson(p, def = null) {
  const t = readText(p, MISS);
  if (t === MISS) return def;
  try { return JSON.parse(t); } catch (e) { return def; }
}
export function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
export function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
export function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
export function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return []; } }
export function statOf(p) { try { return fs.lstatSync(p); } catch (e) { return null; } }

/** 目录体积, 不跟随符号链接, 避免递归进 pnpm store */
export function dirSize(p) {
  let total = 0;
  const walk = (cur, depth) => {
    if (depth > 6) return;
    for (const d of listDir(cur)) {
      const fp = path.join(cur, d.name);
      try {
        if (d.isSymbolicLink()) { total += 64; continue; }
        if (d.isDirectory()) walk(fp, depth + 1);
        else if (d.isFile()) total += fs.statSync(fp).size;
      } catch (e) { /* 忽略 */ }
    }
  };
  if (isDir(p)) walk(p, 0);
  return total;
}
export function humanSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}
export function nowIso() { return new Date().toISOString(); }
export function stamp() { return nowIso().replace(/[:.]/g, '-'); }
export function tsLabel(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------------- 终端输出 ---------------- */
const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY || process.env.DSH_PM_PLAIN === '1';
const wrap = c => s => (NO_COLOR ? String(s) : ESC + '[' + c + 'm' + s + ESC + '[0m');
export const C = {
  bold: wrap('1'), dim: wrap('2'), red: wrap('31'), green: wrap('32'), yellow: wrap('33'),
  blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'), gray: wrap('90'),
};
let QUIET = false;
export function setQuiet(v) { QUIET = !!v; }
export function isQuiet() { return QUIET; }
export function out(s = '') { if (!QUIET) process.stdout.write(String(s) + '\n'); }
export function say(s = '') { process.stdout.write(String(s) + '\n'); }
export function head(title) { out(''); out(C.bold(C.cyan('== ' + title))); }
export function indent(s, n = 2) { return String(s).split('\n').map(l => ' '.repeat(n) + l).join('\n'); }

/** 显示宽度, CJK 记 2 列 */
export function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f)
      || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff)
      || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0xa000 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x1f300 && c <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}
export function pad(s, n, align = 'left') {
  s = String(s);
  const gap = Math.max(0, n - width(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
  return s + ' '.repeat(gap);
}
export function table(rows, headers) {
  if (!rows || !rows.length) return '  (无)';
  const widths = headers.map(h => Math.max(width(h.title),
    ...rows.map(r => width(r[h.key] === undefined || r[h.key] === null ? '' : String(r[h.key])))));
  const line = cells => '  ' + cells.map((v, i) => pad(v, widths[i], headers[i].align)).join('  ');
  const res = [line(headers.map(h => h.title)), '  ' + widths.map(w => '-'.repeat(w)).join('  ')];
  for (const r of rows) {
    res.push(line(headers.map(h => (r[h.key] === undefined || r[h.key] === null) ? '' : String(r[h.key]))));
  }
  return res.join('\n');
}