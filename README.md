# dsh-hot-restart · DSH 热重启

在 DSH 主区域**左下角固定一个按钮**：**点一下就热重启 DSH** —— 关闭 DSH（Electron 外壳 + 宿主进程），
约 5–15 秒后由重启助手**自动重新打开**。**全程不出现任何黑色控制台/终端窗口**（v0.3.0 修复）。

- 位置固定、不参与布局（浮层），**不会挤压正文**；
- 按钮是实心主题色 + 白字「热重启 DSH」，一眼能看见；
- 点下去先弹一个确认框（重启会中断正在运行的任务），确认后立刻执行；
- 重启完成后页面会弹一条「DSH 已热重启完成（约 N 秒）」。

按钮固定在 `左侧 = 侧边栏宽度 + 16px`、`距底 14px`（读的是 DSH 自己发布的
`--dsh-windows-sidebar-width`，窗口缩放会跟着走）。**故意放在左边**：右下角被小鲸鱼挂件整块占着
（`.dshwv-root{position:fixed;right:0;bottom:0}`，尺寸可达 300px+）。

> **关于「为什么不在系统托盘的右键菜单里」**：那个菜单（打开应用 / 退出）由 DSH 的 Electron 外壳在
> `app.asar/lib/main.js` 的 `DesktopTray.relabel()` 里**写死**，宿主侧的插件既拿不到 Electron API，
> 外壳也没有任何插件扩展点或 IPC 让插件加项——所以插件无法往原生托盘菜单里加东西，
> 入口只能放在页面内。原生托盘菜单要加项必须改外壳（重打包 `app.asar`，官方更新后失效）。

## 安装

四种装法任选，**推荐 ①**（已发布到 npm：不需要 git、不需要代理，插件页里也能按名字搜到）：

**① 从 npm 装**

```
dsh-hot-restart
```

**② 从 GitHub 装**（需要目标机器装了 `git`）

插件管理器会先 `git ls-remote` 检查，再交给 pnpm：

```
github:xiaolu511/dsh-hot-restart
```

**③ 用打包好的 tgz**（离线 / 无 git 环境最稳）

把 `dsh-hot-restart-<版本>.tgz` 拷到目标机器，spec 用 `file:<tgz 绝对路径>`。

**④ 本地目录**（开发用，link 安装，路径不能移动/删除）

spec 用 `link:<你的克隆目录>\dsh-hot-restart`。

桌面客户端读的是 `desktop` profile，而 CLI 按设计**不允许** `--profile desktop`，所以上面几种都用内置插件管理器
（让 Agent 执行 `plugin_manager` → `install_bundle`）。非桌面形态（`web` profile）才走 CLI：

```bash
dsh plugin --profile web add dsh-hot-restart
```

### 升级 / 首次安装后要手动重启一次 DSH（只有这一次）

两个原因，都必须靠一次**真实的进程重启**解决：

1. **桌面壳的注入表是宿主启动时一次性收集的**（`collectIndexInjections()` → IPC → 渲染层缓存，
   页面每次 boot 只从 `dsh-desktop:boot` 取这份缓存），运行期没有刷新通道 —— 不重启的话页面里没按钮；
2. **宿主侧代码按模块 URL 缓存**：插件热装/热更不会替换已经在跑的模块，所以 `lib/index.js` 的改动
   必须等下一次宿主启动才生效（插件管理器自己也会把这种安装标成 `restart-required`）。

所以升级到 v0.3.0 之后，请用下面**任意一种零窗口方式**重启一次：

- **双击 `tools\restart-dsh.vbs`**（推荐：静默、无窗口、不经过插件）；
- 或托盘鲸鱼图标右键「退出」，再正常打开 DSH。

> ⚠️ 在那次重启之前**先别点页面里的按钮**：运行中的宿主还是旧模块，点它会复现黑窗口。
> 重启之后按钮就完全无窗口了。

## 用法

