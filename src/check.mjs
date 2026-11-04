// 更新检查: 市场最新版本 + 兼容性判定 + 每个插件的更新策略
import fs from 'node:fs';
import path from 'node:path';
import { scanProfile } from './scan.mjs';
import { fetchPackument, mapLimit } from './registry.mjs';
import { fetchLatestRelease, githubSource } from './releases.mjs';
import { satisfies, satisfiesBoth, compare, parse, gt, eq, isPre } from './semver.mjs';
import { hostVersions } from './host.mjs';

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

export function loadMarketIndex(root) {
  const j = readJsonSafe(path.join(root, '.dsh-market', 'discovery-compatibility-v1.json'));
  return (j && j.entries) || {};
}
export function loadPolicy(root) {
  return readJsonSafe(path.join(root, 'stardustlc-plugin-updates.json'));
}

function rangeVerdict(have, range) {
  const b = satisfiesBoth(have, range);
  if (b.strict) return 'ok';
  if (b.lenient) return 'gate';
  return 'fail';
}

/** 判定某个候选版本相对宿主是否兼容; ok=false 表示宿主会拒装 */
export function evalCompat(req, hostVersion, hostPkgs) {
  const reasons = [];
  const notes = [];
  let ok = true;
  let unknown = false;
  let prereleaseGate = false;
  const engines = req && req.engines;
  if (engines) {
    const e = engines.dsh || engines.dshVersion || engines['dsh-version'] || engines.dshFramework;
    if (e) {
      if (!hostVersion) { unknown = true; reasons.push('宿主版本未知, 无法校验 engines.dsh=' + e); }
      else {
        const vd = rangeVerdict(hostVersion, e);
        if (vd === 'fail') { ok = false; reasons.push('engines.dsh=' + e + ' 不接受宿主 ' + hostVersion); }
        else if (vd === 'gate') { prereleaseGate = true; notes.push('engines.dsh=' + e + ': 严格 pre 门控不满足宿主 ' + hostVersion + ', 宽松语义通过'); }
      }
    }
  }
  const rel = req && req.dsh && req.dsh.compatibility && req.dsh.compatibility.dshReleases;
  if (rel && typeof rel === 'object') {
    const keys = Object.keys(rel);
    if (hostVersion && keys.indexOf(hostVersion) >= 0) {
      const v = String(rel[hostVersion]).toLowerCase();
      if (v.indexOf('compat') < 0 && v.indexOf('ok') < 0) { ok = false; reasons.push('dshReleases[' + hostVersion + ']=' + rel[hostVersion]); }
    } else if (keys.length) {
      unknown = true;
      reasons.push('dshReleases 未声明 ' + hostVersion + ' (只声明了 ' + keys.join('/') + ')');
    }
  }
  const peers = req && req.peerDependencies;
  if (peers) {
    for (const k of Object.keys(peers)) {
      if (k.indexOf('@deepseek-ai/') !== 0) continue;
      const have = hostPkgs ? hostPkgs[k] : null;
      const range = peers[k];
      if (!have) { unknown = true; reasons.push('peer ' + k + ' ' + range + ': 宿主 payload 里没有这个包'); continue; }
      const vd = rangeVerdict(have, range);
      if (vd === 'fail') { ok = false; reasons.push('peer ' + k + ' ' + range + ' 但宿主提供的是 ' + have); }
      else if (vd === 'gate') { prereleaseGate = true; notes.push('peer ' + k + ' ' + range + ': 严格 pre 门控不满足宿主 ' + have + ', 宽松语义通过'); }
    }
  }
  return { ok, unknown, reasons, notes, prereleaseGate };
}

export function bumpKind(cur, next) {
  const a = parse(cur), b = parse(next);
  if (!a || !b) return 'unknown';
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'prerelease';
}

export function pickTargets(pack, spec) {
  const versions = (pack && pack.versions) || [];
  const sorted = versions.filter((v) => parse(v)).slice().sort((a, b) => {
    const c = compare(a, b);
    return c === null ? 0 : c;
  });
  const stable = sorted.filter((v) => !isPre(v));
  const latest = (pack && pack.latest) || (stable.length ? stable[stable.length - 1] : (sorted.length ? sorted[sorted.length - 1] : null));
  const s = String(spec || '').trim();
  let wanted = null;
  if (s && /[\^~><*xX ]/.test(s) && !/^(link|file|workspace|portal):/.test(s)) {
    const cands = sorted.filter((v) => satisfies(v, s) === true);
    wanted = cands.length ? cands[cands.length - 1] : null;
  }
  return { latest, latestStable: stable.length ? stable[stable.length - 1] : null, wanted, total: sorted.length };
}

