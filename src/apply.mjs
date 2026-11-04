// 更新执行: 真正调用 pnpm 装新版本. 默认只预演, 加 {write:true} 才动手, 动手前自动快照
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { profileDir, REPORT_DIR, ensureDir, nowIso, stamp, isFile, DSH_HOME } from './util.mjs';
import { checkProfile } from './check.mjs';
import { createSnapshot, restoreSnapshot } from './snapshot.mjs';
import { satisfies } from './semver.mjs';

// pnpm 位置推导. 不能只靠 process.execPath 往上退两级: 用打包好的桌面端时
//   execPath = <安装目录>\DeepSeek-Harness.exe
//   pnpm     = <安装目录>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs
// 也就是说 pnpm 在 exe 目录**下面**四层, 不是上面两级. 所以这里一条条试, 谁在就返回谁.
export function pnpmCandidates() {
  const out = [];
  const push = (p) => { if (p) out.push(path.resolve(p)); };
  push(process.env.DSH_PM_PNPM);                       // 1. 用户/环境变量明确指定, 优先级最高

  const exeDir = path.dirname(process.execPath);
  // 2. 打包桌面端: exe 同级的 resources\runtime\... （primary-runtime 与普通 runtime 两种布局都试）
  for (const rt of ['primary-runtime', 'runtime']) {
    for (const sub of ['dependencies', 'dependencies\\pnpm\\node_modules']) {
      push(path.join(exeDir, 'resources', 'runtime', rt, sub, 'pnpm', 'bin', 'pnpm.mjs'));
      push(path.join(exeDir, 'resources', 'runtime', rt, sub, 'pnpm', 'bin', 'pnpm.cjs'));
    }
  }
  // 3. 开发/源码布局: exe 往上两级 (原来的算法, 保留)
  const up2 = path.resolve(exeDir, '..', '..');
  push(path.join(up2, 'pnpm', 'bin', 'pnpm.mjs'));
  push(path.join(up2, 'pnpm', 'bin', 'pnpm.cjs'));
  // 4. DSH_HOME 下的运行时 (程序被移动/重装也不受影响)
  for (const p of nodeRuntimeCandidates()) {
    push(path.join(p, 'pnpm', 'bin', 'pnpm.mjs'));
    push(path.join(p, 'pnpm', 'bin', 'pnpm.cjs'));
  }
  // 5. 从 node 位置往上找: <deps>\node\bin\node.exe -> <deps>\pnpm\bin\pnpm.mjs
  const nodeBin = path.dirname(process.execPath);
  if (path.basename(path.dirname(nodeBin)).toLowerCase() === 'bin') {
    const deps = path.dirname(path.dirname(nodeBin));
    push(path.join(deps, 'pnpm', 'bin', 'pnpm.mjs'));
    push(path.join(deps, 'pnpm', 'bin', 'pnpm.cjs'));
  }
  return [...new Set(out)];
}

// DSH_HOME 下各运行时目录: ~/.dsh/dsh-runtimes/<name>/dependencies
function nodeRuntimeCandidates() {
  const base = path.join(DSH_HOME, 'dsh-runtimes');
  const out = [];
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const deps = path.join(base, d.name, 'dependencies');
      if (fs.existsSync(path.join(deps, 'pnpm'))) out.push(deps);
    }
  } catch (e) {}
  return out;
}

export function pnpmBin() {
  if (process.env.DSH_PM_PNPM && isFile(process.env.DSH_PM_PNPM)) return process.env.DSH_PM_PNPM;
  for (const p of pnpmCandidates()) if (isFile(p)) return p;
  // 一个都找不到: 返回最有把握的那个, 让报错信息带上它, 方便定位
  const c = pnpmCandidates();
  return c.length ? c[c.length - 1] : path.join(DSH_HOME, 'dsh-runtimes');
}

// 诊断用: 列出所有候选路径及是否存在
export function pnpmDiagnose() {
  return {
    env: process.env.DSH_PM_PNPM || null,
    execPath: process.execPath,
    dshHome: DSH_HOME,
    candidates: pnpmCandidates().map((p) => ({ path: p, exists: isFile(p) })),
    chosen: pnpmBin(),
    chosenExists: isFile(pnpmBin()),
  };
}

export function readInstalled(profile, name) {
  const root = profileDir(profile);
  const pkgFile = path.join(root, 'node_modules', name, 'package.json');
  if (!isFile(pkgFile)) return null;
  try { return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || null; } catch (e) { return null; }
}

