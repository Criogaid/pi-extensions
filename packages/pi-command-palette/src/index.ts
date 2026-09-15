/**
 * pi-command-palette — Global command palette for pi.
 *
 * Press Ctrl+Shift+P to open a searchable command palette overlay,
 * regardless of whether the editor has content.
 *
 * Features:
 * - Lists extension commands, skills, and prompt templates (from pi.getCommands())
 * - Built-in actions: model selector, new session, compact, reload
 * - Fuzzy search via SelectList
 * - Floating overlay on top of existing content
 * - Saves editor text before overwriting; offers "Restore" in palette
 * - Clear editor into the restore buffer
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { paletteCommandRegistry } from "@d3ara1n/pi-command-palette-core";
import {
  Container,
  type SelectItem,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { resolveShortcutKey } from "./config.ts";

// ── Types ──────────────────────────────────────────────────────────

type CommandAction =
  | { type: "editor"; text: string }
  | { type: "native"; id: string }
  | { type: "model-select" }
  | { type: "model"; provider: string; modelId: string }
  | { type: "compact" }
  | { type: "reload" }
  | { type: "restore" }
  | { type: "copy-editor" }
  | { type: "clear-editor" };

interface PaletteItem {
  value: string;
  label: string;
  description: string;
  category: string;
  action: CommandAction;
}

// ── Module state ───────────────────────────────────────────────────

/** Editor text saved before the palette overwrites it. */
let savedEditorText: string | null = null;

/**
 * Explicit display order for built-in palette entries (lower = higher up).
 * Unlisted built-ins fall back to alphabetical, after the listed ones;
 * non-built-in entries always sort after built-ins.
 */
const BUILTIN_ORDER: Record<string, number> = {
  __model_select: 0,
  __restore: 1,
  __copy_editor: 2,
  __clear_editor: 3,
};

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Sort ranks: built-in actions first, then native commands registered by other
 * extensions (direct callbacks), then everything that fills the editor with a
 * `/command`. Lower rank = higher up in the palette.
 */
function paletteSortRank(item: PaletteItem): number {
  if (item.category === "Built-in") return 0;
  if (item.action.type === "native") return 1;
  return 2;
}

/**
 * @internal — exported for testing; builds the palette item list from
 * built-ins, the native-command registry, and pi's command registry.
 */
