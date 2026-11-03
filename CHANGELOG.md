# 变更记录

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