/** 这个包的 package.json 里写了 GitHub 仓库地址吗 (用于给人看的说明, 不参与更新判定) */
export function pkgHasRepository(p) {
  const r = (p && p.repository) || null;
  const url = typeof r === 'string' ? r : (r && r.url) || '';
  return /github\.com[/:]/.test(String(url));
}

/** git tag 版本比 npm 上的高吗? 用来判断该不该顺手问一次 GitHub */
function flatter(installed, packLatest) {
  const c = compare(packLatest, installed);
  return c === null ? false : c <= 0;
}

/**
 * 走 GitHub Releases 版本源.
 * 命中并确实有新版本时把 row 填好并返回 true; 与 npm 一致或查不到时返回 false,
 * 让调用方继续走 npm 的逻辑。
 */
async function tryGithubRow(row, p, o, packLatest) {
  const info = githubSource(p.spec, p.name);
  if (!info.repo) return false;
  const rel = await fetchLatestRelease(info.repo, { refresh: o.refreshGithub, maxAgeMs: o.githubMaxAgeMs, timeoutMs: o.timeoutMs });
  row.github = { repo: info.repo, tag: rel.tag || null, error: rel.error || null };
  if (!rel.version) return false;
  row.githubVersion = rel.version;
  row.githubPublishedAt = rel.publishedAt || null;
  // 装的时候锁了 tag (github:owner/repo#v1.2.0) 就只看这个 tag, 别自作主张跳版本
  if (info.pinned) {
    row.reason = '装的时候锁定了 ' + info.tag + ', 不自动跳版本';
    row.skipped = 'pinned-git';
    return true;
  }
  if (packLatest && !(gt(rel.version, packLatest))) return false;
  if (p.version && !gt(rel.version, p.version)) return false;
  row.versionSource = 'github';
  row.latest = rel.version;
  row.latestStable = rel.version;
  row.wanted = null;
  row.target = rel.version;
  row.updatable = true;
  row.kind = bumpKind(p.version, rel.version);
  row.pinned = false;
  row.reason = '可升级 ' + p.version + ' 到 ' + rel.version + ' (来源 GitHub Releases, 不是 npm)';
  row.githubTarball = rel.tarballUrl || null;
  return true;
}

