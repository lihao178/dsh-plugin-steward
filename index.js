/**
 * Host half of the plugin steward (@local/dsh-plugin-manager).
 *
 * Registers /api/dsh-plugin-manager/* on the host web server and drives the
 * same modules the CLI (bin/dsh-pm.mjs) uses, so the panel and the terminal
 * always agree. The browser half (./client) renders the left-panel UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { profileDir, STATE_DIR, ensureDir } from './src/util.mjs';
import { scanProfile, ORIGIN_LABEL } from './src/scan.mjs';
import { checkProfile, evalCompat } from './src/check.mjs';
import { doctorProfile } from './src/doctor.mjs';
import { dupeReport } from './src/dupes.mjs';
import { cleanPlan, cleanApply } from './src/clean.mjs';
import { fixPlan, fixApply } from './src/fix.mjs';
import { updatePlan, updateApply } from './src/apply.mjs';
import { createSnapshot, listSnapshots, restoreSnapshot } from './src/snapshot.mjs';
import { setLabel, loadLabels, applyLabel } from './src/labels.mjs';
import { humanizeList, auditNames, humanizePlugin, catIndex, hasZh } from './src/humanize.mjs';
import { readPatchState, setDisabledText, writePatchText } from './src/patch.mjs';
import { scheduleStatus } from './src/schedule.mjs';
import { autoRun, readAutoConfig, writeAutoConfig, readAutoLog } from './src/auto.mjs';
import { auditProfile, auditPackageVersion, auditInstalled, cacheInfo as safetyCacheInfo, clearCache as clearSafetyCache } from './src/safety.mjs';
import { loadCatalog, filterCatalog, sortCatalog, categories as catalogCategories, resolveCandidate } from './src/market.mjs';
import { hostVersions } from './src/host.mjs';
import { runPnpm, pnpmDiagnose, readInstalled } from './src/apply.mjs';
import { restartSelf, launchInfo } from './src/restart.mjs';

// pnpm 找不到 (或者跑了但失败) 时, 把「试过哪些路径」一并返回给面板, 免得只看到一句 ENOENT
function pnpmHint(r) {
  const d = pnpmDiagnose();
  return {
    bin: (r && r.bin) || d.chosen,
    exists: d.chosenExists,
    env: d.env,
    execPath: d.execPath,
    candidates: d.candidates.filter((c) => c.exists).map((c) => c.path),
    tried: d.candidates.map((c) => (c.exists ? '✓ ' : '✗ ') + c.path),
    advice: d.chosenExists
      ? 'pnpm 路径正确定位到了, 失败原因看 stderr / log'
      : '找不到 pnpm. 设置环境变量 DSH_PM_PNPM 指向 pnpm 的 bin/pnpm.mjs 后重启软件即可',
  };
}

// 宿主进程的「出生证明」: 面板用它判断重启是否真的发生过 (pid 变了才算)
const STARTED_AT = Date.now();

// 本次加载的代码版本 —— 面板可以在重启后对比, 确认新代码真的到位了
function buildInfo() {
  const out = { module: 'index.js' };
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    out.version = pkg.version || null;
    out.name = pkg.name || null;
  } catch (error) {
    out.version = null;
  }
  for (const f of ['index.js', 'client.js', 'src/apply.mjs', 'src/restart.mjs']) {
    try {
      const st = fs.statSync(new URL('./' + f, import.meta.url));
      out[f] = Math.round(st.mtimeMs);
    } catch (error) {
      out[f] = null;
    }
  }
  return out;
}
const BUILD_INFO = buildInfo();

/** Stable cordis plugin name. */
export const name = 'plugin-manager';

/** Services required before the routes can mount. */
export const inject = ['webServer'];

/** Route paths. The browser half mirrors these literals. */
export const ROUTES = {
  overview: '/api/dsh-plugin-manager/overview',
  check: '/api/dsh-plugin-manager/check',
  update: '/api/dsh-plugin-manager/update',
  doctor: '/api/dsh-plugin-manager/doctor',
  fix: '/api/dsh-plugin-manager/fix',
  dupes: '/api/dsh-plugin-manager/dupes',
  clean: '/api/dsh-plugin-manager/clean',
  toggle: '/api/dsh-plugin-manager/toggle',
  policy: '/api/dsh-plugin-manager/policy',
  policyBulk: '/api/dsh-plugin-manager/policy-bulk',
  label: '/api/dsh-plugin-manager/label',
  snapshots: '/api/dsh-plugin-manager/snapshots',
  auto: '/api/dsh-plugin-manager/auto',
  safety: '/api/dsh-plugin-manager/safety',
  market: '/api/dsh-plugin-manager/market',
  install: '/api/dsh-plugin-manager/install',
  names: '/api/dsh-plugin-manager/names',
  restart: '/api/dsh-plugin-manager/restart',
  settings: '/api/dsh-plugin-manager/settings',
};

