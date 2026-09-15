# pi-command-palette

[![npm version](https://img.shields.io/npm/v/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette) [![npm downloads](https://img.shields.io/npm/dm/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette) [![license](https://img.shields.io/npm/l/@d3ara1n/pi-command-palette)](https://www.npmjs.com/package/@d3ara1n/pi-command-palette)

Global command palette for [Pi Coding Agent](https://pi.dev) — press **Ctrl+Shift+P** to search and run commands from anywhere.

## Why?

Pi's slash commands (`/model`, `/compact`, extension commands, etc.) only work when the editor is empty. If you've typed something and want to switch models or run a command, you're stuck. This extension opens a floating command palette via keyboard shortcut, regardless of editor state.

## Dependencies

- [`@d3ara1n/pi-command-palette-core`](../pi-command-palette-core) — shared registry for native palette commands (pure npm library, installed automatically)

## Installation

```bash
pi install npm:@d3ara1n/pi-command-palette
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/packages/pi-command-palette"
  ]
}
```

## Usage

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` _(default, configurable)_ | Open command palette |

The palette opens as a single macOS-launcher-style overlay with nested pages. Selecting a category with **Enter** replaces the current list in the same overlay instead of opening a second overlay. Press **Backspace** with an empty search field to return to the parent page; press **Esc** to close the palette immediately.

The palette lists:

- **Built-in Actions** — curated shortcuts for common operations (detailed below)
- **Extension Actions** — entries registered by other extensions that run a callback directly (see below)
- **Commands** — all registered `/command` entries
- **Skills** — installed skill commands
- **Templates** — prompt templates

Use **↑/↓** to move through entries and **←/→** to edit the search cursor. Search is fuzzy within the current page and updates as you type; Backspace uses the normal text-editing behavior while the query is non-empty.

### Built-in actions

Built-in actions are grouped by how they run:

**Run immediately** — they call pi's API directly, no editor round-trip:

| Action | What it does |
|--------|--------------|
| Model: Switch Model | Open a model selector overlay; switch instantly |
| Session: Compact | Compact the conversation right away |
| Editor: Copy Content | Copy current editor text to the clipboard |
| Editor: Clear Content | Clear the editor, saving the current text to the restore buffer |
| Restore: Previous Editor Text | Bring back text saved before the last command _(appears only when available)_ |

**Fill the editor** — they insert the matching `/command` for you to submit, just like any extension command:

| Action | Inserts |
|--------|---------|
| Session: New | `/new` |
| Session: Reload | `/reload` |
| Session: Fork | `/fork` |
| Session: Tree | `/tree` |
| Session: Resume | `/resume` |

> Pi ships with more built-in slash commands (e.g. `/export`, `/share`, `/name`, `/settings`). This palette only surfaces a curated subset above — for the rest, type them directly into the editor.

### Native commands from other extensions

Extensions built on [`@d3ara1n/pi-command-palette-core`](../pi-command-palette-core) can register palette entries backed by a **direct callback** instead of a `/command` editor fill. They appear above the extension-command entries, and selecting one runs the callback in place — your editor text is never touched, saved, or restored:

```ts
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";

paletteCommandRegistry.register({
  id: "my-plugin:do-thing",
  label: "My Plugin: Do the Thing",
  description: "Runs immediately, without touching the editor",
  run: (pi, ctx) => { /* ... */ },
});
```

The registry is read every time the palette opens, so commands can be registered and unregistered at any time. Failures inside `run` are caught and surfaced as an error notification. See the [core package](../pi-command-palette-core) for the full API.

### Editor text preservation

When a command replaces your editor text, or you run **Editor: Clear Content**, the original content is saved and a **Restore: Previous Editor Text** entry appears at the top of the palette. Select it to get your text back.

### Model selector

The "Model: Switch Model" entry opens a model page inside the same overlay. Models are loaded when the page is first entered, then can be searched and selected without stacking another overlay.

**Scoped models float to the top**, marked with a ★ (favorite) prefix. "Scoped" here means the same set pi uses for its built-in selector's scoped tab and `Ctrl+P` cycling — the `enabledModels` patterns in your `settings.json` (project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`). Everything else follows alphabetically. Filtering preserves that boundary too — scoped matches stay above the rest while you type, rather than collapsing into one score-ordered list. If no scope is configured, the list is a plain alphabetical roster — nothing breaks.

## Configuration

The default shortcut is `Ctrl+Shift+P`, matching VS Code's Command Palette for familiar muscle memory. If it conflicts with your terminal or other shortcuts, override it via either of the following (evaluated in order, first match wins).

### 1. Environment variable

Useful for terminals that intercept `Ctrl+Shift+<key>` before it reaches the session (e.g. Termius on Windows/WSL2):

```bash
export PI_COMMAND_PALETTE_KEY=ctrl+shift+p
```

Add it to your shell profile to persist (`~/.zshrc` on macOS, `~/.bashrc` on bash).

### 2. settings.json

Set `commandPalette.shortcut` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` in your project. A present project `commandPalette` block replaces the global block:

```json
{
  "commandPalette": {
    "shortcut": "ctrl+shift+p"
  }
}
```

Any valid pi keybinding string works (e.g. `ctrl+shift+p`, `ctrl+shift+k`, `ctrl+alt+k`, `ctrl+k`). Restart pi (or run `/reload`) after changing the shortcut.
