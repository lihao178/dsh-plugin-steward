/**
 * 重启: 把整个 DeepSeek Assistant 关干净, 再启动一个新的.
 *
 * 为什么不能"自杀再拉起" (2026-11-04 踩的坑, 用户崩了很多次):
 *   桌面壳把宿主当成自己的子进程. 宿主一退出, 壳立刻判定"应用已崩溃"
 *   并弹出「应用无法启动或已意外停止」——这就是用户反复看到的那个弹窗.
 *   更糟的是旧实现先拉起新实例、再杀自己: 于是同时存在两个实例,
 *   而 task-board 的账本锁只允许一个进程持有:
 *     Error: task-board ledger is already owned by process <pid>
 *   新实例挂载失败 -> 退出 -> 又是弹窗; 旧壳虽然死了, 它的宿主却成了孤儿,
 *   一直占着锁, 于是"每次关插件都崩".
 *
 * 正确顺序 (helper 脚本里执行):
 *   1. 先 kill 掉壳 (父进程). 壳没了就不会弹"已崩溃"的窗.
 *   2. 再 kill 掉自己 (宿主).
 *   3. 轮询等这两个 pid 真的消失 (Windows 释放端口/文件锁要一会儿).
 *   4. 才用 exe 启动一个全新的应用 (等价于用户双击图标).
 * helper 自己是 detached 的, 上面三步都做完它还活着, 才有资格当"发起者".
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 当前进程的启动方式.
 * @returns { execPath, args, cwd, electron, defaultApp, shellPid }
 */
export function launchInfo() {
  const execPath = process.execPath;
  const electron = !!(process.versions && process.versions.electron);
  const isDefaultApp = process.defaultApp === true;
  const argv = Array.isArray(process.argv) ? process.argv.slice() : [];
  const execArgv = Array.isArray(process.execArgv) ? process.execArgv.slice() : [];

  // Electron 打包版: argv = [App.exe, <host 入口>, <profile>, ...] —— 入口由壳决定,
  // 重开时不要再把这些参数喂回去 (那会变成"以宿主入口启动的第二个实例"),
  // 直接不带参数启动 exe 才是用户双击图标的效果.
  const args = electron ? [] : argv.slice(1);
  const missing = execArgv.filter((a) => args.indexOf(a) < 0 && !a.startsWith('--'));
  return {
    execPath,
    args: args.concat(missing),
    cwd: process.cwd(),
    electron,
    defaultApp: isDefaultApp,
    // 壳 (Electron 主进程) 的 pid: 宿主是它 fork 出来的
    shellPid: process.ppid || 0,
  };
}

/** 把 value 安全地塞进 JS 源码字面量. */
function lit(value) {
  return JSON.stringify(value);
}

/**
 * helper 源码: 关干净 -> 等真的没了 -> 启动新的.
 * @param info launchInfo() 的结果
 * @param logFile helper 自己的日志
 */
export function helperSource(info, logFile) {
  const exec = lit(info.execPath);
  const args = lit(info.args || []);
  const cwd = lit(info.cwd || process.cwd());
  const shell = Number(info.shellPid) || 0;
  const host = Number(info.hostPid) || 0;
  const log = lit(logFile);
  return [
    "const { spawn, execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const exec = ' + exec + ';',
    'const args = ' + args + ';',
    'const cwd = ' + cwd + ';',
    'const shellPid = ' + shell + ';',
    'const hostPid = ' + host + ';',
    'const logFile = ' + log + ';',
    'function log(msg) { try { fs.appendFileSync(logFile, new Date().toISOString() + " " + msg + "\\n"); } catch (e) {} }',
    'function sleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }',
    'function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } }',
    'function kill(pid, why) {',
    '  if (!pid) return;',
    '  try { execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" }); log("taskkill " + why + " " + pid + " ok"); }',
    '  catch (e) { log("taskkill " + why + " " + pid + " failed: " + String((e && e.message) || e)); }',
    '}',
    'function waitGone(pid, tries) {',
    '  for (let i = 0; i < tries; i += 1) { if (!alive(pid)) return true; sleep(250); }',
    '  return !alive(pid);',
    '}',
    'log("helper start: shell=" + shellPid + " host=" + hostPid + " exec=" + exec);',
    'if (!exec || !fs.existsSync(exec)) { log("ABORT: exe 不存在, 不敢动: " + exec); process.exit(1); }',
    '// 1. 先关壳, 壳没了就不会弹"应用已崩溃"',
    'kill(shellPid, "shell");',
    'waitGone(shellPid, 40);',
    '// 2. 再关宿主 (也就是发起这次重启的自己)',
    'kill(hostPid, "host");',
    'waitGone(hostPid, 40);',
    '// 3. 多等一会儿: 端口/账本锁/文件句柄都要释放',
    'sleep(900);',
    '// 4. 启动全新的应用 (等价于双击图标)',
    'try {',
    '  const child = spawn(exec, args, { cwd: cwd, detached: true, stdio: "ignore", env: process.env });',
    '  child.unref();',
    '  log("launched new app pid=" + child.pid);',
    '} catch (error) {',
    '  log("LAUNCH FAILED: " + String((error && error.stack) || error));',
    '}',
    '// 5. 留个尾巴: 再确认一次新实例起来了',
    'sleep(1500);',
    'log("helper done");',
  ].join('\n');
}

/**
 * 安排一次重启 (先把 helper 拉起来, 由 helper 执行关闭与启动).
 * @param opts { dir?, delayMs?, holdMs? }
 */
export function scheduleRestart(opts) {
  const o = opts || {};
  const launch = launchInfo();
  const dir = o.dir || path.join(process.cwd(), '.state');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'restart.log');
  const info = Object.assign({}, launch, { hostPid: process.pid });
  const helper = path.join(dir, 'restart-helper.cjs');
  fs.writeFileSync(helper, helperSource(info, logFile), 'utf8');
  const child = spawn(process.execPath, [helper], {
    cwd: launch.cwd,
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      DSH_PM_RESTART_FROM: String(process.pid),
      DSH_PM_RESTART_SHELL: String(launch.shellPid),
    }),
  });
  child.unref();
  return {
    pid: process.pid,
    shellPid: launch.shellPid,
    helper,
    helperPid: child.pid,
    logFile,
    execPath: launch.execPath,
    args: launch.args,
    cwd: launch.cwd,
    electron: launch.electron,
    // 调试用: 重开时到底会跑什么
    commandLine: [launch.execPath].concat(launch.args).map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
  };
}

/**
 * 安排重启. 调用方要先把 HTTP 响应写完 —— 重启会断开连接.
 * 真正的关闭由 helper 做 (它先关壳再关我们), 这里只负责把 helper 拉起来.
 */
export function restartSelf(opts) {
  const o = opts || {};
  const info = scheduleRestart(o);
  // 兜底: 万一 helper 因为权限/被杀没动手, 自己也别赖着不走
  const delay = Number(o.delayMs) || 4000;
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch (error) {
      /* 已经要死了, 忽略 */
    }
  }, delay);
  return info;
}
