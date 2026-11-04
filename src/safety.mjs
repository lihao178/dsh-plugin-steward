// 安装前安全检查: 静态扫描 npm tarball, 不执行包内任何代码.
//
// 判定思路: 不追求"证明安全"(做不到), 只追求"把可疑点摆出来, 让人有决定依据".
// 每条命中都带 file:line 和原文片段, 用户能自己去核对, 而不是看一个笼统的分数.
//
// 用法:
//   auditTarball({name, version, tarball, integrity}) -> report
//   auditInstalled(profile, name)                     -> report (扫已装目录)
//   auditProfile(profile, opts)                       -> { rows, summary }
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { profileDir, STATE_DIR, ensureDir, writeJson, nowIso, isDir, isFile } from './util.mjs';
import { fetchPackument, mapLimit } from './registry.mjs';
import { scanProfile } from './scan.mjs';

export const SAFETY_DIR = path.join(STATE_DIR, 'safety');
export const SAFETY_CACHE = path.join(SAFETY_DIR, 'cache.json');

/** 扫描上限: 大包也不会把内存吃干. */
const MAX_FILE_BYTES = 1024 * 1024;      // 单文件最多读 1MB 参与扫描
const MAX_SCAN_BYTES = 12 * 1024 * 1024; // 单个包最多扫 12MB 源码
const MAX_FINDINGS = 60;
const SCAN_EXT = /\.(m|c)?js$|\.(c)?tsx?$|\.json$|\.sh$|\.ps1$|\.cmd$|\.bat$|\.py$/i;

/**
 * 规则表. level:
 *   high   = 典型恶意软件/供应链攻击手法 (混淆载荷, 反弹 shell, 偷凭据)
 *   medium = 合法插件也会用, 但值得知情 (起子进程, 发网络请求, 读 home)
 *   low    = 信息性提示 (装时脚本, 内网地址, 文件名可疑)
 * 正则都是全局的, 每次用前要重设 lastIndex.
 */
