# DSH 插件管家 (dsh-plugin-steward)

Plugin steward for DeepSeek Harness — update checks, auto-update with snapshot rollback,
health checks, duplicate analysis, cleanup. One left-panel UI, one CLI, zero runtime dependencies.

一个零依赖的纯 Node 工具, 专门管理 DeepSeek Harness 的插件:
分类 / 查更新 / 查重 / 体检 / 修复 / 清理 / 备份回滚 / 定时自动更新。

## 怎么用

**装**: 对 Harness 里的 AI 说「装这个插件: github:lihao178/dsh-plugin-steward」, 装完重启一次软件。

**进**: 打开左侧栏「插件市场」页, 标签行最右边那格「插件管家」就是它。

**用**: 三个页面够了——

    我的插件    看装了什么、哪些能更新。点「更新」, 装完自动重启, 不用手动关软件
    有风险吗    静态扫一遍每个插件的代码, 谁会联网、谁跑命令、谁翻密钥。只提示, 不拦你
    设置        点「全部打开 (N)」, 所有市场插件开启自动查新版+自动装新版

点完「全部打开」就不用管了: 有新版本它自己装、自己重启; 装坏了自动退回上一个备份。

**出问题**: 设置 → 备份还原 → 退回这个。命令行 `dsh-pm.cmd snapshot list` 也能看。

## 安装

从 GitHub 装 (推荐, 不需要 npm 发布):

    dsh plugin --profile desktop add github:lihao178/dsh-plugin-steward

在 Harness 里装 (面板 + HTTP 接口一起进来):

    plugin_manager action=install_bundle target=dsh-plugin-steward

或者在插件市场里搜「插件管家」/ `dsh-plugin-steward`, 点安装。

只想用命令行 (不要面板):

    npx dsh-plugin-steward status
    npx dsh-plugin-steward check
    npx dsh-plugin-steward auto --write      # 有新版本就装, 装前自动备份

> 装完要重启 Harness 才会加载新版本。**1.4.0 起, 面板里升级/安装/卸载/停用之后会自己重启**,
> 不用手动关软件 (命令行跑的 `auto` 仍会提示你重启)。

## 快速开始

本机开发目录直接用 `dsh-pm.cmd` (已内置 node 路径, 双击/终端都能用):

    D:\智能\dsh-plugin-manager\dsh-pm.cmd

不带参数会进入交互菜单。也可以直接下命令:

    D:\智能\dsh-plugin-manager\dsh-pm.cmd status
    D:\智能\dsh-plugin-manager\dsh-pm.cmd check
    D:\智能\dsh-plugin-manager\dsh-pm.cmd doctor

## 全部命令

    status              总览: 插件数量, 分类, 占用, 宿主版本, 体检结论
    list                插件清单 (--origin self|market|builtin / --group <功能组>)
    check               检查有没有新版本 (--refresh 强制刷新, 不用缓存)
    update              升级插件 (默认只预演, 加 --write 才真装)
    auto                自动更新: 一有新版本就装 (先备份, 出错自动还原)
    doctor              健康体检: 找坏掉的, 缺失的, 冲突的, 该修的
    fix                 自动修复 (默认只预演, 加 --write 才真改)
    dupes               重复分析: 功能重叠 / 同名多版本 / 运行时 id 冲突 / 共用插槽
    clean               清理垃圾 (默认只预演, 加 --write 才真删)
    snapshot            备份与回滚: create|list|diff|restore|prune
    schedule            定时任务: install|status|remove|time
    report              导出 Markdown 报告到 reports\
    daily               每天跑一次的那条命令 (输出 JSON, 可接定时任务)
    label               中文名登记表: label list|set|sync
    help                帮助

通用参数:

    --profile <名字>    默认 desktop
    --json              输出机器可读 JSON
    --write             真正执行 (不带这个一律只预演, 不会动你的东西)
    --only a,b          只处理指定的插件
    --refresh           忽略本地缓存, 重新联网查

## 两个核心分类

工具把插件分成几类, 你最关心的两类在最前面:

    自创插件    你自己写的 / 本地开发中的
                判定: package.json 里写的是 link: / file: / workspace: 或 @local/ 开头,
                      或者包的真实路径不在 node_modules 里 (是软链指向你的源码目录)
                这类的特点是: 不跟市场更新, 归你自己管

    市场插件    从插件市场装的, 需要经常更新的
                判定: 从 npm registry 拉下来的包

    宿主自带    宿主 DeepSeek Harness 自己打包在 app.asar 里的基础能力,
                磁盘上的 node_modules 里没有, 不该当成损坏
    缺失        配置里引用了, 但磁盘上没有, 宿主自己也不带 -> 是真问题