export function buildPaletteItems(pi: ExtensionAPI): PaletteItem[] {
  const items: PaletteItem[] = [];

  // ── Restore option (if previous editor text was saved) ────────
  if (savedEditorText) {
    const preview =
      savedEditorText.length > 40 ? `${savedEditorText.slice(0, 37)}...` : savedEditorText;
    items.push({
      value: "__restore",
      label: "Restore: Previous Editor Text",
      description: preview.replace(/\n/g, "⏎"),
      category: "Built-in",
      action: { type: "restore" },
    });
  }

  // ── Built-in actions ──────────────────────────────────────────
  items.push({
    value: "__model_select",
    label: "Model: Switch Model",
    description: "Select a model from the registry",
    category: "Built-in",
    action: { type: "model-select" },
  });

  items.push({
    value: "__new_session",
    label: "Session: New",
    description: "Start a new session",
    category: "Built-in",
    action: { type: "editor", text: "/new" },
  });

  items.push({
    value: "__compact",
    label: "Session: Compact",
    description: "Compact conversation to free context",
    category: "Built-in",
    action: { type: "compact" },
  });

  items.push({
    value: "__reload",
    label: "Session: Reload",
    description: "Reload extensions, skills, and config",
    category: "Built-in",
    action: { type: "reload" },
  });

  items.push({
    value: "__fork",
    label: "Session: Fork",
    description: "Fork from selected entry",
    category: "Built-in",
    action: { type: "editor", text: "/fork" },
  });

  items.push({
    value: "__tree",
    label: "Session: Tree",
    description: "Navigate session tree",
    category: "Built-in",
    action: { type: "editor", text: "/tree" },
  });

  items.push({
    value: "__resume",
    label: "Session: Resume",
    description: "Resume a previous session",
    category: "Built-in",
    action: { type: "editor", text: "/resume" },
  });

  items.push({
    value: "__copy_editor",
    label: "Editor: Copy Content",
    description: "Copy current editor text to clipboard",
    category: "Built-in",
    action: { type: "copy-editor" },
  });

  items.push({
    value: "__clear_editor",
    label: "Editor: Clear Content",
    description: "Clear editor (recover via Restore)",
    category: "Built-in",
    action: { type: "clear-editor" },
  });

  // ── Native commands from other extensions ────────────────────
  // Direct callbacks registered via @d3ara1n/pi-command-palette-core —
  // executed in place, never touching the editor. Read at palette-open time,
  // so late registrations are visible the next time the palette opens.
  for (const cmd of paletteCommandRegistry.getAll()) {
    items.push({
      value: `native:${cmd.id}`,
      label: cmd.label,
      description: cmd.description ?? "",
      category: "Native",
      action: { type: "native", id: cmd.id },
    });
  }

  // ── Extension commands, skills, templates ────────────────────
  const commands = pi.getCommands();
  for (const cmd of commands) {
    const editorText = `/${cmd.name}`;
    const sourceLabel =
      cmd.source === "extension" ? "Command" : cmd.source === "skill" ? "Skill" : "Template";

    items.push({
      value: `cmd:${cmd.name}`,
      label: `${sourceLabel}: /${cmd.name}`,
      description: cmd.description ?? "",
      category: sourceLabel,
      action: { type: "editor", text: editorText },
    });
  }

  // Sort: built-in actions first (ordered by BUILTIN_ORDER, then alphabetical),
  // then native commands, then editor-fill entries — each group alphabetical.
  items.sort((a, b) => {
    const ar = paletteSortRank(a);
    const br = paletteSortRank(b);
    if (ar !== br) return ar - br;
    if (ar === 0) {
      const ai = BUILTIN_ORDER[a.value] ?? Number.MAX_SAFE_INTEGER;
      const bi = BUILTIN_ORDER[b.value] ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
    }
    return a.label.localeCompare(b.label);
  });

  return items;
}

// ── Model selector ─────────────────────────────────────────────────

const STAR = "★ ";

/**
 * @internal — exported for testing; parses the selector's `provider/model-id` values.
 */
export function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
  const slash = modelRef.indexOf("/");
  if (slash === -1) return undefined;
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

// ── Partitioned fuzzy filter ───────────────────────────────────────

/**
 * Filter two partitions independently and concatenate them in a stable order:
 * every matching item from `primary`, then every matching item from
 * `secondary`. Each group is ranked by fuzzy score on its own, so `primary`
 * always stays on top — a single {@link fuzzyFilter} call flattens both groups
 * into one score-ordered list and erases the boundary between them.
 *
 * An empty (or whitespace-only) query returns `[...primary, ...secondary]`
 * unchanged.
 *
 * @internal — exported for testing; the model selector is the only caller.
 */
export function partitionedFuzzyFilter<T>(
  primary: T[],
  secondary: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query.trim()) return [...primary, ...secondary];
  return [...fuzzyFilter(primary, query, getText), ...fuzzyFilter(secondary, query, getText)];
}

// ── Command palette overlay ────────────────────────────────────────

interface PalettePage {
  title: string;
  items: Array<PaletteItem | { type: "page"; value: string; label: string; description: string; page: PalettePage }>;
}

function pageItem(
  value: string,
  label: string,
  description: string,
  page: PalettePage,
): PalettePage["items"][number] {
  return { type: "page", value, label, description, page };
}

