import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGitPorcelain } from "./index.ts";

describe("parseGitPorcelain", () => {
  it("preserves the leading space of the first unstaged entry", () => {
    assert.deepEqual(parseGitPorcelain(" M example.ts\n"), {
      staged: 0,
      unstaged: 1,
      untracked: 0,
    });
  });

  it("counts multiple unstaged entries without inventing a staged entry", () => {
    assert.deepEqual(parseGitPorcelain(" M first.ts\n D second.ts\n"), {
      staged: 0,
      unstaged: 2,
      untracked: 0,
    });
  });

  it("counts staged, unstaged, and untracked entries independently", () => {
    const output = " M first.ts\nA  added.ts\nMM both.ts\n?? new-directory/\n!! ignored.ts\n";
    assert.deepEqual(parseGitPorcelain(output), {
      staged: 2,
      unstaged: 2,
      untracked: 1,
    });
  });

  it("accepts output without a trailing newline", () => {
    assert.deepEqual(parseGitPorcelain(" M example.ts"), {
      staged: 0,
      unstaged: 1,
      untracked: 0,
    });
  });

  it("returns zero counts for empty output", () => {
    assert.deepEqual(parseGitPorcelain(""), {
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
  });
});
