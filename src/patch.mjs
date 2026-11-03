// cordis.patch.yml 读写: 识别插件条目 / disabled 状态 / 顶层 insert 段
import path from 'node:path';
import { readText, writeText, readJson } from './util.mjs';

export function patchPath(profileRoot) { return path.join(profileRoot, 'cordis.patch.yml'); }

/** 解析出所有顶层条目 { id, disabled, line, endLine, isInsert } */
export function parseEntries(text) {
  const lines = String(text).split('\n');
  const entries = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const topItem = raw.match(/^-\s*(.*)$/);
    if (topItem) {
      if (cur) { cur.endLine = i - 1; entries.push(cur); }
      const body = topItem[1];
      const idm = body.match(/^id:\s*["']?([^"'\s]+)["']?/);
      const ins = /^insert:\s*$/.test(body) || /^insert:/.test(body);
      cur = {
        id: idm ? idm[1] : null,
        isInsert: !!ins,
        disabled: false,
        line: i,
        endLine: lines.length - 1,
        indent: 0,
      };
      continue;
    }
    if (cur && /^\s+disabled:\s*true\s*$/.test(raw)) cur.disabled = true;
  }
  if (cur) { cur.endLine = lines.length - 1; entries.push(cur); }
  return entries;
}

/** 返回被显式禁用的 id 集合 */
export function parseDisabled(text) {
  const set = new Set();
  for (const e of parseEntries(text)) if (e.disabled && e.id) set.add(e.id);
  return set;
}

/** 在 patch 文本里开启/关闭某个插件条目, 返回新文本; 找不到条目则返回 null */
export function setDisabledText(text, id, disabled) {
  const lines = String(text).split('\n');
  const entries = parseEntries(text);
  const hit = entries.find(e => e.id === id);
  if (!hit) return null;
  let found = -1;
  for (let i = hit.line + 1; i <= hit.endLine; i++) {
    if (/^\s+disabled:\s*(true|false)\s*$/.test(lines[i])) { found = i; break; }
  }
  if (found >= 0) {
    if (disabled) lines[found] = lines[found].replace(/disabled:\s*(true|false)/, 'disabled: true');
    else lines.splice(found, 1);
  } else if (disabled) {
    lines.splice(hit.line + 1, 0, '  disabled: true');
  }
  return lines.join('\n');
}

/** 提取某个 id 条目的配置对象 (极简 YAML: 只处理二三层标量与列表) */
export function entryConfig(text, id) {
  const lines = String(text).split('\n');
  const entries = parseEntries(text);
  const hit = entries.find(e => e.id === id);
  if (!hit) return null;
  const out = {};
  let section = null;
  for (let i = hit.line + 1; i <= hit.endLine; i++) {
    const raw = lines[i];
    const kv = raw.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const depth = kv[1].length;
    const key = kv[2];
    const val = kv[3].trim();
    if (depth <= 2) { section = null; if (val !== '') out[key] = coerce(val); else { out[key] = {}; section = key; } }
    else if (section && depth === 4) { if (val !== '') out[section][key] = coerce(val); else { out[section][key] = {}; } }
  }
  return out;
}
function coerce(v) {
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v.replace(/^["']|["']$/g, '');
}

/** 读取一个 profile 的 cordis 配置三件套 */
export function readPatchState(profileRoot) {
  const p = patchPath(profileRoot);
  const text = readText(p, '');
  const entries = parseEntries(text);
  return {
    path: p,
    text,
    exists: text.length > 0,
    entries,
    disabled: new Set(entries.filter(e => e.disabled && e.id).map(e => e.id)),
    ids: entries.filter(e => e.id).map(e => e.id),
  };
}
export function writePatchText(profileRoot, text) { writeText(patchPath(profileRoot), text); }
/** 读一个 patch 文件里定义/引用的所有行(条目), 抽出 id / name / 设了哪些键.
 *  用于回答"这个插件的行 id 和 name 是什么" - 即想在 profile 的 cordis.patch.yml
 *  里给它写配置时该抄什么. 注意 name 是"这一行由哪个模块实现", 对 MCP 类插件
 *  往往是 @deepseek-ai/dsh-mcp-client 而不是插件自己的包名. */
export function rowDefs(text) {
  const lines = String(text).split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const row = { id: null, name: null, disabled: false, keys: [], line: i }; let keyInd = null;
    const grab = (body) => {
      const idm = body.match(/^id:\s*["']?([^"'\s]+)["']?/);
      if (idm && !row.id) row.id = idm[1];
      const nm = body.match(/^name:\s*["']?([^"'\s]+)["']?/);
      if (nm && !row.name) row.name = nm[1];
      if (/^disabled:\s*true\s*$/.test(body)) row.disabled = true;
    };
    grab(m[2]);
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      const ind = raw.match(/^(\s*)/)[1].length;
      if (ind <= indent) break;
      if (/^\s*-\s/.test(raw)) break;
      if (!raw.trim() || /^\s*#/.test(raw)) continue;
      const km = raw.match(/^\s*([A-Za-z_$][\w$-]*):\s*(.*)$/);
      const kmInd = raw.match(/^(\s*)/)[1].length;
      if (keyInd === null) keyInd = kmInd; else if (kmInd !== keyInd) continue;
      if (!km) continue;
      const key = km[1];
      const val = km[2].trim().replace(/^["']|["']$/g, "");
      if (key === "id" && !row.id) row.id = val;
      else if (key === "name" && !row.name) row.name = val;
      else if (key === "disabled" && val === "true") row.disabled = true;
      if (row.keys.indexOf(key) < 0) row.keys.push(key);
    }
    rows.push(row);
  }
  return rows;
}
