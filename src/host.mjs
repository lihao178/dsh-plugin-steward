import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './util.mjs';

export const HOST_CACHE = path.join(STATE_DIR, 'host-payload.json');
export const HOST_APP_CONFIG = path.join(STATE_DIR, 'host-app.json');

function ensureState() { try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {} }

/**
 * Run a plain-disk file operation with Electron's asar interception disabled.
 *
 * Inside the Harness process fs is patched: any path containing `.asar` is
 * treated as an archive entry, so stat/open on `app.asar` itself fails or
 * returns a directory. That made the host payload set empty in-process (the
 * CLI, running under plain node, saw all 307 packages) and every bundled
 * @deepseek-ai package looked "missing". Under plain node this is a no-op.
 */
function noAsar(fn) {
  const prev = process.noAsar;
  try { process.noAsar = true; return fn(); } finally { process.noAsar = prev; }
}

function isFile(p) { try { return noAsar(() => fs.statSync(p).isFile()); } catch (e) { return false; } }
function isDir(p) { try { return noAsar(() => fs.statSync(p).isDirectory()); } catch (e) { return false; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

export function appCandidates() {
  const out = [];
  const add = (p) => { if (p && out.indexOf(p) < 0) out.push(p); };
  add(process.env.DSH_APP_DIR);
  const cfg = readJsonSafe(HOST_APP_CONFIG);
  if (cfg && cfg.resourcesDir) add(cfg.resourcesDir);
  add('D:/软件/电脑工具/AL/deep seek/文件/resources');
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:/Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const names = ['DeepSeek Harness', 'deepseek-harness', 'DeepSeekHarness', 'dsh'];
  for (const base of [path.join(la, 'Programs'), la, pf, pf86]) {
    for (const n of names) add(path.join(base, n, 'resources'));
  }
  return out;
}

export function findAppDir(extra) {
  const list = appCandidates();
  if (extra) list.unshift(extra);
  for (const c of list) {
    let r = c;
    if (/app\.asar$/i.test(r)) r = path.dirname(r);
    const asar = path.join(r, 'app.asar');
    if (isFile(asar)) return { found: true, resourcesDir: r, asarPath: asar, exeDir: path.dirname(r) };
  }
  return { found: false, resourcesDir: null, asarPath: null, exeDir: null };
}

function parseAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const hlen = head.readUInt32LE(12);
    if (!(hlen > 0 && hlen < 256 * 1024 * 1024)) throw new Error('bad asar header length ' + hlen);
    const buf = Buffer.alloc(hlen);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, 16 + got);
      if (n <= 0) break;
      got += n;
    }
    const json = JSON.parse(buf.slice(0, got).toString('utf8'));
    return { json, dataOffset: 8 + head.readUInt32LE(4) };
  } finally { fs.closeSync(fd); }
}

function collectFromNode(nmNode) {
  const out = [];
  if (!nmNode || !nmNode.files) return out;
  for (const k of Object.keys(nmNode.files)) {
    const v = nmNode.files[k];
    if (!v || typeof v !== 'object' || !v.files) continue;
    if (k.charAt(0) === '@') { for (const s of Object.keys(v.files)) out.push(k + '/' + s); }
    else out.push(k);
  }
  return out;
}

function collectFromDisk(nmDir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(nmDir); } catch (e) { return out; }
  for (const e of ents) {
    const full = path.join(nmDir, e);
    if (e.charAt(0) === '@') {
      let subs = [];
      try { subs = fs.readdirSync(full); } catch (err) {}
      for (const s of subs) out.push(e + '/' + s);
    } else if (isDir(full)) out.push(e);
  }
  return out;
}

export const HOST_VERSIONS_CACHE = path.join(STATE_DIR, 'host-versions.json');
export const HOST_NAME_RE = /^(?:@deepseek-ai[/]|(?:@[a-z0-9._-]+[/])?dsh-|dsh$)/i;

