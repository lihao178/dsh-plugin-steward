# 变更记录

## 1.4.3

**侧边栏那一格变成可选, 默认不出现**
- 面板本来就能从「插件市场」页的标签行进去, 侧边栏再占一格是重复的, 所以默认不再注册
  `sidebar.panellist`。想加回来: **设置 → 侧边栏显示「插件管家」** 勾上, 重启软件生效。
- 新增 `GET/POST /api/dsh-plugin-manager/settings`, 存在插件自己的 `.state/settings.json`,
  不跟 profile 的插件策略混。只有 `showInSidebar` 一个字段, 默认 `false`。
- 客户端是同步加载的 (`apply` 一进来就得决定注册不注册), 不能 `await` 一次 fetch, 所以用
  `localStorage['dpm:showInSidebar']` 做启动缓存; 打开面板时会用后端 `settings.json` 的真值
  校正一次, 两边不会长期对不上。

**pnpm 非 0 退出但活儿干完了, 不再误判为失败**
- 依赖里有 build 脚本被跳过的包会以 `ERR_PNPM_IGNORED_BUILDS` + 退出码 1 结束, 但包其实已经
  装进去了。以前 `runPnpm` 只看退出码 → 面板判失败 → **不重启** → 用户看到「装完没反应」。
- 现在 `runPnpm` 返回 `softFailure`; `install` 路由再以 **磁盘上到底装上没有**
  (`readInstalled`) 为准, 装上了就算成功 (`ok:true`, 附 `softFailure` 说明), 照常触发重启。
- soft code 只认 `ERR_PNPM_IGNORED_BUILDS` / `ERR_PNPM_APPROVE_BUILDS` 两个明确的码,
  不用 `WARN` 这种太宽的词, 免得真失败混一行 WARN 就被当成成功。

**端到端实测 (真跑, 不是推断)**
- 自重启: `POST /restart` → pid `23756 → 26968`, 端口 `52268 → 55731`, 与会话被断开的表现一致。
- 安装: 临时插件 `dsh-e2e-probe` 经 `POST /install` 装上 (pnpm 退出码 1 + IGNORED_BUILDS,
  但 `readInstalled` 确认已落盘 → 判成功)。
- 卸载: `POST /install {action:'uninstall'}` → `ok:true`, 快照已建。
- 自检 `scripts/_selfcheck.mjs` 23/23 通过, exit 0。

## 1.4.2