/**
 * 插件管家自己的开关. 存在插件目录下, 不跟 profile 混.
 *   showInSidebar: 是否在左侧边栏出现「插件管家」图标. 默认 false ——
 *   面板已经从「插件市场」页的标签行进去了, 侧边栏再占一格是重复的.
 */
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const SETTINGS_DEFAULTS = { showInSidebar: false };

export function readSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch (error) {
    saved = {};
  }
  return Object.assign({}, SETTINGS_DEFAULTS, saved, {
    defaults: Object.assign({}, SETTINGS_DEFAULTS),
  });
}

function writeSettings(patch) {
  const next = Object.assign({}, SETTINGS_DEFAULTS, readSettings(), patch || {});
  delete next.defaults;
  ensureDir(path.dirname(SETTINGS_FILE));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return Object.assign({}, next, { defaults: Object.assign({}, SETTINGS_DEFAULTS) });
}

/** Policy file the market's own updater reads (per-plugin update switches). */
const POLICY_FILE = 'stardustlc-plugin-updates.json';

function policyPath(root) {
  return path.join(root, POLICY_FILE);
}

/** Read the per-plugin update policy; a broken file degrades to an empty map. */
function readPolicy(root) {
  try {
    const obj = JSON.parse(fs.readFileSync(policyPath(root), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (error) {
    return {};
  }
}

function writePolicy(root, obj) {
  obj.revision = (Number(obj.revision) || 0) + 1;
  fs.writeFileSync(policyPath(root), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * Trust fence. The panel only ever runs on this machine, so refuse anything
 * that reached us through a proxy and anything that is not a loopback socket.
 */
function allowed(req) {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  if (req.headers['cf-connecting-ip'] !== undefined) return false;
  const addr = req.socket && req.socket.remoteAddress;
  if (typeof addr !== 'string') return false;
  if (addr === '127.0.0.1' || addr === '::1') return true;
  if (addr.indexOf('::ffff:127.') === 0) return true;
  return false;
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1048576) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function query(url, key) {
  const value = url.searchParams.get(key);
  return value === null ? undefined : value;
}

/**
 * Build every route. Exported so a plain node process can exercise the
 * handlers without the host (tests call handler() with fake req/res).
 */
export function makeRoutes(ctx, config) {
  const logger = ctx && ctx.logger ? ctx.logger : null;
  const warn = (error) => {
    if (logger && typeof logger.warn === 'function') logger.warn(error);
  };
  const defaultProfile = config && config.profile ? config.profile : 'desktop';
  const profileOf = (url, body) => {
    const fromUrl = url ? query(url, 'profile') : undefined;
    const fromBody = body && typeof body.profile === 'string' ? body.profile : undefined;
    return fromBody || fromUrl || defaultProfile;
  };

  const routes = [
    {
      kind: 'exact',
      path: ROUTES.overview,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const scan = scanProfile(profile, { noSize: true });
          const root = scan.root || profileDir(profile);
          const policy = readPolicy(root);
          const packages = policy.packages && typeof policy.packages === 'object' ? policy.packages : {};
          const groups = [];
          const seenGroup = new Set();
          for (const p of scan.plugins) {
            const key = p.capabilities.primary;
            if (!key || seenGroup.has(key)) continue;
            seenGroup.add(key);
            groups.push({ key, label: p.capabilities.primaryLabel || key });
          }
          let schedule = null;
          try {
            schedule = scheduleStatus();
          } catch (error) {
            schedule = null;
          }
          return writeJson(res, 200, {
            profile,
            root,
            // pid / startedAt: 面板靠它判断"真的重启过了"(旧进程在退出前也能应答, 只看能不能读是错的)
            pid: process.pid,
            startedAt: STARTED_AT,
            builds: BUILD_INFO,
            pnpm: pnpmDiagnose(),
            host: scan.host,
            hostPayloadCount: scan.hostPayloadCount,
            counts: scan.counts,
            orphans: scan.orphans,
            plugins: humanizeList(scan.plugins).map((h) => {
              const p = scan.plugins.find((x) => x.name === h.name) || {};
              return {
                name: p.name,
                title: h.title,
                titleEn: p.titleEn,
                titleLang: h.titleLang,
                titleFrom: h.titleFrom,
                description: h.description,
                descriptionLang: h.descriptionLang,
                descriptionFrom: h.descriptionFrom,
                rawTitle: h.rawTitle,
                rawDescription: h.rawDescription,
                needsZh: h.needsZh,
                version: p.version,
                spec: p.spec,
                origin: p.origin,
                originLabel: ORIGIN_LABEL[p.origin] || p.origin,
                source: p.source,
                installed: p.installed,
                disabled: p.disabled,
                hostProvided: p.hostProvided,
                group: p.capabilities.primary,
                groupLabel: p.capabilities.primaryLabel,
                groups: p.capabilities.labels,
                sizeBytes: p.sizeBytes,
                cordisIds: p.cordisIds,
                issues: p.issues,
                policy: packages[p.name] || null,
              };
            }),
            policy,
            schedule,
            groups,
            checkedAt: new Date().toISOString(),
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.check,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const refresh = query(url, 'refresh') === '1';
          const result = await checkProfile(profile, { refresh });
          return writeJson(res, 200, {
            profile: result.profile,
            hostVersion: result.hostVersion,
            rows: result.rows,
            summary: result.summary,
            checkedAt: result.checkedAt,
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.update,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const names = Array.isArray(body.names) ? body.names : [];
          const plan = await updatePlan(profile, { refresh: body.refresh === true, only: names });
          if (body.dryRun === true) return writeJson(res, 200, { dryRun: true, plan });
          const applied = updateApply(plan, { write: true, forceIncompatible: body.force === true, rollback: body.rollback !== false });
          return writeJson(res, 200, { dryRun: false, plan, applied });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.doctor,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const report = doctorProfile(profile);
          return writeJson(res, 200, {
            profile,
            summary: report.summary,
            findings: report.findings,
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.fix,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const plan = fixPlan(profile);
          if (body.dryRun === true) return writeJson(res, 200, { dryRun: true, plan });
          const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : undefined;
          const applied = fixApply(plan, { dryRun: false, only: kinds, snapshot: true });
          return writeJson(res, 200, { dryRun: false, plan, applied });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.dupes,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const report = dupeReport(profile);
          return writeJson(res, 200, {
            profile,
            summary: report.summary,
            findings: report.findings,
            capability: report.capability,
            inject: report.inject,
            biggest: report.biggest,
            multiVersion: report.multiVersion,
            split: report.split,
            similar: report.similar,
            cordis: report.cordis,
            totalBytes: report.totalBytes,
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.clean,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const profile = profileOf(null, body);
            const plan = cleanPlan(profile);
            const applied = cleanApply(plan, { dryRun: false, includeUnsafe: body.includeUnsafe === true });
            return writeJson(res, 200, { plan: { totalBytes: plan.totalBytes, safeBytes: plan.safeBytes, safeCount: plan.safeCount, unsafeCount: plan.unsafeCount }, applied });
          }
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const plan = cleanPlan(profile);
          return writeJson(res, 200, {
            profile,
            totalBytes: plan.totalBytes,
            safeBytes: plan.safeBytes,
            safeCount: plan.safeCount,
            unsafeCount: plan.unsafeCount,
            items: plan.items,
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.toggle,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const pluginName = typeof body.name === 'string' ? body.name : '';
          if (!pluginName) return writeJson(res, 400, { error: 'name required' });
          const scan = scanProfile(profile, { noSize: true });
          const plugin = scan.plugins.find((p) => p.name === pluginName);
          if (!plugin) return writeJson(res, 404, { error: 'plugin not found: ' + pluginName });
          const id = plugin.cordisIds && plugin.cordisIds.length ? plugin.cordisIds[0] : pluginName;
          const state = readPatchState(scan.root);
          const next = setDisabledText(state.text, id, body.disabled !== false);
          if (next === null) return writeJson(res, 409, { error: '在 cordis.patch.yml 里找不到 id: ' + id + ' (这个插件可能是通过 insert 挂载的)' });
          createSnapshot(profile, 'toggle ' + (body.disabled !== false ? 'disable' : 'enable') + ' ' + pluginName);
          writePatchText(scan.root, next);
          return writeJson(res, 200, { ok: true, id, disabled: body.disabled !== false });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.policy,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const pluginName = typeof body.name === 'string' ? body.name : '';
          if (!pluginName) return writeJson(res, 400, { error: 'name required' });
          const root = profileDir(profile);
          const obj = readPolicy(root);
          if (!obj.packages || typeof obj.packages !== 'object') obj.packages = {};
          const current = obj.packages[pluginName] && typeof obj.packages[pluginName] === 'object' ? obj.packages[pluginName] : {};
          const next = Object.assign({}, current);
          if (typeof body.checkEnabled === 'boolean') next.checkEnabled = body.checkEnabled;
          if (typeof body.autoInstall === 'boolean') next.autoInstall = body.autoInstall;
          if (typeof body.ignoredVersion === 'string' || body.ignoredVersion === null) next.ignoredVersion = body.ignoredVersion;
          obj.packages[pluginName] = next;
          writePolicy(root, obj);
          return writeJson(res, 200, { ok: true, policy: next });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.policyBulk,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const names = Array.isArray(body.names) ? body.names.map(String).filter(Boolean) : [];
          if (!names.length) return writeJson(res, 400, { error: 'names required (空数组 = 没有可改的插件)' });
          const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
          // 只认这三个键, 其余一律忽略 (面板只该改检查/自动安装/忽略版本)
          const clean = {};
          if (typeof patch.checkEnabled === 'boolean') clean.checkEnabled = patch.checkEnabled;
          if (typeof patch.autoInstall === 'boolean') clean.autoInstall = patch.autoInstall;
          if (typeof patch.ignoredVersion === 'string' || patch.ignoredVersion === null) clean.ignoredVersion = patch.ignoredVersion;
          if (!Object.keys(clean).length) return writeJson(res, 400, { error: 'patch 里没有任何可改字段' });
          const root = profileDir(profile);
          const obj = readPolicy(root);
          if (!obj.packages || typeof obj.packages !== 'object') obj.packages = {};
          for (const name of names) {
            const current = obj.packages[name] && typeof obj.packages[name] === 'object' ? obj.packages[name] : {};
            obj.packages[name] = Object.assign({}, current, clean);
          }
          writePolicy(root, obj);
          return writeJson(res, 200, { ok: true, changed: names.length, patch: clean });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.label,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const pluginName = typeof body.name === 'string' ? body.name : '';
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!pluginName || !title) return writeJson(res, 400, { error: 'name and title required' });
          setLabel(pluginName, title, typeof body.description === 'string' ? body.description : undefined);
          const scan = scanProfile(profile, { noSize: true });
          const plugin = scan.plugins.find((p) => p.name === pluginName);
          if (!plugin || !plugin.realPath) return writeJson(res, 404, { error: 'plugin not installed: ' + pluginName });
          const written = applyLabelTo(plugin, title);
          return writeJson(res, 200, { ok: true, written });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      // 「看得懂的信息」: 缺中文的插件清单 + 一键用市场目录补齐
      kind: 'exact',
      path: ROUTES.names,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const profile = profileOf(null, body);
            const action = typeof body.action === 'string' ? body.action : 'fill';
            if (action !== 'fill') return writeJson(res, 400, { error: 'unknown action: ' + action });
            const scan = scanProfile(profile, { noSize: true });
            const idx = catIndex();
            const table = loadLabels();
            const filled = [];
            const skipped = [];
            for (const p of scan.plugins) {
              const h = humanizePlugin(p, idx, table);
              if (!h.needsZh) continue;
              const cat = idx.get(p.name) || null;
              // 目录里的中文名/中文说明有一个能用就补一个, 两个都没有才跳过
              const zhTitle = cat && hasZh(cat.zhTitle) ? cat.zhTitle : null;
              const zhDesc = cat && hasZh(cat.zhDesc) ? cat.zhDesc : null;
              if (!zhTitle && !zhDesc) {
                skipped.push({ name: p.name, reason: '市场目录里也没有中文条目, 只能手工命名 (dsh-pm label set)' });
                continue;
              }
              try {
                setLabel(p.name, zhTitle || p.title || p.name, zhDesc || undefined);
                const written = p.realPath ? applyLabelTo(p, zhTitle || p.title || p.name, zhDesc || undefined) : null;
                filled.push({ name: p.name, title: zhTitle || p.title || p.name, desc: zhDesc, written });
              } catch (error) {
                skipped.push({ name: p.name, reason: error && error.message ? error.message : String(error) });
              }
            }
            return writeJson(res, 200, { ok: true, filled, skipped });
          }
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          const scan = scanProfile(profile, { noSize: true });
          const audit = auditNames(scan.plugins);
          return writeJson(res, 200, Object.assign({ ok: true, profile }, audit));
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.snapshots,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const profile = profileOf(null, body);
            const action = typeof body.action === 'string' ? body.action : 'create';
            if (action === 'restore') {
              if (!body.id) return writeJson(res, 400, { error: 'id required' });
              const result = restoreSnapshot(profile, body.id, { dryRun: body.dryRun === true });
              return writeJson(res, 200, result);
            }
            const meta = createSnapshot(profile, 'panel');
            return writeJson(res, 200, { ok: true, meta });
          }
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          return writeJson(res, 200, { profile, snapshots: listSnapshots(profile) });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.auto,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            const profile = profileOf(null, body);
            const action = typeof body.action === 'string' ? body.action : 'run';
            if (action === 'on' || action === 'off') {
              const config = writeAutoConfig({ enabled: action === 'on' });
              return writeJson(res, 200, { ok: true, config });
            }
            if (action === 'skip' || action === 'unskip') {
              if (!body.name) return writeJson(res, 400, { error: 'name required' });
              const current = readAutoConfig();
              const skip = current.skip.filter((s) => String(s).toLowerCase() !== String(body.name).toLowerCase());
              if (action === 'skip') skip.push(String(body.name));
              const config = writeAutoConfig({ skip });
              return writeJson(res, 200, { ok: true, config });
            }
            const result = await autoRun(profile, { write: body.write === true, refresh: body.refresh !== false });
            return writeJson(res, 200, result);
          }
          const url = new URL(req.url || '/', 'http://x');
          const profile = profileOf(url, null);
          return writeJson(res, 200, {
            profile,
            config: readAutoConfig(),
            log: readAutoLog(10),
            schedule: scheduleStatus(),
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      /**
       * 安全检查. 只是把风险摆出来, 不做拦截 —— 拦截策略由调用方(面板/用户)决定.
       *   GET  ?mode=profile            -> 已装插件全扫(本地, 不联网, 快)
       *   GET  ?mode=installed&name=X   -> 单个已装插件
       *   GET  ?mode=package&name=X&version=Y -> 下载 tarball 静态扫描(慢, 有缓存)
       *   POST {action:'clear-cache'}   -> 清扫描缓存
       */
      kind: 'exact',
      path: ROUTES.safety,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          if (req.method === 'POST') {
            const body = await readBody(req);
            if (body.action === 'clear-cache') return writeJson(res, 200, { ok: true, cleared: clearSafetyCache() });
            return writeJson(res, 400, { error: 'unknown action' });
          }
          const mode = query(url, 'mode') || 'profile';
          const profile = profileOf(url, null);
          if (mode === 'installed') {
            const name = query(url, 'name');
            if (!name) return writeJson(res, 400, { error: 'name required' });
            const r = auditInstalled(profile, name);
            return writeJson(res, 200, r);
          }
          if (mode === 'package') {
            const name = query(url, 'name');
            const version = query(url, 'version');
            if (!name) return writeJson(res, 400, { error: 'name required' });
            const r = await auditPackageVersion(name, version || 'latest', { refresh: query(url, 'refresh') === '1' });
            return writeJson(res, 200, r);
          }
          const only = query(url, 'only');
          const r = await auditProfile(profile, { only: only ? only.split(',') : null });
          return writeJson(res, 200, Object.assign({ cache: safetyCacheInfo() }, r));
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      /**
       * 插件市场目录(读 dsh-plugin-catalog 包里的 plugins.json).
       *   GET ?q=&category=&limit=&refresh=1   -> 过滤后的列表
       *   GET ?resolve=包名                   -> 解析出 latest/版本数/tarball
       */
      kind: 'exact',
      path: ROUTES.market,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://x');
          const resolveName = query(url, 'resolve');
          if (resolveName) {
            const r = await resolveCandidate({ npm: resolveName, title: resolveName });
            // 兼容性: 用和 check 完全相同的判定 (engines.dsh / dshReleases / @deepseek-ai peer)
            try {
              const hv = hostVersions();
              // hostVersions() 返回 { found, fromCache, versions }; versions 是「包名 -> 版本」
              // 的映射(宿主 payload 里五百多个包), 宿主自己的版本也得从里面取.
              const hostPkgs = (hv && hv.versions) || null;
              const hostVersion = (hostPkgs && (hostPkgs['@deepseek-ai/dsh'] || hostPkgs['@deepseek-ai/dsh-acp-app'])) || null;
              const compat = evalCompat(r.req || {}, hostVersion, hostPkgs);
              r.compat = Object.assign({ hostVersion }, compat);
            } catch (e) {
              r.compat = { hostVersion: null, ok: null, unknown: true, reasons: ['宿主版本读不到: ' + String((e && e.message) || e)], notes: [] };
            }
            return writeJson(res, 200, r);
          }
          const cat = await loadCatalog({ refresh: query(url, 'refresh') === '1' });
          if (!cat.ok) return writeJson(res, 502, { error: cat.error, count: 0, plugins: [] });
          const excludeCaps = query(url, 'nocreds') === '1' ? ['credentials', 'dynamic-code'] : null;
          let list = filterCatalog(cat.plugins, {
            q: query(url, 'q'),
            category: query(url, 'category'),
            excludeCaps,
          });
          list = sortCatalog(list, query(url, 'sort'));
          const total = list.length;
          const limit = Math.min(Number(query(url, 'limit')) || 60, 2000);
          list = list.slice(0, limit);
          const scan = scanProfile(profileOf(url, null), { noSize: true });
          const installed = new Map();
          for (const p of scan.plugins) installed.set(String(p.name).toLowerCase(), { version: p.version, installed: p.installed });
          return writeJson(res, 200, {
            ok: true, source: cat.source, catalogVersion: cat.version, at: cat.at,
            fromCache: !!cat.fromCache, stale: !!cat.stale,
            total, returned: list.length,
            categories: catalogCategories(cat.plugins),
            plugins: list.map((p) => Object.assign({}, p, {
              raw: undefined,
              installed: installed.get(String(p.npm || '').toLowerCase()) || null,
            })),
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      /**
       * 安装/卸载插件. 装的是市场目录里的 npm 包, 走同一套 apply.runPnpm.
       * 安全检查不在这里拦截 —— 面板会在装之前先调 ROUTES.safety 并把报告给用户看,
       * 用户点了「继续安装」才回到这里.
       *   POST { action:'install', name, version?, spec? }
       *   POST { action:'uninstall', name }
       */
      kind: 'exact',
      path: ROUTES.install,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const profile = profileOf(null, body);
          const root = profileDir(profile);
          const name = body.name ? String(body.name) : '';
          if (!name) return writeJson(res, 400, { error: 'name required' });
          const action = body.action || 'install';
          if (action === 'uninstall') {
            if (body.dryRun === true) return writeJson(res, 200, { dryRun: true, argv: ['pnpm', 'remove', name].join(' ') });
            const snapshot = createSnapshot(profile, '卸载 ' + name + ' 前自动备份');
            const r = runPnpm(root, ['remove', name], { timeoutMs: body.timeoutMs });
            return writeJson(res, 200, { ok: r.ok, status: r.status, log: r.log, snapshot: snapshot.id, stderr: (r.stderr || '').slice(-600), pnpm: r.ok ? undefined : pnpmHint(r) });
          }
          // 组装安装规格: 显式 spec > name@version > name@latest
          let spec = body.spec ? String(body.spec) : null;
          if (!spec) {
            const cand = await resolveCandidate({ npm: name, title: name });
            if (cand.error || !cand.installSpec) {
              return writeJson(res, 502, { error: '解析不到版本: ' + (cand.error || '无 latest'), candidate: cand });
            }
            spec = body.version ? name + '@' + String(body.version) : cand.installSpec;
          }
          if (body.dryRun === true) return writeJson(res, 200, { dryRun: true, argv: ['pnpm', 'add', spec].join(' ') });
          const snapshot = createSnapshot(profile, '安装 ' + spec + ' 前自动备份');
          const r = runPnpm(root, ['add', spec], { timeoutMs: body.timeoutMs || 600000 });
          // 退出码不是唯一判据: 有些依赖的 build 脚本被跳过后 pnpm 会以 1 退出, 但包已经装好了.
          // 以「磁盘上到底装上没有」为准, 才不会把成功的安装误报成失败 (然后不重启).
          const after = readInstalled(profile, name);
          const landed = !!after;
          const ok = r.ok || landed;
          return writeJson(res, 200, {
            ok, status: r.status, spec, log: r.log, snapshot: snapshot.id,
            installedVersion: after || null,
            softFailure: r.softFailure || null,
            needsRestart: ok,
            stderr: ok && !r.ok ? ('pnpm 有警告但仍装上了: ' + (r.softFailure || '')) : (ok ? null : (r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ')),
            pnpm: ok ? undefined : pnpmHint(r),
          });
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      /**
       * 自重启: 让宿主用原来的启动参数把自己重新拉起来, 用户不用手动关软件.
       * 安装 / 更新 / 卸载 / 改配置之后调它, 新代码才会被真正加载.
       */
      kind: 'exact',
      path: ROUTES.restart,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'POST only' });
        try {
          const body = await readBody(req);
          const waitMs = Number(body.waitMs) || 1500;
          const delayMs = Number(body.delayMs) || 600;
          if (body.dryRun === true) {
            const li = launchInfo();
            return writeJson(res, 200, { dryRun: true, pid: process.pid, execPath: li.execPath, args: li.args, cwd: li.cwd });
          }
          // 先把响应写回去, 再安排重启 —— 否则客户端只会看到连接被重置
          writeJson(res, 200, {
            ok: true,
            pid: process.pid,
            message: '正在自动重启, 约 ' + Math.round((delayMs + waitMs) / 1000) + ' 秒后恢复',
            needsReload: true,
          });
          setTimeout(() => {
            try {
              restartSelf({ waitMs, delayMs });
            } catch (error) {
              warn(error);
            }
          }, 120);
          return undefined;
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
    {
      /**
       * 插件管家自己的开关 (不是插件策略).
       *   GET  -> 当前设置 + 默认值
       *   POST { showInSidebar: bool } -> 写入并返回新值
       * 改 showInSidebar 之后要重启宿主才会生效 (侧边栏是启动时注册的).
       */
      kind: 'exact',
      path: ROUTES.settings,
      handler: async (req, res) => {
        if (!allowed(req)) return writeJson(res, 403, { error: 'forbidden: loopback only' });
        try {
          if (req.method === 'GET') {
            const s = readSettings();
            return writeJson(res, 200, Object.assign({ ok: true, file: SETTINGS_FILE }, s));
          }
          if (req.method !== 'POST') return writeJson(res, 405, { error: 'GET or POST only' });
          const body = await readBody(req);
          const patch = {};
          if (body.showInSidebar !== undefined) patch.showInSidebar = body.showInSidebar === true;
          if (!Object.keys(patch).length) return writeJson(res, 400, { error: '没有可改的字段 (showInSidebar)' });
          const next = writeSettings(patch);
          return writeJson(res, 200, Object.assign({
            ok: true,
            file: SETTINGS_FILE,
            needsRestart: true,
          }, next));
        } catch (error) {
          warn(error);
          return writeJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      },
    },
  ];

  return routes;
}

/** Write the plugin's own locale files so a rename survives the next upgrade. */
function applyLabelTo(plugin, title, description) {
  const dir = plugin.realPath;
  const localeDir = path.join(dir, 'locale');
  fs.mkdirSync(localeDir, { recursive: true });
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const meta = { title };
  const desc = description || pkg.description;
  if (desc) meta.description = desc;
  for (const lang of ['zh', 'en']) {
    const file = path.join(localeDir, lang + '.json');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (error) {
      existing = {};
    }
    existing.meta = Object.assign({}, existing.meta, lang === 'zh' ? meta : { title });
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  }
  if (!pkg.exports || typeof pkg.exports !== 'object') pkg.exports = {};
  if (!pkg.exports['./locale/*.json']) {
    pkg.exports['./locale/*.json'] = './locale/*.json';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return { dir, title };
}

/**
 * Mount the steward routes.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config) {
  if (config && config.enabled === false) return;
  const routes = makeRoutes(ctx, config || {});
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'plugin-manager: routes');
}