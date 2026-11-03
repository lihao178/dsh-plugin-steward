// labels.mjs - 中文名登记表
//
// 为什么需要它: 插件的中文名是写在插件自己目录的 locale/zh.json 里的,
// 所以 pnpm 一升级就会把整个目录换掉, 手工改的中文名跟着一起没了
// (实测: dsh-ppt 0.18.1 -> 0.19.0 后 演示文稿 变回 dsh-ppt;
//        dsh-better-sidebar 0.28.1 -> 0.28.2 后 增强侧边栏 变回 Better Sidebar)
// 解决办法: 把"正确的名字"记在本表里, 每次体检拿它跟现状对比,
//           一旦发现名字丢了/变了, 就报出来并能一键重新套用。
//
// 表里 BASE 是出厂自带的那批名字, 你自己加的插件可以用
//   dsh-pm label set <包名> <中文名>
// 记到 .state/labels.json (不会因为升级而丢)。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, ensureDir, readJson, writeJson, isFile } from './util.mjs';

export const LABEL_FILE = path.join(STATE_DIR, 'labels.json');

// name -> { zh: {title, description?}, en: {title, description?} }
export const BASE = {
  '@linxin666/dsh-client-ui-skill-explorer': {
    zh: { title: '技能中心', description: '在网页面板里管理技能: 按来源浏览已加载的技能, 启用 / 停用, 新建, 删除. (原包名 dsh-client-ui-skill-explorer)' },
    en: { title: 'Skill Center', description: 'Browse, enable, disable, create and delete loaded skills from a web panel.' },
  },
  '@linxin666/dsh-client-ui-task-board': {
    zh: { title: '任务看板', description: '给网页界面加一块任务看板: 任务由主进程真实跑, 可定时调度, 并可选防止系统空闲休眠. (原包名 dsh-client-ui-task-board)' },
    en: { title: 'Task Board', description: 'Task board for the Web GUI: real session execution, cron scheduling and optional idle-sleep protection.' },
  },
  '@liustack/modlens': {
    zh: { title: '图片识别', description: '给只能读文字的模型加上眼睛: 把图片读成文字证据 (全文识别, 版式, 语义), 再交给模型判断. (原包名 modlens)' },
    en: { title: 'Image Reading', description: 'Plug-in vision for text-only models: turns an image into text evidence.' },
  },
  '@tonydua/dsh-web-search-exa': {
    zh: { title: '联网搜索', description: '免配置的联网搜索 (Exa): 不填 Key 也能匿名搜, 填了 Key 就走正式接口. (原包名 dsh-web-search-exa)' },
    en: { title: 'Web Search', description: 'Zero-config Exa web search: keyless anonymous search, or keyed REST search once an API key is added.' },
  },
  '@tt-a1i/archify-dsh': {
    zh: { title: '架构图生成', description: 'Archify 架构图技能: 让智能体画出系统架构图. (原包名 archify-dsh)' },
    en: { title: 'Architecture Diagrams', description: 'Archify architecture-diagram skill bundle.' },
  },
  'billion-context': {
    zh: { title: '上下文压缩', description: '把上下文压缩后再送给模型: 每轮更省 token, 单个会话可以开很久. (原包名 billion-context)' },
    en: { title: 'Context Compression', description: 'Compresses the context so a small window still works.' },
  },
  'dsh-hindsight-memory': {
    zh: { title: '长期记忆', description: '把 Hindsight 记忆服务接进 DSH: 跨会话记住事实, 自动按项目 / 全局分层, 模型只看到 9 个语义化记忆工具. (原包名 dsh-hindsight-memory)' },
    en: { title: 'Long-term Memory', description: 'Bridges the Hindsight memory service into DSH.' },
  },
  'dsh-image-gen': {
    zh: { title: 'AI 画图', description: '在 DSH 里生成图片: 支持 Gemini, OpenAI, Seedream (即梦), 通义万相, 本地 ComfyUI 等. (原包名 dsh-image-gen)' },
    en: { title: 'AI Image Generation', description: 'Generate images inside DSH with Gemini, OpenAI, Seedream, DashScope, local ComfyUI and more.' },
  },
  'dsh-ppt': {
    zh: { title: '演示文稿', description: '做演示文稿: 生成 HTML 演示, 可编辑的 PPTX 和工程文件, 支持数字溯源与 AI 看图修复. (原包名 dsh-ppt)' },
    en: { title: 'Presentation', description: 'Generate HTML decks, editable PPTX files and project files.' },
  },
  'dsh-univer-office': {
    zh: { title: '表格文档', description: '内嵌 Univer 表格 / 文档: 会话里直接预览文件, 还能用浮动窗口编辑工作区文件. (原包名 dsh-univer-office)' },
    en: { title: 'Spreadsheet and Docs', description: 'Embedded Univer viewer: inline previews of office files plus floating windows for live editing.' },
  },
  'dsh-better-sidebar': { zh: { title: '增强侧边栏' }, en: { title: 'Better Sidebar' } },
  'dsh-context': { zh: { title: '上下文 (dsh-context)' }, en: { title: 'Context' } },
  'dsh-cost-meter': { zh: { title: '费用计量 (dsh-cost-meter)' }, en: { title: 'Cost Meter' } },
  dshmarket: { zh: { title: '插件市场' }, en: { title: 'Plugin Market' } },
  '@local/desktop-control-mcp': { zh: { title: '桌面控制（后台静默 + 前台输入）' }, en: { title: 'Desktop Control' } },
  '@local/dsh-plugin-quant': { zh: { title: '量化回测' }, en: { title: 'Quant Backtest' } },
  '@local/dsh-plugin-thrifty': { zh: { title: '省着用' }, en: { title: 'Thrifty' } },
};

