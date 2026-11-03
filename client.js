/**
 * Browser half of the plugin steward (@local/dsh-plugin-manager).
 *
 * Registers one row in the left sidebar (sidebar.panellist) plus the page it
 * opens (main). React comes from the browser module table, so there is no
 * bundler, no duplicate React and no build step.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'plugin-manager';
    const API = 'api/dsh-plugin-manager/';

    async function call(path, init) {
      const res = await fetch(API + path, init);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        data = { error: text ? text.slice(0, 300) : 'empty response' };
      }
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      return data;
    }
    const getJson = (path) => call(path);
    const postJson = (path, body) =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '-';
      if (v < 1024) return v + ' B';
      if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
      return (v / 1073741824).toFixed(2) + ' GB';
    }

    const KIND_LABEL = { major: '大版本', minor: '次版本', patch: '补丁', prerelease: '预发布', unknown: '未知' };
    const SEV = { error: '严重', warn: '警告', info: '提示' };

    const CSS = [
      '.dpm{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5}',
      '.dpm-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid rgba(128,128,128,.22)}',
      '.dpm-title{font-size:14px;font-weight:600;margin-right:4px}',
      '.dpm-tabs{display:flex;gap:4px;padding:8px 14px 0}',
      '.dpm-tab{cursor:pointer;border:1px solid transparent;background:transparent;color:inherit;font:inherit;padding:5px 11px;border-radius:8px 8px 0 0;opacity:.72}',
      '.dpm-tab:hover{background:rgba(128,128,128,.12);opacity:1}',
      '.dpm-tab.on{opacity:1;border-color:rgba(128,128,128,.28);border-bottom-color:transparent;background:rgba(128,128,128,.10);font-weight:600}',
      '.dpm-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 28px}',
      '.dpm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin-bottom:12px}',
      '.dpm-card{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:9px 11px}',
      '.dpm-card b{display:block;font-size:19px;font-weight:650;line-height:1.25}',
      '.dpm-card span{opacity:.68;font-size:11.5px}',
      '.dpm-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
      '.dpm-btn{cursor:pointer;border:1px solid rgba(128,128,128,.34);background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:4px 10px;border-radius:7px;white-space:nowrap}',
      '.dpm-btn:hover{background:rgba(128,128,128,.14)}',
      '.dpm-btn:disabled{opacity:.42;cursor:default}',
      '.dpm-btn.pri{background:#2f6feb;border-color:#2f6feb;color:#fff}',
      '.dpm-btn.pri:hover{filter:brightness(1.08)}',
      '.dpm-btn.danger{color:#e5534b;border-color:rgba(229,83,75,.55)}',
      '.dpm-chip{cursor:pointer;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 9px;border-radius:999px;opacity:.8}',
      '.dpm-chip.on{background:rgba(47,111,235,.16);border-color:rgba(47,111,235,.66);opacity:1;font-weight:600}',
      '.dpm-input{font:inherit;font-size:12.5px;padding:4px 9px;border-radius:7px;border:1px solid rgba(128,128,128,.34);background:transparent;color:inherit;min-width:132px}',
      '.dpm-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid rgba(128,128,128,.18);border-radius:9px;margin-bottom:6px}',
      '.dpm-row:hover{border-color:rgba(128,128,128,.4)}',
      '.dpm-grow{flex:1;min-width:0}',
      '.dpm-nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpm-sub{font-size:11.5px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpm-badge{font-size:10.5px;padding:1px 6px;border-radius:5px;border:1px solid rgba(128,128,128,.34);opacity:.9;white-space:nowrap}',
      '.dpm-badge.self{border-color:rgba(126,231,135,.6);color:#3fb950}',
      '.dpm-badge.market{border-color:rgba(47,111,235,.6);color:#2f6feb}',
      '.dpm-badge.host{opacity:.6}',
      '.dpm-badge.up{border-color:rgba(210,153,34,.75);color:#bf8700}',
      '.dpm-badge.off{border-color:rgba(229,83,75,.6);color:#e5534b}',
      '.dpm-note{font-size:12px;opacity:.72;margin:6px 0 10px}',
      '.dpm-err{color:#e5534b;font-size:12.5px;margin:6px 0}',
      '.dpm-ok{color:#3fb950;font-size:12.5px;margin:6px 0}',
      '.dpm-empty{opacity:.6;padding:18px 0;text-align:center}',
      '.dpm-hr{height:1px;background:rgba(128,128,128,.22);margin:14px 0}',
      '.dpm-sect{font-weight:650;margin:14px 0 6px}',
    ].join('\n');

    function Btn(props) {
      const cls = 'dpm-btn' + (props.tone ? ' ' + props.tone : '');
      return h('button', { className: cls, onClick: props.onClick, disabled: props.disabled, title: props.title }, props.children);
    }

    function Badge(props) {
      return h('span', { className: 'dpm-badge' + (props.tone ? ' ' + props.tone : '') }, props.children);
    }

    function Card(props) {
      return h('div', { className: 'dpm-card' }, h('b', null, props.value), h('span', null, props.label));
    }

    function PluginRow(props) {
      const p = props.plugin;
      const up = props.update;
      const tone = p.origin === 'self' ? 'self' : p.origin === 'builtin' ? 'host' : 'market';
      const subParts = [p.name];
      if (p.groupLabel) subParts.push(p.groupLabel);
      if (p.hostProvided) subParts.push('宿主自带');
      return h(
        'div',
        { className: 'dpm-row' },
        h(
          'div',
          { className: 'dpm-grow' },
          h('div', { className: 'dpm-nm' }, p.title || p.name, p.disabled ? ' ' + '' : ''),
          h('div', { className: 'dpm-sub' }, subParts.join(' · '))
        ),
        h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
          up ? h(Badge, { tone: 'up' }, '可升级 ' + up.target + ' (' + (KIND_LABEL[up.kind] || up.kind) + ')') : null,
          p.disabled ? h(Badge, { tone: 'off' }, '已停用') : null,
          h(Badge, { tone }, p.originLabel || p.origin),
          h('span', { className: 'dpm-sub', style: { minWidth: 62, textAlign: 'right' } }, 'v' + (p.version || '?')),
          up ? h(Btn, { tone: 'pri', disabled: !!props.busy, onClick: () => props.onUpdate(p.name) }, '升级') : null,
          p.installed && !p.hostProvided
            ? h(Btn, { disabled: !!props.busy, onClick: () => props.onToggle(p) }, p.disabled ? '启用' : '停用')
            : null
        )
      );
    }

    function Finding(props) {
      const f = props.finding;
      const tone = f.severity === 'error' ? { color: '#e5534b' } : f.severity === 'warn' ? { color: '#bf8700' } : { opacity: 0.72 };
      return h(
        'div',
        { className: 'dpm-row', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { className: 'dpm-grow' },
          h('div', { className: 'dpm-nm', style: tone }, '[' + (SEV[f.severity] || f.severity) + '] ' + (f.subject || f.code)),
          h('div', { className: 'dpm-sub', style: { whiteSpace: 'normal', opacity: 0.78 } }, f.message),
          f.fix ? h('div', { className: 'dpm-sub', style: { opacity: 0.55 } }, '可自动修复: ' + f.fix) : null
        )
      );
    }

    function Panel() {
      const [tab, setTab] = React.useState('plugins');
      const [ov, setOv] = React.useState(null);
      const [err, setErr] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [check, setCheck] = React.useState(null);
      const [doc, setDoc] = React.useState(null);
      const [dup, setDup] = React.useState(null);
      const [cln, setCln] = React.useState(null);
      const [snaps, setSnaps] = React.useState(null);
      const [q, setQ] = React.useState('');
      const [origin, setOrigin] = React.useState('all');
      const [group, setGroup] = React.useState('all');
      const [upOnly, setUpOnly] = React.useState(false);

      const wrap = React.useCallback(async (label, fn) => {
        setBusy(label);
        setErr('');
        setMsg('');
        try {
          const out = await fn();
          if (typeof out === 'string') setMsg(out);
          return out;
        } catch (error) {
          setErr(error && error.message ? error.message : String(error));
          return null;
        } finally {
          setBusy('');
        }
      }, []);

      const loadOverview = React.useCallback(() => wrap('读取插件清单...', async () => {
        const data = await getJson('overview');
        setOv(data);
      }), [wrap]);

      const loadCheck = React.useCallback((refresh) => wrap('检查更新中(会访问 npm)...', async () => {
        const data = await getJson('check' + (refresh ? '?refresh=1' : ''));
        setCheck(data);
        return '检查完成: ' + data.summary.updatable + ' 个可更新';
      }), [wrap]);

      const loadDoctor = React.useCallback(() => wrap('体检中...', async () => {
        const data = await getJson('doctor');
        setDoc(data);
      }), [wrap]);

      const loadDupes = React.useCallback(() => wrap('分析重复中...', async () => {
        const data = await getJson('dupes');
        setDup(data);
      }), [wrap]);

      const loadClean = React.useCallback(() => wrap('扫描垃圾中...', async () => {
        const data = await getJson('clean');
        setCln(data);
      }), [wrap]);

      const loadSnaps = React.useCallback(() => wrap('读取快照...', async () => {
        const data = await getJson('snapshots');
        setSnaps(data);
      }), [wrap]);

      React.useEffect(() => {
        loadOverview();
      }, [loadOverview]);

      React.useEffect(() => {
        if (tab === 'health' && !doc) loadDoctor();
        if (tab === 'dupes' && !dup) loadDupes();
        if (tab === 'clean' && !cln) loadClean();
        if (tab === 'settings' && !snaps) loadSnaps();
        if (tab === 'plugins' && !check) loadCheck(false);
      }, [tab]);

      const rowsByName = React.useMemo(() => {
        const map = {};
        if (check && check.rows) for (const r of check.rows) map[r.name] = r;
        return map;
      }, [check]);

      const plugins = (ov && ov.plugins) || [];
      const filtered = React.useMemo(() => {
        const needle = q.trim().toLowerCase();
        return plugins.filter((p) => {
          if (origin !== 'all' && p.origin !== origin) return false;
          if (group !== 'all' && p.group !== group) return false;
          if (upOnly) {
            const r = rowsByName[p.name];
            if (!r || !r.updatable) return false;
          }
          if (!needle) return true;
          const hay = [p.name, p.title, p.titleEn, p.description, p.groupLabel].filter(Boolean).join(' ').toLowerCase();
          return hay.indexOf(needle) >= 0;
        });
      }, [plugins, origin, group, upOnly, q, rowsByName]);

      const updatable = React.useMemo(() => {
        if (!check || !check.rows) return [];
        return check.rows.filter((r) => r.updatable).map((r) => r.name);
      }, [check]);

      const counts = (ov && ov.counts) || {};
      const groups = (ov && ov.groups) || [];
      const schedule = ov && ov.schedule;

      const doUpdate = (names) => wrap('更新中(会调用 pnpm, 可能要一分钟)...', async () => {
        const out = await postJson('update', { names });
        const plan = out.plan || {};
        const ops = plan.ops || [];
        const applied = out.applied || {};
        const failed = applied.failed || [];
        await loadCheck(false);
        await loadOverview();
        if (failed.length) throw new Error('有 ' + failed.length + ' 个失败: ' + failed.map((f) => f.name || f).join(', '));
        return '已更新 ' + ops.length + ' 个插件' + (applied.snapshot ? ' (已备份)' : '');
      });

      const doToggle = (p) => wrap(p.disabled ? '启用中...' : '停用中...', async () => {
        await postJson('toggle', { name: p.name, disabled: !p.disabled });
        await loadOverview();
        return (p.disabled ? '已启用 ' : '已停用 ') + (p.title || p.name) + ' (重启 DSH 后生效)';
      });

      const doFix = () => wrap('修复中...', async () => {
        const out = await postJson('fix', {});
        const applied = out.applied || {};
        const done = applied.done || [];
        await loadDoctor();
        await loadOverview();
        return '已修复 ' + done.length + ' 项' + (applied.snapshot ? ' (已备份)' : '');
      });

      const doClean = () => wrap('清理中...', async () => {
        const out = await postJson('clean', { includeUnsafe: false });
        const applied = out.applied || {};
        await loadClean();
        return '已删除 ' + (applied.deleted || 0) + ' 项, 释放 ' + fmtSize(applied.freedBytes);
      });

      const doPolicy = (name, patch) => wrap('保存设置...', async () => {
        await postJson('policy', Object.assign({ name }, patch));
        await loadOverview();
        return '已保存';
      });

      const doSnapshot = () => wrap('备份中...', async () => {
        await postJson('snapshots', { action: 'create' });
        await loadSnaps();
        return '已创建快照';
      });

      const doRestore = (id) => wrap('回滚中...', async () => {
        const out = await postJson('snapshots', { action: 'restore', id });
        await loadOverview();
        await loadSnaps();
        return '已回滚到 ' + id;
      });

      const tabBtn = (key, text) => h('button', { className: 'dpm-tab' + (tab === key ? ' on' : ''), onClick: () => setTab(key) }, text);

      const status = h(
        'div',
        null,
        busy ? h('div', { className: 'dpm-note' }, busy) : null,
        err ? h('div', { className: 'dpm-err' }, '错误: ' + err) : null,
        msg ? h('div', { className: 'dpm-ok' }, msg) : null
      );

      let content = null;

      if (tab === 'plugins') {
        const cards = h(
          'div',
          { className: 'dpm-cards' },
          h(Card, { value: counts.total || plugins.length, label: '插件总数' }),
          h(Card, { value: check ? check.summary.updatable : '-', label: '可更新' }),
          h(Card, { value: (counts.self || 0) + ' / ' + (counts.market || 0), label: '自创 / 市场' }),
          h(Card, { value: counts.builtin || 0, label: '宿主自带' }),
          h(Card, { value: counts.disabled || 0, label: '已停用' })
        );
        const tools = h(
          'div',
          { className: 'dpm-tools' },
          h(Btn, { disabled: !!busy, onClick: () => loadCheck(true) }, '检查更新'),
          h(Btn, { tone: 'pri', disabled: !!busy || !updatable.length, onClick: () => doUpdate(updatable) }, '全部升级 (' + updatable.length + ')'),
          h('input', { className: 'dpm-input', placeholder: '搜索插件名 / 中文名', value: q, onChange: (e) => setQ(e.target.value) }),
          h('span', { className: 'dpm-sub' }, '来源:'),
          h('button', { className: 'dpm-chip' + (origin === 'all' ? ' on' : ''), onClick: () => setOrigin('all') }, '全部'),
          h('button', { className: 'dpm-chip' + (origin === 'self' ? ' on' : ''), onClick: () => setOrigin('self') }, '自创'),
          h('button', { className: 'dpm-chip' + (origin === 'market' ? ' on' : ''), onClick: () => setOrigin('market') }, '市场'),
          h('button', { className: 'dpm-chip' + (origin === 'builtin' ? ' on' : ''), onClick: () => setOrigin('builtin') }, '宿主'),
          h('button', { className: 'dpm-chip' + (origin === 'missing' ? ' on' : ''), onClick: () => setOrigin('missing') }, '缺失'),
          h('button', { className: 'dpm-chip' + (upOnly ? ' on' : ''), onClick: () => setUpOnly(!upOnly) }, '只看可更新'),
          h(
            'select',
            { className: 'dpm-input', value: group, onChange: (e) => setGroup(e.target.value) },
            h('option', { value: 'all' }, '全部分组'),
            groups.map((g) => h('option', { key: g.key, value: g.key }, g.label))
          )
        );
        const list = filtered.length
          ? filtered.map((p) =>
              h(PluginRow, {
                key: p.name,
                plugin: p,
                update: rowsByName[p.name] && rowsByName[p.name].updatable ? rowsByName[p.name] : null,
                busy: busy,
                onUpdate: (name) => doUpdate([name]),
                onToggle: doToggle,
              })
            )
          : h('div', { className: 'dpm-empty' }, ov ? '没有匹配的插件' : '读取中...');
        content = h('div', null, cards, tools, status, list);
      }

      if (tab === 'health') {
        const s = (doc && doc.summary) || {};
        content = h(
          'div',
          null,
          h(
            'div',
            { className: 'dpm-cards' },
            h(Card, { value: s.errors || 0, label: '严重' }),
            h(Card, { value: s.warns || 0, label: '警告' }),
            h(Card, { value: s.infos || 0, label: '提示' })
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(Btn, { disabled: !!busy, onClick: loadDoctor }, '重新体检'),
            h(Btn, { tone: 'pri', disabled: !!busy, onClick: doFix }, '一键修复')
          ),
          status,
          doc && doc.findings && doc.findings.length
            ? doc.findings.map((f, i) => h(Finding, { key: f.code + ':' + i, finding: f }))
            : h('div', { className: 'dpm-empty' }, doc ? '没有发现任何问题' : '体检中...')
        );
      }

      if (tab === 'dupes') {
        const s = (dup && dup.summary) || {};
        const findList = (dup && dup.findings) || [];
        content = h(
          'div',
          null,
          h(
            'div',
            { className: 'dpm-cards' },
            h(Card, { value: s.capability || 0, label: '功能重叠组' }),
            h(Card, { value: s.inject || 0, label: '共用插槽' }),
            h(Card, { value: s.multiVersion || 0, label: '同名多版本' }),
            h(Card, { value: fmtSize(dup && dup.totalBytes), label: '插件总占用' })
          ),
          h('div', { className: 'dpm-tools' }, h(Btn, { disabled: !!busy, onClick: loadDupes }, '重新分析')),
          status,
          findList.length
            ? findList.map((f, i) => h(Finding, { key: f.code + ':' + i, finding: f }))
            : h('div', { className: 'dpm-empty' }, dup ? '没有发现重复' : '分析中...')
        );
      }

      if (tab === 'clean') {
        const items = (cln && cln.items) || [];
        content = h(
          'div',
          null,
          h(
            'div',
            { className: 'dpm-cards' },
            h(Card, { value: cln ? cln.safeCount : '-', label: '安全可删项' }),
            h(Card, { value: fmtSize(cln && cln.safeBytes), label: '安全可释放' }),
            h(Card, { value: fmtSize(cln && cln.totalBytes), label: '合计' })
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(Btn, { disabled: !!busy, onClick: loadClean }, '重新扫描'),
            h(Btn, { tone: 'pri', disabled: !!busy || !items.length, onClick: doClean }, '清理安全项')
          ),
          status,
          items.length
            ? items.map((it, i) =>
                h(
                  'div',
                  { className: 'dpm-row', key: i },
                  h(
                    'div',
                    { className: 'dpm-grow' },
                    h('div', { className: 'dpm-nm' }, it.name || it.path),
                    h('div', { className: 'dpm-sub' }, it.kind + ' · ' + (it.safe ? '安全' : '需确认') + ' · ' + (it.reason || ''))
                  ),
                  h('span', { className: 'dpm-sub' }, fmtSize(it.sizeBytes))
                )
              )
            : h('div', { className: 'dpm-empty' }, cln ? '没有可清理的东西' : '扫描中...')
        );
      }

      if (tab === 'settings') {
        const policy = (ov && ov.policy && ov.policy.packages) || {};
        const list = plugins.filter((p) => p.origin === 'market');
        content = h(
          'div',
          null,
          h('div', { className: 'dpm-sect' }, '自动更新策略 (每个插件)'),
          h('div', { className: 'dpm-note' }, '勾选后, 每日自动检查会把它记进 stardustlc-plugin-updates.json, 插件市场与插件管家都按这个开关走。'),
          status,
          list.map((p) => {
            const pol = policy[p.name] || {};
            return h(
              'div',
              { className: 'dpm-row', key: p.name },
              h(
                'div',
                { className: 'dpm-grow' },
                h('div', { className: 'dpm-nm' }, p.title || p.name),
                h('div', { className: 'dpm-sub' }, p.name)
              ),
              h(
                'label',
                { className: 'dpm-sub', style: { display: 'flex', gap: 4, alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: pol.checkEnabled !== false, disabled: !!busy, onChange: (e) => doPolicy(p.name, { checkEnabled: e.target.checked }) }),
                '检查更新'
              ),
              h(
                'label',
                { className: 'dpm-sub', style: { display: 'flex', gap: 4, alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: pol.autoInstall === true, disabled: !!busy, onChange: (e) => doPolicy(p.name, { autoInstall: e.target.checked }) }),
                '自动安装'
              )
            );
          }),
          h('div', { className: 'dpm-hr' }),
          h('div', { className: 'dpm-sect' }, '每日自动检查'),
          schedule && schedule.installed
            ? h(
                'div',
                { className: 'dpm-note' },
                '已安装计划任务: 下次运行 ' + (schedule.nextRun || '?') + ' · 上次 ' + (schedule.lastRun || '从未运行过')
              )
            : h('div', { className: 'dpm-note' }, '未安装。在终端运行 dsh-pm schedule install --time 09:30 --write 即可开启。'),
          h('div', { className: 'dpm-hr' }),
          h('div', { className: 'dpm-sect' }, '快照 (改坏了可以回滚)'),
          h('div', { className: 'dpm-tools' }, h(Btn, { disabled: !!busy, onClick: doSnapshot }, '立即备份一份')),
          snaps && snaps.snapshots && snaps.snapshots.length
            ? snaps.snapshots.map((s2) =>
                h(
                  'div',
                  { className: 'dpm-row', key: s2.id },
                  h(
                    'div',
                    { className: 'dpm-grow' },
                    h('div', { className: 'dpm-nm' }, s2.id),
                    h('div', { className: 'dpm-sub' }, (s2.reason || '') + ' · ' + ((s2.files || []).length) + ' 个文件')
                  ),
                  h(Btn, { tone: 'danger', disabled: !!busy, onClick: () => doRestore(s2.id) }, '回滚')
                )
              )
            : h('div', { className: 'dpm-empty' }, '还没有快照')
        );
      }

      return h(
        'div',
        { className: 'dpm' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dpm-bar' },
          h('span', { className: 'dpm-title' }, '插件管家'),
          ov && ov.host && ov.host.version ? h('span', { className: 'dpm-sub' }, '宿主 ' + ov.host.version) : null,
          ov ? h('span', { className: 'dpm-sub' }, ov.profile) : null,
          h(Btn, { disabled: !!busy, onClick: loadOverview }, '刷新')
        ),
        h('div', { className: 'dpm-tabs' }, tabBtn('plugins', '插件'), tabBtn('health', '体检'), tabBtn('dupes', '重复'), tabBtn('clean', '清理'), tabBtn('settings', '设置')),
        h('div', { className: 'dpm-body' }, content)
      );
    }

    function EntryIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'currentColor', opacity: 0.16 }),
        h('rect', { x: 6, y: 8, width: 8, height: 2, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 6, y: 12, width: 12, height: 2, rx: 1, fill: 'currentColor' }),
        h('circle', { cx: 17.5, cy: 15.5, r: 3.2, fill: 'currentColor' })
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        ctx.effect(() => {
          const disposers = [];
          disposers.push(
            slots.inject('sidebar.panellist', () =>
              slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '插件管家' }, EntryIcon)
            )
          );
          disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel)));
          return () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose();
              } catch (error) {
                /* ignore */
              }
            }
          };
        }, 'plugin-manager: panel');
      },
    };
  },
});