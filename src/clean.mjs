// 清理: 找出可以安全删掉的东西(残留/空日志/缓存), 默认只出计划不删
import fs from 'node:fs';
import path from 'node:path';
import { scanProfile } from './scan.mjs';
import { STATE_DIR, listDir, isDir, isFile, dirSize, humanSize } from './util.mjs';

export function cleanPlan(profile, opts) {
  const o = opts || {};
  const s = scanProfile(profile, { orphans: true });
  const items = [];
  const push = (kind, p, sizeBytes, safe, reason, extra) => {
    items.push(Object.assign({ kind, path: p, sizeBytes: sizeBytes || 0, safe: !!safe, reason }, extra || {}));
  };

  for (const or of s.orphans || []) {
    push('orphan-pkg', or.dir, or.sizeBytes, true, '不在 package.json 也不在 pnpm 安装映射里: 纯残留, 删了没有任何东西依赖它', { name: or.name });
  }
  for (const or of s.orphansManaged || []) {
    push('transitive-dep', or.dir, or.sizeBytes, false, '不在 package.json, 但 pnpm 记录它是某个插件的依赖: 删了下次 install 会被装回来 (建议留着)', { name: or.name });
  }

  const logsDir = path.join(s.root, '.plugin-manager', 'logs');
  let zeroCount = 0;
  for (const d of listDir(logsDir)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(logsDir, d.name);
    const lg = path.join(dir, 'pnpm.log');
    let empty = false;
    if (isFile(lg)) { try { empty = fs.statSync(lg).size === 0; } catch (e) {} }
    if (empty) { zeroCount++; push('zero-op-log', dir, 0, true, '0 字节的安装记录: 当时安装失败或被中断, 没有信息量', { group: 'logs' }); }
  }

  const nm = path.join(s.root, 'node_modules');
  const cacheDir = path.join(nm, '.cache');
  if (isDir(cacheDir)) push('cache-dir', cacheDir, dirSize(cacheDir), true, 'pnpm 的临时缓存, 删了会自动重建');

  const snaps = (s.snapshots || []).slice();
  if (snaps.length > 2) {
    for (const name of snaps.slice(0, snaps.length - 2)) {
      const p = path.join(s.root, '.dsh-market', 'snapshots', name);
      push('old-market-snapshot', p, isFile(p) ? fs.statSync(p).size : 0, false, '插件市场自己存的配置快照(用于它的一键回滚), 只保留最近 2 份', { name });
    }
  }

  for (const rel of ['registry-cache.json', 'host-payload.json', 'host-versions.json']) {
    const p = path.join(STATE_DIR, rel);
    if (isFile(p)) {
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) {}
      push('own-cache', p, size, true, '本工具的缓存, 删了下次运行会重新生成');
    }
  }

  const safeItems = items.filter((i) => i.safe);
  return {
    profile, root: s.root, items,
    totalBytes: items.reduce((a, i) => a + (i.sizeBytes || 0), 0),
    safeBytes: safeItems.reduce((a, i) => a + (i.sizeBytes || 0), 0),
    safeCount: safeItems.length,
    unsafeCount: items.length - safeItems.length,
    zeroLogCount: zeroCount,
  };
}

export function cleanApply(plan, opts) {
  const o = opts || {};
  const dryRun = o.dryRun !== false;
  const includeUnsafe = !!o.includeUnsafe;
  const done = [], skipped = [], failed = [];
  for (const it of plan.items) {
    if (!it.safe && !includeUnsafe) { skipped.push(Object.assign({}, it, { skipReason: '未标记为安全项' })); continue; }
    if (dryRun) { done.push(Object.assign({}, it, { simulated: true })); continue; }
    try {
      if (isDir(it.path)) fs.rmSync(it.path, { recursive: true, force: true });
      else if (isFile(it.path)) fs.unlinkSync(it.path);
      else { skipped.push(Object.assign({}, it, { skipReason: '路径已不存在' })); continue; }
      done.push(it);
    } catch (e) {
      failed.push({ path: it.path, kind: it.kind, error: String((e && e.message) || e) });
    }
  }
  return {
    dryRun, includeUnsafe,
    deleted: done, skipped, failed,
    freedBytes: done.reduce((a, i) => a + (i.sizeBytes || 0), 0),
  };
}

export function cleanSummary(plan) {
  return '可清理 ' + plan.items.length + ' 项 (安全 ' + plan.safeCount + ' / 需确认 ' + plan.unsafeCount + '), 安全项可释放 ' + humanSize(plan.safeBytes) + ' / 合计 ' + humanSize(plan.totalBytes);
}