**装/卸/更新真的闭环了 (两个真 bug)**
- **pnpm 路径算错** —— `src/apply.mjs` 的 `pnpmBin()` 用
  `path.resolve(path.dirname(process.execPath), '..', '..')` 推 pnpm, 那是对**源码布局**成立的
  假设; 打包好的桌面端里 pnpm 在 `exe目录\resources\runtime\primary-runtime\dependencies\pnpm\bin\`
  —— 在 exe 目录**下面**四层, 不是上面两级。于是算出来 `D:\...\AL\pnpm\bin\pnpm.mjs` (不存在),
  安装/卸载/自动更新全部报错。
  现在改成按顺序试 5 类候选并取第一个存在的: ① `DSH_PM_PNPM` 环境变量 ② 打包端
  `resources\runtime\{primary-runtime,runtime}\dependencies\pnpm\bin\pnpm.{mjs,cjs}`
  ③ 老的两级上溯 (源码布局) ④ `~/.dsh/dsh-runtimes/*/dependencies/pnpm` (程序被移动/重装也不受影响)
  ⑤ 由 node 自身位置反推。另加 `pnpmDiagnose()`: 装/卸失败时把「试过哪些路径、哪个存在、
  环境变量是什么」一起返回给面板, 不再只给一句 ENOENT。
- **「重启好了」是假的** —— `client.js` 的 `restartNow()` 轮询 `overview`, 一旦能读就当重启成功;
  但旧进程在收到 SIGTERM 之前仍然能正常应答, 所以它永远"立刻成功", 实际从没重启过,
  这正是"点完更新还显示能更新 4 个"的根因。现在: 重启前记下 `overview.pid`, 之后每 900ms 比一次,
  **pid 变了**才算重启成功; 60 秒内 pid 一直没变就明确报「没能自动重启, 请手动关一次软件」。
- `overview` 新增 `pid` / `startedAt` / `builds`(版本与关键文件 mtime) / `pnpm`(定位诊断),
  面板与自检都靠这几个字段判断「新代码到底有没有生效」。
- 装/卸/更新/停用的顺序改成 **先动手 → 再重启 → 重启完重新读列表**。
  以前是重启前读 check, 所以重启后面板还挂着旧的「能更新 4」。
- 自检脚本从 19 项扩到 23 项, 把这次踩的坑固化成常驻断言: pnpm 能否定位、overview 是否带 pid、
  restart 路由是否可用、check 是否留下「当前版本 == 目标版本」的陈旧条目。任何一项失败就
  exit code 1, 不再"看着像是好的"。

## 1.4.1

**面板里的字全换成大白话 (功能一行没动)**
- 标签页: `我的插件 / 有风险吗 / 体检 / 重复的 / 垃圾清理 / 设置`
  (原「已装插件 / 安全检查 / 体检 / 重复 / 清理 / 设置」)。
- 按钮: `更新 / 打开|关掉 / 删除 / 再看看 / 重新读一遍 / 现在备份一份 / 退回这个`
  (原「升级 / 启用|停用 / 卸载 / 重新扫描 / 刷新 / 立即快照 / 恢复」)。
- 提示语: 全部改成说人话的进度句, 例如「正在查有没有新版本(要联网, 等一下)…」
  「正在看插件代码有没有风险(只看不跑, 不联网)…」「正在自动重启软件…(约 5 秒, 不用你手动关)」。
  成功提示也改口: 「已装好 X(备份在 Y)」「删掉 N 个文件, 腾出 …」「补好了 N 个插件的中文说明」。
- 来源徽章: `我自己做的 / 市场装的 / 系统自带 / 找不到(没装上) / 不知道哪来的`
  (`src/scan.mjs` 的 `ORIGIN_LABEL`、`SOURCE_LABEL` 同步改)。
- 安全检查(`src/safety.mjs`): 13 条规则标题全部改白话——「能把文字当代码跑起来」
  「会启动别的程序」「会联网」「去翻你的密码 / 密钥文件」「像是从外面反向控制这台电脑」
  「一大段看不懂的加密字符串」等; 结论句改成「没看到可疑的东西 / 会用到 N 类正常能力
  (起外部程序 / 联网 / 写文件), 功能完整的插件基本都这样」。
- 体检等级: 严重 / 注意 / 提示; 版本类型: 大版本 / 小版本 / 修补版 / 测试版; 风险等级:
  有风险 / 正常会用到的 / 轻微 / 很干净 / 没看过。
- 阈值、规则、路由、备份、重启等**行为全部没改**, 19 项活宿主机自检仍 19/19 通过;
  磁盘上 safety 复测 `danger:0`。

## 1.4.0

**更新 / 安装 / 卸载 / 停用之后自动重启, 不用手动关软件**
- 新增 `POST /api/dsh-plugin-manager/restart`(第 18 条路由) 与 `src/restart.mjs`。
- 原理照抄 dshmarket 的 `scheduleRestart`: 记下当前进程的 `execPath` + 启动参数 + cwd,
  写成 `.state/restart-helper.cjs`, **detached** 拉起这个 helper, 600ms 后给自己发
  `SIGTERM`; helper 等 1.5 秒(让 Windows 把端口放干净)后用同样的参数把宿主重新拉起。
  端口通常不变, 所以浏览器不用换地址。
- 面板里 `doUpdate` / `doInstall` / `doUninstall` / `doToggle` 成功之后都调 `restartNow()`:
  先 `POST restart`(即使连接被重置也算成功), 然后每 1.2 秒轮询 `overview`, 最多 45 秒,
  一活过来就提示「已重启完成 ✅ 刷新页面(Ctrl+F5)即可看到新版本」。所有「重启后才生效」
  的文案都改成了「会自动重启, 不用手动关软件」。
- 验证: `dryRun` 返回真实启动命令; 用假宿主进程跑 helper, marker 文件确认子进程被成功拉起;
  19 项活宿主机自检仍 19/19。
- 注意: **这一次**上线仍需手动重启一次(当前运行中的宿主没有这条新路由), 之后再更新全自动。

## 1.3.2

**已装插件加了「卸载」按钮**
- 每行多了红色「卸载」: 弹框写清要删的包名/版本, 确认后走 `POST install
  {action:'uninstall'}`, 宿主侧**先建快照再 `pnpm remove`**, 后悔能在
  「设置 → 快照」回滚。自己(`@local/*`)和宿主自带包不给卸载按钮。
- 实测 dryRun 返回 `pnpm remove dsh-cad-preview`。

## 1.3.1

**停用按钮真的能用了 (严重 bug)**
- `toggle` 一直回 409: `src/patch.mjs` 的 `setDisabledText()` 在原 patch 里找不到
  `- id: <插件>` 条目时直接返回 `null` —— 而绝大多数插件是由 bundle 的 `insert`
  挂载的, profile 的 `cordis.patch.yml` 里本来就没有它们的条目, 于是**永远** 409,
  前端只闪一下错误, 看起来就是「点了没反应」。
- 现在找不到条目会**追加**一条 `- id: <id> / disabled: true`; 解禁时条目已存在就写
  `disabled: false` (不删行, 免得留下空条目)。实测停用/启用都 200 并真的生效。

**内嵌市场页移除, 改挂到插件市场页里**
- 面板不再有独立的「插件市场」标签页 —— 市场搬到 dshmarket 那页之后, 两处重复。
- 改为注册 `plugins.tab` slot: 插件管家的标签直接出现在**插件市场页**的标签行
  (「发现 / 主题 / 收藏 / 已安装 / 插件管家」), 用自有 `id`, 是并排一格, 不顶掉原有页。
- 左侧栏的独立入口 (`sidebar.panellist`) 保留, 两边都能进。

**安全检查的误报: 字符串里的 `eval (` 不再算高危**
- `dsh-cad` 被报「动态执行代码」, 实际是 `lib/tools/cad-script.js:197` 里一条日志文案
  `` `eval (${value.language}) — ok` ``。规则只匹配 `eval (` 字样, 没看它在不在引号里。
- 新增 `inStringAt(text, index)`: 从文件头扫到命中点, 用引号状态机判断
  (单/双/反引号, 跳过 `\` 转义)。`dynamic-exec` 规则加 `skipInString: true`,
  命中落在字符串里的直接跳过。
- 单测 5 种情形全过: 模板字符串里的 `eval (` → 0; 真 `eval(code)` → 1;
  `new Function(...)` → 1; 双引号里的 `eval(` → 0; 字符串之后真调用 → 1。
- 实测整个 profile: **danger 1 → 0**, `dsh-cad` 降为「常规」。其余 15 个 caution
  都是子进程/联网/写盘这类正常能力。

## 1.3.0

**看得懂的信息 (humanize)**
- 新增 `src/humanize.mjs`: 每条插件记录补成「中文名 + 一句中文说明 + 说明来源」。
  说明来源按顺序取 `locale/zh.json` → `.state/labels.json` 登记表 → 市场目录中文描述,
  都没有时保留英文但标 `english`, 不假装是中文。
- `catIndex()` 读 `.state/market/plugins.json` 建 name→中文条目索引(实测 9331 条),
  按 `size:mtimeMs` 缓存; 兼容 `[...]` / `{plugins}` / `{raw:{plugins}}` 三种形态
  (目录文件实际是第三种, 第一版判断写错导致索引恒空)。
- 面板「已装插件」每行改成三段: 中文名+版本 / 中文说明 / 灰字包名·分组·宿主自带;
  说明是英文时标「（英文原文）」, 缺中文时标「· 待补中文」。
- 新接口 `GET|POST /api/dsh-plugin-manager/names`: GET 给缺中文清单(已排除 `@deepseek-ai/*`
  宿主自带包), POST `{"action":"fill"}` 用市场目录中文条目批量补齐并写回插件 locale。
- 面板工具行新增 **补齐中文** 按钮。
- `applyLabelTo()` 支持第 3 个参数 description, 中文说明也能写回 locale。
- 实测: 本机 21 个用户插件补前 6 个缺中文, 补后 0 个。

## 1.2.0

**安全检查 (静态扫描)**
- 新增 `src/safety.mjs`: 只读扫描插件源码, 不执行、不联网。三级规则 ——
  高危(混淆载荷/动态执行/反弹 shell/读别人的凭据/环境变量外发)、
  常规(子进程/联网/写盘外/开机自启/裸 TCP)、提示(install 脚本/内网地址/隐藏文件)
- 未安装的包直接下 tarball 到内存解包 (手写 ustar/GNU untar, 支持 `L` 长名、跳过 pax), 不落地
- 来源核验 `verifySource`: integrity / scope / 仓库地址 / 发布时间 / 版本数, 出 good|mixed|poor
- 两处关键去噪, 缺一个报告就没法看:
  - `stripComments()` 手写六态状态机剥注释 —— 不剥的话注释里写「.npmrc 是 profile 配置」
    会被判成读凭据, dshmarket 虚报 14 类高危
  - `dropProseBlocks()` 丢掉内联语言包段落 —— dsh-better-sidebar 有个 lib 文件 14801 行里
    11505 行是正常代码, 语言包里的「支持 ~/.ssh/config 一键导入」是介绍文字不是行为, 曾虚报 24 条
- `credential-path` 只认"别人的"凭据 (带 `homedir()`/`~`/`USERPROFILE`/`HOME` 前缀或 `.ssh/`
  `.aws/` `.git-credentials` 段); 插件读自己管的 profile 里的 `.npmrc` 是正常工作
- 判定按规则聚合成 `ruleHits`, 同一规则多次命中合并成一类并标出次数
- 面板新增「安全检查」页: 4 个计数卡 + 重新扫描 + 每插件一行 (等级徽章 / verdict / 前 8 条明细带 file:line 与代码片段)
- **只提示不拦截**: 报告出来之后安装照旧可点
- 实测本机 18 个已装插件: 高危 0 / 常规 13 / 提示 2 / 干净 3

**插件市场 (内嵌)**
- 新增 `src/market.mjs`: 目录读 npm 上的 `dsh-plugin-catalog` 包里的 `plugins.json`
  (不直连 awesome-dsh-plugin.com, 那个域名经常连不上), 30 分钟缓存,
  主源 registry.npmjs.org、备源 registry.npmmirror.com
- 面板最左边新增「插件市场」页, 观感对齐 dshmarket: 三列自适应卡片网格, 每卡含图标
  (无图标用首字母块) / 名称 / 作者 · 版本 · 下载量 · 星数 / 三行描述 / 截图缩略图 /
  能力标签 / 「✓ 已安装」/ 分类与收录日期 / 「安检并安装」按钮
- 工具栏: 搜索、搜索/刷新目录、排序 (`最近收录` `下载最多` `星数最多` `按名称`)、
  `隐藏读凭据/动态代码` 开关 (官方目录的 capabilities 里 `credentials` 与 `dynamic-code`
  在卡片上标红; 开关一按整体过滤, 实测 8489 → 7304)
- **安装前强制过安检**: 点卡片先 `resolve` 出版本, 再跑静态扫描出报告, 报告出来才出现安装按钮
- **兼容性徽章**: 点开卡片时用 `evalCompat` 比 `engines.dsh` / `dshReleases` /
  `@deepseek-ai/*` peer 与宿主 payload 真实版本, 出 `兼容` / `不兼容` / `未声明` 三档
  (与 `check` 同一套判定, 只提示不拦)
- 安装走 `pnpm add <name>@<version>`, 与 `update` 同一条执行路径, 装前自动建快照, 装完提示重启 Harness
- `resolveCandidate` 实测: `dsh-ppt` → latest `0.20.3`, versions 38,
  installSpec `dsh-ppt@0.20.3`; 目录实测 8489 个插件, 每条都带 npm 包名

**三个让市场"点了半天不出东西"的问题 (都已修)**
- `fetchPackument` 改**并发竞速**: 同一台机器 npmjs 拉大 packument 要 18~20 秒且常超时,
  npmmirror 只要 2.5 秒(32.4MB), 顺序回退等于先白等一个超时 → 两源同时发, 先回者胜,
  其余立刻 abort; 默认超时 15s; `DSH_PM_REGISTRY_MIRRORS` 可换镜像
- **latest 不在 versions 末尾**: `billion-context` 有 7873 个版本, 只留最后 30 个 `meta` 找
  tarball, 而 versions 键序 ≠ 版本序, latest `0.1.212` 不在末尾 → `pickTarball` 返回 null,
  解析出版本 null。改为先把 latest 塞进保留集 (`keep.add(latest)`) 再遍历
- **宿主版本一直取不到**: `hostVersions()` 返回 `{found, fromCache, versions}`, 没有
  `version`/`packages` 键; 原来 `hv.version` 永远是 undefined → 兼容性全判「未声明」。
  改为从 `versions['@deepseek-ai/dsh']` 取宿主版本、`versions` 本身当 peer 包映射
  (`index.js` 与 `src/check.mjs` 两处同源问题一起修)
- 加 `rehydrate()` 让老缓存也能读出新增字段, 不必等 30 分钟过期; 目录缓存 schema 升到 2
  (只存原始条目, 读时再规整, 体积减半)

**界面配色跟随系统**
- 面板不再写死颜色: 边框/填充/强调色/红黄绿状态色全部改走 `.dpm` 上的 CSS 变量,
  用 `@media (prefers-color-scheme: dark)` 覆盖一整套 —— 系统切深色面板就深色,
  切浅色就浅色, 不用重载 Harness
- 变量挂在 `.dpm` 上而不是 `:root`, 不污染宿主自己的主题变量; 根节点同时声明
  `color-scheme: light dark`, 滚动条与 `<select>`/`<input>` 这些原生控件也跟着走
- 内联的等级色(danger/warn/ok)也换成 `var(--dpm-*)`, 深色下不再是一片暗红看不见
- 卡片网格改 `minmax(min(288px,100%),1fr)`: 窄窗口不撑破, 宽窗口自动多列

**新接口**
- `GET /safety?mode=profile|installed|package`, `POST /safety {"action":"clear-cache"}`
- `GET /market?q=&category=&limit=` / `?sort=recent|downloads|stars|name` /
  `?nocreds=1` / `?resolve=<包名>` (resolve 的返回里带 `compat`)
- `POST /install {"action":"install"|"uninstall","name":..,"version":..,"dryRun":..}`
- 路由总数 13 → 16

**面板标签页顺序**: 插件市场 / 已装插件 / 安全检查 / 体检 / 重复 / 清理 / 设置

## 1.1.1

**修: 一键全选之后取消不了**
- 「取消全选」按钮原来带着 `disabled: ... || (allCheck && allAuto)`, 意思是"两个都全勾了就别点了"。
  结果正是用户最需要的场景 —— 点过 `全选全部` 之后 13 个插件全勾满, 取消按钮直接置灰, 退不回来。
- 现在四个批量按钮的 `disabled` 只受 `busy` (请求进行中) 和"没有市场插件"影响, 任何时候都能点。
- 单列按钮 `全选检查更新` / `全选自动安装` 的三态标签最后一段从「已全选」改成「取消」,
  点了就真的全部取消, 不再是置灰的装饰。
- 实测: 13 个插件 `policy-bulk` 写 `{checkEnabled:false,autoInstall:false}` → `changed:13`,
  `overview` 复查残留 0 个; 再写回 true → 13/13。

## 1.1.0

**一键全选**
- 设置页新增四个批量按钮: `全选全部 (N)` 一次把「检查更新 + 自动安装」两列全勾上,
  `取消全选`, 以及只动一列的 `全选检查更新` / `全选自动安装`。
  后两个是切换语义: 空 → 「全选」, 部分 → 「补选」, 全勾 → 「取消」
- 修: 初版给「取消全选」加了 `allCheck && allAuto` 的禁用条件, 导致勾满 13 个插件之后
  取消按钮被置灰、退不回来。现在四个按钮任何时候都可点 —— 取消操作永远不该被禁用
- 新接口 `POST /api/dsh-plugin-manager/policy-bulk {"names":[...],"patch":{...}}`:
  一次请求改完所有条目, revision 自增; 只认 `checkEnabled` / `autoInstall` / `ignoredVersion`,
  `names` 为空回 400

**「自动安装」勾选才真的自动装** (行为变更)
- `auto` 之前不看面板那两个复选框, 凡是能升的都升; 现在筛候选时会读 `autoInstall`,
  没勾的只出现在"可更新"列表里, 理由写「未勾选自动安装」
- `check` 的每一行多返回 `autoInstall` 字段, 供面板和 `auto` 共用同一份判断
- 退回老行为: `.state/auto.json` 写 `"respectPolicy": false`
- 注意: 刚装好时只有 dsh-ppt 是勾着的, 所以要"有新版本就装"先去面板点一次全选

## 1.0.0

首个对外版本。

**面板**
- 左侧栏「插件管家」: 总览 / 查更新 / 体检 / 查重 / 清理 / 快照回滚 / 定时任务
- 中文名登记表: 升级把插件标题冲掉后可以一键修回

**查更新与自动更新**
- `check`: 联网查每个插件的新版本, 本地缓存, `--refresh` 强刷
- `auto`: 有新版本就装。装前自动建快照, 装后重新体检, 出现失败或严重项变多就自动还原, 每轮结果写进 `reports/auto.ndjson`
- `auto on|off|skip|unskip|log`: 总开关、单插件排除、历史记录
- 本地自创插件(link 目录)、宿主内置只读包、peer 依赖不满足的包自动跳过

**体检与修复**
- `doctor`: 缺失 / 冲突 / 重复挂载 / 版本漂移 / 可清理项
- `fix`: 按体检结论修, 默认只预演
- `dupes`: 功能重叠、同名多版本、运行时 id 冲突、共用插槽
- `clean`: 清 pnpm 缓存与残留

**备份与回滚**
- `snapshot create|list|diff|restore|prune`: 快照落在 `.state/snapshots`, 每次自动更新前都会建

**跑在宿主进程里的坑**
- Electron 给 `fs` 打的 asar 补丁会把含 `.asar` 的路径当归档内部路径, 导致宿主自带包集合为空、307 个内置包被误报缺失。`src/host.mjs` 的 `noAsar()` 在读写 asar 前后临时置 `process.noAsar = true` 绕开。

**定时**
- `schedule install --hours 2 --time 08:00`: 建 Windows 计划任务, 每 N 小时跑一次 `auto --write`

**CLI**
- `dsh-pm` / `npx dsh-plugin-steward`: 与面板同一批模块, 结论永远一致
