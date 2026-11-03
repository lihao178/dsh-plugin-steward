// 轻量 semver: 版本比较 + 范围匹配, 实现 prerelease 等元组规则, 无外部依赖
const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).trim().match(RE);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], raw: String(v).trim() };
}
export function valid(v) { return parse(v) !== null; }
export function tuple(v) { const p = parse(v); return p ? p.major + '.' + p.minor + '.' + p.patch : null; }

function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (nx) return -1;
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** 返回 -1 / 0 / 1, 无法解析返回 null */
export function compare(a, b) {
  const A = parse(a), B = parse(b);
  if (!A || !B) return null;
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  return cmpPre(A.pre, B.pre);
}
export function gt(a, b) { return compare(a, b) === 1; }
export function gte(a, b) { const c = compare(a, b); return c === 1 || c === 0; }
export function lt(a, b) { return compare(a, b) === -1; }
export function lte(a, b) { const c = compare(a, b); return c === -1 || c === 0; }
export function eq(a, b) { return compare(a, b) === 0; }
export function isPre(v) { const p = parse(v); return !!p && p.pre.length > 0; }

function upperFor(caret, v) {
  const p = parse(v);
  if (!p) return null;
  if (caret) {
    if (p.major > 0) return (p.major + 1) + '.0.0';
    if (p.minor > 0) return '0.' + (p.minor + 1) + '.0';
    return '0.0.' + (p.patch + 1);
  }
  return p.major + '.' + (p.minor + 1) + '.0';
}
function normalizeBase(s) {
  if (valid(s)) return s;
  const parts = String(s).split('.');
  if (parts.length === 1) return s + '.0.0';
  if (parts.length === 2) return s + '.0';
  return null;
}
function oneComparator(comp, v) {
  comp = String(comp).trim();
  if (!comp || comp === '*' || comp === 'x' || comp === 'X' || comp === 'latest') return true;
  let m = comp.match(/^(\^|~)(.+)$/);
  if (m) {
    const base = normalizeBase(m[2]);
    if (!base) return true;
    const up = upperFor(m[1] === '^', base);
    return gte(v, base) && lt(v, up);
  }
  m = comp.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return true;
  const op = m[1] || '=';
  const rhs = normalizeBase(m[2].trim());
  if (!rhs) return true;
  const c = compare(v, rhs);
  if (c === null) return false;
  if (op === '>=') return c >= 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '<') return c < 0;
  return c === 0;
}
/** 判断 version 是否落在 range 内; 实现 semver 的 prerelease 等元组门控 */
export function satisfies(version, range, opts) {
  if (range === null || range === undefined) return true;
  range = String(range).trim();
  if (!range || range === '*' || range === 'x' || range === 'latest') return true;
  const V = parse(version);
  if (!V) return false;
  for (const alt of range.split('||')) {
    const comps = alt.trim().split(/\s+/).filter(Boolean);
    if (!comps.length) return true;
    let ok = true;
    if (V.pre.length && !(opts && opts.includePrerelease)) {
      let hasPreTuple = false;
      for (const c of comps) {
        const bare = c.replace(/^[\^~<>=]+/, '');
        const p = parse(bare);
        if (p && p.pre.length && tuple(bare) === tuple(version)) { hasPreTuple = true; break; }
      }
      if (!hasPreTuple) ok = false;
    }
    if (ok && comps.every(c => oneComparator(c, version))) return true;
  }
  return false;
}
export function satisfiesBoth(version, range) {
  return { strict: satisfies(version, range), lenient: satisfies(version, range, { includePrerelease: true }) };
}
/** 从 spec 里剥出裸版本号 */
export function specBase(spec) {
  if (!spec) return null;
  const m = String(spec).trim().match(/^[\^~>=<\s]*([0-9][0-9A-Za-z.+-]*)/);
  return m ? m[1] : null;
}
/** 判断 spec 是否是 dist-tag 或 URL 等非版本范围 */
export function isRangeSpec(spec) {
  if (!spec) return false;
  const s = String(spec).trim();
  if (/^(link|file|workspace|portal):/.test(s)) return false;
  if (/^[a-z][a-z0-9-]*$/i.test(s)) return true;
  return /^[\^~>=<*\s0-9]/.test(s);
}