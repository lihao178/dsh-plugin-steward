// 快照与回滚: 改动前先存一份 package.json / cordis.patch.yml / 市场状态, 出问题一键还原
import fs from 'node:fs';
import path from 'node:path';
import { profileDir, STATE_DIR, ensureDir, writeJson, readJson, listDir, isFile, isDir, nowIso } from './util.mjs';

export const SNAPSHOT_ROOT = path.join(STATE_DIR, 'snapshots');
const COPY = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'stardustlc-plugin-updates.json', '.dsh-market/state.json'];

function flatName(rel) { return rel.split('/').join('__'); }
export function newId() { return new Date().toISOString().replace(/[:.]/g, '-'); }

export function createSnapshot(profile, reason) {
  const root = profileDir(profile);
  const id = newId();
  const dir = path.join(SNAPSHOT_ROOT, profile, id);
  ensureDir(dir);
  const files = [];
  for (const rel of COPY) {
    const src = path.join(root, rel);
    if (!isFile(src)) continue;
    const dst = path.join(dir, flatName(rel));
    fs.copyFileSync(src, dst);
    let size = 0;
    try { size = fs.statSync(src).size; } catch (e) {}
    files.push({ rel, file: flatName(rel), size });
  }
  const meta = { id, profile, root, createdAt: nowIso(), reason: reason || '', files };
  writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

export function listSnapshots(profile) {
  const base = path.join(SNAPSHOT_ROOT, profile);
  const out = [];
  for (const d of listDir(base)) {
    if (!d.isDirectory()) continue;
    const meta = readJson(path.join(base, d.name, 'meta.json'), null);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  return out;
}

export function latestSnapshot(profile) {
  const l = listSnapshots(profile);
  return l.length ? l[0] : null;
}

export function restoreSnapshot(profile, id, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const dir = path.join(SNAPSHOT_ROOT, profile, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return { ok: false, error: '找不到快照 ' + id };
  if (o.dryRun !== false) return { ok: true, dryRun: true, id, wouldRestore: meta.files.map((f) => f.rel), meta };
  const pre = createSnapshot(profile, '还原 ' + id + ' 之前的自动备份');
  const restored = [];
  const missing = [];
  for (const f of meta.files) {
    const src = path.join(dir, f.file);
    if (!isFile(src)) { missing.push(f.rel); continue; }
    const dst = path.join(root, f.rel);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    restored.push(f.rel);
  }
  return { ok: true, id, pre: pre.id, restored, missing, meta };
}

export function pruneSnapshots(profile, keep) {
  const n = Math.max(1, keep || 20);
  const list = listSnapshots(profile);
  const dead = list.slice(n);
  const removed = [];
  for (const m of dead) {
    try { fs.rmSync(path.join(SNAPSHOT_ROOT, profile, m.id), { recursive: true, force: true }); removed.push(m.id); } catch (e) {}
  }
  return { kept: list.length - removed.length, removed };
}

export function diffSnapshot(profile, id) {
  const root = profileDir(profile);
  const dir = path.join(SNAPSHOT_ROOT, profile, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return { ok: false, error: '找不到快照 ' + id };
  const out = { ok: true, id, files: [] };
  for (const f of meta.files) {
    const oldText = (() => { try { return fs.readFileSync(path.join(dir, f.file), 'utf8'); } catch (e) { return null; } })();
    const newText = (() => { try { return fs.readFileSync(path.join(root, f.rel), 'utf8'); } catch (e) { return null; } })();
    if (oldText === newText) { out.files.push({ rel: f.rel, changed: false }); continue; }
    const a = (oldText || '').split(String.fromCharCode(10));
    const b = (newText || '').split(String.fromCharCode(10));
    const added = b.filter((l) => l.trim() && a.indexOf(l) < 0);
    const removed = a.filter((l) => l.trim() && b.indexOf(l) < 0);
    out.files.push({ rel: f.rel, changed: true, added: added.slice(0, 40), removed: removed.slice(0, 40) });
  }
  return out;
}