export function loadLabels() {
  const file = readJson(LABEL_FILE, null);
  const mine = (file && file.entries) || {};
  const out = {};
  for (const k of Object.keys(BASE)) out[k] = BASE[k];
  for (const k of Object.keys(mine)) {
    out[k] = Object.assign({}, out[k] || {}, mine[k]);
  }
  return out;
}

export function saveLabels(table) {
  ensureDir(STATE_DIR);
  writeJson(LABEL_FILE, { version: 1, savedAt: new Date().toISOString(), entries: table });
  return LABEL_FILE;
}

export function setLabel(name, title, description) {
  const file = readJson(LABEL_FILE, null) || { version: 1, entries: {} };
  file.entries = file.entries || {};
  const cur = file.entries[name] || {};
  cur.zh = Object.assign({}, cur.zh || {}, { title });
  if (description) cur.zh.description = description;
  file.entries[name] = cur;
  file.version = 1;
  writeJson(LABEL_FILE, file);
  return cur;
}

export function expectedTitle(name) {
  const t = loadLabels()[name];
  return t && t.zh && t.zh.title ? t.zh.title : null;
}

// 名字对不上吗? 返回 null 表示没问题
//   kind: 'wiped' = 中文名整个没了 (升级把 locale 目录换掉了)
//         'drift' = 名字被改回英文/别的了
export function titleDrift(p) {
  const want = expectedTitle(p.name);
  if (!want) return null;
  const cur = p.title && p.title !== p.name ? String(p.title) : null;
  if (!cur) return { kind: 'wiped', expected: want, actual: null };
  if (cur !== want) return { kind: 'drift', expected: want, actual: cur };
  return null;
}

function ensureLocaleExportIn(pkgPath) {
  const raw = fs.readFileSync(pkgPath, 'utf8');
  if (raw.indexOf('"./locale/*.json"') >= 0) return { changed: false };
  const re = /"exports"\s*:\s*\{/;
  if (!re.test(raw)) return { changed: false, noExports: true };
  const text = raw.replace(re, '"exports": {\n    "./locale/*.json": "./locale/*.json",');
  JSON.parse(text);
  fs.writeFileSync(pkgPath, text, 'utf8');
  return { changed: true };
}

// 把登记表里的名字重新写回插件目录
export function applyLabel(p) {
  if (!p.realPath) return { ok: false, note: '找不到插件目录' };
  const table = loadLabels()[p.name];
  if (!table || !table.zh || !table.zh.title) return { ok: false, note: '登记表里没有这个包的中文名' };
  const dir = path.join(p.realPath, 'locale');
  ensureDir(dir);
  const wrote = [];
  for (const lang of ['zh', 'en']) {
    const spec = table[lang];
    if (!spec || !spec.title) continue;
    const file = path.join(dir, lang + '.json');
    let old = {};
    if (isFile(file)) { try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { old = {}; } }
    const meta = Object.assign({}, old.meta || {});
    meta.title = spec.title;
    if (spec.description) meta.description = spec.description;
    else if (!meta.description) meta.description = table.en && table.en.description ? table.en.description : '';
    const body = Object.assign({}, old, { meta });
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    wrote.push(lang);
  }
  const ex = ensureLocaleExportIn(path.join(p.realPath, 'package.json'));
  const bits = [];
  if (wrote.length) bits.push('写入 locale/' + wrote.join(', ') + '.json');
  if (ex.changed) bits.push('exports 已补 ./locale/*.json');
  if (ex.noExports) bits.push('注意: 该包没有 exports 字段, 可能还是要靠宿主兜底');
  return { ok: true, note: bits.join('; ') + ' -> ' + table.zh.title };
}