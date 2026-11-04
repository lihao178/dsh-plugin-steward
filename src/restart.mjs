/**
 * Self-restart: 让宿主把自己重新拉起来, 用户不用手动关软件.
 *
 * 思路和 dshmarket/lib/restart.js 一致:
 *   1. 记下当前进程的启动方式 (execPath + 参数 + cwd) 写成 helper 脚本
 *   2. detached 方式 spawn 那个 helper (宿主死了它也不受影响)
 *   3. 过一会儿给自己发 SIGTERM, 宿主退出, helper 用同样参数把宿主重新拉起
 *
 * 宿主是 Electron 应用 (DeepSeek-Harness.exe), 启动语义和 node 不同:
 *   - process.execPath = DeepSeek-Harness.exe (不是 node.exe)
 *   - process.defaultApp === true 时, node 风格的参数要放在 argv[1]
 *   - process.argv = [exe, ...原始参数], 所以要 slice(1)
 *   - Electron 的开关 (--inspect / --expose-internals) 在 process.execArgv 里,
 *     必须一起带上, 否则重开出来的宿主不等于原来那个
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 当前进程的启动方式.
 * @returns { execPath, args, cwd, electron, env }
 */
export function launchInfo() {
  const execPath = process.execPath;
  const electron = !!(process.versions && process.versions.electron);
  const isDefaultApp = process.defaultApp === true;
  const argv = Array.isArray(process.argv) ? process.argv.slice() : [];
  const execArgv = Array.isArray(process.execArgv) ? process.execArgv.slice() : [];

  // Electron 和 node 的 argv 布局不同:
  //   node:            argv = [node.exe, script.js, ...rest]
  //   electron 打包版: argv = [App.exe, ...rest]                    (入口由 exe 决定)
  //   electron dev:    argv = [electron.exe, appPath, ...rest]       (defaultApp = true)
  // 目标是拿到「argv[0] 之后要原样传回去的那部分」.
  let args;
  if (electron && isDefaultApp) {
    args = argv.slice(1);
  } else if (electron) {
    args = argv.slice(1);
  } else {
    args = argv.slice(1);
  }
  // node 的 CLI 开关其实也可能落在 argv 里; 只有真缺了才补 execArgv,
  // 否则会把 -e / --check 这类一次性开关重复带进重开命令里.
  const missing = execArgv.filter((a) => args.indexOf(a) < 0 && !a.startsWith('--'));
  return {
    execPath,
    args: args.concat(missing),
    cwd: process.cwd(),
    electron,
    defaultApp: isDefaultApp,
  };
}

/** 把 value 安全地塞进 JS 源码字面量. */
function lit(value) {
  return JSON.stringify(value);
}

/** helper 源码: 先等旧进程彻底退出, 再在原来的 cwd 下用原来的 exe + 参数重启. */
export function helperSource(launch, port, waitMs) {
  const exec = lit(launch.execPath);
  const args = lit(launch.args);
  const cwd = lit(launch.cwd || process.cwd());
  const wait = Number(waitMs) || 1500;
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const exec = ' + exec + ';',
    'const args = ' + args + ';',
    'const cwd = ' + cwd + ';',
    'const wait = ' + wait + ';',
    'function go() {',
    '  try {',
    '    const child = spawn(exec, args, { cwd: cwd, detached: true, stdio: "ignore", env: process.env });',
    '    child.unref();',
    '  } catch (error) {',
    '    try { fs.appendFileSync(require("node:path").join(require("node:os").tmpdir(), "dsh-pm-restart.log"), String(error && error.stack || error) + "\\n"); } catch (e) {}',
    '  }',
    '}',
    '// 给旧进程一点时间退干净 (Windows 上端口释放要一会儿)',
    'setTimeout(go, wait);',
  ].join('\n');
}

/**
 * 安排一次自重启 (不杀自己).
 * @param opts { waitMs?, dir? }
 * @returns { pid, helper, helperPid, execPath, args, cwd }
 */
export function scheduleRestart(opts) {
  const o = opts || {};
  const launch = launchInfo();
  const waitMs = Number(o.waitMs) || 1500;
  const dir = o.dir || path.join(process.cwd(), '.state');
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'restart-helper.cjs');
  fs.writeFileSync(helper, helperSource(launch, null, waitMs), 'utf8');
  const child = spawn(process.execPath, [helper], {
    cwd: launch.cwd,
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { DSH_PM_RESTART_FROM: String(process.pid) }),
  });
  child.unref();
  return {
    pid: process.pid,
    helper,
    helperPid: child.pid,
    execPath: launch.execPath,
    args: launch.args,
    cwd: launch.cwd,
    electron: launch.electron,
    // 调试用: 重开时到底会跑什么
    commandLine: [launch.execPath].concat(launch.args).map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '),
  };
}

/**
 * 安排重启, 并在 delayMs 之后给自己发 SIGTERM.
 * 调用方要先把 HTTP 响应写完 —— 重启会立刻断开连接.
 */
export function restartSelf(opts) {
  const o = opts || {};
  const info = scheduleRestart(o);
  const delay = Number(o.delayMs) || 600;
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch (error) {
      /* 已经要死了, 忽略 */
    }
  }, delay);
  return info;
}
