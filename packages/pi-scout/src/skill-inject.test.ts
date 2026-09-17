/**
 * Tests for skill entry normalization and cache-friendly injection.
 * Run: node --test packages/pi-scout/src/skill-inject.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSkillsInjection,
  resetSkillCache,
  stripSkillsSection,
  toSkillEntries,
} from "./skill-inject.ts";

const SKILLS = [
  { name: "llm-skill", description: "d1", filePath: "/a/SKILL.md" },
  { name: "user-only", description: "d2", filePath: "/b/SKILL.md", userOnly: true as const },
];

// ── toSkillEntries ────────────────────────────────────────────────

test("toSkillEntries maps the user-only flag without dropping skills", () => {
  const entries = toSkillEntries([
    { name: "llm-skill", description: "d1", filePath: "/a/SKILL.md" },
    { name: "user-only", description: "d2", filePath: "/b/SKILL.md", disableModelInvocation: true },
  ]);
  assert.deepEqual(entries, [
    { name: "llm-skill", description: "d1", filePath: "/a/SKILL.md" },
    { name: "user-only", description: "d2", filePath: "/b/SKILL.md", userOnly: true },
  ]);
});

test("toSkillEntries omits userOnly when the flag is absent or false", () => {
  const entries = toSkillEntries([
    { name: "absent", description: "d", filePath: "/a/SKILL.md" },
    { name: "false-flag", description: "d", filePath: "/b/SKILL.md", disableModelInvocation: false },
  ]);
  assert.equal(entries.length, 2);
  for (const e of entries) assert.equal("userOnly" in e, false);
});

test("toSkillEntries defaults missing description to empty string", () => {
  const entries = toSkillEntries([{ name: "s", filePath: "/p" }]);
  assert.deepEqual(entries, [{ name: "s", description: "", filePath: "/p" }]);
});

// ── stripSkillsSection ────────────────────────────────────────────

function piSystemPrompt(skillsBlock: string): string {
  return `You are pi.

<project_context>
instructions
</project_context>

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>x</name>
  </skill>
</available_skills>

Current working directory: /tmp`;
}

test("stripSkillsSection removes the default skills section and keeps the rest", () => {
  const prompt = piSystemPrompt("ignored");
  const stripped = stripSkillsSection(prompt);
  assert.equal(stripped.includes("available_skills"), false);
  assert.equal(stripped.includes("specialized instructions"), false);
  assert.equal(stripped.includes("<project_context>"), true);
  assert.equal(stripped.includes("Current working directory: /tmp"), true);
});

test("stripSkillsSection is a no-op when the section is absent", () => {
  const prompt = "Just a plain system prompt.\n\nCurrent working directory: /tmp";
  assert.equal(stripSkillsSection(prompt), prompt);
});

test("stripSkillsSection is deterministic across calls", () => {
  const prompt = piSystemPrompt("ignored");
  assert.equal(stripSkillsSection(prompt), stripSkillsSection(prompt));
});

// ── buildSkillsInjection ──────────────────────────────────────────

test("first injection carries full instructions and descriptions", () => {
  resetSkillCache();
  const msg = buildSkillsInjection(["llm-skill"], SKILLS);
  assert.ok(msg);
  assert.equal(msg.customType, "scout-skills");
  assert.equal(msg.display, false);
  assert.ok(msg.content.includes("resolve it against the skill directory"));
  assert.ok(msg.content.includes("<skill name=\"llm-skill\" location=\"/a/SKILL.md\">d1</skill>"));
});

test("subsequent injection of the same skill is compact", () => {
  resetSkillCache();
  buildSkillsInjection(["llm-skill"], SKILLS);
  const msg = buildSkillsInjection(["llm-skill"], SKILLS);
  assert.ok(msg);
  assert.equal(msg.content.includes("d1"), false);
  assert.ok(msg.content.includes("<skill name=\"llm-skill\" location=\"/a/SKILL.md\" />"));
  // No full instructions after the first injection.
  assert.equal(msg.content.includes("resolve it against the skill directory"), false);
  assert.ok(msg.content.includes("Active skills for this request"));
});

test("new skill after a first injection gets a description but no instructions", () => {
  resetSkillCache();
  buildSkillsInjection(["llm-skill"], SKILLS);
  const msg = buildSkillsInjection(["user-only"], SKILLS);
  assert.ok(msg);
  assert.ok(msg.content.includes(">d2<"));
  assert.equal(msg.content.includes("resolve it against the skill directory"), false);
});

test("empty selection returns null", () => {
  resetSkillCache();
  assert.equal(buildSkillsInjection([], SKILLS), null);
});

test("unknown skill names are skipped; all-unknown returns null", () => {
  resetSkillCache();
  assert.equal(buildSkillsInjection(["nope"], SKILLS), null);
  // Nothing was marked shown by the failed lookup.
  const msg = buildSkillsInjection(["nope", "llm-skill"], SKILLS);
  assert.ok(msg);
  assert.ok(msg.content.includes(">d1<"));
});

test("resetSkillCache restores the verbose first injection", () => {
  resetSkillCache();
  buildSkillsInjection(["llm-skill"], SKILLS);
  resetSkillCache();
  const msg = buildSkillsInjection(["llm-skill"], SKILLS);
  assert.ok(msg);
  assert.ok(msg.content.includes(">d1<"));
  assert.ok(msg.content.includes("resolve it against the skill directory"));
});

test("injection escapes XML-sensitive characters", () => {
  resetSkillCache();
  const msg = buildSkillsInjection(["we<ird>&'\""], [
    { name: "we<ird>&'\"", description: "a<b&c", filePath: "/d/e?f=1&2" },
  ]);
  assert.ok(msg);
  assert.ok(msg.content.includes("&lt;") && msg.content.includes("&amp;"));
  assert.equal(msg.content.includes("we<ird>"), false);
});
