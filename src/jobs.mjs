// 后台任务登记表: 把「更新」这种要跑十几秒到几分钟的活变成可以边跑边看的任务.
//
// 为什么需要它: 一次更新 8 个插件要一两分钟, 同步等 HTTP 返回时面板只能转圈, 用户不知道
// 卡在哪、装到第几个了. 有了 job, POST /update 立刻返回 jobId, 面板每 700ms 拉一次
// /update-status 就能画出进度条和当前步骤.
//
// 任务是**进程内的**: 宿主一重启就没了 (重启本来也意味着这次更新结束了). 跨重启的那种
// 「装到一半断电」由 src/pending.mjs 负责, 两者不重叠.

const KEEP = 12;
const JOBS = new Map();
let SEQ = 0;

export function newJob(kind, meta) {
  SEQ += 1;
  const id = 'j' + Date.now().toString(36) + '-' + SEQ;
  const job = {
    id,
    kind: kind || 'update',
    state: 'running',      // running | done | failed | partial
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
    logTail: [],
    meta: meta || {},
    result: null,
    error: null,
  };
  JOBS.set(id, job);
  // 只留最近 KEEP 个, 免得长年累月堆在内存里
  if (JOBS.size > KEEP) {
    const old = Array.from(JOBS.keys()).slice(0, JOBS.size - KEEP);
    for (const k of old) JOBS.delete(k);
  }
  return job;
}

export function getJob(id) {
  return (id && JOBS.get(id)) || null;
}

export function lastJob(kind) {
  const all = Array.from(JOBS.values()).reverse();
  if (!kind) return all[0] || null;
  return all.find((j) => j.kind === kind) || null;
}

export function listJobs() {
  return Array.from(JOBS.values()).map((j) => view(j));
}

/** 加一步, 返回「做完/做坏」两个钩子 */
export function step(job, name, detail) {
  const s = { name, status: 'running', detail: detail || '', at: Date.now(), ms: null };
  job.steps.push(s);
  const done = (d) => {
    s.status = 'done';
    s.ms = Date.now() - s.at;
    if (d) s.detail = String(d).slice(0, 400);
    return s;
  };
  const fail = (d) => {
    s.status = 'fail';
    s.ms = Date.now() - s.at;
    if (d) s.detail = String(d).slice(0, 400);
    return s;
  };
  return { step: s, done, fail };
}

/** 把 pnpm 输出尾巴记进去, 面板上就能看到最后一行在干什么 */
export function tail(job, text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) job.logTail.push(l);
  if (job.logTail.length > 60) job.logTail = job.logTail.slice(-60);
}

export function finish(job, state, result, error) {
  job.state = state || 'done';
  job.endedAt = Date.now();
  job.result = result === undefined ? null : result;
  job.error = error ? String(error && error.message ? error.message : error) : null;
  for (const s of job.steps) {
    if (s.status === 'running') {
      s.status = state === 'failed' ? 'fail' : 'done';
      s.ms = Date.now() - s.at;
    }
  }
  return job;
}

export function view(job) {
  if (!job) return null;
  const now = job.endedAt || Date.now();
  const total = job.steps.length;
  const finished = job.steps.filter((s) => s.status === 'done' || s.status === 'fail').length;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: now - job.startedAt,
    step: (job.steps.find((s) => s.status === 'running') || {}).name || null,
    steps: job.steps.map((s) => ({ name: s.name, status: s.status, detail: s.detail, ms: s.ms })),
    progress: total ? Math.round((finished / total) * 100) : 0,
    logTail: job.logTail.slice(-14),
    meta: job.meta,
    result: job.result,
    error: job.error,
  };
}
