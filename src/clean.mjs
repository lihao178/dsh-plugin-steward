// 清理: 找出可以安全删掉的东西(残留/空日志/缓存), 默认只出计划不删
import fs from 'node:fs';
import path from 'node:path';
import { scanProfile } from './scan.mjs';
import { STATE_DIR, TOOL_ROOT, listDir, isDir, isFile, dirSize, humanSize } from './util.mjs';

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


  // ---- 真正占空间的那几类 (1.6.2) ----
  const dshHome = path.dirname(s.root);                 // ~/.dsh
  const profileSub = path.basename(s.root);             // desktop

  // a) 本工具存的历史快照: 只留最近 10 份, 更早的可以删 (要回滚早就该回了)
  const snapDir = path.join(STATE_DIR, "snapshots");
  if (isDir(snapDir)) {
    const list = listDir(snapDir).filter((d) => d.isDirectory()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const keep = 10;
    if (list.length > keep) {
      for (const d of list.slice(0, list.length - keep)) {
        push("old-snapshot", path.join(snapDir, d.name), dirSize(path.join(snapDir, d.name)), false,
          "本工具的历史备份, 只保留最近 " + keep + " 份 —— 确认不需要回滚到那么早就删", { group: "snapshots" });
      }
    }
  }

  // b) 运行日志: reports/ 与 .state 下的 .log/.ndjson, 超过 7 天的没用了
  const logDirs = [ path.join(TOOL_ROOT, "reports"), path.join(STATE_DIR, "logs") ];
  const cut = Date.now() - 7 * 24 * 3600 * 1000;
  for (const d of logDirs) {
    for (const f of listDir(d)) {
      if (f.isDirectory()) continue;
      const p2 = path.join(d, f.name);
      if (!/\.(log|ndjson)$/i.test(f.name)) continue;
      let st = null;
      try { st = fs.statSync(p2); } catch (e) { continue; }
      if (st.mtimeMs > cut) continue;
      push("old-log", p2, st.size, true, "7 天前的运行记录, 只是排查用", { group: "logs" });
    }
  }

  // c) 软件自己攒的会话/附件: 超过 30 天的大文件 (只列出来, 让人自己决定)
  for (const sub of ["sessions", "attachments"]) {
    const d = path.join(dshHome, sub);
    if (!isDir(d)) continue;
    let shown = 0;
    for (const f of listDir(d)) {
      if (f.isDirectory()) continue;
      const p2 = path.join(d, f.name);
      let st = null;
      try { st = fs.statSync(p2); } catch (e) { continue; }
      if (st.mtimeMs > Date.now() - 30 * 24 * 3600 * 1000) continue;
      push("old-" + sub, p2, st.size, false, "30 天前的" + (sub === "sessions" ? "对话记录" : "附件") + " —— 删了翻不回这段历史", { group: sub });
      if (++shown >= 20) break;
    }
  }

  // d) 自己以前打包出来、已经推过的旧 tgz
  const pubDir = path.join(path.dirname(TOOL_ROOT), "dsh-plugin-manager-publish");
  if (isDir(pubDir)) {
    for (const f of listDir(pubDir)) {
      if (!/\.tgz$/i.test(f.name)) continue;
      const p2 = path.join(pubDir, f.name);
      let st = null;
      try { st = fs.statSync(p2); } catch (e) { continue; }
      push("old-tarball", p2, st.size, true, "打包产物, 已经发到 GitHub 了, 本地留着没用", { group: "tarball" });
    }
  }

  // e) 桌面端(Chromium)自己攒的缓存 —— 这才是真占地方的那一大块, 上百 MB
  const appCache = [
    ["Cache", "网页缓存, 删了只是第一次打开稍慢"],
    ["Code Cache", "编译好的 JS 缓存, 删了会重新编译"],
    ["GPUCache", "显卡缓存, 删了会自动重建"],
    ["DawnGraphiteCache", "WebGPU 缓存, 删了会自动重建"],
    ["DawnWebGPUCache", "WebGPU 缓存, 删了会自动重建"],
    ["GPUPersistentCache", "显卡持久缓存, 删了会自动重建"],
    ["GrShaderCache", "着色器缓存, 删了会自动重建"],
    ["ShaderCache", "着色器缓存, 删了会自动重建"],
  ];
  const roam = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  for (const appName of ["@deepseek-ai/dsh-desktop", "@deepseek-ai/dsh-web"]) {
    for (const [name, why] of appCache) {
      const d = path.join(roam, appName, name);
      if (!isDir(d)) continue;
      // 正在被软件用着的缓存不删: 只有在跑了超过 6 小时(页面早缓存过)时才列出来
      push("app-cache", d, dirSize(d), true, why + " (软件正在运行时会自动跳过它)", { group: "appcache" });
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
  // 桌面端正在运行 = Chromium 的缓存目录被它占着, 不能硬删, 只能跳过并告诉用户
  const appRunning = listDir(path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop'))
    .some((d) => !d.isDirectory());
  for (const it of plan.items) {
    if (!it.safe && !includeUnsafe) { skipped.push(Object.assign({}, it, { skipReason: '未标记为安全项' })); continue; }
    if (dryRun) { done.push(Object.assign({}, it, { simulated: true })); continue; }
    if (it.kind === 'app-cache') {
      // 用 EBUSY 兜底: 真删失败也只会进 failed, 不会拖垮别的项
      try {
        fs.rmSync(it.path, { recursive: true, force: true, maxRetries: 1 });
        done.push(it);
      } catch (e) {
        skipped.push(Object.assign({}, it, { skipReason: '软件正在用这个缓存, 等关掉软件再清' }));
      }
      continue;
    }
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
    dryRun, includeUnsafe, appRunning,
    deleted: done, skipped, failed,
    freedBytes: done.reduce((a, i) => a + (i.sizeBytes || 0), 0),
  };
}

export function cleanSummary(plan) {
  return '可清理 ' + plan.items.length + ' 项 (安全 ' + plan.safeCount + ' / 需确认 ' + plan.unsafeCount + '), 安全项可释放 ' + humanSize(plan.safeBytes) + ' / 合计 ' + humanSize(plan.totalBytes);
}