export async function updatePlan(profile, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const res = await checkProfile(profile, o);
  const ops = [];
  for (const row of res.rows || []) {
    if (!row.updatable || !row.target) continue;
    if (o.only && !(o.only.indexOf(row.name) >= 0 || o.only.indexOf(row.title) >= 0)) continue;
    const spec = String(row.spec || '');
    const exact = /^\d/.test(spec);
    const argv = ['add', row.name + '@' + row.target];
    if (exact) argv.push('--save-exact');
    ops.push({
      name: row.name, title: row.title, from: row.current, to: row.target, kind: row.kind,
      spec, exact, argv, compat: row.compat, blocked: !!(row.compat && row.compat.ok === false),
    });
  }
  const align = (res.rows || []).filter((r) => r.alignToHost && r.origin === 'builtin');
  return { profile, root, hostVersion: res.hostVersion || res.host, check: res, ops, align, argv0: pnpmBin() };
}

// pnpm 有时「活儿干完了、但还是非 0 退出」: 比如依赖里有 build 脚本被忽略, 它退出码 1 并在 stderr 报
//   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: xxx
// 这时候包其实已经装进去了, 却会被当成「安装失败」→ 面板不重启 → 用户看到「装完没反应」。
// 所以这里区分「真失败」和「只是警告」: 认得出来的警告码 + 目标确实已经落盘 = 成功。
// 只认「明确表示活儿已经干完、只是有脚本被跳过」的几个码, 不用 WARN 这种太宽的词,
// 否则真正的失败只要混进一行 WARN 就会被当成成功。
const SOFT_PNPM_CODES = [
  'ERR_PNPM_IGNORED_BUILDS',
  'ERR_PNPM_APPROVE_BUILDS',
];

export function pnpmSoftFailure(text) {
  const s = String(text || '');
  for (const code of SOFT_PNPM_CODES) {
    if (s.indexOf(code) !== -1) return code;
  }
  return null;
}

export function runPnpm(root, argv, opts) {
  const o = opts || {};
  const bin = pnpmBin();
  if (!isFile(bin)) return { ok: false, status: null, stdout: '', stderr: '找不到 pnpm: ' + bin, bin };
  ensureDir(REPORT_DIR);
  const r = spawnSync(process.execPath, [bin].concat(argv), {
    cwd: root,
    encoding: 'utf8',
    timeout: o.timeoutMs || 600000,
    env: Object.assign({}, process.env, { CI: '1' }),
  });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const logFile = path.join(REPORT_DIR, 'pnpm-' + stamp() + '.log');
  try { fs.writeFileSync(logFile, '$ pnpm ' + argv.join(' ') + String.fromCharCode(10, 10) + stdout + String.fromCharCode(10, 10) + stderr, 'utf8'); } catch (e) {}
  const soft = r.status === 0 ? null : pnpmSoftFailure(stdout + stderr);
  return {
    ok: r.status === 0 || !!soft,
    status: r.status,
    softFailure: soft,                       // 非空 = 退出码非 0 但其实成功了, 只是有警告
    stdout, stderr, log: logFile, bin,
  };
}

export function updateApply(plan, opts) {
  const o = opts || {};
  const write = o.write === true;
  const results = [];
  if (!write) {
    return {
      dryRun: true, write: false, snapshot: null,
      results: plan.ops.map((op) => ({ name: op.name, title: op.title, from: op.from, to: op.to, kind: op.kind, simulated: true, argv: ['pnpm'].concat(op.argv).join(' ') })),
      ok: 0, failed: 0,
    };
  }
  const snapshot = createSnapshot(plan.profile, '更新前自动备份');
  let ok = 0, failed = 0;
  for (const op of plan.ops) {
    if (op.blocked && !o.forceIncompatible) {
      results.push({ name: op.name, skipped: true, reason: '兼容性检查未通过: ' + ((op.compat && op.compat.reasons) || []).join('; ') });
      continue;
    }
    const r = runPnpm(plan.root, op.argv, { timeoutMs: o.timeoutMs });
    const after = readInstalled(plan.profile, op.name);
    const good = r.ok && after === op.to;
    if (good) ok++; else failed++;
    results.push({
      name: op.name, title: op.title, from: op.from, to: op.to, kind: op.kind,
      ok: good, status: r.status, log: r.log, versionAfter: after,
      error: good ? null : (after && after !== op.to ? '装完版本是 ' + after + ', 期望 ' + op.to : (r.stderr || '').split(String.fromCharCode(10)).filter(Boolean).slice(-3).join(' | ')),
    });
  }
  let rollback = null;
  if (failed && ok === 0 && o.rollback !== false) {
    rollback = restoreSnapshot(plan.profile, snapshot.id);
  }
  return { dryRun: false, write: true, snapshot: snapshot.id, results, ok, failed, rollback };
}

export function reinstallPlugin(profile, name, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const argv = ['install'];
  if (o.write !== true) return { dryRun: true, argv: argv.join(' '), name };
  const snapshot = createSnapshot(profile, '重装 ' + name + ' 前自动备份');
  const r = runPnpm(root, argv, { timeoutMs: o.timeoutMs });
  return { dryRun: false, name, ok: r.ok, status: r.status, log: r.log, snapshot: snapshot.id, stderr: (r.stderr || '').slice(-600) };
}