## 功能分组

除了上面两分法, 还按功能打了 14 个标签, 一个插件可以命中多个, primary 是得分最高的那个:

    市场管理 / 记忆知识 / 图像视觉 / 文档办公 / 搜索联网 / 上下文费用 /
    界面交互 / 任务自动化 / 开发可视化 / 语音音频 / 系统桌面控制 /
    模型推理 / 宿主基础 / 数据量化

## 中文名保护 (升级会把名字冲掉)

插件的界面中文名写在插件自己目录的 locale\zh.json 里, 而 pnpm 升级会整个替换那个目录,
所以升级之后中文名会消失。两种表现:

    名字退回包名   dsh-ppt 升级后界面显示 "dsh-ppt"  (locale 目录整个没了)
    名字退回英文   dsh-better-sidebar 升级后显示 "Better Sidebar"

第二种更隐蔽 - 只看"还有没有 locale 文件"是发现不了的。所以工具额外维护一份登记表
.state\labels.json, 每次体检拿实际名字跟登记表对账, 不一致就报 label-drift / label-wiped。

    dsh-pm.cmd label                     登记表 vs 现状
    dsh-pm.cmd label set <包名> <中文名>   登记一个新名字
    dsh-pm.cmd label sync --write         把当前现状记成基线 ("现在这样是对的")
    dsh-pm.cmd fix --write                把丢了/被改掉的中文名写回去

登记表里预置了 17 个插件的名字 (来自作者原来的 rename 脚本), 所以你什么都不用填。
升级完插件顺手跑一次 fix --write 就能把名字补回来。

用 `list --group 上下文费用` 只看某一类。

## 看得懂的信息 (humanize)

面板里的插件不该只给你看 `@linxin666/dsh-client-ui-skill-explorer v0.4.14` —— 不写插件的人
读不出这是干什么的。所以每条插件记录都会补成 **中文名 + 一句中文说明 + 这句说明是哪来的**。

中文说明按顺序取三个来源, 前一个没有才看下一个:

    1. 插件自己带的 locale/zh.json 的 meta.description   作者写的, 最准
    2. .state/labels.json 登记表                          升级也冲不掉的那份
    3. 市场目录 .state/market/plugins.json 的中文描述      8489 条, 中文覆盖 100%

三个都没有时保留英文原文, 但会明确标成 `english`, 面板上打「（英文原文）」, 不会假装它是中文。
实在没有中文条目的 (作者没写、目录也没收录) 会标 `needsZh`, 面板显示「· 待补中文」,
并给你手动命名的入口:

    dsh-pm.cmd label set dsh-cad-preview "CAD 三维预览"

面板「已装插件」页的每一行是三段: 中文名 + 版本 / 中文说明 / 灰字的包名 · 分组 · 宿主自带。
说明为英文时会标出来, 缺中文时右侧有标记。工具行有一个 **补齐中文** 按钮, 一次把缺的补掉。

    GET  /api/dsh-plugin-manager/names            缺中文的清单 {total, missing, rows[]}
    POST /api/dsh-plugin-manager/names            {"action":"fill"} 用市场目录中文条目批量补齐
                                                  -> {ok, filled[], skipped[{name,reason}]}

补齐的动作会把中文写回插件自己的 locale\zh.json (和 label set 一样), 所以名字能过升级 —— 但
升级本身仍可能冲掉, 定期跑 `fix --write` 或再点一次「补齐中文」即可。

实测 (2026-11-03, 本机 21 个用户插件): 补前 6 个缺中文, 补后 **0 个**;
其中 4 个是 `@deepseek-ai/*` 宿主自带包, 它们没有面向用户的说明, 不计入清单。

### 面板上的字全是白话 (1.4.1)

界面文案不写术语, 只写"这按钮干了什么"。1.4.1 起:

| 位置 | 以前 | 现在 |
| --- | --- | --- |
| 标签页 | 已装插件 / 安全检查 / 体检 / 重复 / 清理 | **我的插件 / 有风险吗 / 体检 / 重复的 / 垃圾清理** |
| 行内按钮 | 升级 / 启用 / 停用 / 卸载 | **更新 / 打开 / 关掉 / 删除** |
| 进度提示 | 正在检查更新… | **正在查有没有新版本（要联网, 等一下）…** |
| 来源徽章 | 市场安装 / 宿主自带 / 自创 | **市场装的 / 系统自带 / 我自己做的** |
| 安全规则 | dynamic-exec / reverse-shell | **能把文字当代码跑起来 / 像是从外面反向控制这台电脑** |

