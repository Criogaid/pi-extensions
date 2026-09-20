/**
 * Cache-friendly skill injection.
 *
 * Pi builds its default skills section from systemPromptOptions.skills.
 * The skill router clears that input for the current turn, leaving other
 * structured prompt sections unchanged.
 * `buildSkillsInjection` renders the turn's selected skills as a custom
 * message appended after the user prompt. Injections are history: they
 * never mutate earlier bytes, so the cached prefix keeps growing.
 *
 * Description caching: a skill's description is included only the first
 * time it is injected in a given context (session or post-compaction);
 * later injections carry a compact one-line entry. After a compaction the
 * summarized history no longer holds the descriptions, so callers reset
 * the cache (`resetSkillCache`) and the next injection re-describes.
 */

import type { InjectedMessage, SkillEntry } from "./types.ts";

/** Custom type identifying scout's per-turn skill injections. */
const INJECTION_CUSTOM_TYPE = "scout-skills";

/** Track skill names already described to the LLM in this context. */
let shownSkills: Set<string> = new Set();

/** Reset the description cache — on session_start and session_compact. */
export function resetSkillCache(): void {
  shownSkills = new Set();
}

/**
 * Map pi's skill objects to scout entries, preserving the user-only flag.
 *
 * pi hides skills whose frontmatter sets `disable-model-invocation` from
 * the system prompt — they are only invocable via `/skill:name`. Scout
 * receives the unfiltered list via `systemPromptOptions.skills`; this mapper
 * keeps the full inventory (for list_skills) and flags user-only skills so
 * consumers can exclude them from routing candidates and main-prompt injection.
 *
 * @internal — exported for testing.
 */
export function toSkillEntries(
  skills: Array<{
    name: string;
    description?: string;
    filePath: string;
    disableModelInvocation?: boolean;
  }>,
): SkillEntry[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description ?? "",
    filePath: s.filePath,
    ...(s.disableModelInvocation ? { userOnly: true } : {}),
  }));
}

/**
 * Build the per-turn skill injection message.
 *
 * The message is stored in the session after the user prompt and sent to the
 * LLM (converted to a user message); `display: false` keeps it out of the
 * rendered chat. Because injections are append-only history, they never
 * invalidate the cached prefix — each turn only pays for its own new block.
 *
 * First description of a skill: full entry with description. Already
 * described: compact one-liner (the description is already in history).
 * First injection of a context additionally carries the full usage
 * instructions pi's default section would have provided.
 *
 * @param selectedSkills - Skill names chosen by the side agent
 * @param allSkills - All loaded skills with their metadata
 * @returns Message to inject, or null when nothing is selected
 */
export function buildSkillsInjection(
  selectedSkills: string[],
  allSkills: Array<{ name: string; description: string; filePath: string }>,
): InjectedMessage | null {
  if (selectedSkills.length === 0) return null;

  const firstInjection = shownSkills.size === 0;
  const skillMap = new Map(allSkills.map((s) => [s.name, s]));
  const entries: string[] = [];

  for (const name of selectedSkills) {
    const skill = skillMap.get(name);
    if (!skill) continue;

    if (shownSkills.has(name)) {
      // Already described — compact form
      entries.push(`  <skill name="${esc(skill.name)}" location="${esc(skill.filePath)}" />`);
    } else {
      // First description — include it, then remember
      entries.push(
        `  <skill name="${esc(skill.name)}" location="${esc(skill.filePath)}">${esc(skill.description)}</skill>`,
      );
      shownSkills.add(name);
    }
  }

  if (entries.length === 0) return null;

  const lines: string[] = [];
  if (firstInjection) {
    lines.push(
      "The following skills are active for this request. Use the read tool to load a skill's file when the task matches its description.",
    );
    lines.push(
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    );
  } else {
    lines.push(
      "Active skills for this request (use the read tool to load a skill's file when the task matches its description):",
    );
  }
  lines.push("<active_skills>");
  lines.push(...entries);
  lines.push("</active_skills>");

  return {
    customType: INJECTION_CUSTOM_TYPE,
    content: lines.join("\n"),
    display: false,
  };
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