| 操作 | 结果 |
|---|---|
| **点按钮** | 弹确认框 → 「立即热重启」 → 关闭并自动重开 DSH |
| `Esc` | 关掉确认框 |

按钮状态：正常是主题色；宿主说「不可重启」时变灰并在悬停提示里说明原因（点它会解释）；
正在重启时变琥珀色并显示「正在重启…」。

## 它是怎么重启的

1. 页面 `POST /dsh-hot-restart/restart`（带 `x-dsh-hot-restart: 1` 头）；
2. 宿主半区定位外壳进程：自己的父进程（`process.ppid`）必须**同名可执行文件、且不是 `--type=` 子进程**，
   否则直接拒绝（fail-closed，绝不去 kill 终端里的 `dsh web`）；
3. 用 WMI 派发 `wscript.exe //B lib\relaunch.vbs`（**GUI 子系统 → 不创建控制台**；
   WMI 创建 → 脱离 DSH 的 Job，能活到外壳退出之后）；
4. 宿主回包给页面，700ms 后 `taskkill /F` 终结外壳进程；
5. 助手等外壳退出（25s 内没等到就自己 WMI `Terminate` 兜底）→ 等 19387 端口释放 →
   WMI 拉起 DSH（无控制台继承）。

日志：`$DSH_HOME/hot-restart/restart.log`、`$DSH_HOME/hot-restart/last-restart.json`。

## 文件

```
dsh-hot-restart/
├─ cordis.patch.yml          # bundle 挂载声明
├─ lib/
│  ├─ index.js               # 宿主半区：注入行 + /dsh-hot-restart/* 路由 + 重启编排
│  ├─ relaunch.vbs           # 重启助手（首选）：零控制台，等外壳退出 → WMI 拉起 DSH
│  ├─ relaunch.ps1           # 助手兜底（仅当系统禁用 wscript/VBScript 时才会用到）
│  └─ ui.js                  # 页面侧：固定位置的按钮（无构建步骤）
├─ tools/
│  ├─ restart-dsh.vbs        # 双击即静默重启 DSH（零窗口；升级/救急用）
│  ├─ restart-dsh.cmd        # 终端里用（会打印进度；.cmd 必然带控制台窗口）
│  └─ restart-dsh.ps1        # 上面 .cmd 的实现
├─ tests/host-half.test.mjs
└─ package.json
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-hot-restart/status.json` | 宿主 / 外壳信息、是否可重启（页面加载时问一次） |
| POST | `/dsh-hot-restart/restart` | 发起热重启（需 `x-dsh-hot-restart: 1`） |
| GET | `/dsh-hot-restart/ui.js` | 页面脚本本体 |

三条路由都先过插件自己的**回环 + 同源 + `Sec-Fetch-Site` 校验**，再委托宿主信任栅栏
（`ctx.connection.requestRejection`，裸 `curl` 会拿到 401），因此只有本机页面能触发。

## 卸载

让 Agent 执行 `plugin_manager` → `remove_bundle`（target `dsh-hot-restart`），或：

```bash
dsh plugin --profile web remove dsh-hot-restart
```

再删掉 `$DSH_HOME/hot-restart/` 即可（只有日志和上次重启记录）。

## 限制

- **只在 Windows 桌面客户端**下能热重启；其它情况下按钮变灰并说明原因。
- 重启是**强制**的（`taskkill /F`）：正在生成/执行工具的任务会被中断，会话与项目文件已落盘，重开后能继续。
- 不要用「在控制台里敲命令」的方式启动 DSH：那样 DSH 会挂在那条命令行的控制台上，
  关掉那个窗口 DSH 照样会死（这是 Windows 的行为，不是插件造成的）。用开始菜单快捷方式、
  双击 exe，或本插件的按钮/`restart-dsh.vbs` 都不会有这个问题。
- 按钮位置写死在主区域左下角；要换位置改 `lib/ui.js` 里 `#dsh-hr-btn` 的 `left` / `bottom` 两行。
