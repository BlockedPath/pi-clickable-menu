# pi-clickable-menu

Pi extension: a **clickable TUI quick menu** with mouse hover highlight, keyboard navigation, and configurable actions.

Uses a compact centered overlay so your session stays visible around the panel (terminals cannot alpha-blend; only unpainted cells show through).

## Install

### From a local clone (development)

```bash
pi install /absolute/path/to/tui
# or from this directory:
pi install .
```

### Temporary try without installing

```bash
pi -e /absolute/path/to/tui
```

### From git / npm (once published)

```bash
pi install git:github.com/BlockedPath/pi-clickable-menu
pi install npm:pi-clickable-menu
```

Reload after install:

```text
/reload
```

## Commands

| Command | What it does |
| --- | --- |
| `/menu` | Open the menu |
| `/menu reload` | Reload `~/.pi/agent/clickable-menu.json` |
| `/menu path` | Show config file path |
| `/menu debug` | Toggle click debug logging → `/tmp/clickable-menu-debug.log` |

**Shortcut:** `Ctrl+Shift+M`

## Config

Copy the example and edit:

```bash
cp clickable-menu.example.json ~/.pi/agent/clickable-menu.json
```

```json
{
  "title": "Quick Menu",
  "items": [
    {
      "id": "plan",
      "label": "Plan mode prompt",
      "description": "Insert a planning prompt into the editor",
      "hotkey": "p",
      "action": {
        "type": "insert",
        "text": "Explore the codebase and draft a concrete implementation plan for: "
      }
    }
  ]
}
```

### Action types

| `type` | Effect |
| --- | --- |
| `insert` | Set editor text to `text` |
| `submit` | Send `text` as a user message |
| `notify` | Toast with `message` (`level`: `info` \| `warning` \| `error`) |
| `command` | Prefill editor with a slash command (press Enter to run) |
| `xai_tool` | Drive pi-xai-oauth tools: `open` / `status` / `enable` / `disable` (+ `tool`) |
| `shell` | Run `command` + `args` via `pi.exec` (confirms by default) |
| `none` | Notify selected label only |

#### xAI tools (`xai_tool`)

Requires [pi-xai-oauth](https://github.com/BlockedPath/pi-xai-oauth) and an active xAI/Grok model for enable/open.

```json
{ "type": "xai_tool", "action": "enable", "tool": "web_search" }
{ "type": "xai_tool", "action": "open" }
{ "type": "xai_tool", "action": "status" }
```

Tool names match `/xai-tools`: `web_search`, `xai_x_search`, `xai_deep_research`, `xai_multi_agent`, `xai_code_execution`, `xai_generate_image`, …

If the config file is missing or invalid, built-in defaults are used.

## Controls

- **Click** a row to activate
- **Hover** to highlight
- **↑ / ↓**, wheel, **Home / End**
- **1–9** jump + activate
- Letter **hotkey** activate
- **Esc** / click outside panel to cancel

## Debug

```text
/menu debug
```

Or start pi with `PI_MENU_DEBUG=1`. Logs append to `/tmp/clickable-menu-debug.log`.

## Package layout

```text
.
├── package.json          # pi.extensions → ./extensions/clickable-menu
├── extensions/
│   └── clickable-menu/
│       └── index.ts
├── clickable-menu.example.json
├── README.md
└── LICENSE
```