async function showCommandPalette(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") return;

  const paletteItems = buildPaletteItems(pi);
  const leaves = (category: string) =>
    paletteItems.filter((item) => item.category === category);
  const leafPage = (title: string, items: PaletteItem[]): PalettePage => ({ title, items });

  const builtins = leaves("Built-in").filter((item) => item.action.type !== "model-select");
  const native = leaves("Native");
  const commands = leaves("Command");
  const skills = leaves("Skill");
  const templates = leaves("Template");
  const modelPage: PalettePage = { title: "Models", items: [] };
  const rootItems: PalettePage["items"] = [
    pageItem("models", "Model: Switch Model", "Choose a model", modelPage),
    ...(builtins.length ? [pageItem("builtins", "Built-in Actions", "Session and editor actions", leafPage("Built-in Actions", builtins))] : []),
    ...(native.length ? [pageItem("native", "Extension Actions", "Actions provided by extensions", leafPage("Extension Actions", native))] : []),
    ...(commands.length ? [pageItem("commands", "Commands", "Extension slash commands", leafPage("Commands", commands))] : []),
    ...(skills.length ? [pageItem("skills", "Skills", "Installed skills", leafPage("Skills", skills))] : []),
    ...(templates.length ? [pageItem("templates", "Templates", "Prompt templates", leafPage("Templates", templates))] : []),
  ];
  const root: PalettePage = { title: "Command Palette", items: rootItems };

  const result = await ctx.ui.custom<PaletteItem | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      const listHost = new Container();
      const queryInput = new Input();
      let focused = true;
      const stack: Array<{ page: PalettePage; input: string; selectedValue?: string }> = [
        { page: root, input: "" },
      ];
      let selectList!: SelectList;
      let visibleItems: PalettePage["items"] = [];
      let modelLoading = false;

      const listTheme = {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      };

      function current() {
        return stack[stack.length - 1]!;
      }

      function rebuild() {
        const { page } = current();
        const query = queryInput.getValue();
        visibleItems =
          page === root && query.trim()
            ? [
                ...root.items,
                ...paletteItems.filter((item) => item.action.type !== "model-select"),
              ]
            : page.items;
        const items = visibleItems.map((item) => ({
          value: item.value,
          label: item.label,
          description:
            page === root && query.trim() && !("page" in item)
              ? `${item.category} › ${item.description}`
              : item.description,
        }));
        const getText = (item: SelectItem) => `${item.label} ${item.description ?? ""}`;
        const filtered = query
          ? page === modelPage
            ? partitionedFuzzyFilter(
                items.filter((item) => item.label.startsWith(STAR)),
                items.filter((item) => !item.label.startsWith(STAR)),
                query,
                getText,
              )
            : fuzzyFilter(items, query, getText)
          : items;
        selectList = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), 15), listTheme);
        const restoredIndex = filtered.findIndex(
          (item) => item.value === current().selectedValue,
        );
        if (restoredIndex >= 0) selectList.setSelectedIndex(restoredIndex);
        listHost.clear();
        listHost.addChild(selectList);
        selectList.onSelect = (selected) => {
          current().selectedValue = selected.value;
          const item = visibleItems.find((candidate) => candidate.value === selected.value);
          if (!item) return;
          if ("page" in item) {
            if (item.value === "models" && !modelLoading && item.page.items.length === 0) {
              modelLoading = true;
              try {
                const models = ctx.modelRegistry.getAvailable();
                const scopedIds = new Set(
                  ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`),
                );
                const decorated = models
                  .map((m) => {
                    const value = `${m.provider}/${m.id}`;
                    const scoped = scopedIds.has(value);
                    return {
                      scoped,
                      item: {
                        value,
                        label: scoped ? `${STAR}${m.name}` : m.name,
                        description: m.provider,
                        category: "Built-in",
                        action: { type: "model", provider: m.provider, modelId: m.id } as CommandAction,
                      },
                    };
                  })
                  .sort((a, b) =>
                    a.scoped === b.scoped
                      ? a.item.label.localeCompare(b.item.label)
                      : a.scoped
                        ? -1
                        : 1,
                  );
                item.page.items = decorated.map((d) => d.item);
                modelLoading = false;
                if (item.page.items.length === 0) {
                  ctx.ui.notify("No models available.", "warning");
                  return;
                }
                pushPage(item.page);
              } catch {
                modelLoading = false;
                ctx.ui.notify("Cannot enumerate models.", "warning");
              }
              return;
            }
            pushPage(item.page);
          } else {
            done(item);
          }
        };
        selectList.onSelectionChange = (selected) => {
          current().selectedValue = selected.value;
        };
        selectList.onCancel = () => done(null);
        if (modelLoading && page.title === "Models") {
          listHost.clear();
          listHost.addChild(new Text(theme.fg("muted", "Loading models…"), 1, 0));
        }
      }

      function pushPage(page: PalettePage) {
        current().input = queryInput.getValue();
        stack.push({ page, input: "" });
        queryInput.setValue("");
        rebuild();
        tui.requestRender();
      }

      function popPage() {
        if (stack.length <= 1) return;
        stack.pop();
        queryInput.setValue(current().input);
        rebuild();
        tui.requestRender();
      }

      rebuild();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(root.title)), 1, 0));
      container.addChild(queryInput);
      container.addChild(listHost);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open/select • backspace on empty returns • esc closes"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          queryInput.focused = value;
        },
        render(w: number) {
          const lines = container.render(w);
          const title = stack.map((frame) => frame.page.title).join(" › ");
          lines[1] = theme.fg("accent", theme.bold(title));
          return lines;
        },
        invalidate() {
          container.invalidate();
          queryInput.invalidate();
          selectList.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
          if (matchesKey(data, Key.backspace) && queryInput.getValue().length === 0) {
            popPage();
            return;
          }
          if (
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.enter)
          ) {
            selectList.handleInput(data);
          } else {
            const before = queryInput.getValue();
            queryInput.handleInput(data);
            if (queryInput.getValue() !== before) {
              current().selectedValue = undefined;
              rebuild();
            }
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", minWidth: 50 } },
  );

  if (!result) return;

  // Execute the selected action
  const action = result.action;
  switch (action.type) {
    case "native": {
      const cmd = paletteCommandRegistry.get(action.id);
      if (!cmd) {
        ctx.ui.notify(`Palette command not found: ${action.id}`, "warning");
        break;
      }
      try {
        await cmd.run(pi, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Palette command "${cmd.label}" failed: ${message}`, "error");
      }
      break;
    }
    case "model-select": {
      // Kept for compatibility with callers that may construct this action.
      break;
    }
    case "restore": {
      if (savedEditorText !== null) {
        ctx.ui.setEditorText(savedEditorText);
        savedEditorText = null;
      }
      break;
    }
    case "editor": {
      // Save current editor text before overwriting, so user can restore
      const currentText = ctx.ui.getEditorText();
      if (currentText && currentText.trim()) {
        savedEditorText = currentText;
      }
      ctx.ui.setEditorText(action.text);
      break;
    }
    case "model": {
      const model = ctx.modelRegistry.find(action.provider, action.modelId);
      if (model) {
        const success = await pi.setModel(model);
        ctx.ui.notify(
          success ? `Model: ${action.provider}/${action.modelId}` : `No API key for ${action.provider}/${action.modelId}`,
          success ? "info" : "error",
        );
      }
      break;
    }
    case "compact": {
      ctx.compact({
        onComplete: () => ctx.ui.notify("Compaction completed", "info"),
        onError: (err) => ctx.ui.notify(`Compaction failed: ${err.message}`, "error"),
      });
      break;
    }
    case "reload": {
      const currentText = ctx.ui.getEditorText();
      if (currentText && currentText.trim()) {
        savedEditorText = currentText;
      }
      ctx.ui.setEditorText("/reload");
      break;
    }
    case "copy-editor": {
      const text = ctx.ui.getEditorText();
      if (text && text.trim()) {
        await copyToClipboard(text);
        ctx.ui.notify("Copied editor text to clipboard", "info");
      } else {
        ctx.ui.notify("Editor is empty", "warning");
      }
      break;
    }
    case "clear-editor": {
      // Save current editor text to the restore buffer before clearing, so
      // the built-in Restore action can bring it back.
      const currentText = ctx.ui.getEditorText();
      if (currentText && currentText.trim()) {
        savedEditorText = currentText;
        ctx.ui.setEditorText("");
        ctx.ui.notify("Cleared editor — use Restore to recover", "info");
      } else {
        ctx.ui.notify("Editor is empty", "warning");
      }
      break;
    }
  }
}

// ── Extension entry point ──────────────────────────────────────────

export default function commandPaletteExtension(pi: ExtensionAPI) {
  pi.registerShortcut(resolveShortcutKey(), {
    description: "Open command palette",
    handler: async (ctx) => {
      await showCommandPalette(pi, ctx);
    },
  });
}