export const RULES = [
  // ---- high: 混淆与载荷 ----
  {
    id: 'obfuscation-long-base64', level: 'high', title: '一大段看不懂的加密字符串',
    re: /['"`](?:[A-Za-z0-9+/]{220,}={0,2}|[0-9a-fA-F]{400,})['"`]/g,
    hint: '大量编码字符串常用来藏二次载荷. 正常代码很少需要这么长的字面量.',
  },
  {
    id: 'obfuscation-string-array', level: 'high', title: '代码被故意打乱过',
    re: /(?:\\x[0-9a-f]{2}){12,}|(?:\\u00[0-9a-f]{2}){12,}/gi,
    hint: '成片转义字符是 obfuscator.io 一类工具的典型输出.',
  },
  {
    id: 'dynamic-exec', level: 'high', title: '能把文字当代码跑起来',
    re: /\b(?:eval\s*\(|new\s+Function\s*\(|vm\.runIn(?:New|This)Context\s*\(|\bexecSync\s*\(\s*(?:Buffer\.from|atob))/g,
    hint: '配合远程内容就等价于"随时可以换掉代码". 装完运行时也可能变.',
    // 只认真的在调用: 写在字符串里 (日志文案 / 文档片段) 的不算
    skipInString: true,
  },
  {
    id: 'reverse-shell', level: 'high', title: '像是从外面反向控制这台电脑',
    re: /\bnc\s+-[a-z]*e\b|\/dev\/tcp\/|bash\s+-i\s*>|sh\s+-i\s*>&|socat\s+.*exec/gi,
    hint: '把 shell 反向连出本机, 是入侵的典型动作.',
  },
  {
    id: 'credential-path', level: 'high', title: '去翻你的密码 / 密钥文件',
    // 只认"别人的"凭据: ~/.ssh/*, ~/.aws/credentials, ~/.git-credentials 这类绝对位置.
    // 不能只匹配 ".npmrc" —— 插件读自己管理的 profile 里的 .npmrc 是正常工作
    // (dshmarket 装包就要读它), 那种会被大量误报.
    // 所以要么带 homedir()/~ 前缀, 要么带 .ssh/.aws 这种只在用户主目录下才存在的段.
    re: /(?:homedir\s*\(\s*\)|~\s*[\/\\]|USERPROFILE|HOME\s*[,)\s])[^;'"]{0,40}(?:\.ssh|\.aws|\.npmrc|\.git-credentials|\.config[\/\\]gcloud)|\.ssh[\/\\](?:id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts)|\.aws[\/\\]credentials|\.git-credentials/g,
    hint: '插件没理由读用户主目录下的密钥/凭据. 命中要重点看是不是"扫描并上传".',
  },
  {
    id: 'env-exfil', level: 'high', title: '环境变量 + 网络请求同时出现',
    re: null, // 组合规则, 由 combo 判断
    hint: '把 process.env 整个读出来再发出去, 是偷 token 的标准手法.',
  },
  // ---- medium: 能力 ----
  {
    id: 'child-process', level: 'medium', title: '会启动别的程序',
    re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bexec\s*\(\s*[`'"]/g,
    hint: '装插件、跑 pnpm、调系统命令都合法需要它. 但这也是执行任意命令的入口.',
  },
  {
    id: 'network-outbound', level: 'medium', title: '会联网',
    re: /\bfetch\s*\(|https?\.request\s*\(|https?\.get\s*\(|new\s+WebSocket\s*\(|\baxios\b|\bgot\s*\(/g,
    hint: '查更新、调 API 都要联网. 关注目标域名是不是你认识的服务.',
  },
  {
    id: 'fs-write-outside', level: 'medium', title: '往你的目录或系统目录写文件',
    re: /(?:writeFile|appendFile|createWriteStream|mkdir|rm|unlink|rename)(?:Sync)?\s*\([^)]*(?:homedir\s*\(|USERPROFILE|APPDATA|LOCALAPPDATA|System32|Windows[\/\\]|Program\s*Files|\/etc\/|\/usr\/)/g,
    hint: '插件正常只该写自己的 state/ 和 profile 目录.',
  },
  {
    id: 'registry-autostart', level: 'medium', title: '改注册表 / 设置开机自启',
    re: /reg\s+add\b|regedit|HKEY_|CurrentVersion\\+Run|schtasks\s+\/create|systemd.*\.service|LaunchAgents/gi,
    hint: '持久化手段. 管家自己会创建计划任务, 但第三方插件不该偷偷做.',
  },
  {
    id: 'net-raw', level: 'medium', title: '自己开端口（让别人连进来）',
    re: /net\.(?:connect|createServer|Socket)\s*\(|require\(['"]net['"]\)|createServer\s*\(\s*\{?\s*(?:port|host)/g,
    hint: '插件一般只需要 HTTP 客户端; 主动监听端口要解释.',
  },
  // ---- low: 知情项 ----
  {
    id: 'install-script', level: 'low', title: '装的时候会跑一段脚本',
    re: null, // 由 package.json 的 scripts 判断
    hint: '安装瞬间就会跑, 不经过任何"安装后"的检查. 有脚本的包要看脚本内容.',
  },
  {
    id: 'private-ip', level: 'low', title: '连本机或内网地址',
    re: /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d)/g,
    hint: '本机端口通常是本地服务(正常), 但也可以是内网横向的跳板.',
  },
  {
    id: 'hidden-file', level: 'low', title: '包里带了隐藏文件或可执行文件',
    re: null, // 由文件名判断
    hint: '正常源码包不该带 .exe/.dll/.sh 这类二进制或脚本.',
  },
];

const HIGH_RULES = RULES.filter((r) => r.level === 'high');
const MEDIUM_RULES = RULES.filter((r) => r.level === 'medium');

/** 扫目录时整棵跳过的子目录: 运行时产物不是插件代码, 扫进来只会误报. */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.state', 'reports', 'dist', 'coverage', '.cache']);
/** 单个文件的额外跳过规则: 压缩产物、编辑器临时文件、以 _ 开头的临时脚本. */
const SKIP_REL = /(?:^|\/)(?:[^/]*\.min\.(?:js|mjs|cjs)|\.DS_Store|_[^/]*\.mjs|_probe[^/]*)$/i;

/**
 * 把文件切成"值得扫的代码片段", 丢掉纯文案段.
 *
 * 为什么要切片: 国际化产物会把上百个语言包内联进同一个大文件
 * (实测 dsh-better-sidebar 的 lib/client-terminal.js 有 14801 行,
 * 其中 11505 行是正常代码, 剩下的才是语言包). 整文件判"是不是文案"永远判不对,
 * 而语言包里恰好写着 "支持 ~/.ssh/config 一键导入" 这种介绍文字 ——
 * 按整文件扫就会把它当成"读密钥文件"报高危.
 *
 * 切法: 连续两行以上都是"长字符串文案行"的段落丢掉, 其余留下.
 * 返回留下的文本, 行号不保持(describeHit 里的行号是按片段算的相对位置),
 * 所以这里用换行补齐行数, 保证行号仍能用.
 */
export function dropProseBlocks(text) {
  const lines = text.split('\n');
  const litRe = /'((?:[^'\\]|\\.){40,})'|"((?:[^"\\]|\\.){40,})"/;
  const keep = new Array(lines.length).fill(true);
  let runStart = -1;
  const flush = (endExclusive) => {
    if (runStart < 0) return;
    if (endExclusive - runStart >= 2) {
      for (let k = runStart; k < endExclusive; k++) keep[k] = false;
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    const lit = s ? litRe.exec(s) : null;
    const isProse = !!(lit && (lit[1] || lit[2] || '').indexOf(' ') >= 0);
    if (isProse) { if (runStart < 0) runStart = i; }
    else flush(i);
  }
  flush(lines.length);
  let dropped = 0;
  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) outLines.push(lines[i]);
    else { outLines.push(''); dropped++; }
  }
  return { text: outLines.join('\n'), dropped };
}
/** 安全模块自己的规则表: 里面全是待匹配的模式字面量, 不能拿来自证有罪. */
const SELF_RULES_FILE = /(?:^|\/)safety\.mjs$/;

/**
 * 剥掉注释, 只留真正会被执行的代码.
 *
 * 这一步是必须的: 不剥的话规则会命中自己 —— 正经插件在注释里写
 * "// .env 和 .npmrc 是真实的 profile 配置" 会被当成"读凭据文件",
 * 安全扫描器自己定义规则的那几行也会被打成高危. 实测 dshmarket 因此误报 14 类.
 *
 * 用状态机而不是正则, 因为要找的是"字符串之外"的注释:
 *   'http://a.com' 里的 // 不是注释, 但 // 行首的注释不该被当成代码.
 * 模板字符串里的 ${} 嵌套不深究 —— 保留内容比漏掉更安全(宁可多留).
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 0; // 0=code 1=squote 2=dquote 3=tpl 4=line 5=block
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 0) {
      if (c === '/' && c2 === '/') { state = 4; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 5; i += 2; continue; }
      if (c === "'") { state = 1; out += c; i++; continue; }
      if (c === '"') { state = 2; out += c; i++; continue; }
      if (c === '`') { state = 3; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 1 || state === 2) {
      const q = state === 1 ? "'" : '"';
      if (c === '\\') { out += c + c2; i += 2; continue; }
      if (c === q) { state = 0; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 3) {
      if (c === '\\') { out += c + c2; i += 2; continue; }
      if (c === '`') { state = 0; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 4) { // 行注释, 到换行为止
      if (c === '\n') { state = 0; out += c; }
      i++; continue;
    }
    if (state === 5) { // 块注释
      if (c === '*' && c2 === '/') { state = 0; i += 2; continue; }
      if (c === '\n') out += '\n'; // 保留行号
      i++; continue;
    }
  }
  return out;
}

/**
 * 极简 tar 解析: 只认 ustar/GNU 头, 返回条目列表.
 * npm tarball 全是这种格式, 所以不引 tar 依赖.
 */
export function untar(buffer) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buffer.length) {
    const header = buffer.subarray(off, off + 512);
    // 全零块 = 归档结束
    let zero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { zero = false; break; }
    if (zero) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const mode = header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8) || 0;
    const bodyOff = off + 512;
    const body = buffer.subarray(bodyOff, Math.min(bodyOff + size, buffer.length));
    off = bodyOff + (Math.ceil(size / 512) * 512);

    if (typeflag === 'L') { // GNU 长文件名
      longName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue; // pax 扩展头, 忽略
    if (longName) { name = longName; longName = null; }
    else if (prefix) name = prefix + '/' + name;
    if (typeflag === '5') continue; // 目录
    if (!name) continue;
    entries.push({ name, size, mode, type: typeflag, body });
  }
  return entries;
}

/** 去掉 npm 包的 `package/` 前缀. */
function stripPrefix(name) {
  return String(name).replace(/^[^/]+\//, '');
}

/** 把命中位置变成 file:line + 截断的原文, 方便人工核对. */
function describeHit(relFile, text, index, matchLen) {
  const before = text.slice(0, index);
  const line = before.split(/\r?\n/).length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', index + matchLen);
  const raw = text.slice(lineStart, lineEnd === -1 ? Math.min(text.length, index + matchLen + 80) : lineEnd);
  const snippet = raw.trim().replace(/\s+/g, ' ').slice(0, 160);
  return { file: relFile, line, snippet };
}

/**
 * 命中点是不是落在字符串/模板字面量里?
 *
 * 为什么需要: `eval (` 这种字样出现在日志文案里很常见
 * (dsh-cad 就有 `eval (${value.language}) — ok`), 判高危纯属冤枉.
 * 做法: 从文件开头扫到命中位置, 维护"当前在哪种引号里"的状态机
 * (单引号 / 双引号 / 反引号), 同时正确跳过 \\ 转义与 `\\` 续行.
 * 注释已经由 stripComments 去掉, 所以不用管 // 和 /*.
 */
function inStringAt(text, index) {
  let quote = null; // null | "'" | '"' | '`'
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return quote !== null;
}

/** 从 package.json 的 scripts 判断有没有安装期脚本. */function installScripts(pkg) {
  const s = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const keys = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
  return keys.filter((k) => typeof s[k] === 'string' && s[k].trim()).map((k) => ({ name: k, cmd: s[k].slice(0, 200) }));
}

const SUSPECT_EXT = /\.(exe|dll|so|dylib|bat|cmd|ps1|vbs|scr|msi)$/i;

/**
 * 扫一批"文件内容", 出 findings.
 * files: [{ rel, text }]
 * 逐行对照用原文(带注释也行), 因为要给人看; 判定用剥过注释的版本.
 */
export function scanContents(files, pkg) {
  const findings = [];
  const push = (rule, hit) => {
    if (findings.length >= MAX_FINDINGS) return;
    findings.push({
      id: rule.id, level: rule.level, title: rule.title, hint: rule.hint,
      file: hit ? hit.file : null, line: hit ? hit.line : null, snippet: hit ? hit.snippet : null,
    });
  };

  // 判定用的代码版本: 注释剥掉 + 语言包段落丢掉
  const code = files.map((f) => ({ rel: f.rel, raw: f.text, text: dropProseBlocks(stripComments(f.text)).text }));

  // 组合规则: 同一文件里既读 env 又发网络请求
  for (const f of code) {
    const readsEnv = /process\.env\b|process\.env\[/.test(f.text);
    const sendsOut = /\bfetch\s*\(|https?\.request\s*\(|new\s+WebSocket\s*\(|\baxios\b/.test(f.text);
    const envWhole = /JSON\.stringify\s*\(\s*process\.env\s*\)|Object\.(?:entries|keys|assign)\s*\(\s*process\.env\s*\)/.test(f.text);
    if (readsEnv && sendsOut && envWhole) {
      const rule = RULES.find((r) => r.id === 'env-exfil');
      const idx = f.text.search(/JSON\.stringify\s*\(\s*process\.env\s*\)/);
      push(rule, describeHit(f.rel, f.text, idx < 0 ? 0 : idx, 20));
    }
  }

  // 逐条正则
  for (const rule of RULES) {
    if (!rule.re) continue;
    for (const f of code) {
      rule.re.lastIndex = 0;
      let m;
      let seenInFile = 0;
      while ((m = rule.re.exec(f.text)) !== null) {
        // 有些规则只管"真的在调代码": 命中落在字符串/模板字面量里的一律不算.
        // 例: dsh-cad 的 `eval (${value.language}) — ok` 只是日志文案, 判高危就是冤枉.
        if (rule.skipInString && inStringAt(f.text, m.index)) {
          if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
          continue;
        }
        if (seenInFile >= 3) break; // 同一规则同一文件最多记 3 条
        seenInFile++;
        push(rule, describeHit(f.rel, f.text, m.index, m[0].length));
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
      }
    }
  }

  // 安装期脚本
  const scripts = installScripts(pkg);
  if (scripts.length) {
    for (const s of scripts) {
      push(RULES.find((r) => r.id === 'install-script'), {
        file: 'package.json', line: null, snippet: s.name + ': ' + s.cmd,
      });
    }
  }

  // 可疑文件
  for (const f of files) {
    if (SUSPECT_EXT.test(f.rel)) {
      push(RULES.find((r) => r.id === 'hidden-file'), { file: f.rel, line: null, snippet: '带可执行文件或脚本' });
      break;
    }
  }

  // 去重: 同一 rule+file+line 只留一条
  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const k = f.id + '|' + (f.file || '') + '|' + (f.line || 0) + '|' + (f.snippet || '');
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(f);
  }
  return dedup;
}

/**
 * 按 findings 算风险等级和一句话结论.
 * 结果里额外给一个按规则的摘要(ruleHits), 让人一眼看到"报警的是不是同一件事重复 13 次".
 */
export function gradeFindings(findings, extra) {
  const e = extra || {};
  // 按规则聚合: 同一规则命中多少次只算一类, 但要把次数亮出来,
  // 否则"读凭据 x13" 和 "读凭据 x1" 看起来一样严重.
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.id)) byRule.set(f.id, { id: f.id, level: f.level, title: f.title, count: 0, sample: f });
    byRule.get(f.id).count++;
  }
  const ruleHits = Array.from(byRule.values()).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[a.level] ?? 9) - (rank[b.level] ?? 9) || b.count - a.count;
  });
  const nHigh = ruleHits.filter((r) => r.level === 'high').length;
  const nMed = ruleHits.filter((r) => r.level === 'medium').length;
  const nLow = ruleHits.filter((r) => r.level === 'low').length;
  let level = 'safe';
  let verdict = '没看到可疑的东西';
  if (nHigh > 0) {
    level = 'danger';
    verdict = '有 ' + nHigh + ' 类可疑行为，建议看一眼原文再决定';
  } else if (nMed > 0) {
    level = 'caution';
    verdict = '会用到 ' + nMed + ' 类正常能力（起外部程序 / 联网 / 写文件），功能完整的插件基本都这样';
  } else if (nLow > 0) {
    level = 'info';
    verdict = '只有些小提醒';
  }
  if (e.deprecated) { verdict += ' · 该版本已被作者弃用'; if (level === 'safe') level = 'caution'; }
  if (e.veryNew) { verdict += ' · 发布不到 14 天'; }
  return { level, verdict, counts: { high: nHigh, medium: nMed, low: nLow, total: ruleHits.length, hits: findings.length }, ruleHits };
}

/**
 * 来源核验: 这个包是谁的, 有多少人在用, 和 registry 说的是不是一致.
 * 返回 { checks: [{id, ok, label, detail}], level }
 */
export function verifySource(pkgJson, packument, expectedIntegrity) {
  const checks = [];
  const p = pkgJson || {};
  const name = p.name || '';
  const m = /^(?:@([^/]+)\/)?(.+)$/.exec(String(name));
  const scope = m && m[1] ? m[1] : null;

  if (scope) {
    checks.push({ id: 'scope', ok: true, label: '官方范围包 @' + scope, detail: 'npm 上作用域唯一归属于该 scope 的所有者, 别人无法抢注同名' });
  } else {
    checks.push({ id: 'no-scope', ok: false, label: '普通包名（谁都能注册）', detail: '无 scope 的名字可以被任意人注册; 仿冒者常用单字符差异 (如 dsh-contex)。不是错误, 只是要多看一眼作者。' });
  }

  const repo = p.repository && (p.repository.url || p.repository);
  if (repo) {
    const s = typeof repo === 'string' ? repo : '';
    const ok = /github\.com|gitlab\.com|gitee\.com|codeberg\.org/i.test(s);
    checks.push({ id: 'repository', ok, label: '源码仓库：' + (ok ? '能对得上' : '不常见'), detail: String(s).slice(0, 200) });
  } else {
    checks.push({ id: 'no-repository', ok: false, label: '没写代码仓库', detail: '装之前无法看源码, 只能靠下载的包本身判断' });
  }

  const scripts = installScripts(p);
  checks.push({
    id: 'install-script',
    ok: scripts.length === 0,
    label: scripts.length ? '装的时候会跑 ' + scripts.map((s) => s.name).join('/') : '装的时候不跑任何脚本',
    detail: scripts.length ? scripts.map((s) => s.name + ': ' + s.cmd).join(' · ') : '安装过程不会执行包内代码',
  });

  if (packument && !packument.error) {
    const v = packument.versions || [];
    const downloadsHint = v.length >= 30 ? '版本历史较长(' + v.length + ' 个版本)' : '版本只有 ' + v.length + ' 个, 比较新';
    checks.push({ id: 'versions', ok: v.length >= 10, label: downloadsHint, detail: '版本迭代多通常意味着有人长期在用' });
    const modified = packument.modified;
    if (modified) {
      const ageMs = Date.now() - Date.parse(modified);
      const days = Math.floor(ageMs / 86400000);
      checks.push({ id: 'age', ok: days >= 14, label: '最近一次更新是 ' + days + ' 天前', detail: '刚发布几天的版本被攻击者替换/夹带的可能性相对更高' });
    }
    const dist = packument.distTags && packument.distTags.latest;
    if (dist) checks.push({ id: 'latest', ok: true, label: 'registry 上的 latest = ' + dist, detail: '' });
    const meta = packument.meta && packument.meta[packument.latest];
    const integ = meta && meta.integrity;
    if (integ && expectedIntegrity) {
      const same = integ === expectedIntegrity;
      checks.push({
        id: 'integrity', ok: same,
        label: same ? '完整性哈希与 registry 一致' : '完整性哈希不一致!',
        detail: same ? String(integ).slice(0, 40) + '…' : '期望 ' + integ + ', 实际 ' + expectedIntegrity,
      });
    } else if (integ) {
      checks.push({ id: 'integrity', ok: true, label: 'registry 声明了完整性哈希', detail: String(integ).slice(0, 40) + '…' });
    }
  } else if (packument && packument.error) {
    checks.push({ id: 'registry', ok: false, label: '查不到 registry 信息', detail: String(packument.error).slice(0, 160) });
  }

  const bad = checks.filter((c) => c.ok === false).length;
  const level = bad === 0 ? 'good' : bad <= 2 ? 'mixed' : 'poor';
  return { checks, level };
}

/**
 * 抓 tarball 并静态扫描. 不落盘、不执行.
 * opts: { tarball, integrity, expectedName, expectVersion, timeoutMs, packument }
 */
export async function auditTarball(opts) {
  const o = opts || {};
  const at = nowIso();
  if (!o.tarball) {
    return {
      target: o.expectedName || null, version: o.expectVersion || null, at,
      ok: false, error: '没有可下载的 tarball 地址', findings: [],
      grade: { level: 'unknown', verdict: '无法检查: 没拿到下载地址', counts: { high: 0, medium: 0, low: 0, total: 0 } },
      source: null, pkg: null, files: { scanned: 0, bytes: 0 },
    };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || 30000);
  let buf = null;
  try {
    const res = await fetch(o.tarball, { signal: ac.signal, headers: { accept: 'application/octet-stream' } });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  } catch (error) {
    clearTimeout(timer);
    return {
      target: o.expectedName || null, version: o.expectVersion || null, at,
      ok: false, error: String((error && error.message) || error), findings: [],
      grade: { level: 'unknown', verdict: '无法检查: 下载 tarball 失败', counts: { high: 0, medium: 0, low: 0, total: 0 } },
      source: null, pkg: null, files: { scanned: 0, bytes: 0 },
    };
  }
  clearTimeout(timer);

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  let gz = null;
  try {
    gz = zlib.gunzipSync(buf);
  } catch (error) {
    return {
      target: o.expectedName || null, version: o.expectVersion || null, at,
      ok: false, error: '解压失败: ' + String((error && error.message) || error), findings: [],
      grade: { level: 'unknown', verdict: '无法检查: tarball 解不开', counts: { high: 0, medium: 0, low: 0, total: 0 } },
      source: null, pkg: null, files: { scanned: 0, bytes: 0 }, sha256, tarballBytes: buf.length,
    };
  }

  const entries = untar(gz);
  let pkg = null;
  const files = [];
  let scannedBytes = 0;
  let fileCount = 0;
  for (const e of entries) {
    const rel = stripPrefix(e.name);
    if (!rel || /\/$/.test(rel)) continue;
    fileCount++;
    if (rel === 'package.json' || rel === '') {
      try { pkg = JSON.parse(e.body.toString('utf8')); } catch (x) { /* 坏 json 交给下面判定 */ }
      continue;
    }
    if (!SCAN_EXT.test(rel)) continue;
    if (e.size > MAX_FILE_BYTES) continue;
    if (scannedBytes + e.size > MAX_SCAN_BYTES) continue;
    let text = '';
    try { text = e.body.toString('utf8'); } catch (x) { continue; }
    if (text.indexOf('\u0000') >= 0) continue; // 二进制
    scannedBytes += e.size;
    files.push({ rel, text });
  }

  const findings = scanContents(files, pkg);
  const packument = o.packument || null;
  const modDays = packument && packument.modified ? Math.floor((Date.now() - Date.parse(packument.modified)) / 86400000) : null;
  const grade = gradeFindings(findings, { deprecated: !!(packument && packument.meta && packument.meta[o.expectVersion] && packument.meta[o.expectVersion].deprecated), veryNew: modDays !== null && modDays < 14 });
  const pkgNameOk = !o.expectedName || !pkg || !pkg.name || pkg.name === o.expectedName;

  return {
    target: o.expectedName || (pkg && pkg.name) || null,
    version: o.expectVersion || (pkg && pkg.version) || null,
    at, ok: true, error: null,
    findings, grade,
    source: verifySource(pkg, packument, o.integrity || null),
    pkg: pkg ? { name: pkg.name || null, version: pkg.version || null, repository: pkg.repository ? String(pkg.repository.url || pkg.repository) : null, license: pkg.license || null, scripts: installScripts(pkg) } : null,
    pkgNameMatches: pkgNameOk,
    files: { scanned: files.length, total: fileCount, bytes: scannedBytes },
    sha256, tarballBytes: buf.length,
  };
}

/** 扫已装目录(本地 link / 已安装包), 走同一套规则. */
export function auditInstalled(profile, name, opts) {
  const o = opts || {};
  const root = profileDir(profile);
  const dir = o.dir || path.join(root, 'node_modules', ...String(name).split('/'));
  if (!isDir(dir)) {
    return { target: name, ok: false, error: '找不到安装目录: ' + dir, findings: [], grade: { level: 'unknown', verdict: '未安装', counts: { high: 0, medium: 0, low: 0, total: 0 }, ruleHits: [] }, source: null, pkg: null, files: { scanned: 0, bytes: 0 } };
  }
  let pkg = null;
  const pkgFile = path.join(dir, 'package.json');
  if (isFile(pkgFile)) { try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { pkg = null; } }
  const files = [];
  let scannedBytes = 0;
  let skipped = 0;
  let textOnly = 0;
  const walk = (d, base, depth) => {
    if (depth > 6 || files.length > 800) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      // 跳过运行时产物: 这些不是"插件代码", 扫进来只会制造误报
      //   .state/  插件自己的状态与快照
      //   reports/ 日志
      //   .git/   仓库元数据
      if (SKIP_DIR_NAMES.has(it.name)) continue;
      const full = path.join(d, it.name);
      const rel = base ? base + '/' + it.name : it.name;
      if (it.isDirectory()) { walk(full, rel, depth + 1); continue; }
      if (!it.isFile() || !SCAN_EXT.test(it.name)) continue;
      if (SKIP_REL.test(rel)) continue;
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st || st.size > MAX_FILE_BYTES || scannedBytes + st.size > MAX_SCAN_BYTES) { skipped++; continue; }
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      if (text.indexOf('\u0000') >= 0) continue;
      // 安全模块自己是规则表, 里面写着所有待匹配的模式字面量 —— 拿它自证有罪没有意义.
      if (SELF_RULES_FILE.test(rel)) continue;
      scannedBytes += st.size;
      files.push({ rel, text });
    }
  };
  walk(dir, '', 0);
  const findings = scanContents(files, pkg);
  const grade = gradeFindings(findings, {});
  return {
    target: name, version: (pkg && pkg.version) || null, at: nowIso(), ok: true, error: null, dir,
    findings, grade, source: verifySource(pkg, null, null),
    pkg: pkg ? { name: pkg.name || null, version: pkg.version || null, repository: pkg.repository ? String(pkg.repository.url || pkg.repository) : null, license: pkg.license || null, scripts: installScripts(pkg) } : null,
    files: { scanned: files.length, bytes: scannedBytes, skipped, textOnly },
  };
}

/* ------------------------------------------------------------------ *
 * 缓存: 同一个 name@version 的扫描结果不会变, 存下来避免重复下载  *
 * ------------------------------------------------------------------ */

function loadCache() {
  try {
    const j = JSON.parse(fs.readFileSync(SAFETY_CACHE, 'utf8'));
    if (j && j.entries) return j;
  } catch (e) { /* ignore */ }
  return { schema: 1, entries: {} };
}
function saveCache(c) {
  try {
    ensureDir(SAFETY_DIR);
    const keys = Object.keys(c.entries);
    if (keys.length > 400) {
      keys.sort((a, b) => (c.entries[a].at || '') < (c.entries[b].at || '') ? -1 : 1);
      for (const k of keys.slice(0, keys.length - 400)) delete c.entries[k];
    }
    writeJson(SAFETY_CACHE, c);
  } catch (e) { /* ignore */ }
}
export function cacheInfo() {
  const c = loadCache();
  return { count: Object.keys(c.entries).length, file: SAFETY_CACHE };
}
export function clearCache() {
  try { fs.unlinkSync(SAFETY_CACHE); return true; } catch (e) { return false; }
}

/** 带缓存的 tarball 审计. */
export async function auditPackageVersion(name, version, opts) {
  const o = opts || {};
  const key = name + '@' + version;
  if (!o.refresh) {
    const c = loadCache();
    const hit = c.entries[key];
    if (hit) return Object.assign({}, hit, { fromCache: true });
  }
  const pack = o.packument || await fetchPackument(name, { timeoutMs: o.timeoutMs });
  const meta = (pack && pack.meta && pack.meta[version]) || null;
  const latestMeta = (pack && pack.meta && pack.meta[pack.latest]) || null;
  const use = meta || latestMeta;
  const report = await auditTarball({
    tarball: use && use.tarball,
    integrity: use && use.integrity,
    expectedName: name, expectVersion: version,
    packument: pack, timeoutMs: o.timeoutMs,
  });
  if (report.ok) {
    const c = loadCache();
    c.entries[key] = report;
    saveCache(c);
  }
  return report;
}

/**
 * 全 profile 体检: 每个已装插件跑一遍本地扫描(不联网, 快).
 * opts: { only, noCache }
 */
export async function auditProfile(profile, opts) {
  const o = opts || {};
  const s = scanProfile(profile, { noSize: true });
  const targets = (s.plugins || []).filter((p) => p.installed && p.origin !== 'missing');
  const only = Array.isArray(o.only) && o.only.length ? new Set(o.only) : null;
  const picked = only ? targets.filter((p) => only.has(p.name)) : targets;
  const rows = await mapLimit(picked, o.concurrency || 4, async (p) => {
    const r = auditInstalled(profile, p.name, { dir: p.realPath });
    return {
      name: p.name, title: p.title, version: p.version, origin: p.origin, source: p.source, dir: p.realPath,
      level: (r.grade && r.grade.level) || 'unknown',
      verdict: (r.grade && r.grade.verdict) || '',
      counts: (r.grade && r.grade.counts) || { high: 0, medium: 0, low: 0, total: 0 },
      findings: (r.findings || []).slice(0, 20),
      files: r.files,
      error: r.error || null,
    };
  });
  const order = { danger: 0, caution: 1, info: 2, safe: 3, unknown: 4 };
  rows.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || String(a.name).localeCompare(String(b.name)));
  const summary = {
    total: rows.length,
    danger: rows.filter((r) => r.level === 'danger').length,
    caution: rows.filter((r) => r.level === 'caution').length,
    info: rows.filter((r) => r.level === 'info').length,
    safe: rows.filter((r) => r.level === 'safe').length,
    unknown: rows.filter((r) => r.level === 'unknown').length,
    at: nowIso(),
  };
  return { profile, summary, rows };
}
