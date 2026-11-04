// humanize.mjs - 把插件信息改成"看得懂的话"
//
// 为什么需要它:
//   面板里原来给的是 pkg 名 + locale 里的英文 title. 一个不写插件的人看到
//   "@linxin666/dsh-client-ui-skill-explorer v0.4.14" 是读不出这是干什么的.
//   这个模块把每条插件记录补成: 中文名 + 一句中文说明 + 这句说明是哪来的.
//
// 中文说明的三个来源, 按优先级:
//   1. 插件自己带的 locale/zh.json 的 meta.description (作者写的, 最准)
//   2. .state/labels.json 登记表 (我们写回插件目录的那份, 升级也不会丢)
//   3. 市场目录 .state/market/plugins.json 里的中文描述 (8489 条几乎全覆盖)
// 全都没有时保留英文原文, 但明确标成 english, 前端会打上"英文原文"标记,
// 不会假装它是中文.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './util.mjs';
import { loadLabels } from './labels.mjs';

export const CAT_FILE = path.join(STATE_DIR, 'market', 'plugins.json');

const ZH = /[\u4e00-\u9fa5]/;

export function hasZh(s) {
  return typeof s === 'string' && ZH.test(s);
}

/** 市场目录的中文描述索引: name -> { zhTitle, zhDesc } */
let INDEX_CACHE = null; // { key, map }

export function catIndex() {
  let st = null;
  try {
    st = fs.statSync(CAT_FILE);
  } catch (e) {
    INDEX_CACHE = null;
    return new Map();
  }
  const key = st.size + ':' + st.mtimeMs;
  if (INDEX_CACHE && INDEX_CACHE.key === key) return INDEX_CACHE.map;
  const map = new Map();
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(CAT_FILE, 'utf8'));
  } catch (e) {
    return map;
  }
  // 目录文件可能是 { plugins: [...] }, { raw: { plugins: [...] } } 或直接数组
  const root = doc && doc.raw !== undefined ? doc.raw : doc;
  let list = [];
  if (Array.isArray(root)) list = root;
  else if (root && Array.isArray(root.plugins)) list = root.plugins;
  else if (root && Array.isArray(root.entries)) list = root.entries;
  else if (doc && Array.isArray(doc.plugins)) list = doc.plugins;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name || item.package || item.pkg || item.npm;
    if (!name) continue;
    const d = item.description;
    const zhDesc = (d && typeof d === 'object' ? d.zh || d['zh-CN'] || d.en : typeof d === 'string' ? d : '') || '';
    const zhTitle = item.title || item.displayName || item.name;
    const entry = { zhTitle: String(zhTitle || name).trim(), zhDesc: String(zhDesc).trim() };
    map.set(name, entry);
    // 目录里 npm 名和 name 可能不同, 两个键都登记
    if (item.npm && item.npm !== name) map.set(item.npm, entry);
  }
  INDEX_CACHE = { key, map };
  return map;
}

/** 一条插件记录 -> 看得懂的信息 */
export function humanizePlugin(p, idx, tableIn) {
  const table = tableIn || loadLabels();
  const row = table[p.name];
  const reg = row && row.zh ? row.zh : null;
  const cat = (idx && idx.get(p.name)) || null;

  // --- 中文名 ---
  let title = (p.title || '').trim();
  let titleFrom = 'plugin';
  if (!hasZh(title) || title === p.name) {
    if (reg && hasZh(reg.title)) { title = reg.title.trim(); titleFrom = 'labels'; }
    else if (cat && hasZh(cat.zhTitle)) { title = cat.zhTitle.trim(); titleFrom = 'catalog'; }
    else { title = (p.title || p.name || '').trim(); titleFrom = 'raw'; }
  }

  // --- 中文说明 ---
  let desc = (p.description || '').trim();
  let descFrom = desc ? 'plugin' : 'none';
  if (!hasZh(desc)) {
    if (reg && hasZh(reg.description)) { desc = reg.description.trim(); descFrom = 'labels'; }
    else if (cat && hasZh(cat.zhDesc)) { desc = cat.zhDesc; descFrom = 'catalog'; }
    else if (desc) descFrom = 'english';
  }

  // --- 怎么用 (从插件 README 抽出来的那一段, 存在登记表里) ---
  const usage = reg && reg.usage ? String(reg.usage).trim() : '';
  const usageMeta = (row && row.usageMeta) || {};

  const descLang = desc ? (hasZh(desc) ? 'zh' : 'en') : 'none';
  const titleLang = hasZh(title) ? 'zh' : 'en';

  return {
    title,
    titleFrom,
    titleLang,
    description: desc,
    descriptionFrom: descFrom,
    descriptionLang: descLang,
    usage,
    usageFrom: usage ? 'readme' : 'none',
    usageHeading: usageMeta.heading || null,
    usageAt: usageMeta.at || null,
    usageVersion: usageMeta.version || null,
    // 前端可以直接拿来标"要补中文"
    needsZh: titleLang !== 'zh' || descLang === 'en' || descLang === 'none',
    // 英文原名留着, 想对照原文时用
    rawTitle: p.title || null,
    rawDescription: p.description || null,
  };
}

/** 批量 */
export function humanizeList(plugins) {
  const idx = catIndex();
  const table = loadLabels();
  const out = [];
  const seen = new Set();
  for (const p of plugins || []) {
    if (!p || !p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(Object.assign({}, humanizePlugin(p, idx, table), { name: p.name }));
  }
  return out;
}

/** 缺中文的清单, 给 CLI label audit 用 (宿主自带包不算, 那些没有面向用户的说明) */
export function auditNames(plugins) {
  const list = (plugins || []).filter((p) => p && !p.hostProvided);
  const rows = humanizeList(list).filter((r) => r.needsZh);
  return {
    total: list.length,
    missing: rows.length,
    rows: rows.map((r) => ({
      name: r.name,
      title: r.title,
      titleLang: r.titleLang,
      descriptionLang: r.descriptionLang,
      hint: r.titleLang !== 'zh' ? '缺中文名' : '缺中文说明',
    })),
  };
}
