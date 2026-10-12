# dsh-hot-restart · hot restart for DSH

[![npm version](https://img.shields.io/npm/v/dsh-hot-restart)](https://www.npmjs.com/package/dsh-hot-restart)
[![license](https://img.shields.io/npm/l/dsh-hot-restart)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

[中文](README.md) | [English](README.en.md)

One fixed button inside the DSH window. Click it and DSH closes and reopens automatically. Right-click it for a built-in self check that writes a single diagnostic report you can send as-is.

- the button floats above the page and never squeezes your content;
- solid theme colour with white text, hard to miss;
- clicking asks for confirmation first, because a restart interrupts running tasks;
- once DSH is back, the page shows a short "DSH hot restart finished" toast.

Release notes for every version live in [CHANGELOG.md](CHANGELOG.md). There is also a
[beginner guide](小白向指南.md), in Chinese.
## Install

Published on npm. Use an exact version (a freshly published version is skipped for 24 hours):

```
dsh-hot-restart@0.3.14
```

If that fails, use the GitHub spec. The target machine needs git:

```
github:xiaolu511/dsh-hot-restart@0.3.14
```

For an offline machine, pack a tgz and use a `file:` spec with its absolute path.

On the desktop client, ask the Agent to run `plugin_manager` and then `install_bundle`. For the
`web` profile, use the CLI:

```bash
dsh plugin --profile web add dsh-hot-restart@0.3.14
```

### Restart DSH once after installing

Two reasons, both of which need a real process restart:

1. **The desktop shell collects its injection table once, at host startup**, then hands it to the
   page over IPC. There is no runtime refresh channel, so without a restart the button never shows up;
2. **Host-side code is cached by module URL**, so a hot install or update does not replace a module
   that is already running. Changes to `lib/index.js` take effect on the next host start. The plugin
   manager marks these installs as `restart-required`.

Pick either way to restart, both are window-free:

- double-click `tools\restart-dsh.vbs`, recommended;
- right-click the tray icon and choose Quit, then start DSH again.

## Usage

| Action | Result |
|---|---|
| Click the button | confirmation dialog → "restart now" → DSH closes and reopens |
| `Esc` | closes the dialog |

The button uses the theme colour normally. It turns grey when the host decides a restart is not
possible and hovering shows the reason. It turns amber while a restart is running.

## How the restart works

1. The page sends `POST /dsh-hot-restart/restart` with the `x-dsh-hot-restart: 1` header;
2. The host locates the shell process from its own parent. The parent must not be an Electron
   `--type=` child, must not be a terminal or an interpreter, and its executable name has to look
   like a DSH app. Anything else is refused, so a `dsh web` running in a terminal is never killed;
3. It dispatches `wscript.exe //B lib\relaunch.vbs` through WMI. wscript is a GUI-subsystem program
   and creates no console. Processes created through WMI leave the DSH job object, so the helper
   survives the shell;
4. The host answers the page, then runs `taskkill /F` on the shell process 700 ms later;
5. The helper waits for the shell to exit, force-terminates it through WMI if that takes longer than
   25 seconds, waits for the port to be released, and finally starts DSH through WMI, so the new
   instance inherits no console.

Logs live in `$DSH_HOME/hot-restart/`: `restart.log` and `last-restart.json`.

## Files

```
dsh-hot-restart/
├─ cordis.patch.yml          # bundle mount declaration
├─ lib/
│  ├─ index.js               # host half: injection row + /dsh-hot-restart/* routes + restart orchestration
│  ├─ relaunch.vbs           # preferred helper: zero console, waits for the shell, starts DSH via WMI
│  ├─ relaunch.ps1           # helper fallback, only used when wscript or VBScript is disabled
│  └─ ui.js                  # page half: the fixed button, no build step
├─ tools/
│  ├─ restart-dsh.vbs        # double-click to restart DSH silently, zero window, handy for upgrades
│  ├─ restart-dsh.cmd        # for terminals, prints progress, but .cmd always brings a console window
│  └─ restart-dsh.ps1        # implementation behind the .cmd above
├─ tests/host-half.test.mjs
└─ package.json
```

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/dsh-hot-restart/status.json` | host and shell info, whether a restart is possible. The page asks once on load |
| POST | `/dsh-hot-restart/restart` | starts a hot restart, requires `x-dsh-hot-restart: 1` |
| GET | `/dsh-hot-restart/ui.js` | the page script itself |

All three routes run the plugin's own loopback, same-origin and `Sec-Fetch-Site` checks first, then
hand over to the host trust fence, so only a local page can trigger them. A bare `curl` gets a 401.

## Uninstall

Ask the Agent to run `plugin_manager` and then `remove_bundle` with the target `dsh-hot-restart`, or:

```bash
dsh plugin --profile web remove dsh-hot-restart@0.3.14
```

Then delete `$DSH_HOME/hot-restart/`, which only holds logs and the last restart record.

## Limitations

- A hot restart only works on the Windows desktop client. Everywhere else the button turns grey and
  explains why.
- The restart is forced. Tasks that are generating or executing tools are interrupted; the session
  and your project files are already on disk, so you can continue after the restart.
- Do not start DSH by typing a command in a console. DSH then hangs off that console, and closing
  the window kills DSH. This is Windows behaviour, not something this plugin causes. Starting DSH
  from a Start Menu shortcut, by double-clicking the exe, or through this plugin's restart tools is fine.
- The button position is hard-coded to the bottom-left of the main area. To move it, edit the `left`
  and `bottom` lines of `#dsh-hr-btn` in `lib/ui.js`.
