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

    /**
     * 侧边栏开关的本地缓存.
     * 客户端模块是同步加载的 (apply 一进来就要决定注册不注册侧边栏), 没法 await 一次 fetch,
     * 所以: 开机用上一次记住的值; 如果在设置里改了, 写完立刻更新这里, 重启后就用新值.
     * 默认 false —— 面板从「插件市场」页的标签行进去就够了, 侧边栏不必再占一格.
     */
    const SIDEBAR_KEY = 'dpm:showInSidebar';
    function isSidebarEnabled() {
      try {
        return window.localStorage.getItem(SIDEBAR_KEY) === '1';
      } catch (error) {
        return false;
      }
    }
    function rememberSidebar(on) {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, on ? '1' : '0');
      } catch (error) {
        /* localStorage 不可用就算了, 后端 settings.json 才是真源 */
      }
    }

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

    const KIND_LABEL = { major: '大版本', minor: '小版本', patch: '修补版', prerelease: '测试版', unknown: '未知' };
    const SEV = { error: '严重', warn: '注意', info: '提示' };

    /**
     * 常用词的「人话」表.
     * 面板上凡是专业术语都从这里取中文, 不散落在各处, 免得改一处漏一处.
     * 原则: 说「会发生什么」, 而不是说「它叫什么」。
     */
    const WORD = {
      // 插件来源
      self: '我自己做的',
      market: '市场装的',
      builtin: '系统自带',
      host: '系统自带',
      // 分组
      hidden: '隐藏项',
      // 安全检查等级
      danger: '有风险',
      caution: '要联网/跑命令',
      info: '轻微',
      safe: '没问题',
      unknown: '没检查',
      // 安全能力
      'dynamic-code': '能动态执行代码',
      credentials: '能读账号密码',
    };

    /**
     * 面板样式表.
     * 配色不写死, 全部走 CSS 变量 + `prefers-color-scheme`:
     * 系统切深色面板就深色, 切浅色就浅色, 不需要重载 Harness.
     * 变量挂在 `.dpm` 上(而不是 :root), 免得污染宿主自己的主题变量.
     */
    const CSS = [
      '.dpm{',
      '  color-scheme:light dark;',
      '  display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5;',
      // 浅色(默认)
      '  --dpm-bg:#ffffff;',
      '  --dpm-fg:#1f2328;',
      '  --dpm-line:rgba(31,35,40,.14);',
      '  --dpm-line-strong:rgba(31,35,40,.28);',
      '  --dpm-fill:rgba(31,35,40,.05);',
      '  --dpm-fill-hover:rgba(31,35,40,.09);',
      '  --dpm-accent:#2f6feb;',
      '  --dpm-accent-soft:rgba(47,111,235,.12);',
      '  --dpm-on-accent:#ffffff;',
      '  --dpm-danger:#c0342c;',
      '  --dpm-warn:#8a6100;',
      '  --dpm-ok:#1a7f37;',
      '  background:var(--dpm-bg);color:var(--dpm-fg);',
      '}',
      '@media (prefers-color-scheme: dark){',
      '  .dpm{',
      '    --dpm-bg:#16191d;',
      '    --dpm-fg:#e6edf3;',
      '    --dpm-line:rgba(255,255,255,.16);',
      '    --dpm-line-strong:rgba(255,255,255,.32);',
      '    --dpm-fill:rgba(255,255,255,.06);',
      '    --dpm-fill-hover:rgba(255,255,255,.12);',
      '    --dpm-accent:#4d8bff;',
      '    --dpm-accent-soft:rgba(77,139,255,.18);',
      '    --dpm-on-accent:#0b1220;',
      '    --dpm-danger:#ff6b60;',
      '    --dpm-warn:#d9a227;',
      '    --dpm-ok:#3fb950;',
      '  }',
      // 深色主题下按截图那样: 亮轨道 + 深色圆钮 (浅色主题是蓝轨道 + 白圆钮)
      '  .dpm-sw.on{background:#eef2f6}',
      '  .dpm-sw.on::after{background:#14181d}',
      '}',
      '.dpm-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dpm-line)}',
      '.dpm-title{font-size:14px;font-weight:600;margin-right:4px}',
      '.dpm-tabs{display:flex;gap:4px;padding:8px 14px 0;flex-wrap:wrap}',
      '.dpm-tab{cursor:pointer;border:1px solid transparent;background:transparent;color:inherit;font:inherit;padding:5px 11px;border-radius:8px 8px 0 0;opacity:.72}',
      '.dpm-tab:hover{background:var(--dpm-fill);opacity:1}',
      '.dpm-tab.on{opacity:1;border-color:var(--dpm-line-strong);border-bottom-color:transparent;background:var(--dpm-fill);font-weight:600}',
      '.dpm-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 28px}',
      '.dpm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin-bottom:12px}',
      '.dpm-card{border:1px solid var(--dpm-line);border-radius:10px;padding:9px 11px}',
      '.dpm-card b{display:block;font-size:19px;font-weight:650;line-height:1.25}',
      '.dpm-card span{opacity:.68;font-size:11.5px}',
      '.dpm-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
      '.dpm-btn{cursor:pointer;border:1px solid var(--dpm-line-strong);background:transparent;color:inherit;font:inherit;font-size:12.5px;padding:4px 10px;border-radius:7px;white-space:nowrap}',
      '.dpm-btn:hover{background:var(--dpm-fill-hover)}',
      '.dpm-btn:disabled{opacity:.42;cursor:default}',
      '.dpm-btn.pri{background:var(--dpm-accent);border-color:var(--dpm-accent);color:var(--dpm-on-accent)}',
      '.dpm-btn.pri:hover{filter:brightness(1.08)}',
      '.dpm-btn.danger{color:var(--dpm-danger);border-color:var(--dpm-danger)}',
      '.dpm-chip{cursor:pointer;border:1px solid var(--dpm-line-strong);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 9px;border-radius:999px;opacity:.82}',
      '.dpm-chip:hover{background:var(--dpm-fill-hover);opacity:1}',
      '.dpm-chip.on{background:var(--dpm-accent-soft);border-color:var(--dpm-accent);opacity:1;font-weight:600}',
      '.dpm-input{font:inherit;font-size:12.5px;padding:4px 9px;border-radius:7px;border:1px solid var(--dpm-line-strong);background:var(--dpm-bg);color:inherit;min-width:132px}',
      'select.dpm-input{cursor:pointer}',
      '.dpm-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--dpm-line);border-radius:9px;margin-bottom:6px}',
      '.dpm-row:hover{border-color:var(--dpm-line-strong)}',
      '.dpm-grow{flex:1;min-width:0}',
      '.dpm-nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpm-sub{font-size:11.5px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpm-badge{font-size:10.5px;padding:1px 6px;border-radius:5px;border:1px solid var(--dpm-line-strong);opacity:.92;white-space:nowrap}',
      '.dpm-badge.self{border-color:var(--dpm-ok);color:var(--dpm-ok)}',
      '.dpm-badge.market{border-color:var(--dpm-accent);color:var(--dpm-accent)}',
      '.dpm-badge.host{opacity:.6}',
      '.dpm-badge.up{border-color:var(--dpm-warn);color:var(--dpm-warn)}',
      '.dpm-badge.off{border-color:var(--dpm-danger);color:var(--dpm-danger)}',
      '.dpm-note{font-size:12px;opacity:.72;margin:6px 0 10px}',
      '.dpm-err{color:var(--dpm-danger);font-size:12.5px;margin:6px 0}',
      '.dpm-ok{color:var(--dpm-ok);font-size:12.5px;margin:6px 0}',
      '.dpm-empty{opacity:.6;padding:18px 0;text-align:center}',
      '.dpm-hr{height:1px;background:var(--dpm-line);margin:14px 0}',
      // iOS 那种拨动开关: 关=灰底圆钮在左, 开=亮底深钮在右. 整块跟着系统的深色/浅色走.
      '.dpm-sw{position:relative;display:inline-flex;flex:0 0 auto;align-items:center;width:42px;height:24px;border-radius:999px;border:none;padding:0;cursor:pointer;background:var(--dpm-line-strong);transition:background .2s ease}',
      '.dpm-sw::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .2s ease,background .2s ease}',
      '.dpm-sw.on{background:var(--dpm-accent)}',
      '.dpm-sw.on::after{transform:translateX(18px)}',
      '.dpm-sw:disabled{opacity:.4;cursor:default}',
      '.dpm-swrow{display:flex;gap:7px;align-items:center}',
      '.dpm-prog{height:6px;border-radius:999px;background:var(--dpm-line);overflow:hidden;margin:6px 0}',
      '.dpm-prog > i{display:block;height:100%;background:var(--dpm-accent);transition:width .3s ease}',
      '.dpm-log{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.75;white-space:pre-wrap;max-height:72px;overflow:auto;margin-top:4px}',
      '.dpm-sect{font-weight:650;margin:14px 0 6px}',
      // ---- 市场卡片 CSS ----
      // 内嵌市场那页已经隐藏, 但卡片样式留着: 代码还在, 以后想挂回来直接就能用.
      '.dpm-mkt{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(288px,100%),1fr));gap:10px;margin-top:10px}',
      '.dpm-mk{border:1px solid var(--dpm-line);border-radius:11px;padding:11px 12px;display:flex;flex-direction:column;gap:7px;cursor:pointer;background:var(--dpm-bg)}',
      '.dpm-mk:hover{border-color:var(--dpm-line-strong)}',
      '.dpm-mk.on{border-color:var(--dpm-accent);box-shadow:0 0 0 1px var(--dpm-accent-soft) inset}',
      '.dpm-mkhead{display:flex;gap:9px;align-items:flex-start}',
      '.dpm-mkicon{width:34px;height:34px;border-radius:8px;flex:none;object-fit:cover;background:var(--dpm-fill)}',
      '.dpm-mkicon.ph{display:flex;align-items:center;justify-content:center;font-weight:650;font-size:15px;opacity:.75}',
      '.dpm-mktitle{font-weight:650;font-size:13.5px;line-height:1.3;word-break:break-all}',
      '.dpm-mkmeta{font-size:11px;opacity:.62;margin-top:2px}',
      '.dpm-mkdesc{font-size:12px;line-height:1.5;opacity:.82;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.dpm-mkcaps{display:flex;gap:4px;flex-wrap:wrap}',
      '.dpm-mkcap{font-size:10.5px;padding:0 5px;border-radius:4px;border:1px solid var(--dpm-line-strong);opacity:.8;white-space:nowrap}',
      '.dpm-mkcap.bad{border-color:var(--dpm-danger);color:var(--dpm-danger);opacity:1;font-weight:600}',
      '.dpm-mkfoot{display:flex;gap:6px;align-items:center;margin-top:auto;padding-top:4px}',
      '.dpm-mkshot{display:flex;gap:5px;overflow:hidden}',
      '.dpm-mkshot img{width:58px;height:36px;object-fit:cover;border-radius:5px;border:1px solid var(--dpm-line)}',
    ].join('\n');

    /**
     * 市场界面的两张对照表 + 数字缩写.
     * 分类取值来自官方目录 (dsh-plugin-catalog) 的 category 枚举;
     * 能力取值来自官方目录预计算的 capabilities —— 其中「读凭据」「动态代码」
     * 是安全上要盯的两项, 卡片上用红色标出来.
     */
    const MK_CAT = {
      agi: 'AGI 架构探索', ui: 'UI 增强', usage: '用量与计费', theme: '主题与外观',
      model: '模型与账号接入', identity: '身份与通信', session: '会话与消息', memory: '记忆',
      tools: '工具与能力', skill: '技能', dev: '开发工具', workflow: '工作流', docs: '文档',
      notify: '通知', browser: '浏览器', vision: '视觉', voice: '语音', security: '安全',
      remote: '远程', market: '插件市场', git: 'Git', wsl: 'WSL', fun: '娱乐',
    };
    const MK_CAP = {
      shell: '执行命令', 'fs-read': '读文件', 'fs-write': '写文件', network: '联网',
      env: '读环境变量', credentials: '读凭据', llm: '调用模型', 'host-runtime': '宿主运行时',
      'dynamic-code': '动态代码', subagent: '子代理',
    };
    const MK_BAD_CAP = ['credentials', 'dynamic-code'];

    function fmtNum(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      return String(v);
    }

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

    /** iOS 那种拨动开关. 关=灰底钮在左, 开=亮底(浅色主题是蓝, 深色主题是白)钮在右. */
    function Switch(props) {
      const on = props.checked === true;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        className: 'dpm-sw' + (on ? ' on' : ''),
        disabled: props.disabled,
        title: props.title,
        onClick: (e) => { e.preventDefault(); if (props.disabled) return; if (props.onChange) props.onChange(!on); },
      });
    }

    function PluginRow(props) {
      const p = props.plugin;
      const up = props.update;
      const tone = p.origin === 'self' ? 'self' : p.origin === 'builtin' ? 'host' : 'market';
      const subParts = [p.name];
      if (p.groupLabel) subParts.push(p.groupLabel);
      if (p.hostProvided) subParts.push('系统自带, 不用管');
      const desc = p.description || '';
      const usage = p.usage || '';
      // 「怎么用」默认收起来: 一屏几十个插件全展开就没法看了
      const [openUsage, setOpenUsage] = React.useState(false);
      return h(
        'div',
        { className: 'dpm-row', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { className: 'dpm-grow', style: { minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('div', { className: 'dpm-nm' }, p.title || p.name),
            desc ? h('span', { className: 'dpm-sub', style: { opacity: 0.62 } }, 'v' + (p.version || '?')) : null
          ),
          desc
            ? h(
                'div',
                { className: 'dpm-sub', style: { whiteSpace: 'normal', lineHeight: 1.5, opacity: 0.82 } },
                desc,
                p.descriptionLang === 'en' ? h('span', { style: { opacity: 0.6, marginLeft: 4 } }, '（只有英文说明）') : null,
                p.needsZh ? h('span', { style: { opacity: 0.6, marginLeft: 4 } }, '· 还没有中文说明') : null
              )
            : null,
          usage
            ? h(
                'div',
                { style: { marginTop: 3 } },
                h(
                  'span',
                  {
                    className: 'dpm-sub',
                    onClick: () => setOpenUsage(!openUsage),
                    style: { cursor: 'pointer', color: 'var(--dpm-accent)', userSelect: 'none' },
                    title: p.usageHeading ? '摘自插件 README 的「' + p.usageHeading + '」' : '摘自插件的 README',
                  },
                  (openUsage ? '▾ ' : '▸ ') + '怎么用'
                ),
                openUsage
                  ? h(
                      'div',
                      {
                        className: 'dpm-sub',
                        style: {
                          whiteSpace: 'pre-wrap', lineHeight: 1.55, opacity: 0.86, marginTop: 4,
                          background: 'var(--dpm-fill)', border: '1px solid var(--dpm-line)',
                          borderRadius: 6, padding: '7px 9px', maxHeight: 260, overflow: 'auto',
                          fontFamily: 'inherit', fontSize: 'inherit',
                        },
                      },
                      usage
                    )
                  : null
              )
            : null,
          h('div', { className: 'dpm-sub', style: { opacity: 0.5 } }, subParts.join(' · '))
        ),
        h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
          up ? h(Badge, { tone: 'up' }, '可升级到 ' + up.target + '（' + (KIND_LABEL[up.kind] || up.kind) + '）') : null,
          p.disabled ? h(Badge, { tone: 'off' }, '已关掉') : null,
          h(Badge, { tone }, WORD[p.origin] || p.originLabel || p.origin),
          desc ? null : h('span', { className: 'dpm-sub', style: { minWidth: 62, textAlign: 'right' } }, 'v' + (p.version || '?')),
          up ? h(Btn, { tone: 'pri', disabled: !!props.busy, onClick: () => props.onUpdate(p.name) }, '更新') : null,
          p.installed && !p.hostProvided
            ? h(Btn, { disabled: !!props.busy, onClick: () => props.onToggle(p) }, p.disabled ? '打开' : '关掉')
            : null,
          p.installed && !p.self
            ? h(Btn, { tone: 'danger', disabled: !!props.busy, onClick: () => props.onUninstall(p), title: '删掉之前会自动备份一份，删错了能恢复' }, '删除')
            : null
        )
      );
    }

    function Finding(props) {
      const f = props.finding;
      const tone = f.severity === 'error' ? { color: 'var(--dpm-danger)' } : f.severity === 'warn' ? { color: 'var(--dpm-warn)' } : { opacity: 0.72 };
      return h(
        'div',
        { className: 'dpm-row', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { className: 'dpm-grow' },
          h('div', { className: 'dpm-nm', style: tone }, '[' + (SEV[f.severity] || f.severity) + '] ' + (f.subject || f.code)),
          h('div', { className: 'dpm-sub', style: { whiteSpace: 'normal', opacity: 0.78 } }, f.message),
          f.fix ? h('div', { className: 'dpm-sub', style: { opacity: 0.55 } }, '能自动修好: ' + f.fix) : null
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
      const [safety, setSafety] = React.useState(null);
      const [mkt, setMkt] = React.useState(null);
      const [mktQ, setMktQ] = React.useState('');
      const [mktCat, setMktCat] = React.useState('all');
      const [mktItem, setMktItem] = React.useState(null);
      const [mktAudit, setMktAudit] = React.useState(null);
      const [mktSort, setMktSort] = React.useState('recent');
      const [mktNoBad, setMktNoBad] = React.useState(false);
      // 正在跑的更新任务 (异步 job): 有它就画进度条, 没有就不占地方
      const [job, setJob] = React.useState(null);
      // 上次装到一半被打断的残留: 有就要提示用户"要不要退回备份"
      const [recov, setRecov] = React.useState(null);
      // 插件管家自己的开关 (跟插件策略不是一回事): 侧边栏要不要留一格
      const [appCfg, setAppCfg] = React.useState({ showInSidebar: isSidebarEnabled() });
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

      /**
       * 顶部「重新读一遍」.
       * 以前它只是再读一次列表 —— 数据没变化时界面上什么都看不出来, 用户会以为按钮坏了.
       * 现在它把「列表 + 更新检查 + 备份记录 + 残留提醒」一起刷一遍, 并且把结果说出来.
       */
      const doReload = React.useCallback(() => wrap('正在重新读一遍（列表 / 更新 / 备份）…', async () => {
        const data = await getJson('overview');
        setOv(data);
        let chk = null;
        try {
          chk = await getJson('check?refresh=1');
          setCheck(chk);
        } catch (error) { /* 联网失败不影响其它两项 */ }
        try { setSnaps(await getJson('snapshots')); } catch (error) {}
        try { setRecov(await getJson('recover')); } catch (error) { setRecov(null); }
        const n = (data && data.plugins ? data.plugins.length : 0);
        const up = chk && chk.summary ? chk.summary.updatable : null;
        return '读完了：' + n + ' 个插件' + (up == null ? '' : (up ? '，' + up + ' 个能更新' : '，都是最新的'));
      }), [wrap]);

      const loadOverview = React.useCallback(() => wrap('正在读插件列表…', async () => {
        const data = await getJson('overview');
        setOv(data);
        // 顺手看一眼上次有没有「装到一半被打断」的残留 (独立接口, 失败不影响列表)
        try {
          const r = await getJson('recover');
          setRecov(r);
        } catch (error) {
          setRecov(null);
        }
      }), [wrap]);

      /**
       * 让宿主自己重启 (用户不用手动关软件).
       * 宿主会先用原参数把新进程拉起来, 再退出自己; 端口通常不变.
       *
       * 判定"真的重启过了"不能只看 overview 能不能读 —— 旧进程在被 SIGTERM 之前
       * 仍然能应答, 那样会立刻误判成"重启完成". 所以这里记录重启前的 pid,
       * 必须等 overview 报出**不同的 pid** 才算数; 一直等到同一个 pid 就说明重启没发生.
       */
      const restartNow = React.useCallback(async (reason) => {
        const pre = await getJson('overview').catch(() => null);
        const oldPid = (pre && (pre.pid || (pre.host && pre.host.pid))) || null;
        const head = reason ? reason + '，' : '';
        let accepted = false;
        try {
          await postJson('restart', {});
          accepted = true;
        } catch (error) {
          // 连接被重置 = 宿主已经在退出, 也算信号
          accepted = true;
        }
        setMsg(head + '正在重启软件：窗口会自己关掉再打开，约 6 秒，不用你操作…');
        const started = Date.now();
        let newPid = null;
        let samePidSeen = false;
        while (Date.now() - started < 60000) {
          await new Promise((r) => setTimeout(r, 900));
          let ov2 = null;
          try {
            ov2 = await getJson('overview');
          } catch (error) {
            continue; // 还没起来, 继续等
          }
          const pid = ov2 && (ov2.pid || (ov2.host && ov2.host.pid));
          if (pid && oldPid && pid === oldPid) {
            samePidSeen = true;
            continue; // 还是老进程, 说明还没真的重启
          }
          if (pid && (!oldPid || pid !== oldPid)) {
            newPid = pid;
            break;
          }
          // 拿不到 pid 的旧版本宿主: 等够 6 秒就认为起过一次
          if (Date.now() - started > 6000) {
            newPid = pid || '(未知)';
            break;
          }
        }
        if (newPid) {
          setMsg(head + '重启好了 ✅ 新版本已加载。按一下 Ctrl+F5 刷新页面（页面会自动重连）');
          // 重启后端口可能没变, 但也可能变了 —— 一次性重读, 失败就当还是旧地址
          try { await getJson('overview'); } catch (error) {}
        } else if (samePidSeen) {
          setMsg(head + '⚠️ 没能重启（旧进程还在）。再点一次「重启软件」试试');
        } else {
          setMsg(head + '⚠️ 重启后没能连回来，等几秒后按 Ctrl+F5 刷新。如果还是不行就手动重开软件一次');
        }
        return !!newPid;
      }, []);

      const loadCheck = React.useCallback((refresh) => wrap('正在查有没有新版本（要联网，等一下）…', async () => {
        const data = await getJson('check' + (refresh ? '?refresh=1' : ''));
        setCheck(data);
        return '查完了：有 ' + data.summary.updatable + ' 个插件可以更新';
      }), [wrap]);

      const loadDoctor = React.useCallback(() => wrap('正在给插件做体检…', async () => {
        const data = await getJson('doctor');
        setDoc(data);
      }), [wrap]);

      const loadDupes = React.useCallback(() => wrap('正在找功能重复的插件…', async () => {
        const data = await getJson('dupes');
        setDup(data);
      }), [wrap]);

      const loadClean = React.useCallback(() => wrap('正在找能删的垃圾文件…', async () => {
        const data = await getJson('clean');
        setCln(data);
      }), [wrap]);

      const loadSnaps = React.useCallback(() => wrap('正在读备份记录…', async () => {
        const data = await getJson('snapshots');
        setSnaps(data);
      }), [wrap]);

      const loadSafety = React.useCallback((only) => wrap('正在看插件代码有没有风险（只看不跑，不联网）…', async () => {
        const data = await getJson('safety?mode=profile' + (only && only.length ? '&only=' + encodeURIComponent(only.join(',')) : ''));
        setSafety(data);
        const s = data.summary || {};
        return '看完了：一共 ' + s.total + ' 个插件，' + (s.danger || 0) + ' 个有风险';
      }), [wrap]);

      const loadMarket = React.useCallback((q, cat, refresh, opt) => wrap('正在打开插件市场…', async () => {
        const o = opt || {};
        const params = [];
        if (q) params.push('q=' + encodeURIComponent(q));
        if (cat && cat !== 'all') params.push('category=' + encodeURIComponent(cat));
        if (refresh) params.push('refresh=1');
        if (o.sort) params.push('sort=' + encodeURIComponent(o.sort));
        if (o.noBad) params.push('nocreds=1');
        params.push('limit=' + (o.limit || 60));
        const data = await getJson('market?' + params.join('&'));
        setMkt(data);
        return '市场里一共 ' + (data.total || 0) + ' 个插件（这里先显示 ' + (data.returned || 0) + ' 个）';
      }), [wrap]);

      /**
       * 市场条目点开: 先看版本, 再做静态扫描 —— 这是"安装前必须过安检"的落点.
       * 只提示不拦截: 报告出来之后, 安装按钮照旧可点.
       */
      const inspectMarket = React.useCallback((item) => {
        setMktItem(item);
        setMktAudit(null);
        return wrap('正在查最新版本 + 看看代码有没有风险…', async () => {
          const nm = item.npm;
          if (!nm) throw new Error('这个插件没有可安装的包名，装不了');
          const resolved = await getJson('market?resolve=' + encodeURIComponent(nm));
          if (resolved.error) throw new Error(resolved.error);
          setMktItem(Object.assign({}, item, { resolved }));
          if (resolved.version) {
            const report = await getJson('safety?mode=package&name=' + encodeURIComponent(nm) + '&version=' + encodeURIComponent(resolved.version));
            setMktAudit(report);
            return nm + ' ' + resolved.version + ' 看完了：' + ((report.grade && report.grade.verdict) || '');
          }
          return nm + '：查不到版本号';
        });
      }, [wrap]);

      const doInstall = React.useCallback((item) => wrap('正在安装（要下载，差不多一分钟）…', async () => {
        const nm = item.npm;
        const resolved = (item && item.resolved) || {};
        if (document.body && !window.__dpmNoConfirm) {
          const g = (mktAudit && mktAudit.grade) || {};
          const warn = g.level === 'danger';
          const ask = '要装 ' + nm + (resolved.version ? ' ' + resolved.version : '') + ' 吗？\n\n' +
            '安全情况：' + (g.verdict || '还没检查') + '\n' +
            (warn ? '\n提醒：这个插件有些可疑行为，建议先看一眼下面的明细再决定。\n' : '') +
            '装之前会自动备份一份，装完会自动重启软件，不用你手动关。';
          if (!window.confirm(ask)) return null;
        }
        const out = await postJson('install', { action: 'install', name: nm, version: resolved.version || undefined });
        if (!out.ok) throw new Error('没装上：' + (out.stderr || 'HTTP ' + out.status));
        // 重启之后重新读, 新插件才会出现在列表里
        await restartNow('已装好 ' + out.spec + '');
        await loadOverview().catch(() => {});
        await loadMarket(mktQ, mktCat, false, { sort: mktSort, noBad: mktNoBad }).catch(() => {});
        return '已装好 ' + out.spec + '（备份在 ' + out.snapshot + '）';
      }), [wrap, loadOverview, loadMarket, mktQ, mktCat, mktAudit, mktSort, mktNoBad]);

      React.useEffect(() => {
        loadOverview();
        // 顺手把侧边栏开关的真值拉一次, 免得 localStorage 里的缓存和后端 settings.json 对不上
        getJson('settings')
          .then((s) => {
            setAppCfg({ showInSidebar: s && s.showInSidebar === true });
            rememberSidebar(s && s.showInSidebar === true);
          })
          .catch(() => {});
      }, [loadOverview]);

      React.useEffect(() => {
        if (tab === 'health' && !doc) loadDoctor();
        if (tab === 'dupes' && !dup) loadDupes();
        if (tab === 'clean' && !cln) loadClean();
        if (tab === 'settings' && !snaps) loadSnaps();
        if (tab === 'plugins' && !check) loadCheck(false);
        if (tab === 'safety' && !safety) loadSafety();
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
          const hay = [p.name, p.title, p.titleEn, p.description, p.groupLabel, p.usage].filter(Boolean).join(' ').toLowerCase();
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

      /**
       * 一键更新. 顺序很关键: 先装 → 再重启 → 重启完**重新读**插件列表和更新列表.
       * 以前是重启前就读 check, 于是重启完面板还挂着「能更新 4」, 看着像没装好.
       */
      /**
       * 更新: 走异步 job + 轮询进度.
       * 一次更新几个插件要一两分钟, 同步等只能转圈; 现在后端边装边记账,
       * 面板每 700ms 拉一次 /update-status, 就能显示「备份 → 装第 2/5 个 → 体检」和 pnpm 最后一行输出.
       */
      const doUpdate = (names) => wrap('开始更新…', async () => {
        let out = null;
        try {
          out = await postJson('update', { names, async: true });
        } catch (error) {
          out = null;
        }
        // 老宿主没有 async 模式: 退回同步调用, 至少不会报错
        if (!out || !out.jobId) {
          const sync = await postJson('update', { names });
          const ops = (sync.plan && sync.plan.ops) || [];
          const failed = ((sync.applied && sync.applied.failed) || []);
          if (failed.length) {
            await loadOverview().catch(() => {});
            await loadCheck(false).catch(() => {});
            throw new Error('有 ' + failed.length + ' 个没更新成功：' + failed.map((f) => f.name || f).join('、'));
          }
          if (!ops.length) return '没有需要更新的插件（已经是最新的）';
          const restarted = await restartNow('已更新 ' + ops.length + ' 个插件');
          await loadOverview().catch(() => {});
          await loadCheck(true).catch(() => {});
          return restarted
            ? '已更新 ' + ops.length + ' 个插件，新版本已生效'
            : '已更新 ' + ops.length + ' 个插件，但没能自动重启 —— 关掉软件再打开一次就会生效';
        }

        setJob({ id: out.jobId, state: 'running', progress: 0, steps: [], step: '准备中…', elapsedMs: 0, logTail: [] });
        const started = Date.now();
        let last = null;
        while (Date.now() - started < 20 * 60 * 1000) {
          await new Promise((r) => setTimeout(r, 700));
          let j = null;
          try {
            const got = await getJson('update-status?id=' + encodeURIComponent(out.jobId));
            j = got && got.job;
          } catch (error) {
            continue; // 宿主正在忙, 下一轮再问
          }
          if (!j) continue;
          setJob(j);
          last = j;
          if (j.state !== 'running') break;
        }
        await loadOverview().catch(() => {});
        await loadCheck(true).catch(() => {});

        const res = (last && last.result) || {};
        const results = res.results || [];
        const bad = results.filter((r) => !r.ok);
        const okN = results.filter((r) => r.ok).length;
        if (!results.length) {
          setJob(null);
          return (last && last.error) ? ('没更新成：' + last.error) : '没有需要更新的插件（已经是最新的）';
        }
        if (bad.length) {
          const why = bad.slice(0, 3).map((b) => b.name + '：' + (b.error || '失败')).join(' ｜ ');
          setJob(last);
          throw new Error(bad.length + ' 个没更新成功（' + why + '）' + (res.rollback ? '，已经整体退回备份' : ''));
        }
        const restarted = await restartNow('已更新 ' + okN + ' 个插件');
        setJob(null);
        await loadOverview().catch(() => {});
        await loadCheck(true).catch(() => {});
        if (!restarted) {
          return '已更新 ' + okN + ' 个插件，但没能自动重启 —— 关掉软件再打开一次就会生效';
        }
        return '已更新 ' + okN + ' 个插件' + (res.snapshot ? '（备份在 ' + res.snapshot + '）' : '') + '，新版本已生效';
      });

      /**
       * 上次更新被打断的善后:
       *   restore  用当时的快照整体退回去 (装坏了最稳的出路)
       *   dismiss  只是记录残留, 手动确认不再提醒
       */
      const doRecover = (action) => wrap(action === 'restore' ? '正在退回备份…' : '正在处理…', async () => {
        const r = await postJson('recover', { action });
        if (action === 'dismiss') {
          setRecov(null);
          await loadOverview().catch(() => {});
          return '好，这条提醒不再出现（备份还留着，随时可以在「设置 → 备份还原」里退回去）';
        }
        await restartNow('已退回备份 ' + (r.restored || ''));
        setRecov(null);
        await loadOverview().catch(() => {});
        await loadCheck(true).catch(() => {});
        return '已退回备份 ' + (r.restored || '') + '，重启后用旧版本起来了';
      });

      // 关掉 / 打开: 只改配置, 不自动重启软件.
      // 重启会把整个窗口关掉再打开, 用户只是关一个插件, 不该被这么打断 ——
      // 而且之前的"自杀式重启"会留下孤儿宿主、抢 task-board 账本锁, 直接导致应用起不来.
      const doToggle = (p) => wrap(p.disabled ? '正在打开…' : '正在关掉…', async () => {
        await postJson('toggle', { name: p.name, disabled: !p.disabled });
        await loadOverview().catch(() => {});
        const what = (p.disabled ? '已打开 ' : '已关掉 ') + (p.title || p.name);
        return what + ' —— 点上方的「重启软件」才会真正生效';
      });

      // 手动重启软件: 关干净再自动打开, 用来看新装的插件 / 新代码
      const doRestart = () => wrap('正在重启软件…', async () => {
        const ok = await restartNow('');
        return ok ? '重启好了' : '没能重启，请手动关掉软件再打开一次';
      });

      // 卸载: 先让人看清要删什么. 卸载前宿主侧会自动建一份快照, 后悔能回滚.
      const doUninstall = (p) => wrap('正在删除…', async () => {
        const label = p.title || p.name;
        const ask =
          '要删掉「' + label + '」吗？\n(' + p.name + (p.version ? ' v' + p.version : '') + ')\n\n' +
          '删之前会自动备份一份，之后在「设置 → 备份还原」里能恢复。\n' +
          '删完会自动重启软件，不用你手动关。';
        if (!window.__dpmNoConfirm && !window.confirm(ask)) return null;
        const out = await postJson('install', { action: 'uninstall', name: p.name });
        if (!out.ok) throw new Error('没删掉：' + (out.stderr || 'HTTP ' + out.status));
        await restartNow('已删掉 ' + label);
        await loadOverview().catch(() => {});
        return '已删掉 ' + label + '（备份在 ' + out.snapshot + '）';
      });

      const doFix = () => wrap('正在修…', async () => {
        const out = await postJson('fix', {});
        const applied = out.applied || {};
        const done = applied.done || [];
        await loadDoctor();
        await loadOverview();
        return '修好了 ' + done.length + ' 个问题' + (applied.snapshot ? '（已备份）' : '');
      });

      const doClean = () => wrap('正在清…', async () => {
        const out = await postJson('clean', { includeUnsafe: false });
        const applied = out.applied || {};
        await loadClean();
        return '删掉 ' + (applied.deleted || 0) + ' 个文件，腾出 ' + fmtSize(applied.freedBytes);
      });

      const doPolicy = (name, patch) => wrap('正在保存…', async () => {
        await postJson('policy', Object.assign({ name }, patch));
        await loadOverview();
        return '保存好了';
      });

      // 批量改策略: 一次请求写完, 用来支撑「全选」按钮
      const doPolicyBulk = (names, patch, label) => wrap(label || '正在保存…', async () => {
        const list = (names || []).filter(Boolean);
        if (!list.length) return '没有可以改的插件';
        const out = await postJson('policy-bulk', { names: list, patch });
        await loadOverview();
        const keys = Object.keys(patch);
        const what = keys.map((k) => (k === 'checkEnabled' ? '自动查新版本' : k === 'autoInstall' ? '自动装新版' : k)).join(' + ');
        return '已为 ' + (out.changed || list.length) + ' 个插件' + (patch[keys[0]] ? '打开' : '关闭') + '「' + what + '」';
      });

      // 一次性把缺中文的插件名/说明补齐(来源: 市场目录里的中文条目)
      const doFillNames = () => wrap('正在补中文…', async () => {
        const out = await postJson('names', { action: 'fill' });
        await loadOverview();
        const n = (out.filled || []).length;
        const s = (out.skipped || []).length;
        if (!n) return '没得补（市场目录里也找不到中文说明）：' + s + ' 个';
        return '补好了 ' + n + ' 个插件的中文说明' + (s ? '，跳过 ' + s + ' 个' : '') + ' · 刷新页面就能看到';
      });

      // 从每个插件自己的 README 里抽「怎么用」那一段, 存进登记表 (升级不会丢)
      const doFillUsage = () => wrap('正在从插件说明里找「怎么用」…', async () => {
        const out = await postJson('names', { action: 'fill-usage' });
        await loadOverview();
        const n = (out.filled || []).length;
        const s = (out.skipped || []).length;
        if (!n) return '这些插件的说明里没写「怎么用」：' + s + ' 个';
        return '找到了 ' + n + ' 个插件的「怎么用」' + (s ? '，' + s + ' 个作者没写用法' : '') + ' · 展开插件名下面的「怎么用」就能看';
      });

      // 侧边栏开关: 写后端 settings.json + 立刻更新本地缓存, 然后重启宿主才真正生效.
      // 不自动重启 —— 关掉侧边栏这种事不值得打断用户当前正在做的事, 提示一句让他自己挑时机.
      const doSidebar = (on) => wrap(on ? '正在打开侧边栏图标…' : '正在关掉侧边栏图标…', async () => {
        const out = await postJson('settings', { showInSidebar: !!on });
        rememberSidebar(!!on);
        setAppCfg({ showInSidebar: out.showInSidebar === true });
        return (on ? '已打开' : '已关掉') + '侧边栏图标 · 重启软件后生效';
      });

      const doSnapshot = () => wrap('正在备份…', async () => {
        await postJson('snapshots', { action: 'create' });
        await loadSnaps();
        return '备份好了';
      });

      const doRestore = (id) => wrap('正在还原…', async () => {
        const out = await postJson('snapshots', { action: 'restore', id });
        await loadOverview();
        await loadSnaps();
        return '已还原到 ' + id;
      });

      const tabBtn = (key, text) => h('button', { className: 'dpm-tab' + (tab === key ? ' on' : ''), onClick: () => setTab(key) }, text);

      const status = h(
        'div',
        null,
        busy ? h('div', { className: 'dpm-note' }, busy) : null,
        err ? h('div', { className: 'dpm-err' }, '出错了：' + err) : null,
        msg ? h('div', { className: 'dpm-ok' }, msg) : null
      );

      let content = null;

      if (tab === 'safety') {
        const s = (safety && safety.summary) || {};
        const rows = (safety && safety.rows) || [];
        const levelTone = { danger: 'var(--dpm-danger)', caution: 'var(--dpm-warn)', info: 'var(--dpm-accent)', safe: 'var(--dpm-ok)', unknown: 'var(--dpm-fg)' };
        const levelLabel = { danger: '有风险', caution: '正常会用到的', info: '轻微', safe: '很干净', unknown: '没看过' };
        content = h(
          'div',
          null,
          h(
            'div',
            { className: 'dpm-cards' },
            h(Card, { value: s.danger || 0, label: '有风险' }),
            h(Card, { value: s.caution || 0, label: '要联网/跑命令' }),
            h(Card, { value: (s.info || 0) + (s.safe || 0), label: '轻微或没问题' }),
            h(Card, { value: s.total || 0, label: '看了几个' })
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(Btn, { tone: 'pri', disabled: !!busy, onClick: () => loadSafety() }, '再看看'),
            h('span', { className: 'dpm-sub' }, '只看代码不运行，也不联网；结果存在 .state/safety')
          ),
          status,
          h(
            'div',
            { className: 'dpm-note', style: { marginBottom: 10 } },
            '这一页只是给你提个醒，不会拦着你装。怎么看：把插件代码里的注释和语言包去掉后对规则。「有风险」= 藏起来看不懂的代码 / 反向连到别人的机器 / 偷读你的账号密码；「要联网/跑命令」= 会起外部程序、会上网、会写文件 —— 绝大多数功能完整的插件都会这样，属于正常。'
          ),
          rows.length
            ? rows.map((r) =>
                h(
                  'div',
                  { key: r.name, className: 'dpm-row', style: { alignItems: 'flex-start', flexDirection: 'column' } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', width: '100%' } },
                    h('span', { className: 'dpm-badge', style: { borderColor: levelTone[r.level], color: levelTone[r.level] } }, levelLabel[r.level] || r.level),
                    h('span', { className: 'dpm-nm' }, r.title || r.name),
                    h('span', { className: 'dpm-sub' }, 'v' + (r.version || '?')),
                    h('span', { className: 'dpm-sub', style: { marginLeft: 'auto' } }, (r.counts && r.counts.high ? r.counts.high + ' 类风险 · ' : '') + (r.counts && r.counts.medium ? r.counts.medium + ' 类正常能力' : '') + (r.counts && !r.counts.high && !r.counts.medium ? '没发现问题' : ''))
                  ),
                  h('div', { className: 'dpm-sub', style: { width: '100%', marginTop: 3 } }, r.verdict || ''),
                  (r.findings || []).length
                    ? h(
                        'div',
                        { style: { width: '100%', marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--dpm-line-strong)' } },
                        r.findings.slice(0, 8).map((f, i) =>
                          h(
                            'div',
                            { key: f.id + ':' + i, className: 'dpm-sub', style: { marginBottom: 4 } },
                            h('span', { style: { color: levelTone[f.level] || 'inherit', fontWeight: 600 } }, (levelLabel[f.level] || f.level) + ' '),
                            h('span', null, f.title || f.id),
                            f.file ? h('span', { style: { opacity: 0.62 } }, '  ' + f.file + (f.line ? ':' + f.line : '')) : null,
                            f.snippet ? h('div', { style: { opacity: 0.55, marginTop: 1, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11.5 } }, String(f.snippet).slice(0, 130)) : null
                          )
                        )
                      )
                    : null
                )
              )
            : h('div', { className: 'dpm-empty' }, safety ? '没有可以看的插件' : '正在看…')
        );
      }

      if (tab === 'market') {
        const list = (mkt && mkt.plugins) || [];
        const cats = (mkt && mkt.categories) || [];
        const levelTone = { danger: 'var(--dpm-danger)', caution: 'var(--dpm-warn)', info: 'var(--dpm-accent)', safe: 'var(--dpm-ok)', unknown: 'var(--dpm-fg)' };
        const levelLabel = { danger: '有风险', caution: '正常会用到的', info: '轻微', safe: '很干净', unknown: '没看过' };
        const ag = (mktAudit && mktAudit.grade) || null;
        const compat = (mktItem && mktItem.resolved && mktItem.resolved.compat) || null;
        const reload = () => loadMarket(mktQ, mktCat, false, { sort: mktSort, noBad: mktNoBad });
        const pickSort = (v) => { setMktSort(v); loadMarket(mktQ, mktCat, false, { sort: v, noBad: mktNoBad }); };
        const toggleNoBad = () => { const v = !mktNoBad; setMktNoBad(v); loadMarket(mktQ, mktCat, false, { sort: mktSort, noBad: v }); };
        content = h(
          'div',
          null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 17, fontWeight: 650 } }, '插件市场'),
            h('div', { className: 'dpm-sub', style: { opacity: 0.6 } }, '社区给 DeepSeek-Harness 做的插件 · 装之前先帮你看一眼'),
            h('span', { className: 'dpm-sub', style: { marginLeft: 'auto' } },
              '共 ' + ((mkt && mkt.total) || 0) + ' 个 · 源 ' + ((mkt && mkt.source) || '?') + ' · 目录 v' + ((mkt && mkt.catalogVersion) || '?'))
          ),
          h(
            'div',
            { className: 'dpm-tools', style: { marginTop: 10 } },
            h('input', {
              className: 'dpm-input',
              style: { flex: '1 1 260px', minWidth: 190 },
              placeholder: '搜插件名 / 说明 / 作者…',
              value: mktQ,
              onChange: (e) => setMktQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') reload(); },
            }),
            h(Btn, { disabled: !!busy, onClick: reload }, '搜索'),
            h(Btn, { disabled: !!busy, onClick: () => loadMarket(mktQ, mktCat, true, { sort: mktSort, noBad: mktNoBad }) }, '重新拉一遍'),
            h(
              'select',
              { className: 'dpm-input', value: mktSort, onChange: (e) => pickSort(e.target.value) },
              h('option', { value: 'recent' }, '最新上架'),
              h('option', { value: 'downloads' }, '最多人装'),
              h('option', { value: 'stars' }, '收藏最多'),
              h('option', { value: 'name' }, '按名称')
            ),
            h(
              'button',
              { className: 'dpm-chip' + (mktNoBad ? ' on' : ''), onClick: toggleNoBad, title: '把会读账号密码、或者能动态执行代码的插件藏起来' },
              '藏起会读密码的'
            )
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h('button', { className: 'dpm-chip' + (mktCat === 'all' ? ' on' : ''), onClick: () => { setMktCat('all'); loadMarket(mktQ, 'all', false, { sort: mktSort, noBad: mktNoBad }); } }, '全部'),
            cats.slice(0, 16).map((c) =>
              h('button', {
                key: c.key,
                className: 'dpm-chip' + (mktCat === c.key ? ' on' : ''),
                onClick: () => { setMktCat(c.key); loadMarket(mktQ, c.key, false, { sort: mktSort, noBad: mktNoBad }); },
              }, MK_CAT[c.key] ? MK_CAT[c.key] + ' ' + c.count : c.key + ' ' + c.count)
            )
          ),
          status,
          h(
            'div',
            { className: 'dpm-note' },
            '找到 ' + ((mkt && mkt.total) || 0) + ' 个，这里先显示 ' + list.length + ' 个。点一下卡片，会先查最新版本 + 看一遍代码安不安全，报告出来之后才出现「安装」按钮 —— 装之前自动备份，装完自动重启，不用你手动关。'
          ),
          // 选中条目的详情 + 安检报告
          mktItem
            ? h(
                'div',
                { style: { border: '1px solid var(--dpm-accent)', borderRadius: 10, padding: '10px 12px', marginBottom: 12 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { className: 'dpm-nm' }, mktItem.title || mktItem.npm),
                  h('span', { className: 'dpm-sub' }, mktItem.npm || '（没有可安装的包名）'),
                  mktItem.resolved && mktItem.resolved.version ? h(Badge, { tone: 'market' }, 'v' + mktItem.resolved.version) : null,
                  mktItem.installed ? h(Badge, { tone: 'up' }, '已装 ' + (mktItem.installed.version || '?')) : null,
                  ag ? h('span', { className: 'dpm-badge', style: { borderColor: levelTone[ag.level], color: levelTone[ag.level] } }, '检查结果: ' + (levelLabel[ag.level] || ag.level)) : null,
                  compat
                    ? h('span', { className: 'dpm-badge', style: { borderColor: compat.unknown ? 'var(--dpm-warn)' : (compat.ok === false ? 'var(--dpm-danger)' : 'var(--dpm-ok)'), color: compat.unknown ? 'var(--dpm-warn)' : (compat.ok === false ? 'var(--dpm-danger)' : 'var(--dpm-ok)') } },
                        '能不能装: ' + (compat.unknown ? '作者没说，不确定' : (compat.ok === false ? '装不了，版本不配套' : '可以装')) + (compat.hostVersion ? '（你的软件 ' + compat.hostVersion + '）' : ''))
                    : null,
                  h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
                    h(Btn, { disabled: !!busy || !mktAudit, tone: ag && ag.level === 'danger' ? 'danger' : 'pri', onClick: () => doInstall(mktItem) }, '安装' + (mktItem.resolved && mktItem.resolved.version ? ' v' + mktItem.resolved.version : '')),
                    h(Btn, { disabled: !!busy, onClick: () => { setMktItem(null); setMktAudit(null); } }, '关闭')
                  )
                ),
                mktItem.desc ? h('div', { className: 'dpm-sub', style: { marginTop: 4 } }, String(mktItem.desc).slice(0, 300)) : null,
                compat && ((compat.reasons || []).length || (compat.notes || []).length)
                  ? h('div', { style: { marginTop: 6 } },
                      (compat.reasons || []).map((r, i) => h('div', { key: 'c' + i, className: 'dpm-sub', style: { color: compat.ok === false ? 'var(--dpm-danger)' : 'var(--dpm-warn)' } }, '· ' + r)),
                      (compat.notes || []).map((r, i) => h('div', { key: 'n' + i, className: 'dpm-sub', style: { opacity: 0.7 } }, '· ' + r))
                    )
                  : null,
                ag
                  ? h('div', { style: { marginTop: 8 } },
                      h('div', { className: 'dpm-sub', style: { fontWeight: 600 } }, '安全检查: ' + ag.verdict),
                      mktAudit.files ? h('div', { className: 'dpm-sub', style: { opacity: 0.7 } }, '扫描 ' + mktAudit.files.scanned + '/' + mktAudit.files.total + ' 个文件 · ' + Math.round((mktAudit.files.bytes || 0) / 1024) + ' KB · tarball ' + (mktAudit.tarballBytes || 0) + ' B') : null,
                      (mktAudit.source && mktAudit.source.checks || []).map((c, i) =>
                        h('div', { key: i, className: 'dpm-sub', style: { marginTop: 2 } },
                          h('span', { style: { color: c.ok ? 'var(--dpm-ok)' : 'var(--dpm-warn)' } }, (c.ok ? '✓ ' : '! ') + c.label),
                          c.detail ? h('span', { style: { opacity: 0.55 } }, ' — ' + String(c.detail).slice(0, 120)) : null
                        )
                      ),
                      (ag.ruleHits || []).map((hh, i) =>
                        h('div', { key: 'r' + i, className: 'dpm-sub', style: { marginTop: 3 } },
                          h('span', { style: { color: levelTone[hh.level] || 'inherit', fontWeight: 600 } }, (levelLabel[hh.level] || hh.level) + ' '),
                          h('span', null, (hh.title || hh.id) + ' ×' + hh.count),
                          h('div', { style: { opacity: 0.55, fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11.5 } }, hh.sample.file + (hh.sample.line ? ':' + hh.sample.line : '') + '  ' + String(hh.sample.snippet || '').slice(0, 110))
                        )
                      )
                    )
                  : null
              )
            : null,
          list.length
            ? h(
                'div',
                { className: 'dpm-mkt' },
                list.map((p) => {
                  const bad = (p.caps || []).filter((c) => MK_BAD_CAP.indexOf(c) >= 0);
                  const isOn = mktItem && (mktItem.npm || mktItem.name) === (p.npm || p.name);
                  const initial = String(p.title || p.npm || '?').trim().slice(0, 1).toUpperCase();
                  return h(
                    'div',
                    {
                      key: p.npm || p.name || p.title,
                      className: 'dpm-mk' + (isOn ? ' on' : ''),
                      title: '点开：先查版本，再看代码',
                      onClick: () => { if (!busy) inspectMarket(p); },
                    },
                    h(
                      'div',
                      { className: 'dpm-mkhead' },
                      p.icon
                        ? h('img', { className: 'dpm-mkicon', src: p.icon, alt: '', onError: (e) => { e.target.style.visibility = 'hidden'; } })
                        : h('div', { className: 'dpm-mkicon ph' }, initial),
                      h(
                        'div',
                        { style: { minWidth: 0, flex: 1 } },
                        h('div', { className: 'dpm-mktitle' }, p.title || p.npm),
                        h('div', { className: 'dpm-mkmeta' },
                          [
                            p.author,
                            p.version ? 'v' + p.version : null,
                            p.downloads ? '↓' + fmtNum(p.downloads) : null,
                            p.stars ? '★' + fmtNum(p.stars) : null,
                          ].filter(Boolean).join(' · '))
                      ),
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end', flex: 'none' } },
                        p.installed ? h(Badge, { tone: 'self' }, '✓ 已经装了') : null,
                        bad.length ? h('span', { className: 'dpm-badge off' }, bad.indexOf('credentials') >= 0 ? '会读密码' : '动态代码') : null
                      )
                    ),
                    p.desc ? h('div', { className: 'dpm-mkdesc' }, p.desc) : null,
                    (p.screens || []).length
                      ? h('div', { className: 'dpm-mkshot' }, p.screens.map((s, i) => h('img', { key: i, src: s, alt: '' })))
                      : null,
                    (p.caps || []).length
                      ? h('div', { className: 'dpm-mkcaps' },
                          (p.caps || []).slice(0, 7).map((c) => h('span', { key: c, className: 'dpm-mkcap' + (MK_BAD_CAP.indexOf(c) >= 0 ? ' bad' : '') }, MK_CAP[c] || c)))
                      : null,
                    h(
                      'div',
                      { className: 'dpm-mkfoot' },
                      h('span', { className: 'dpm-sub' }, (MK_CAT[p.category] || p.category || '没分类') + (p.added ? ' · ' + p.added : '')),
                      h('span', { style: { marginLeft: 'auto' } },
                        h(Btn, {
                          disabled: !!busy || !p.npm,
                          tone: 'pri',
                          onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); inspectMarket(p); },
                        }, p.installed ? '查看/重装' : '看一遍再装'))
                    )
                  );
                })
              )
            : h('div', { className: 'dpm-empty' }, mkt ? '没找到符合的插件' : '正在打开市场…')
        );
      }

      if (tab === 'plugins') {
        const cards = h(
          'div',
          { className: 'dpm-cards' },
          h(Card, { value: counts.total || plugins.length, label: '插件总共' }),
          h(Card, { value: check ? check.summary.updatable : '-', label: '能更新' }),
          h(Card, { value: (counts.self || 0) + ' / ' + (counts.market || 0), label: '我做的 / 市场装的' }),
          h(Card, { value: counts.builtin || 0, label: '系统自带' }),
          h(Card, { value: counts.disabled || 0, label: '已关掉' })
        );
        const tools = h(
          'div',
          { className: 'dpm-tools' },
          h(Btn, { disabled: !!busy, onClick: () => loadCheck(true) }, '查新版本'),
          h(Btn, { tone: 'pri', disabled: !!busy || !updatable.length, onClick: () => doUpdate(updatable) }, '一键全更新 (' + updatable.length + ')'),
          h(Btn, { disabled: !!busy, onClick: doFillNames, title: '把没有中文说明的插件补齐（用市场里的中文介绍）' }, '补中文说明'),
          h(Btn, { disabled: !!busy, onClick: doFillUsage, title: '从每个插件自己的说明文档里，抽出「装好之后怎么用」那一段' }, '补怎么用'),
          h('input', { className: 'dpm-input', placeholder: '搜插件名 / 中文名 / 说明', value: q, onChange: (e) => setQ(e.target.value) }),
          h('span', { className: 'dpm-sub' }, '哪来的：'),
          h('button', { className: 'dpm-chip' + (origin === 'all' ? ' on' : ''), onClick: () => setOrigin('all') }, '全部'),
          h('button', { className: 'dpm-chip' + (origin === 'self' ? ' on' : ''), onClick: () => setOrigin('self') }, '我做的'),
          h('button', { className: 'dpm-chip' + (origin === 'market' ? ' on' : ''), onClick: () => setOrigin('market') }, '市场装的'),
          h('button', { className: 'dpm-chip' + (origin === 'builtin' ? ' on' : ''), onClick: () => setOrigin('builtin') }, '系统自带'),
          h('button', { className: 'dpm-chip' + (origin === 'missing' ? ' on' : ''), onClick: () => setOrigin('missing') }, '找不到了'),
          h('button', { className: 'dpm-chip' + (upOnly ? ' on' : ''), onClick: () => setUpOnly(!upOnly) }, '只看能更新的'),
          h(
            'select',
            { className: 'dpm-input', value: group, onChange: (e) => setGroup(e.target.value) },
            h('option', { value: 'all' }, '所有分组'),
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
                onUninstall: doUninstall,
              })
            )
          : h('div', { className: 'dpm-empty' }, ov ? '没找到符合条件的插件' : '正在读…');
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
            h(Card, { value: s.errors || 0, label: '严重问题' }),
            h(Card, { value: s.warns || 0, label: '需要注意' }),
            h(Card, { value: s.infos || 0, label: '提个醒' })
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(Btn, { disabled: !!busy, onClick: loadDoctor }, '再体检一次'),
            h(Btn, { tone: 'pri', disabled: !!busy, onClick: doFix }, '能修的一键修好')
          ),
          status,
          doc && doc.findings && doc.findings.length
            ? doc.findings.map((f, i) => h(Finding, { key: f.code + ':' + i, finding: f }))
            : h('div', { className: 'dpm-empty' }, doc ? '检查过了，一切正常，没有发现问题' : '正在体检…')
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
            h(Card, { value: s.capability || 0, label: '功能重复的组' }),
            h(Card, { value: s.inject || 0, label: '抢同一位置的' }),
            h(Card, { value: s.multiVersion || 0, label: '同名装了多份' }),
            h(Card, { value: fmtSize(dup && dup.totalBytes), label: '插件一共占' })
          ),
          h('div', { className: 'dpm-tools' }, h(Btn, { disabled: !!busy, onClick: loadDupes }, '再查一遍')),
          status,
          findList.length
            ? findList.map((f, i) => h(Finding, { key: f.code + ':' + i, finding: f }))
            : h('div', { className: 'dpm-empty' }, dup ? '没有重复的插件，很清爽' : '正在查…')
        );
      }

      if (tab === 'clean') {
        const items = (cln && cln.items) || [];
        const KIND_TEXT = { cache: '缓存', log: '日志', temp: '临时文件', backup: '旧备份', duplicate: '重复文件' };
        content = h(
          'div',
          null,
          h(
            'div',
            { className: 'dpm-cards' },
            h(Card, { value: cln ? cln.safeCount : '-', label: '能放心删的' }),
            h(Card, { value: fmtSize(cln && cln.safeBytes), label: '能腾出的空间' }),
            h(Card, { value: fmtSize(cln && cln.totalBytes), label: '全部加起来' })
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(Btn, { disabled: !!busy, onClick: loadClean }, '再找一遍'),
            h(Btn, { tone: 'pri', disabled: !!busy || !items.length, onClick: doClean }, '删掉这些垃圾')
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
                    h('div', { className: 'dpm-sub' }, (KIND_TEXT[it.kind] || it.kind) + ' · ' + (it.safe ? '可以删' : '建议先看一眼') + (it.reason ? ' · ' + it.reason : ''))
                  ),
                  h('span', { className: 'dpm-sub' }, fmtSize(it.sizeBytes))
                )
              )
            : h('div', { className: 'dpm-empty' }, cln ? '干干净净，没有垃圾' : '正在找…')
        );
      }

      if (tab === 'settings') {
        const policy = (ov && ov.policy && ov.policy.packages) || {};
        const list = plugins.filter((p) => p.origin === 'market');
        const names = list.map((p) => p.name);
        const polOf = (p) => policy[p.name] || {};
        const nCheck = list.filter((p) => polOf(p).checkEnabled !== false).length;
        const nAuto = list.filter((p) => polOf(p).autoInstall === true).length;
        const allCheck = list.length > 0 && nCheck === list.length;
        const anyCheck = nCheck > 0;
        const allAuto = list.length > 0 && nAuto === list.length;
        const anyAuto = nAuto > 0;
        content = h(
          'div',
          null,
          h('div', { className: 'dpm-sect' }, '自动更新设置（按插件分别开关）'),
          h('div', { className: 'dpm-note' }, '勾上之后，插件的自动检查会把它记进 stardustlc-plugin-updates.json，插件市场 App 和这里的开关是同一份设置。'),
          h(
            'div',
            { className: 'dpm-tools' },
            h(
              Btn,
              {
                tone: 'pri',
                disabled: !!busy || !list.length,
                onClick: () => doPolicyBulk(names, { checkEnabled: true, autoInstall: true }, '正在全部打开…'),
                title: '把下面所有市场插件的「自动查新版本」和「自动装新版」都打开',
              },
              '全部打开 (' + list.length + ')'
            ),
            h(
              Btn,
              {
                // 取消永远可点 —— 之前多写了个 (allCheck && allAuto) 判断, 结果全勾满时
                // 这个按钮反而被禁用, 用户就没法取消全选了
                disabled: !!busy || !list.length,
                onClick: () => doPolicyBulk(names, { checkEnabled: false, autoInstall: false }, '正在全部关闭…'),
              },
              '全部关闭'
            )
          ),
          h(
            'div',
            { className: 'dpm-tools' },
            h(
              Btn,
              {
                // 切换语义: 没全勾 -> 全勾上; 已全勾 -> 全部取消. 永远可点.
                disabled: !!busy || !list.length,
                onClick: () => doPolicyBulk(names, { checkEnabled: !allCheck }),
              },
              (allCheck ? '取消' : anyCheck ? '补上' : '全选') + '「自动查新版本」'
            ),
            h(
              Btn,
              {
                disabled: !!busy || !list.length,
                onClick: () => doPolicyBulk(names, { autoInstall: !allAuto }),
              },
              (allAuto ? '取消' : anyAuto ? '补上' : '全选') + '「自动装新版」'
            ),
            h('span', { className: 'dpm-sub' }, '已开 ' + nCheck + ' / ' + nAuto + '，共 ' + list.length + ' 个市场插件')
          ),
          status,
          list.map((p) => {
            const pol = polOf(p);
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
                { className: 'dpm-sub dpm-swrow', title: '有新版本时，检查一下' },
                h(Switch, { checked: pol.checkEnabled !== false, disabled: !!busy, onChange: (v) => doPolicy(p.name, { checkEnabled: v }) }),
                '自动查新版本'
              ),
              h(
                'label',
                { className: 'dpm-sub dpm-swrow', title: '查到新版本就直接装' },
                h(Switch, { checked: pol.autoInstall === true, disabled: !!busy, onChange: (v) => doPolicy(p.name, { autoInstall: v }) }),
                '自动装新版'
              )
            );
          }),
          h('div', { className: 'dpm-hr' }),
          h('div', { className: 'dpm-sect' }, '侧边栏显示「插件管家」'),
          h(
            'label',
            { className: 'dpm-sub dpm-swrow' },
            h(Switch, { checked: !!appCfg.showInSidebar, disabled: !!busy, onChange: (v) => doSidebar(v) }),
            '在左侧边栏放一个「插件管家」图标'
          ),
          h(
            'div',
            { className: 'dpm-note' },
            appCfg.showInSidebar
              ? '现在是开着的。关掉之后，还是可以从「插件市场」页的标签行进入。改完要重启软件才生效。'
              : '默认关着 —— 从「插件市场」页的标签行就能进来，侧边栏不用再占一格。想加回来就勾上，然后重启软件。'
          ),
          h('div', { className: 'dpm-hr' }),
          h('div', { className: 'dpm-sect' }, '定时自动检查'),
          schedule && schedule.installed
            ? h(
                'div',
                { className: 'dpm-note' },
                '已经开着了：下次 ' + (schedule.nextRun || '?') + ' · 上次 ' + (schedule.lastRun || '还没跑过')
              )
            : h('div', { className: 'dpm-note' }, '还没开。在终端跑 dsh-pm schedule install --time 09:30 --write 就能开。'),
          h('div', { className: 'dpm-hr' }),
          h('div', { className: 'dpm-sect' }, '备份还原（搞坏了能退回上一步）'),
          h('div', { className: 'dpm-tools' }, h(Btn, { disabled: !!busy, onClick: doSnapshot }, '现在备份一份')),
          snaps && snaps.snapshots && snaps.snapshots.length
            ? snaps.snapshots.map((s2) =>
                h(
                  'div',
                  { className: 'dpm-row', key: s2.id },
                  h(
                    'div',
                    { className: 'dpm-grow' },
                    h('div', { className: 'dpm-nm' }, s2.id),
                    h('div', { className: 'dpm-sub' }, (s2.reason || '手动备份') + ' · 存了 ' + ((s2.files || []).length) + ' 个文件')
                  ),
                  h(Btn, { tone: 'danger', disabled: !!busy, onClick: () => doRestore(s2.id) }, '退回这个')
                )
              )
            : h('div', { className: 'dpm-empty' }, '还没备份过')
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
          ov && ov.host && ov.host.version ? h('span', { className: 'dpm-sub' }, '软件版本 ' + ov.host.version) : null,
          ov && ov.tool && ov.tool.version ? h('span', { className: 'dpm-sub' }, '管家 v' + ov.tool.version) : null,
          ov ? h('span', { className: 'dpm-sub' }, ov.profile) : null,
          h(Btn, { disabled: !!busy, onClick: doReload, title: '列表、更新检查、备份记录一起刷一遍' }, '重新读一遍'),
          h(Btn, { disabled: !!busy, onClick: doRestart, title: '关掉软件再自动打开（约 6 秒）—— 新装的插件、改过的设置都靠它生效' }, '重启软件')
        ),
        // 「上次没装完」的提醒: 装到一半断电/被强退, node_modules 里会留半套文件, 下次可能起不来.
        recov && recov.verdict === 'needs-restore'
          ? h(
              'div',
              { className: 'dpm-body', style: { padding: '8px 14px 0' } },
              h(
                'div',
                { className: 'dpm-err' },
                '上次装到一半没装完（' + ((recov.pending && recov.pending.at) || '时间不明') + '），要不要退回那次之前的备份？'
              ),
              recov.broken && recov.broken.length
                ? h('div', { className: 'dpm-sub' }, '看着不对的：' + recov.broken.join(', '))
                : null,
              h(
                'div',
                { className: 'dpm-tools' },
                h(Btn, { tone: 'pri', disabled: !!busy, onClick: () => doRecover('restore') }, '退回备份并重开'),
                h(Btn, { disabled: !!busy, onClick: () => doRecover('dismiss') }, '不用，我知道了')
              )
            )
          : null,
        // 更新进度: 每一步都写出来, 并且保留 pnpm 输出的最后几行.
        job
          ? h(
              'div',
              { className: 'dpm-body', style: { padding: '8px 14px 0' } },
              h(
                'div',
                { className: 'dpm-sub' },
                (job.state === 'running' ? '正在更新：' : job.state === 'updated' ? '更新完了：' : '更新没成功：') +
                  (job.step || '准备中')
              ),
              h('div', { className: 'dpm-prog' }, h('i', { style: { width: Math.round((job.progress || 0) * 100) + '%' } })),
              job.logTail && job.logTail.length ? h('div', { className: 'dpm-log' }, job.logTail.slice(-6).join('\n')) : null
            )
          : null,
        h(
          'div',
          { className: 'dpm-tabs' },
          tabBtn('plugins', '我的插件'),
          tabBtn('safety', '有风险吗'),
          tabBtn('health', '体检'),
          tabBtn('dupes', '重复的'),
          tabBtn('clean', '垃圾清理'),
          tabBtn('settings', '设置')
        ),
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
        // 侧边栏是否出现「插件管家」. 客户端模块是同步加载的, 不能等 await,
        // 所以这里先读一次缓存; 面板里改完开关后我们会把结果写进缓存, 重启后自然生效.
        let sidebarOn = isSidebarEnabled();
        ctx.effect(() => {
          const disposers = [];
          // 侧边栏那一格是可选的 (默认不出现): 面板已经能从「插件市场」页的标签行进去,
          // 侧边栏再占一格是重复的. 想去掉/加回来: 设置 → 侧边栏显示「插件管家」.
          // 设置存在插件自己的 .state/settings.json 里, 改完要重启宿主才生效.
          if (sidebarOn) {
            disposers.push(
              slots.inject('sidebar.panellist', () =>
                slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '插件管家' }, EntryIcon)
              )
            );
          }
          disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel)));
          // 也进「插件市场」页的标签行: plugins.tab 是这个页的 list slot
          // (它自己的「发现」页之后追加一格). id 用自己的, 所以是并排一格,
          // 不顶掉市场页原有的「发现 / 主题 / 收藏 …」.
          disposers.push(
            slots.inject('plugins.tab', () =>
              slots.register({ name: 'plugins.tab', id: PANEL_ID, order: 50, label: () => '插件管家' }, Panel)
            )
          );
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