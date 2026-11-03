/**
 * Host half of the plugin steward (@local/dsh-plugin-manager).
 *
 * Registers /api/dsh-plugin-manager/* on the host web server and drives the
 * same modules the CLI (bin/dsh-pm.mjs) uses, so the panel and the terminal
 * always agree. The browser half (./client) renders the left-panel UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { profileDir } from './src/util.mjs';
import { scanProfile, ORIGIN_LABEL } from './src/scan.mjs';
import { checkProfile } from './src/check.mjs';
import { doctorProfile } from './src/doctor.mjs';
import { dupeReport } from './src/dupes.mjs';
import { cleanPlan, cleanApply } from './src/clean.mjs';
import { fixPlan, fixApply } from './src/fix.mjs';
import { updatePlan, updateApply } from './src/apply.mjs';
import { createSnapshot, listSnapshots, restoreSnapshot } from './src/snapshot.mjs';
import { setLabel } from './src/labels.mjs';
import { readPatchState, setDisabledText, writePatchText } from './src/patch.mjs';
import { scheduleStatus } from './src/schedule.mjs';
import { autoRun, readAutoConfig, writeAutoConfig, readAutoLog } from './src/auto.mjs';

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
  label: '/api/dsh-plugin-manager/label',
  snapshots: '/api/dsh-plugin-manager/snapshots',
  auto: '/api/dsh-plugin-manager/auto',
};

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
            host: scan.host,
            hostPayloadCount: scan.hostPayloadCount,
            counts: scan.counts,
            orphans: scan.orphans,
            plugins: scan.plugins.map((p) => ({
              name: p.name,
              title: p.title,
              titleEn: p.titleEn,
              version: p.version,
              spec: p.spec,
              origin: p.origin,
              originLabel: ORIGIN_LABEL[p.origin] || p.origin,
              source: p.source,
              installed: p.installed,
              disabled: p.disabled,
              hostProvided: p.hostProvided,
              description: p.description,
              group: p.capabilities.primary,
              groupLabel: p.capabilities.primaryLabel,
              groups: p.capabilities.labels,
              sizeBytes: p.sizeBytes,
              cordisIds: p.cordisIds,
              issues: p.issues,
              policy: packages[p.name] || null,
            })),
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
  ];

  return routes;
}

/** Write the plugin's own locale files so a rename survives the next upgrade. */
function applyLabelTo(plugin, title) {
  const dir = plugin.realPath;
  const localeDir = path.join(dir, 'locale');
  fs.mkdirSync(localeDir, { recursive: true });
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const meta = { title };
  if (pkg.description) meta.description = pkg.description;
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