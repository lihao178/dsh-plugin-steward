// 「装到一半被打断」的记录本.
//
// 场景: 正在 pnpm add 的时候断电 / 用户强退 / 宿主被任务管理器杀掉. 结果是 node_modules 里
// 留半套文件, 下次启动可能起不来 (我们真的踩过: 悬空 junction 让宿主直接跳过 bundle).
//
// 做法很简单, 但必须做:
//   1. 动手之前先把「打算做什么、备份是哪个快照」写到 .state/pending-update.json
//   2. 正常结束就删掉这个文件
//   3. 下次启动发现文件还在 -> 说明上次没走完, 拿里面的快照退回去
//
// 记录 7 天后自动算过期, 免得一个很老的记录反复打扰.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ensureDir } from './util.mjs';
import { readInstalled } from './apply.mjs';

export const PENDING_FILE = path.join(STATE_DIR, 'pending-update.json');
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function writePending(profile, data) {
  ensureDir(STATE_DIR);
  const body = Object.assign(
    { at: Date.now(), atISO: new Date().toISOString(), profile },
    data || {}
  );
  fs.writeFileSync(PENDING_FILE, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return body;
}

export function readPending() {
  try {
    const doc = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!doc || typeof doc !== 'object') return null;
    doc.ageMs = Date.now() - (Number(doc.at) || 0);
    doc.stale = doc.ageMs > MAX_AGE_MS;
    return doc;
  } catch (e) {
    return null;
  }
}

export function clearPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 判断上次中断的更新现在是什么状况:
 *   none         没有残留记录
 *   completed    记录还在, 但目标版本都已经装好了 -> 只是没来得及删记录, 直接清掉
 *   needs-restore 有插件还是旧版本/装坏了 -> 建议用记录里的快照退回
 *   stale        记录太老 (>7 天), 只提示不自动动
 */
export function recoverPlan(profile) {
  const p = readPending();
  if (!p) return { verdict: 'none', pending: null, broken: [], missing: [] };
  const ops = Array.isArray(p.ops) ? p.ops : [];
  const broken = [];
  const landed = [];
  for (const op of ops) {
    const name = op && op.name;
    if (!name) continue;
    const now = readInstalled(profile, name);
    const want = op.to || null;
    if (want && now === want) landed.push({ name, version: now });
    else broken.push({ name, want, now: now || null, from: op.from || null });
  }
  let verdict = 'needs-restore';
  if (p.stale) verdict = 'stale';
  else if (ops.length && broken.length === 0) verdict = 'completed';
  return {
    verdict,
    pending: {
      at: p.at, atISO: p.atISO, ageMs: p.ageMs, stale: p.stale,
      snapshot: p.snapshot || null, reason: p.reason || null, pid: p.pid || null,
      ops: ops.map((o) => ({ name: o.name, from: o.from, to: o.to })),
    },
    broken,
    missing: broken.filter((b) => !b.now).map((b) => b.name),
    landed,
  };
}
