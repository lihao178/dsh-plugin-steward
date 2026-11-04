// releases.mjs - GitHub Releases 版本源
//
// 为什么需要它: check 原来只看 npm registry 的 dist-tags.latest。
// 凡是 "dsh plugin add github:owner/repo" 装进来的插件, 永远不会出现在更新列表里
// —— 因为这类包根本没发 npm, 版本号只存在于 GitHub Releases / git tag 上。
// 本文件和 registry.mjs 对称: 一个查 npm, 一个查 GitHub, 都带磁盘缓存。
//
// 约定: 只有 tag 名是 SemVer 的 release 才参与版本比较 (v1.4.3 / 1.4.3 都认),
// 其它 tag (nightly, latest, build-20260101) 一律跳过, 不猜。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './util.mjs';

export const GH_CACHE_FILE = path.join(STATE_DIR, 'github-cache.json');
export const GH_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
// 没 token 时匿名每分钟只有 60 次, 所以默认 6 小时缓存; 有 token 也照样缓存。
const API = 'https://api.github.com';

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT || '';
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(GH_CACHE_FILE, 'utf8'));
    if (j && j.entries) return j;
  } catch (e) { /* 没有缓存 */ }
  return { schema: 1, entries: {} };
}
function save(c) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(GH_CACHE_FILE, JSON.stringify(c), 'utf8');
  } catch (e) { /* 忽略 */ }
}

export function githubCacheInfo() {
  const c = load();
  const names = Object.keys(c.entries);
  let newest = 0;
  for (const n of names) newest = Math.max(newest, c.entries[n].fetchedAt || 0);
  return { count: names.length, file: GH_CACHE_FILE, newest, token: !!token() };
}

/** 从各种写法的 spec 里认出 "哪个 GitHub 仓库" 与 "锁没锁死版本" */
export function githubSource(spec, name) {
  const s = String(spec || '').trim();
  const out = { repo: null, tag: null, pinned: false, kind: null };
  // github:owner/repo#tag   /  github:owner/repo
  let m = /^github:([^/#\s]+)\/([^/#\s]+?)(?:#(.+))?$/.exec(s);
  if (m) { out.repo = m[1] + '/' + m[2]; out.tag = m[3] || null; out.pinned = !!m[3]; out.kind = 'github-shortcut'; return out.repo ? out : { repo: null }; }
  // https://github.com/owner/repo(.git)(#tag|/tree/tag)
  m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:\/(?:tree|releases\/tag)\/([^/\s]+))?(?:#(.+))?\/?$/.exec(s);
  if (m) { out.repo = m[1] + '/' + m[2]; out.tag = m[4] || m[3] || null; out.pinned = !!out.tag; out.kind = 'github-url'; return out; }
  // git+https://github.com/owner/repo.git
  m = /^git\+https:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#(.+))?$/.exec(s);
  if (m) { out.repo = m[1] + '/' + m[2]; out.tag = m[3] || null; out.pinned = !!m[3]; out.kind = 'git-url'; return out; }
  // github 简写 owner/repo (pnpm 也认)
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (m && !/^(link|file|workspace|portal):/.test(s)) { out.repo = m[1] + '/' + m[2]; out.kind = 'shorthand'; return out; }
  // 作用域包名不代表 GitHub 仓库, 只能靠 package.json 的 repository 字段
  void name;
  return out;
}

/** 统一成可以比较的裸版本: v1.4.3 -> 1.4.3, 其它返回 null */
export function tagVersion(tag) {
  if (!tag) return null;
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(String(tag).trim());
  return m ? m[1] : null;
}

async function ghJson(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-steward', 'x-github-api-version': '2022-11-28' };
  const t = token();
  if (t) h.authorization = 'Bearer ' + t;
  try {
    const res = await fetch(url, { headers: h, signal: ac.signal });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!res.ok) {
      const msg = (j && j.message) || text.slice(0, 120) || ('HTTP ' + res.status);
      const err = new Error('HTTP ' + res.status + ': ' + msg);
      err.status = res.status;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查一个 GitHub 仓库的最新 release 版本.
 * 返回 {repo, tag, version, publishedAt, assets[], htmlUrl, fromCache, error}
 * 注意: 只回 release, 不回 commit 级快照 —— 那种没法比版本。
 */
export async function fetchLatestRelease(repo, opts) {
  const o = opts || {};
  const cache = load();
  const key = String(repo).toLowerCase();
  const hit = cache.entries[key];
  const now = Date.now();
  if (!o.refresh && hit && hit.fetchedAt && (now - hit.fetchedAt) < (o.maxAgeMs || GH_DEFAULT_TTL_MS)) {
    return Object.assign({}, hit, { fromCache: true });
  }
  let out = null;
  let lastErr = null;
  // 先试 /releases/latest (带 draft/prerelease 过滤), 失败再退回 /releases 列表自己挑
  const attempts = [
    API + '/repos/' + repo + '/releases/latest',
    API + '/repos/' + repo + '/releases?per_page=30',
  ];
  for (const url of attempts) {
    try {
      const j = await ghJson(url, o.timeoutMs);
      const list = Array.isArray(j) ? j : [j];
      for (const rel of list) {
        if (!rel || rel.draft) continue;
        const v = tagVersion(rel.tag_name);
        if (!v) continue;
        out = {
          repo,
          tag: rel.tag_name,
          version: v,
          name: rel.name || rel.tag_name,
          prerelease: !!rel.prerelease,
          publishedAt: rel.published_at || null,
          htmlUrl: rel.html_url || null,
          tarballUrl: rel.tarball_url || null,
          zipballUrl: rel.zipball_url || null,
          assets: (rel.assets || []).map((a) => ({
            name: a.name, size: a.size, url: a.browser_download_url, downloads: a.download_count,
          })),
          fetchedAt: now,
        };
        break;
      }
      if (out) break;
    } catch (e) {
      lastErr = e;
      // 404 = 仓库不存在或没有 release; 403/429 = 限流, 都不必再试第二种写法
      if (e.status === 404) break;
    }
  }
  if (!out) {
    const msg = lastErr ? String(lastErr.message || lastErr) : '没有 SemVer 形式的 release';
    if (hit) return Object.assign({}, hit, { fromCache: true, stale: true, error: msg });
    return { repo, version: null, tag: null, error: msg, fromCache: false };
  }
  cache.entries[key] = out;
  save(cache);
  return Object.assign({}, out, { fromCache: false, error: null });
}

/** 判断一个已装插件该不该走 GitHub 更新源, 返回 repo 或 null */
export function repoOf(p, pkgJson) {
  const fromSpec = githubSource(p && p.spec, p && p.name);
  if (fromSpec.repo) return fromSpec.repo;
  const r = pkgJson && pkgJson.repository;
  const url = typeof r === 'string' ? r : (r && r.url) || '';
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:[/#].*)?$/.exec(String(url));
  if (m) return m[1] + '/' + m[2];
  return null;
}