export async function checkProfile(profile, opts) {
  const o = opts || {};
  const s = scanProfile(profile, { orphans: false });
  const hv = hostVersions();
  const hostPkgs = hv.versions || {};
  // scan 里的 host 就是 hostVersions() 的返回值, 它没有 version 键 ——
  // 宿主版本要从包映射里取 (@deepseek-ai/dsh 是宿主主包).
  const hostVersion = (s.host && s.host.version) || hostPkgs['@deepseek-ai/dsh'] || hostPkgs['@deepseek-ai/dsh-acp-app'] || null;
  const marketIdx = loadMarketIndex(s.root);
  const policyRoot = o.updates || loadPolicy(s.root);
  const targets = s.plugins.filter((p) => p.installed && p.origin !== 'missing');

  const rows = await mapLimit(targets, o.concurrency || 6, async (p) => {
    const policy = (policyRoot && policyRoot.packages && policyRoot.packages[p.name]) || null;
    const row = {
      name: p.name, title: p.title, origin: p.origin, source: p.source, installed: p.installed,
      current: p.version, spec: p.spec, policy, repository: p.repository || null,
      versionSource: 'npm', github: null, githubVersion: null, githubPublishedAt: null,
      autoInstall: !!(policy && policy.autoInstall === true),
      ignored: false, deferred: false, updatable: false, kind: 'none', reason: '', skipped: null,
      compat: { ok: true, unknown: false, reasons: [], notes: [], prereleaseGate: false },
      latest: null, latestStable: null, wanted: null, target: null,
      checkedAt: new Date().toISOString(),
    };
    if (p.source === 'link' || p.source === 'local' || p.source === 'file') {
      row.skipped = 'local';
      row.reason = '本地/自创包 (' + p.source + '), 由你自己的仓库维护, 不查市场';
      return row;
    }
    if (p.origin === 'builtin') {
      row.compat = evalCompat({}, hostVersion, hostPkgs);
      if (hostVersion && p.version && eq(p.version, hostVersion) === false) {
        row.updatable = true;
        row.target = hostVersion;
        row.kind = bumpKind(p.version, hostVersion);
        row.alignToHost = true;
        row.reason = '官方内置包 ' + p.version + ' 与宿主 ' + hostVersion + ' 不一致, 应跟随宿主';
      } else {
        row.reason = '官方内置包, 跟随宿主 ' + (hostVersion || '?');
      }
      return row;
    }
    const pack = await fetchPackument(p.name, { refresh: o.refresh, maxAgeMs: o.maxAgeMs, timeoutMs: o.timeoutMs });
    if ((!pack.versions || !pack.versions.length) && pack.error) {
      // npm 上根本没有这个包 —— 它是从 GitHub 直接装的, 换 GitHub Releases 再问一次
      const gh = await tryGithubRow(row, p, o);
      if (gh) return row;
      row.skipped = 'offline';
      row.reason = 'registry 查询失败: ' + pack.error;
      return row;
    }
    // npm 上的版本追不上 git tag 时 (作者发了 release 忘了发 npm), 也拿去比一次。
    // 注意只认 spec 里明写的 GitHub 来源 —— package.json 里的 repository 字段
    // 对 npm 包来说只是"源码在这", 不代表"更新要从这里来", 否则会把 npm 版本盖掉。
    const specInfo = githubSource(p.spec, p.name);
    const packLatest = (pack.distTags && pack.distTags.latest) || pack.latest || null;
    if (specInfo.repo && (!packLatest || (p.version && flatter(p.version, packLatest)))) {
      const gh = await tryGithubRow(row, p, o, packLatest);
      if (gh) return row;
    }
    const t = pickTargets(pack, p.spec);
    row.latest = t.latest;
    row.latestStable = t.latestStable;
    row.wanted = t.wanted;
    row.versionCount = t.total;
    let target = null;
    if (t.wanted && (!p.version || gt(t.wanted, p.version))) target = t.wanted;
    else if (t.latest && (!p.version || gt(t.latest, p.version))) target = t.latest;
    row.target = target;
    const meta = (pack.meta && (pack.meta[target] || pack.meta[t.latest])) || null;
    const facts = marketIdx[p.name] && marketIdx[p.name].facts ? marketIdx[p.name].facts : null;
    row.compat = evalCompat({
      engines: (meta && meta.engines) || (facts && facts.enginesDsh ? { dsh: facts.enginesDsh } : null),
      dsh: meta && meta.dsh ? meta.dsh : null,
      peerDependencies: (meta && meta.peerDependencies) || (facts && facts.peerDependencies) || null,
    }, hostVersion, hostPkgs);
    if ((meta && meta.deprecated) || (facts && facts.deprecated)) row.deprecated = (meta && meta.deprecated) || (facts && facts.deprecated);
    if (policy && policy.checkEnabled === false) { row.skipped = 'policy-off'; row.reason = '策略已关闭检查 (checkEnabled=false)'; return row; }
    if (policy && policy.ignoredVersion && target && eq(policy.ignoredVersion, target)) { row.ignored = true; row.reason = '策略里已忽略 ' + target; return row; }
    if (policy && policy.deferredUntil) {
      const ms = Date.parse(policy.deferredUntil);
      if (isFinite(ms) && ms > Date.now()) { row.deferred = true; row.reason = '推迟到 ' + policy.deferredUntil; return row; }
    }
    if (!target) { row.reason = p.version ? '已是最新 ' + p.version : '本地版本未知'; return row; }
    row.updatable = true;
    row.kind = bumpKind(p.version, target);
    const pinned = !/[\^~><*xX ]/.test(String(p.spec || ''));
    row.pinned = pinned;
    row.reason = (pinned ? '精确锁定 ' + p.spec + ', 需手动决定' : '可升级 ' + p.version + ' 到 ' + target);
    return row;
  });

  const summary = { checked: rows.length, updatable: 0, major: 0, minor: 0, patch: 0, prerelease: 0, blockedCompat: 0, ignored: 0, deferred: 0, offline: 0, alignToHost: 0, local: 0 };
  for (const r of rows) {
    if (r.skipped === 'local') summary.local++;
    if (r.skipped === 'offline') summary.offline++;
    if (r.updatable) {
      summary.updatable++;
      if (summary[r.kind] !== undefined) summary[r.kind]++;
      if (r.compat && r.compat.ok === false) summary.blockedCompat++;
      if (r.alignToHost) summary.alignToHost++;
    }
    if (r.ignored) summary.ignored++;
    if (r.deferred) summary.deferred++;
  }
  return { profile, root: s.root, hostVersion, hostPayloadFound: hv.found, scan: s, rows, summary, checkedAt: new Date().toISOString() };
}

export async function checkAll(opts) {
  const { listProfiles } = await import('./util.mjs');
  const out = [];
  for (const p of listProfiles()) out.push(await checkProfile(p, opts));
  return out;
}