改动只在文案层 (`client.js` 的 `WORD` / `KIND_LABEL` / `SEV` / `MK_CAT` / `MK_CAP`,
`src/safety.mjs` 的规则 `title`, `src/scan.mjs` 的 `ORIGIN_LABEL` / `SOURCE_LABEL`)。
判定阈值、扫描规则、路由、备份与自动重启的行为都没动 —— 改完 19 项活宿主机自检仍 19/19。

## 安全设计

* **默认只预演**。所有会改动磁盘的动作 (update / fix / clean / snapshot restore)
  不加 --write 就只打印计划, 一个字节都不动。菜单里会再追问一次 w。
* **改动前自动备份**。fix 和 update 在真正动手前会存一份快照到
  `D:\智能\dsh-plugin-manager\.state\snapshots\<profile>\<时间戳>\`,
  包含 package.json, cordis.patch.yml, pnpm-workspace.yaml,
  stardustlc-plugin-updates.json, .dsh-market/state.json 五个关键文件。
* **装坏了自动回滚**。update 时如果所有插件都装失败, 会自动 restore 到动手前的快照。
* **不删传递依赖**。像 @stardustlc/dsh-updates 这种看着像残留、其实是别的插件的依赖的包,
  工具能从 pnpm 的 node_modules\.modules.yaml 里认出来, 归到 unsafe 不清理。

## 数据来源 (不猜, 全部读真实文件)

    插件清单      profiles\desktop\package.json 的 dependencies + dsh.profile.bundles
    版本          node_modules\<包>\package.json
    软链          lstat / readlink
    中文名        <包>\locale\zh.json 的 meta.title
    安装映射      node_modules\.modules.yaml 的 hoistedLocations
    工作区配置    pnpm-workspace.yaml (nodeLinker=hoisted)
    禁用状态      cordis.patch.yml 的 disabled: true (按 runtime id 匹配)
    宿主版本      dsh-runtimes\...\runtime.json 的 desktopVersion
    宿主自带包    DeepSeek Harness.exe 旁边的 resources\app.asar (直接解 asar 头)
    新版本        https://registry.npmjs.org (可用 DSH_PM_REGISTRY 换源)
    每插件更新策略 stardustlc-plugin-updates.json
    市场快照      .dsh-market\snapshots\

## 目录结构

    dsh-pm.cmd          启动器 (已内置 node 路径, 双击/终端都能用)
    bin\dsh-pm.mjs      命令行主程序
    src\*.mjs           各功能模块:
                          util 基础 / semver 版本比较 / patch 配置层 /
                          scan 扫描 / host 宿主 payload (解 asar) /
                          pnpmmeta pnpm 落盘元数据 / registry npm 源 /
                          check 更新检查 / doctor 体检 / dupes 查重 /
                          clean 清理 / fix 修复 / snapshot 备份 /
                          auto 自动更新闭环 / schedule 定时 / report 报告 /
                          apply 安装执行 / labels 中文名登记 /
                          safety 静态安全扫描 / market 市场目录与安装解析
    reports\            导出的 Markdown 报告
    .state\             缓存, 快照, 定时任务配置, 每次跑动的日志

## 自动更新 (auto)

一条命令把「查 → 装 → 验 → 该还原就还原」串起来:

    dsh-pm.cmd auto              预演, 只告诉你会升哪些
    dsh-pm.cmd auto --write      真装

每次都是这个顺序:

    1. checkProfile (联网刷新)     找出所有"有新版本"的插件
    2. 筛候选                      按 auto.json 的规则排除
    3. doctor 记基线               体检严重项 before
    4. updateApply (write:true)    真正装, 装之前自动建快照 (reason: 更新前自动备份)
    5. doctor 再体检               严重项 after
    6. 判定                        有失败或严重项变多 -> restoreSnapshot 自动还原
    7. 写记录                      一行 JSON 进 reports\auto.ndjson

装完要重启 Harness 才生效: 插件代码在启动时加载, 磁盘上的新版本不会热替换已加载的模块。
从 1.4.0 起面板会**自动重启** (见下节), 命令行跑的 `auto` 仍然提示你重启。

## 更新完自动重启 (不用手动关软件)

插件代码是在宿主启动时加载的, 所以任何 `pnpm add/remove` 之后都必须让宿主重新加载模块。
1.4.0 之前只能手动关软件再开; 现在面板帮你做:

| 动作 | 以前 | 现在 |
| --- | --- | --- |
| 升级 | 提示「重启 Harness 后生效」 | 自动重启, 回来提示 Ctrl+F5 |
| 安装 / 卸载 | 同上 | 自动重启 |
| 停用 / 启用 | 同上 | 自动重启 |

实现 (`src/restart.mjs`, 思路照 dshmarket 的 `scheduleRestart`):

    1. 抓当前进程的启动方式    process.execPath / process.argv.slice(1) / cwd
                               (Electron 打包版: execPath 是 DeepSeek-Harness.exe,
                                argv[0] 是 exe 本身, 所以取 slice(1))
    2. 写 helper                .state/restart-helper.cjs
    3. detached spawn           spawn(node.exe, [helper], {detached:true, stdio:'ignore'})
                                然后 helper.unref() —— 宿主死了它也不受影响
    4. 600ms 后自杀             process.kill(process.pid, 'SIGTERM')
    5. helper 等 1.5 秒         Windows 放端口要一会儿
    6. 用同样参数拉起宿主        spawn(execPath, args, {cwd, detached:true})

面板侧 `restartNow()` (1.4.2 起改了判定方式): 先读一次 `overview` 记下 `pid` → `POST restart`
→ 每 900ms 读 `overview` 比 `pid`, **pid 变了才算重启成功**, 最多等 60 秒。

> 为什么必须比 pid: 旧进程在收到 SIGTERM 之前照样能应答 HTTP, 只看"能不能读 overview"
> 会立刻误判成"重启完成"——这就是 1.4.1 及以前「点完更新还显示能更新 4 个」的原因。
> 60 秒内 pid 没变, 面板会明说「没能自动重启, 请手动关一次软件」, 不再假装成功。

`POST /api/dsh-plugin-manager/restart`:

    {}                     真的重启 (响应先写回, 600ms 后才动手)
    {"dryRun":true}        只回显「将会执行什么命令」, 不动手
    {"waitMs":1500}        helper 等待秒数, 默认 1500
    {"delayMs":600}        自杀前等待毫秒, 默认 600

`GET /api/dsh-plugin-manager/overview` 里用来判断"到底生效没有"的字段:

    pid           宿主进程号 —— 变了就是真的重开过
    startedAt     本次启动时间戳
    builds        版本号 + index.js/client.js/src/apply.mjs/src/restart.mjs 的 mtime
    pnpm          pnpm 定位诊断 {chosen, chosenExists, env, candidates[]}

### 装/卸 找不到 pnpm (1.4.2 已修)

`pnpmBin()` 以前只会沿着 `process.execPath` 往上退两级, 那是**源码布局**的假设。打包好的桌面端
里 pnpm 实际在 `exe目录\resources\runtime\primary-runtime\dependencies\pnpm\bin\` —— 在 exe
目录**下面**, 于是算出来的路径根本不存在, 安装/卸载/自动更新全废。

现在按顺序试这些位置, 第一个存在的就用:

    1. $env:DSH_PM_PNPM                                          手工指定, 优先级最高
    2. <exe目录>\resources\runtime\{primary-runtime,runtime}\dependencies\pnpm\bin\pnpm.{mjs,cjs}
    3. <exe目录>\..\..\pnpm\bin\pnpm.{mjs,cjs}                   老算法, 源码布局仍然有效
    4. ~/.dsh/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.{mjs,cjs} 程序被移动/重装也不受影响
    5. 由 node 自身位置反推 <deps>\pnpm\bin\pnpm.mjs

失败时 `install` 响应会带 `pnpm` 字段, 列出**每一条试过的路径**和哪个存在, 不再只给一句 ENOENT。
想手工兜底就设环境变量然后重启一次软件:

    [Environment]::SetEnvironmentVariable("DSH_PM_PNPM",
      "C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs", "User")

> 提醒: **装这个版本本身**还是得手动重启一次——正在跑的宿主没有新路由/新字段。
> 重启之后就都自动了。

## 停用 / 卸载

「已装插件」每行右侧三个按钮: `升级`(有新版才出现) / `停用`(或 `启用`) / `卸载`(红色)。

**停用**是写 profile 的 `cordis.patch.yml`。这里有个必须注意的地方: 绝大多数插件是
bundle 通过 `insert` 挂载的, patch 文件里**本来就没有**它们的 `- id:` 条目, 1.3.0
之前 `setDisabledText()` 找不到条目就直接返回 null → 接口回 409 → 面板只闪一下错误,
表现就是"点了没反应"。现在找不到条目会**追加**一条:

    - id: dsh-cad
      disabled: true

启用时条目已存在就写 `disabled: false`(不删行, 免得留下空的 `- id: x` 条目)。
停用/启用会**自动重启** (1.4.0 起) 让改动真正生效。

**卸载**会先弹框写清要删哪个包哪个版本, 确认后执行 `pnpm remove <包名>`, 并且
**执行前自动建一个快照** —— 删错了去「设置 → 快照」回滚。自己 (`@local/*`) 和宿主
自带包不给卸载按钮。卸载完会**自动重启** (1.4.0 起)。

### 面板里的一键全选

设置页第二段是市场插件的逐行开关 (检查更新 / 自动安装), 上面有四个批量按钮:

    全选全部 (N)     一次把「检查更新 + 自动安装」全勾上 —— 新装机器最常用
    取消全选         两列一起清空
    全选检查更新     只动第一列
    全选自动安装     只动第二列

后两个是"切换"语义, 文字跟着当前状态走:

    一个都没勾 -> 「全选检查更新」   点一下 = 全勾上
    勾了一部分 -> 「补选检查更新」   点一下 = 补齐剩下的
    全勾满了   -> 「取消检查更新」   点一下 = 全部取消

**四个按钮任何时候都能点** —— 尤其"取消"不能因为已经全勾就禁用, 否则勾满了反而退不回来
(1.1.0 初版踩过这个坑: 给"取消全选"加了 `allCheck && allAuto` 的禁用条件)。

批量写走 POST /api/dsh-plugin-manager/policy-bulk
(`{"names":[...],"patch":{"checkEnabled":true,"autoInstall":true}}`),
一次请求改完所有条目 —— 不是循环发 N 个单条请求, 也就不会写坏文件。

### 重要: 「自动安装」勾选才真的自动装

auto 筛候选时会看每个插件的 autoInstall 开关
(stardustlc-plugin-updates.json, 就是面板那两个复选框):

- 勾了「自动安装」→ auto 会装
- 没勾 → 只出现在"可更新"列表里, auto 不动它, 理由写「未勾选自动安装」

**所以刚装好时只有 dsh-ppt 是勾着的, 其余市场插件默认不自动升级。**
想让"有新版本就装", 先去 设置 → 全选自动安装 点一下。

不想要这个限制 (回到老行为: 凡是能升的都升), 在 .state\auto.json 里加:

    { "enabled": true, "allowMajor": true, "respectPolicy": false, "skip": [] }

### 开关与排除

    dsh-pm.cmd auto off                 暂停自动更新 (只影响 auto, 手动 update 照旧)
    dsh-pm.cmd auto on                  恢复
    dsh-pm.cmd auto skip dsh-ppt        这个插件不自动升
    dsh-pm.cmd auto unskip dsh-ppt      撤销
    dsh-pm.cmd auto log                 看最近几次装了啥, 有没有触发还原

配置在 .state\auto.json:

    { "enabled": true, "allowMajor": true, "respectPolicy": true, "skip": [] }

    enabled        总开关
    allowMajor     false = 只自动装次版本和补丁, 主版本留给你手动确认
    respectPolicy  true (默认) = 只装面板里勾了「自动安装」的插件
    skip           包名黑名单

另外这些也会被跳过 (不是出错, 是没法自动升): 本地自创插件 (link: 目录, 没有版本可比)、
宿主内置包 (只读)、peer 依赖不满足且没给 --force、没勾「自动安装」的插件。

### 定时跑 (每 N 小时)

    dsh-pm.cmd schedule install --hours 2 --time 08:00            先看计划
    dsh-pm.cmd schedule install --hours 2 --time 08:00 --write    真建

建出来的是 Windows 计划任务 DSH-Plugin-Manager-Daily, 从 08:00 起每 2 小时跑一次
`auto --write`, 结果追加到 reports\daily.ndjson (一行一个 JSON, 好翻历史)。

    dsh-pm.cmd schedule install --time 09:30 --write   改成每天一次 (不传 --hours)
    dsh-pm.cmd schedule time 21:00 --write             只改起始时间
    dsh-pm.cmd schedule status                         看下次运行时间
    dsh-pm.cmd schedule remove --write                 卸掉

--hours 必须带数字; 不带数字会直接报错, 不会悄悄退化成"每小时"。

## 安全检查 (safety)

面板的「安全检查」页和「插件市场」页共用一套扫描器。它只读代码、不执行、不联网:

    1. 取包           已装的 -> 直接读 node_modules 里的文件
                      未装的 -> 下 tarball 到内存, 解包 (手写 untar, 不落地)
    2. 洗文本         剥注释 (手写状态机, 六态) + 丢掉语言包段落
    3. 打规则         按 high / medium / low 三级匹配, 同一规则多次命中合并成一类
    4. 核来源         比对 registry 的 integrity / scope / 仓库地址 / 发布时间 / 版本数
    5. 出结论         danger / caution / info / safe + verdict 一句话

三级规则各自认什么:

    高危   混淆载荷 (长 base64 / 字符串数组) · 动态执行 (eval / new Function)
           反弹 shell · 读别人的凭据 (~/.ssh, ~/.aws, .git-credentials)
           环境变量外发 (读 process.env 同时往外发)
    常规   起子进程 (child_process) · 联网 (fetch / http / net)
           往项目目录外写盘 · 写开机自启动 · 裸 TCP
    提示   package.json 里有 install/prepare 脚本 · 内网地址 · 隐藏文件

**"常规"不是"有问题"**: 一个功能完整的插件几乎必然要起子进程、联网、写盘。
真正要盯的是"高危"那一档。

### 两处必须这么写, 否则误报会把报告淹掉

    stripComments(src)      不剥注释, 注释里写一句「.npmrc 是 profile 配置」
                            就会被当成"读凭据"——实测 dshmarket 因此虚报 14 类高危
    dropProseBlocks(text)   语言包经常被内联进打包产物 (dsh-better-sidebar 的一个
                            lib 文件 14801 行里 11505 行是正常代码), 而语言包里的
                            "支持 ~/.ssh/config 一键导入"是介绍文字, 不是代码行为。
                            做法: 连续 >=2 行、每行 40 字符以上且带空格的段落整段丢弃,
                            用空行占位以保持行号不变

`credential-path` 规则只认"别人的"凭据: 必须带 `homedir()` / `~` / `USERPROFILE` /
`HOME` 前缀, 或者路径里有 `.ssh/` `.aws/` `.git-credentials` 段。
插件读它自己管的 profile 里的 `.npmrc` 是正常工作, 不算。

校验效果 (本机 18 个已装插件): 高危 0 / 常规 13 / 提示 2 / 干净 3。

**这个功能只提示, 不拦截。** 报告出来之后安装按钮照旧可点 —— 决定权在你。

## 插件市场 (内嵌页已移除, 现在挂在市场页的标签行里)

> 1.3.1 起面板里不再有独立的「插件市场」页 —— 市场已经搬到 dshmarket 那一页了, 两处重复没意义。
> 插件管家改为注册 `plugins.tab`: 打开「插件市场」页时, 标签行是
> 「发现 / 主题 / 收藏 / 已安装(N) / 插件管家」, 点最后一格就是本插件管家的完整面板。

### 左侧栏那个图标是可选的 (1.4.3 起默认不出现)

入口只在「插件市场」页的标签行里就够了, 左侧栏再占一格是重复的。所以默认**不注册**
`sidebar.panellist`。想加回来:

    面板 → 设置 → 勾上「在左侧边栏放一个「插件管家」图标」→ 重启软件

设置存在插件自己的 `.state/settings.json` (不跟 profile 的插件策略混):

```json
{ "showInSidebar": false }
```

对接口就是一条:

    GET  /api/dsh-plugin-manager/settings
    POST /api/dsh-plugin-manager/settings   {"showInSidebar": true}

> 为什么还要一份 `localStorage` 缓存: 客户端模块是**同步**加载的, `apply()` 一进来就得决定
> 注册不注册左侧栏, 不能 `await` 一次 fetch。所以开机先按上一次记住的值来, 打开面板时再用
> `settings.json` 的真值校正一次。两侧长期不会对不上。

下面这段是内嵌页的原始设计 (留档, 也是市场页那一格复用的能力):

面板里那格市场页, 观感对齐 dshmarket 那套卡片流: 三列自适应网格, 每张卡有图标
(没图标就用首字母块)、名称、作者 · 版本 · 下载量 · 星数、三行描述、截图缩略图、能力标签,
已装的卡上打「✓ 已安装」。能搜、能筛分类、能排序, 装之前强制先过一遍上面的安检:

    点卡片 -> 先解析版本 (registry 的 latest + versions) 与兼容性
           -> 再跑静态扫描, 出报告 (文件数 / 体积 / 来源核验 / 命中明细)
           -> 报告出来了才出现「安装 vX.Y.Z」按钮
           -> 装之前自动建快照, 装完提示重启 Harness

工具栏四件套: 搜索框、搜索/刷新目录、排序 (`最近收录` / `下载最多` / `星数最多` / `按名称`)、
以及一个 `隐藏读凭据/动态代码` 开关 —— 官方目录给每个插件预计算了 capabilities,
其中 `credentials`(读凭据) 和 `dynamic-code`(动态执行代码) 在卡片上标红, 这个开关一按就把
这两类整体过滤掉 (实测 8489 → 7304)。想快速在 8.5k 个插件里挑安全货, 就按它。

兼容性徽章: 点开卡片时会把该版本的 `engines.dsh` / `dshReleases` / `@deepseek-ai/*` peer
依赖和宿主 payload 里的真实版本比一遍, 结果分三档 —— `兼容` / `不兼容` / `未声明`
(未声明不是坏, 只是作者没写要求)。判定逻辑和 `check` 用的是同一个 `evalCompat`,
所以面板看到的结论和命令行升级前的拦截标准一致。

目录不直连 awesome-dsh-plugin.com (那个域名经常连不上), 而是读 npm 上的
`dsh-plugin-catalog` 包里的 `plugins.json`, 30 分钟缓存一次, 主源 registry.npmjs.org、
备源 registry.npmmirror.com。当前实测 8489 个插件, 每条都带 npm 包名, 所以"装"就是
`pnpm add <包名>@<版本>`, 走和 `update` 完全相同的执行路径 (含快照)。

### 配色跟随系统

面板不写死颜色: 边框、填充、强调色、红黄绿状态色都存在 `.dpm` 上的 CSS 变量里, 由
`@media (prefers-color-scheme: dark)` 换一整套。系统切深色, 面板跟着深; 切浅色, 面板跟着浅,
不用重载 Harness。变量挂在 `.dpm` 而不是 `:root`, 所以不会污染宿主自己的主题变量;
根节点声明 `color-scheme: light dark`, 滚动条和 `<select>`、`<input>` 这些原生控件也跟着走。

真要强制某一档 (不跟随系统), 给它盖一层变量就行, 例如写死浅色:

    .dpm { color-scheme: light !important;
           --dpm-bg:#fff; --dpm-fg:#1f2328;
           --dpm-line:rgba(31,35,40,.14); --dpm-line-strong:rgba(31,35,40,.28);
           --dpm-fill:rgba(31,35,40,.05); --dpm-fill-hover:rgba(31,35,40,.09);
           --dpm-accent:#2f6feb; --dpm-accent-soft:rgba(47,111,235,.12); --dpm-on-accent:#fff;
           --dpm-danger:#c0342c; --dpm-warn:#8a6100; --dpm-ok:#1a7f37; }

### 两个让"解析版本"慢到用不了的问题 (已修)

1. **源的选择**: 同一台机器上, npmjs 拉一个大 packument 要 18~20 秒 (经常直接超时),
   npmmirror 只要 2.5 秒。所以不是"顺序回退", 而是**两个源同时发、谁先回用谁、其余立刻
   中止** (见 `src/registry.mjs` 的 `fetchPackument`)。`DSH_PM_REGISTRY_MIRRORS` 可改镜像。
2. **latest 不在版本列表末尾**: `billion-context` 有 7873 个版本, 我们只留最后 30 个版本的
   `meta` 用来找 tarball, 但 packument 里 versions 的键顺序不等于版本顺序, latest
   (`0.1.212`) 恰好不在末尾 — 于是 `pickTarball` 返回 null、版本解析成 null。修法是
   先把 latest 单独塞进保留集再遍历 (`keep.add(latest)`)。

## 一个容易误会的地方: 同一 id 出现两次

cordis.patch.yml 里同一个 id 可以合法地出现多次, 每条只设置它自己写出来的那几个字段。
宿主的 applyEntryPatches 是按 id 找到条目后逐键赋值 (target[key] = value), 所以:

    - id: better-sidebar
      name: dsh-better-sidebar
      config: { agentOpenTools: false }
    ...
    - id: better-sidebar
      disabled: false

这两条不冲突, config 照样生效。**只有重复设置同一个字段时, 后面的才会静默盖掉前面的**
(那才是真问题, 体检会报 patch-key-conflict)。所以体检只在"同一字段被重复设置"时报警,
只是把 id 拆成多条的情况会作为"提示"说明一下, 不用管。

**另一个坑**: 给某个插件写 config 时是把整个 config 换掉, 不是深层合并。
所以想改一个开关, 必须把原来那份 config 全抄过来一起写, 否则剩下的项会被清空。

## 作为 Harness 插件安装 (面板)

这个目录不只是一份命令行工具, 它本身就是一个 DSH 插件包:

    index.js           宿主半边: 把功能挂在 /api/dsh-plugin-manager/* 上
    client.js          浏览器半边: 在左侧栏注册"插件管家"面板图标 (id: plugin-manager)
    cordis.patch.yml   挂载行 (id: dsh-plugin-manager)
    locale/zh.json     面板标题与说明 (en.json 同名)

安装 (让 Harness 里的 AI 执行一次即可):

    plugin_manager action=install_bundle target=D:\智能\dsh-plugin-manager

装上之后左侧栏多一个"插件管家"图标, 点开就是插件市场 / 已装插件 / 安全检查 / 体检 /
重复分析 / 清理 / 快照回滚 / 定时任务。面板和 `dsh-pm.cmd` 读的是同一批模块, 结论永远一致。

HTTP 接口 (GET 即可, 便于 AI 或脚本直接调用):

    /api/dsh-plugin-manager/overview    总览
    /api/dsh-plugin-manager/check       查更新
    /api/dsh-plugin-manager/auto        自动更新状态 (config + 最近记录 + 计划任务)
    /api/dsh-plugin-manager/doctor      体检
    /api/dsh-plugin-manager/dupes       重复分析
    /api/dsh-plugin-manager/snapshots   快照列表
    /api/dsh-plugin-manager/safety      安全检查 (?mode=profile|installed|package)
    /api/dsh-plugin-manager/market      市场目录 (?q= &category= &limit= / ?resolve=包名)
    /api/dsh-plugin-manager/policy-bulk 批量改策略
    /api/dsh-plugin-manager/install     安装 / 卸载

/auto 也收 POST: {"action":"on"|"off"|"skip"|"unskip","name":"包名"} 开关与排除,
{"action":"run","write":true} 立刻跑一次自动更新。未知的 /api 路径宿主一律回 401,
所以新加的接口在 Harness 重启前访问会看到 401——这不是权限问题, 是路由还没挂上。

批量改策略 (面板「全选」按钮走的就是这个):

    POST /api/dsh-plugin-manager/policy-bulk
    {"names":["a","b"], "patch":{"checkEnabled":true,"autoInstall":true}}

只认 checkEnabled / autoInstall / ignoredVersion 三个键, 其余忽略; names 为空回 400。
写的是 profile 根下 stardustlc-plugin-updates.json, revision 自增。

安全检查与安装:

    GET  /api/dsh-plugin-manager/safety?mode=profile              全部已装插件, 本地扫 (不联网)
    GET  /api/dsh-plugin-manager/safety?mode=installed&name=<包名>
    GET  /api/dsh-plugin-manager/safety?mode=package&name=<包名>&version=<版本>
    POST /api/dsh-plugin-manager/safety  {"action":"clear-cache"}  清扫描缓存

    GET  /api/dsh-plugin-manager/market?q=memory&category=agi&limit=50
    GET  /api/dsh-plugin-manager/market?sort=downloads     recent(默认) / downloads / stars / name
    GET  /api/dsh-plugin-manager/market?nocreds=1          剔除 capabilities 含读凭据/动态代码的
    GET  /api/dsh-plugin-manager/market?resolve=dsh-ppt    版本 / tarball / 可装的 spec / compat

    POST /api/dsh-plugin-manager/install
    {"action":"install","name":"dsh-ppt","version":"0.20.3"}     version 省略则取 latest
    {"action":"install","name":"dsh-ppt","dryRun":true}          只回 argv, 不动磁盘
    {"action":"uninstall","name":"dsh-ppt"}

install 不自己判安全检查 —— 面板先调 safety 把报告摆给用户, 用户点了才回到这里。
执行前自动建快照, 返回体里带着 snapshot 名字, 想退就 `dsh-pm.cmd snapshot restore <名字>`。

自动重启 (1.4.0 起, 面板升完/装完/卸完/停用完自己调):

    POST /api/dsh-plugin-manager/restart
    {}                        真的重启: 先把响应写完, 600ms 后才 spawn helper + 自杀
    {"dryRun":true}           只回显 "将会执行什么命令行", 不动手
    {"waitMs":1500}           helper 等多久再拉起宿主 (默认 1500, 给 Windows 放端口)
    {"delayMs":600}           自杀前等多久 (默认 600)

**跑在宿主进程里的坑**: Electron 给 fs 打的补丁会把任何含 `.asar` 的路径当成归档内部路径,
直接 stat/open `app.asar` 会失败, 于是"宿主自带包"集合变成空, 打包在 app.asar 里的
@deepseek-ai/* 全被误报为"缺失"(面板上显示"严重 2")。`src/host.mjs` 里的 `noAsar()` 在读写
asar 前后临时置 `process.noAsar = true` 解决; 纯 node 下调用它是空操作, 命令行本来就没这毛病。
判断是否踩了这个坑: 面板复检后"缺失"应为 0,"宿主自带包"应为 307 左右。