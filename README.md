# dsh-hot-restart · DSH 热重启

[![npm version](https://img.shields.io/npm/v/dsh-hot-restart)](https://www.npmjs.com/package/dsh-hot-restart)
[![license](https://img.shields.io/npm/l/dsh-hot-restart)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

[中文](README.md) | [English](README.en.md) | [小白向指南](小白向指南.md)

在 DSH 窗口里放一个固定的按钮，点一下就把 DSH 关掉并自动重开。

- 按钮固定不动，浮在页面上，不会挤压正文；
- 实心主题色加白字「热重启 DSH」，一眼能看见；
- 点下去先弹确认框，提醒重启会中断正在运行的任务；
- 重开之后页面会弹一条「DSH 已热重启完成」。

每个版本的改动见 [CHANGELOG.md](CHANGELOG.md)。

按钮位置是 `左侧 = 侧边栏宽度 + 16px`、`距底 14px`，读的是 DSH 自己发布的 CSS 变量
`--dsh-windows-sidebar-width`，窗口缩放会跟着走。故意放左边，因为右下角被小鲸鱼挂件整块占着。

> **为什么不在系统托盘的右键菜单里**：那个菜单由 DSH 的 Electron 外壳写死在
> `app.asar/lib/main.js` 的 `DesktopTray.relabel` 里，宿主侧的插件拿不到 Electron API，
> 外壳也没留任何扩展点，所以插件加不了项，入口只能放在页面内。
> 要进原生托盘菜单必须重打包 `app.asar`，官方更新后失效。

## 安装

已发布到 npm:

```
dsh-hot-restart
```

装不上就换 GitHub 地址，目标机器需要有 git：

```
github:xiaolu511/dsh-hot-restart
```

离线环境可以用打包好的 tgz，spec 写 `file:` 加上 tgz 的绝对路径。

桌面客户端让 Agent 执行 `plugin_manager` 的 `install_bundle` 即可。`web` profile 走 CLI：

```bash
dsh plugin --profile web add dsh-hot-restart
```

### 装完要手动重启一次 DSH

两个原因，都得靠一次真实的进程重启解决：

1. **桌面壳的注入表只在宿主启动时收集一次**，之后经 IPC 交给页面并缓存，运行期没有刷新通道。
   不重启的话，页面里不会出现按钮；
2. **宿主侧代码按模块 URL 缓存**，热装热更不会替换已经在跑的模块，所以 `lib/index.js` 的改动
   要等下一次宿主启动才生效。插件管理器也会把这类安装标成 `restart-required`。

重启方式二选一：

- 双击 `tools\restart-dsh.vbs`，推荐；
- 托盘图标右键「退出」，再正常打开 DSH。

## 用法

| 操作 | 结果 |
|---|---|
| 点按钮 | 弹确认框 →「立即热重启」→ 关闭并自动重开 DSH |
| `Esc` | 关掉确认框 |

按钮平时是主题色；宿主判断不可重启时变灰，悬停能看到原因；正在重启时变琥珀色。

## 它是怎么重启的

1. 页面请求 `POST /dsh-hot-restart/restart`，带上 `x-dsh-hot-restart: 1` 头；
2. 宿主半区先定位外壳进程，看的是自己的父进程：不能是 Electron 的 `--type=` 子进程，不能是终端或解释器，
   并且 exe 名字得像 DSH 应用，否则直接拒绝，绝不去杀终端里的 `dsh web`；
3. 用 WMI 派发 `wscript.exe //B lib\relaunch.vbs`。wscript 是 GUI 子系统程序，不创建控制台；
   WMI 创建的进程脱离 DSH 的 Job，能活到外壳退出之后；
4. 宿主回包给页面，700ms 后 `taskkill /F` 终结外壳进程；
5. 助手等外壳退出，25 秒内没等到就自己用 WMI 强制结束，接着等 19387 端口释放，
   最后用 WMI 拉起 DSH，新实例不继承任何控制台。

日志在 `$DSH_HOME/hot-restart/`，里面有 `restart.log` 和 `last-restart.json`。

## 文件

```
dsh-hot-restart/
├─ cordis.patch.yml          # bundle 挂载声明
├─ lib/
│  ├─ index.js               # 宿主半区：注入行 + /dsh-hot-restart/* 路由 + 重启编排
│  ├─ relaunch.vbs           # 重启助手首选：零控制台，等外壳退出后用 WMI 拉起 DSH
│  ├─ relaunch.ps1           # 助手兜底，只在系统禁用 wscript 或 VBScript 时用到
│  └─ ui.js                  # 页面侧：固定位置的按钮，无构建步骤
├─ tools/
│  ├─ restart-dsh.vbs        # 双击即静默重启 DSH，零窗口，升级或救急用
│  ├─ restart-dsh.cmd        # 终端里用，会打印进度，但 .cmd 必然带控制台窗口
│  └─ restart-dsh.ps1        # 上面 .cmd 的实现
├─ tests/host-half.test.mjs
└─ package.json
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-hot-restart/status.json` | 宿主与外壳信息、能否重启，页面加载时问一次 |
| POST | `/dsh-hot-restart/restart` | 发起热重启，需要 `x-dsh-hot-restart: 1` |
| GET | `/dsh-hot-restart/ui.js` | 页面脚本本体 |

三条路由都会先过插件自己的回环检查、同源检查和 `Sec-Fetch-Site` 检查，再交给宿主信任栅栏，
所以只有本机页面能触发。裸 `curl` 会拿到 401。

## 卸载

让 Agent 执行 `plugin_manager` 的 `remove_bundle`，target 写 `dsh-hot-restart`；或者：

```bash
dsh plugin --profile web remove dsh-hot-restart
```

最后删掉 `$DSH_HOME/hot-restart/` 就行，里面只有日志和上次重启记录。

## 限制

- 只在 Windows 桌面客户端下能热重启，其它情况按钮会变灰并说明原因。
- 重启是强制的。正在生成或执行工具的任务会被中断，会话与项目文件都已落盘，重开后可以继续。
- 别用「在控制台里敲命令」的方式启动 DSH：那样 DSH 会挂在那条命令行的控制台上，关掉那个窗口 DSH 也会死。
  这是 Windows 的行为，不是插件造成的。用开始菜单快捷方式、双击 exe 或本插件的重启工具都没这个问题。
- 按钮位置写死在主区域左下角。想换位置就改 `lib/ui.js` 里 `#dsh-hr-btn` 的 `left` 和 `bottom`。