function readAsarFile(fd, dataOffset, entry) {
  const off = Number(entry.offset);
  const size = Number(entry.size);
  if (!isFinite(off) || !isFinite(size) || size < 0 || size > 8 * 1024 * 1024) return null;
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = fs.readSync(fd, buf, got, size - got, dataOffset + off + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.slice(0, got).toString('utf8');
}

function readPkgVersion(fd, dataOffset, pkgNode, loc, rel) {
  const pj = pkgNode && pkgNode.files && pkgNode.files['package.json'];
  if (!pj) return null;
  if (pj.unpacked) {
    try { return JSON.parse(fs.readFileSync(path.join(loc.resourcesDir, 'app.asar.unpacked', 'dsh', 'node_modules', rel, 'package.json'), 'utf8')).version || null; } catch (e) { return null; }
  }
  const txt = readAsarFile(fd, dataOffset, pj);
  if (!txt) return null;
  try { return JSON.parse(txt).version || null; } catch (e) { return null; }
}

export function hostVersions(opts) {
  return noAsar(() => hostVersionsInner(opts));
}

function hostVersionsInner(opts) {
  const o = opts || {};
  const loc = findAppDir(o.appDir);
  if (!loc.found) return { found: false, versions: {} };
  let st = null;
  try { st = fs.statSync(loc.asarPath); } catch (e) { return { found: false, versions: {} }; }
  const cache = readJsonSafe(HOST_VERSIONS_CACHE);
  if (!o.refresh && cache && cache.asarPath === loc.asarPath && cache.mtimeMs === st.mtimeMs && cache.sizeBytes === st.size && cache.versions) {
    return { found: true, fromCache: true, versions: cache.versions };
  }
  const versions = Object.create(null);
  const fd = fs.openSync(loc.asarPath, 'r');
  try {
    const pi = parseAsarHeader(loc.asarPath);
    const dshNode = pi.json.files && pi.json.files.dsh;
    const nm = dshNode && dshNode.files && dshNode.files.node_modules;
    if (nm && nm.files) {
      for (const k of Object.keys(nm.files)) {
        const v = nm.files[k];
        if (!v || typeof v !== 'object' || !v.files) continue;
        if (k.charAt(0) === '@') {
          for (const s of Object.keys(v.files)) versions[k + '/' + s] = readPkgVersion(fd, pi.dataOffset, v.files[s], loc, k + '/' + s);
        } else {
          versions[k] = readPkgVersion(fd, pi.dataOffset, v, loc, k);
        }
      }
    }
  } catch (e) {
    return { found: false, versions: {} };
  } finally { fs.closeSync(fd); }
  ensureState();
  try { fs.writeFileSync(HOST_VERSIONS_CACHE, JSON.stringify({ schema: 1, asarPath: loc.asarPath, mtimeMs: st.mtimeMs, sizeBytes: st.size, versions, cachedAt: new Date().toISOString() }), 'utf8'); } catch (e) {}
  return { found: true, fromCache: false, versions };
}

export function hostIndex(opts) {
  return noAsar(() => hostIndexInner(opts));
}

function hostIndexInner(opts) {
  const o = opts || {};
  const loc = findAppDir(o.appDir);
  if (!loc.found) return { found: false, reason: 'app.asar not found', packages: [], resourcesDir: null, version: null };
  let st = null;
  try { st = fs.statSync(loc.asarPath); } catch (e) { return { found: false, reason: 'stat failed', packages: [], resourcesDir: loc.resourcesDir, version: null }; }
  const cache = readJsonSafe(HOST_CACHE);
  if (!o.refresh && cache && cache.asarPath === loc.asarPath && cache.mtimeMs === st.mtimeMs && cache.sizeBytes === st.size && Array.isArray(cache.packages)) {
    return { found: true, fromCache: true, resourcesDir: loc.resourcesDir, asarPath: loc.asarPath, version: cache.version, packages: cache.packages, cachedAt: cache.cachedAt };
  }
  let json = null;
  let dataOffset = 0;
  try { const pi = parseAsarHeader(loc.asarPath); json = pi.json; dataOffset = pi.dataOffset; } catch (e) { return { found: false, reason: 'asar parse failed: ' + e.message, packages: [], resourcesDir: loc.resourcesDir, version: null }; }
  const dsh = json.files && json.files.dsh;
  const nmNode = dsh && dsh.files && dsh.files.node_modules;
  let packages = collectFromNode(nmNode);
  const unpacked = path.join(loc.resourcesDir, 'app.asar.unpacked', 'dsh', 'node_modules');
  if (isDir(unpacked)) packages = packages.concat(collectFromDisk(unpacked));
  const seen = Object.create(null);
  packages = packages.filter((n) => (seen[n] ? false : (seen[n] = true)));
  packages.sort();
  let version = null;
  try { version = fs.readFileSync(path.join(loc.exeDir, 'version'), 'utf8').trim(); } catch (e) {}
  const out = { schema: 1, resourcesDir: loc.resourcesDir, asarPath: loc.asarPath, mtimeMs: st.mtimeMs, sizeBytes: st.size, version, packages, cachedAt: new Date().toISOString() };
  ensureState();
  try { fs.writeFileSync(HOST_CACHE, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
  return { found: true, fromCache: false, resourcesDir: out.resourcesDir, asarPath: out.asarPath, version: out.version, packages: out.packages, cachedAt: out.cachedAt };
}

export function hostPackageSet(opts) {
  try { return new Set(hostIndex(opts).packages.filter((n) => HOST_NAME_RE.test(n))); } catch (e) { return new Set(); }
}