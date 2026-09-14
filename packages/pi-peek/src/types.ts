/** Public contracts for ephemeral, full-context session consults. */

export interface PeekConfig {
  /** Total deadline per question, including authentication and streaming. */
  timeoutMs?: number;
  /** A large-context model role resolved by pi-model-roles. */
  role?: string;
}

export const DEFAULT_PEEK_CONFIG: Required<PeekConfig> = {
  timeoutMs: 90_000,
  role: "utility",
};

export interface MainAgentStatus {
  activity: string;
  toolName?: string;
  toolIndex: number;
  turn: number;
  lastUpdated: string;
}

export interface PeekReferenceOptions {
  /** Include readable thinking actually saved in the source session. Default false. */
  includeThinking?: boolean;
}

export type InvestigateStage = "answering" | "done" | "error";

export interface AskOptions {
  onToken?: (delta: string) => void;
  onStage?: (stage: InvestigateStage) => void;
  signal?: AbortSignal;
}

export interface InvestigateOptions extends AskOptions, PeekReferenceOptions {}

export interface InvestigateResult {
  /** Model answer only; limit notices are separate metadata. */
  answer: string;
  referenceLength: number;
  snapshotAt: string;
  model: string;
  /** A length stop preserves the partial answer without automatically continuing. */
  stopReason: "stop" | "length";
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  };
}

/** Upstream context overflow; prior successful consult turns remain intact. */
export class PeekContextOverflowError extends Error {
  readonly code = "context_overflow";
  constructor(cause?: unknown) {
    super("Context limit reached.", { cause });
    this.name = "PeekContextOverflowError";
  }
}

export interface PeekConsult {
  readonly snapshotAt: string;
  /** One stream request per question, using the full fixed reference and prior answers. */
  ask(question: string, opts?: AskOptions): Promise<InvestigateResult>;
  /** Abort pending work and release the snapshot and history. Idempotent. */
  dispose(): void;
}

export interface PeekAPI {
  /** Pin the current branch, thinking inclusion and resolved model for follow-ups. */
  createConsult(options?: PeekReferenceOptions): PeekConsult;
  /** One question in a temporary consult, disposed after completion or failure. */
  investigate(question: string, opts?: InvestigateOptions): Promise<InvestigateResult>;
  /** Complete text reference without token or character-budget truncation. */
  serializeMainConversation(options?: PeekReferenceOptions): string;
  getMainAgentStatus(): MainAgentStatus;
}

export const PEEK_GLOBAL_KEY = "__piPeek";
