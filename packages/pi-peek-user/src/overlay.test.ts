import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PeekContextOverflowError, type InvestigateResult, type PeekAPI, type PeekConsult, type PeekReferenceOptions } from "@d3ara1n/pi-peek";
import { PeekOverlay } from "./overlay.ts";

const result = (answer: string, stopReason: "stop" | "length" = "stop"): InvestigateResult => ({
  answer, snapshotAt: "2026-01-01T00:00:00Z", referenceLength: 10, stopReason, model: "fake/model",
  usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11, cost: 0 },
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function panel(api: PeekAPI, options: PeekReferenceOptions = {}) {
  const overlay = new PeekOverlay({ requestRender() {}, terminal: { rows: 40, columns: 100 } }, {
    fg: (_color, text) => text, bold: text => text,
  }, () => {}, {} as ExtensionContext, api, options);
  const state = overlay as unknown as {
    submit(value: string): void;
    history: { role: string; text: string; notice?: string }[];
    streamText: string;
    mode: string;
  };
  return { overlay, state };
}
function apiFor(createConsult: (options?: PeekReferenceOptions) => PeekConsult): PeekAPI {
  return {
    createConsult,
    investigate: async () => { throw new Error("one-shot path must not be used by the overlay"); },
    serializeMainConversation: () => { throw new Error("UI must not rebuild model history"); },
    getMainAgentStatus: () => ({ activity: "idle", toolIndex: 0, turn: 0, lastUpdated: "2026-01-01T00:00:00Z" }),
  };
}

test("overlay reuses one consult for follow-ups and disposes on close", async () => {
  let created = 0;
  let disposed = 0;
  const questions: string[] = [];
  let shown = "";
  const consult: PeekConsult = {
    snapshotAt: "2026-01-01T00:00:00Z",
    async ask(question, opts) {
      questions.push(question);
      opts?.onStage?.("answering");
      opts?.onToken?.(`Answer ${questions.length}`);
      shown = state.streamText;
      return result(`Answer ${questions.length}`);
    },
    dispose() { disposed++; },
  };
  const { overlay, state } = panel(apiFor(options => {
    assert.equal(options?.includeThinking, undefined);
    created++;
    return consult;
  }));
  try {
    state.submit("first question");
    await flush();
    assert.equal(shown, "Answer 1");
    state.submit("follow-up question");
    await flush();
    assert.equal(created, 1);
    assert.equal(shown, "Answer 2");
    assert.deepEqual(questions, ["first question", "follow-up question"]);
    assert.deepEqual(state.history.map(h => h.text), ["first question", "Answer 1", "follow-up question", "Answer 2"]);
  } finally { overlay.dispose(); }
  assert.equal(disposed, 1);
  assert.equal(state.history.length, 0);
  overlay.dispose();
  assert.equal(disposed, 1);
});

test("explicit thinking mode is passed to consult creation without adding default UI instructions", async () => {
  let includeThinking: boolean | undefined;
  const { overlay, state } = panel(apiFor(options => {
    includeThinking = options?.includeThinking;
    return { snapshotAt: "fixed", ask: async () => result("answer"), dispose() {} };
  }), { includeThinking: true });
  try {
    const screen = overlay.render(80).join("\n");
    assert.match(screen, /Ask about this session\./);
    assert.doesNotMatch(screen, /snapshot|search or expand|Follow-ups reuse|close and reopen/i);
    state.submit("question");
    await flush();
    assert.equal(includeThinking, true);
  } finally { overlay.dispose(); }
});

test("output and context limits are separate notices, not additions to the answer text", async () => {
  let asks = 0;
  const { overlay, state } = panel(apiFor(() => ({
    snapshotAt: "fixed",
    async ask() {
      if (++asks === 2) throw new PeekContextOverflowError("prompt too long");
      return result("partial answer", "length");
    },
    dispose() {},
  })));
  try {
    state.submit("first");
    await flush();
    assert.equal(state.history[1]!.text, "partial answer");
    assert.equal(state.history[1]!.notice, "Output limit reached");
    state.submit("second");
    await flush();
    assert.equal(state.history[1]!.text, "partial answer");
    assert.equal(state.history[3]!.text, "");
    assert.equal(state.history[3]!.notice, "Context limit reached");
  } finally { overlay.dispose(); }
});

test("consult creation failures restore the input state instead of escaping submit", async () => {
  const { overlay, state } = panel(apiFor(() => { throw new Error("model unavailable"); }));
  try {
    state.submit("question");
    await flush();
    assert.equal(state.mode, "input");
    assert.match(state.history[1]!.text, /model unavailable/);
  } finally { overlay.dispose(); }
});

test("closing the overlay aborts its request and ignores late output", async () => {
  let complete!: (value: InvestigateResult) => void;
  let signal: AbortSignal | undefined;
  let lateToken: ((text: string) => void) | undefined;
  const { overlay, state } = panel(apiFor(() => ({
    snapshotAt: "fixed",
    ask(_question, opts) {
      signal = opts?.signal;
      lateToken = opts?.onToken;
      return new Promise(resolve => { complete = resolve; });
    },
    dispose() {},
  })));
  state.submit("question");
  await flush();
  overlay.dispose();
  assert.equal(signal?.aborted, true);
  lateToken?.("late text");
  complete(result("late answer"));
  await flush();
  assert.equal(state.history.length, 0);
  assert.equal(state.streamText, "");
});
