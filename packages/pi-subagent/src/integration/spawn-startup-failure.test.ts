/**
 * Explicit real-process integration coverage for spawn-time failures.
 *
 * Excluded from the default test set: it spawns child processes. No network
 * and no real pi — a stub `pi` on PATH stands in for the CLI, so the only real
 * parts are the spawn/pipe plumbing under test.
 *
 *   node --test packages/pi-subagent/src/integration/spawn-startup-failure.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSubagent } from "../spawn.ts";

const posixOnly = { skip: process.platform === "win32" };

/** Create a scratch dir with an executable `pi` stub inside. Returns both paths. */
function stubPi(script: string): { dir: string; restorePath: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-integration-"));
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
  return {
    dir,
    restorePath: () => {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "a child that dies at startup is reported, not turned into an EPIPE crash",
  posixOnly,
  async () => {
    // Never reads stdin, so the initial prompt overflows the pipe buffer and
    // stays queued; the exit then fails those queued writes with EPIPE exactly
    // the way the real crash happened.
    const { dir, restorePath } = stubPi(`#!/bin/sh
echo 'Error: Failed to load extension "/tmp/x/src/index.ts": Unexpected token' >&2
echo 'Hint: Start without extensions using "pi -ne".' >&2
exit 1
`);
    try {
      const result = await spawnSubagent("test/model", "x".repeat(400_000), {
        cwd: dir,
        depth: 0,
        timeoutMs: 30_000,
      });

      assert.equal(result.exitCode, 1);
      assert.match(
        result.errorMessage ?? "",
        /^Subagent exited with code 1 before producing any output/,
      );
      assert.match(result.errorMessage ?? "", /Failed to load extension/);
      assert.equal(result.stopReason, "error");
    } finally {
      restorePath();
    }
  },
);

test("a pi binary that cannot be spawned surfaces as an error result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-integration-"));
  const originalPath = process.env.PATH;
  // An empty PATH: `pi` cannot be resolved, so spawn fails before exec.
  process.env.PATH = dir;
  try {
    const result = await spawnSubagent("test/model", "task", {
      cwd: dir,
      depth: 0,
      timeoutMs: 10_000,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /ENOENT/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
