import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModelRolesAPI, type ModelRolesAPI } from "@d3ara1n/pi-model-roles";
import { createConsult } from "./investigate.ts";
import { SessionSnapshot } from "./snapshot.ts";
import * as tracker from "./tracker.ts";
import type { PeekAPI, PeekConfig, PeekConsult } from "./types.ts";
import { DEFAULT_PEEK_CONFIG, PEEK_GLOBAL_KEY } from "./types.ts";

type LiveAPI = PeekAPI & { shutdown(): void };

/** @internal Dependencies for the session-scoped API. */
export interface PeekDeps {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
  config: PeekConfig;
  modelRoles?: Pick<ModelRolesAPI, "resolveRole" | "streamWithRole">;
}

export function initPeekAPI(deps: PeekDeps): PeekAPI {
  shutdownPeekAPI();
  const cfg = { ...DEFAULT_PEEK_CONFIG, ...deps.config };
  const consults = new Set<PeekConsult>();
  let closed = false;
  const capture = () => {
    if (closed) throw new Error("peek: session has closed.");
    return new SessionSnapshot(deps.sessionManager.getBranch());
  };
  const api: LiveAPI = {
    createConsult(options = {}) {
      if (closed) throw new Error("peek: session has closed.");
      const roles = deps.modelRoles ?? getModelRolesAPI();
      const { model } = roles.resolveRole(cfg.role);
      if (!model) throw new Error(`peek: model unavailable for role "${cfg.role}".`);
      const inner = createConsult({
        snapshot: capture(), model, config: cfg, includeThinking: options.includeThinking,
        stream: (context, options) => roles.streamWithRole(cfg.role, context, { ...options, model }),
      });
      const consult: PeekConsult = {
        snapshotAt: inner.snapshotAt,
        ask: (question, options) => inner.ask(question, options),
        dispose() {
          inner.dispose();
          consults.delete(consult);
        },
      };
      consults.add(consult);
      return consult;
    },
    async investigate(question, options) {
      const consult = api.createConsult(options);
      try {
        return await consult.ask(question, options);
      } finally {
        consult.dispose();
      }
    },
    serializeMainConversation(options = {}) {
      const snapshot = capture();
      try { return snapshot.reference(options.includeThinking); }
      finally { snapshot.dispose(); }
    },
    getMainAgentStatus: tracker.getMainAgentStatus,
    shutdown() {
      closed = true;
      for (const consult of consults) consult.dispose();
    },
  };
  (globalThis as any)[PEEK_GLOBAL_KEY] = api;
  return api;
}

/** @internal Release ephemeral consults on shutdown/reload. */
export function shutdownPeekAPI(): void {
  const api = (globalThis as any)[PEEK_GLOBAL_KEY] as LiveAPI | undefined;
  api?.shutdown?.();
  delete (globalThis as any)[PEEK_GLOBAL_KEY];
}

export function getPeekAPI(): PeekAPI {
  const api = tryGetPeekAPI();
  if (!api) throw new Error("PeekAPI not initialized. Load @d3ara1n/pi-peek and wait for session_start.");
  return api;
}

export function tryGetPeekAPI(): PeekAPI | undefined {
  return (globalThis as any)[PEEK_GLOBAL_KEY] as PeekAPI | undefined;
}
