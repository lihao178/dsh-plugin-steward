# DSH 插件管家 (dsh-plugin-steward)

Plugin steward for DeepSeek Harness — update checks, auto-update with snapshot rollback,
health checks, duplicate analysis, cleanup. One left-panel UI, one CLI, zero runtime dependencies.

一个零依赖的纯 Node 工具, 专门管理 DeepSeek Harness 的插件:
分类 / 查更新 / 查重 / 体检 / 修复 / 清理 / 备份回滚 / 定时自动更新。

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

> 装完要重启 Harness 才会加载新版本 —— 更新插件同理 (面板里升完会提示重启)。

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
                          apply 安装执行 / labels 中文名登记
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

### 开关与排除

    dsh-pm.cmd auto off                 暂停自动更新 (只影响 auto, 手动 update 照旧)
    dsh-pm.cmd auto on                  恢复
    dsh-pm.cmd auto skip dsh-ppt        这个插件不自动升
    dsh-pm.cmd auto unskip dsh-ppt      撤销
    dsh-pm.cmd auto log                 看最近几次装了啥, 有没有触发还原

配置在 .state\auto.json:

    { "enabled": true, "allowMajor": true, "skip": [] }

    enabled      总开关
    allowMajor   false = 只自动装次版本和补丁, 主版本留给你手动确认
    skip         包名黑名单

另外这些也会被跳过 (不是出错, 是没法自动升): 本地自创插件 (link: 目录, 没有版本可比)、
宿主内置包 (只读)、peer 依赖不满足且没给 --force。

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

装上之后左侧栏多一个"插件管家"图标, 点开就是总览 / 查更新 / 体检 / 重复分析 /
清理 / 快照回滚 / 定时任务。面板和 `dsh-pm.cmd` 读的是同一批模块, 结论永远一致。

HTTP 接口 (GET 即可, 便于 AI 或脚本直接调用):

    /api/dsh-plugin-manager/overview    总览
    /api/dsh-plugin-manager/check       查更新
    /api/dsh-plugin-manager/auto        自动更新状态 (config + 最近记录 + 计划任务)
    /api/dsh-plugin-manager/doctor      体检
    /api/dsh-plugin-manager/dupes       重复分析
    /api/dsh-plugin-manager/snapshots   快照列表

/auto 也收 POST: {"action":"on"|"off"|"skip"|"unskip","name":"包名"} 开关与排除,
{"action":"run","write":true} 立刻跑一次自动更新。未知的 /api 路径宿主一律回 401,
所以新加的接口在 Harness 重启前访问会看到 401——这不是权限问题, 是路由还没挂上。

**跑在宿主进程里的坑**: Electron 给 fs 打的补丁会把任何含 `.asar` 的路径当成归档内部路径,
直接 stat/open `app.asar` 会失败, 于是"宿主自带包"集合变成空, 打包在 app.asar 里的
@deepseek-ai/* 全被误报为"缺失"(面板上显示"严重 2")。`src/host.mjs` 里的 `noAsar()` 在读写
asar 前后临时置 `process.noAsar = true` 解决; 纯 node 下调用它是空操作, 命令行本来就没这毛病。
判断是否踩了这个坑: 面板复检后"缺失"应为 0,"宿主自带包"应为 307 左右。