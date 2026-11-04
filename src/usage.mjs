// usage.mjs - 从插件自己的 README 里抽出「怎么用」那一段
//
// 为什么需要它:
//   面板里已经有中文名 + 一句说明, 但用户真正会问的是「这东西装上之后我怎么用」。
//   每家插件的 README 都写了用法, 只是位置和标题不统一。这里按常见标题去找,
//   抽到一段人话就存进 labels.json 的 usage 字段 —— 存下来而不是每次都读文件,
//   pnpm 升级换掉插件目录之后这段文字还在。
//
// 抽取原则:
//   - 只认语义明确的标题 (怎么用 / 用法 / 使用 / Usage / Getting started / Quick start)
//   - 跳过安装说明 (Install / 安装) —— 插件已经装好了, 再讲一遍装是废话
//   - 最多留 MAX_LEN 个字符, 到行边界截断并补省略号
//   - 抽不到就返回空, 面板显示「作者没写用法」而不是瞎猜

import fs from 'node:fs';
import path from 'node:path';
import { isFile, isDir, listDir } from './util.mjs';

export const MAX_LEN = 1800;

// 标题里出现这些词就用这一段, 按优先级从高到低
const HEADINGS = [
  '怎么用', '如何使用', '用法', '使用说明', '使用方法', '使用示例', '快速开始', '快速上手', '开始使用', '3 分钟上手',
  'usage', 'how to use', 'how it works', 'getting started', 'quick start', 'quickstart', 'example',
];
// 第二梯队: 第一梯队都没找到时, 退而求其次讲「能干什么」
const FALLBACK_HEADINGS = ['功能总览', '功能', '特性', '特色功能', '能力', 'feature', 'features', '你能得到', '你会得到', '看看实际效果'];
// 这些标题下面的内容不算「怎么用」(是要装什么/怎么装), 命中就整段跳过
const SKIP_HEADINGS = ['install', '安装', '安装方法', '下载', 'requirements', '依赖', 'changelog', '最近更新', '更新日志', 'license', '许可', '贡献', '社区', '友情链接', '致谢'];
// 纯粹是元信息的二级标题, 抽出来的段里遇到就截断
const TAIL_STOP = ['测试', '架构', '文件结构', '许可', '贡献', '社区', '友情链接', '已知限制', '路线图', '数据源', '连接器', '主题'];

function normHeading(line) {
  return String(line || '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase();
}

/** 极简 markdown 清理: 去代码块围栏、去图片、把链接压成文字、压缩空行 */
export function tidy(md) {
  let s = String(md || '');
  s = s.split(String.fromCharCode(13)).join('');
  // 连续的表格行多半是「能力清单 / 参数表」. 全留着会撑爆, 全删掉又什么都没了,
  // 所以留前 4 行 + 一句"还有 N 行" —— 人看得懂这个插件能干什么就够了.
  s = s.replace(/(?:^\|.*\|[ \t]*\n){2,}/gm, (block) => {
    const rows = block.trim().split('\n');
    if (rows.length <= 5 && block.length < 400) return block;
    const keep = rows.slice(0, 4).join('\n');
    return keep + '\n(表格还有 ' + (rows.length - 4) + ' 行, 已省略)\n';
  });
  // 去掉围栏代码块本身保留内容行里的缩进, 太长就整块丢掉 (通常是源码, 不是用法说明)
  s = s.replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, (m, body) => (body.split('\n').length > 14 ? '\n' : body));
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                     // 图片
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                  // 链接 -> 文字
  s = s.replace(/<[^>]+>/g, '');                                  // 内联 html
  s = s.replace(/^\s*>\s?/gm, '');                                // 引用
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');                       // 分隔线
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 从 markdown 里抽「怎么用」段.
 * 返回 { text, heading, found, fallback } —— found=false 表示作者没写, text 为空串.
 */
export function extractUsage(md) {
  // 有些 README 是 CRLF 换行, 不先归一化的话 "#" 标题里会残留 \r, 正则匹配不到
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s*(.+)$/.exec(lines[i]);
    if (m) heads.push({ level: m[1].length, text: m[2], line: i });
  }
  const isSkip = (t) => SKIP_HEADINGS.some((k) => normHeading(t).indexOf(k) >= 0);
  const pick = (wants) => {
    for (const want of wants) {
      for (const h of heads) {
        if (normHeading(h.text).indexOf(want) < 0) continue;
        if (isSkip(h.text)) continue;
        // 取到下一个同级或更高级标题为止
        let end = lines.length;
        for (const h2 of heads) {
          if (h2.line > h.line && h2.level <= h.level) { end = h2.line; break; }
        }
        let body = tidy(lines.slice(h.line + 1, end).join('\n'));
        // 段内如果混进了「测试」「架构」「许可」这类元信息子标题, 在它前面截断
        if (body.length > 400) {
          let cut = body.length;
          for (const stop of TAIL_STOP) {
            const re = new RegExp('^#{1,6}\\s*[^\\n]*' + stop, 'im');
            const m2 = re.exec(body);
            if (m2 && m2.index > 200 && m2.index < cut) cut = m2.index;
          }
          body = body.slice(0, cut).trim();
        }
        // 有些 README 这一节只有一张大表格, 或者干脆是空的: 那次就接着找下一个标题
        if (!body || (body.length < 40 && body.indexOf('|') >= 0)) continue;
        if (body.length > MAX_LEN) {
          const cut = body.lastIndexOf('\n', MAX_LEN);
          body = body.slice(0, cut > MAX_LEN * 0.6 ? cut : MAX_LEN).trim() + '…';
        }
        return { text: body, heading: h.text.trim(), found: true };
      }
    }
    return null;
  };
  const main = pick(HEADINGS);
  if (main) return Object.assign(main, { fallback: false });
  const fb = pick(FALLBACK_HEADINGS);
  if (fb) return Object.assign(fb, { fallback: true });
  return { text: '', heading: null, found: false, fallback: false };
}

// README 可能是 .md / .MD / readme.md / README.zh.md, 中文优先
export function readmeOf(dir) {
  if (!isDir(dir)) return null;
  const cands = listDir(dir).filter((d) => d.isFile() && /^readme.*\.md$/i.test(d.name)).map((d) => d.name);
  if (!cands.length) return null;
  const score = (n) => {
    const l = n.toLowerCase();
    if (/zh|cn|chinese/.test(l)) return 0;
    if (l === 'readme.md') return 1;
    return 2;
  };
  cands.sort((a, b) => score(a) - score(b) || a.length - b.length);
  const file = path.join(dir, cands[0]);
  try {
    const st = fs.statSync(file);
    if (st.size > 400 * 1024) return null;                       // 超大 README 不读, 免得卡面板
    return { file, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return null;
  }
}

/** 对一条已装插件, 从它的目录里抽用法 */
export function usageOfPlugin(p) {
  const dir = p && (p.realPath || null);
  if (!dir) return { found: false, text: '', source: null };
  const r = readmeOf(dir);
  if (!r) return { found: false, text: '', source: null };
  const u = extractUsage(r.text);
  return { found: u.found, text: u.text, heading: u.heading, source: r.file };
}
