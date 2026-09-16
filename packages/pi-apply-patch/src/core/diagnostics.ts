import { normalize, PASSES, seekSequence } from "./matcher.ts";
import { trim, trimEnd } from "./text.ts";
import type { HunkCandidate, HunkFailure } from "./types.ts";

/** Skip candidate and occurrence scans when they would exceed this many line comparisons. */
const SCAN_BUDGET = 2_000_000;
const MIN_CANDIDATE_SCORE = 0.5;

/** Diagnostic-only comparison: trim edges and collapse internal whitespace runs. */
function collapse(text: string): string {
  return trim(text).replace(/\s+/g, " ");
}

/**
 * Similarity of two lines on the diagnostic ladder. Values below 1 fail every
 * matching pass, so windows scoring below 1 per line are genuine near misses.
 */
function lineScore(expected: string, actual: string): number {
  if (expected === actual) return 1;
  if (trimEnd(expected) === trimEnd(actual)) return 0.95;
  if (trim(expected) === trim(actual)) return 0.9;
  if (normalize(expected) === normalize(actual)) return 0.85;
  return collapse(expected) === collapse(actual) ? 0.6 : 0;
}

interface Window {
  readonly line: number;
  readonly score: number;
  readonly differing: number;
  readonly whitespace: number;
}

function withinBudget(lines: readonly string[], pattern: readonly string[]): boolean {
  return pattern.length > 0 && lines.length * pattern.length <= SCAN_BUDGET;
}

function scanWindows(lines: readonly string[], pattern: readonly string[]): Window[] {
  if (!withinBudget(lines, pattern)) return [];
  const windows: Window[] = [];
  const end = lines.length - pattern.length;
  for (let index = 0; index <= end; index++) {
    let score = 0;
    let differing = 0;
    let whitespace = 0;
    for (let offset = 0; offset < pattern.length; offset++) {
      const value = lineScore(pattern[offset], lines[index + offset]);
      score += value;
      if (value < 1) {
        differing++;
        if (value > 0) whitespace++;
      }
    }
    windows.push({ line: index + 1, score: score / pattern.length, differing, whitespace });
  }
  return windows;
}

function toCandidate(window: Window, beforeSearchStart: boolean): HunkCandidate {
  return {
    line: window.line,
    differing: window.differing,
    whitespace: window.whitespace,
    difference:
      window.differing === 0
        ? "exact"
        : window.whitespace === window.differing
          ? "whitespace"
          : "content",
    beforeSearchStart,
  };
}

/**
 * Closest windows to an unmatched context: at most one exact match that lies
 * before the forward search start, plus the best near miss at or after it.
 */
export function findCandidates(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
): HunkCandidate[] {
  const windows = scanWindows(lines, pattern);
  if (!windows.length) return [];
  const candidates: HunkCandidate[] = [];
  const earlier = windows.find((window) => window.line - 1 < start && window.differing === 0);
  if (earlier) candidates.push(toCandidate(earlier, true));
  const near = windows
    .filter(
      (window) =>
        window.line - 1 >= start && window.differing > 0 && window.score >= MIN_CANDIDATE_SCORE,
    )
    .sort((a, b) => b.score - a.score || a.line - b.line)[0];
  if (near) candidates.push(toCandidate(near, false));
  return candidates;
}

/** Count all windows equal under one projection; 1 when the scan is over budget. */
export function countOccurrences(
  lines: readonly string[],
  pattern: readonly string[],
  pass: number,
): number {
  if (!withinBudget(lines, pattern)) return 1;
  const project = PASSES[pass];
  let count = 0;
  const end = lines.length - pattern.length;
  for (let index = 0; index <= end; index++) {
    let equal = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (project(lines[index + offset]) !== project(pattern[offset])) {
        equal = false;
        break;
      }
    }
    if (equal) count++;
  }
  return count;
}

/** Line where a chunk's replacement text already occurs, hinting at a re-application. */
export function findAlreadyApplied(
  lines: readonly string[],
  replacement: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (replacement.length === 0) return undefined;
  const identical =
    replacement.length === pattern.length &&
    replacement.every((line, offset) => line === pattern[offset]);
  if (identical) return undefined;
  const index = seekSequence(lines, replacement, start, endOfFile);
  return index === undefined ? undefined : index + 1;
}

export interface ContextSearch {
  /** Present when an anchor seek itself failed; `pattern` then holds just the anchor. */
  readonly anchor?: string;
  readonly pattern: readonly string[];
  readonly replacement: readonly string[];
  /** 0-based position the forward search started from. */
  readonly start: number;
  readonly endOfFile: boolean;
}

/** Collect every diagnostic for one unmatched chunk. */
export function diagnoseContext(
  lines: readonly string[],
  search: ContextSearch,
): HunkFailure {
  const start = search.endOfFile
    ? Math.max(0, lines.length - search.pattern.length)
    : search.start;
  return {
    anchor: search.anchor,
    pattern: search.pattern,
    searchFrom: start + 1,
    endOfFile: search.endOfFile,
    candidates: findCandidates(lines, search.pattern, start),
    alreadyAppliedAt:
      search.anchor === undefined
        ? findAlreadyApplied(lines, search.replacement, search.pattern, start, search.endOfFile)
        : undefined,
  };
}
