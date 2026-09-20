/**
 * Regression tests for model-role fallback resolution.
 * Run: node --test packages/pi-model-roles/src/api.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initModelRolesAPI } from "./api.ts";

const currentModel = { provider: "test", id: "current" };
const registry = {
  getAvailable: () => [currentModel],
  async getApiKeyAndHeaders() {
    return { ok: true, apiKey: "test-key" };
  },
};

function withSettings(
  settings: unknown,
  run: () => void | Promise<void>,
): void | Promise<void> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-roles-"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cleanup = () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
  } catch (error) {
    cleanup();
    throw error;
  }
}

function withDefaultConfig(run: () => void | Promise<void>): void | Promise<void> {
  return withSettings({}, run);
}

test("resolveRole keeps an unknown requested name while using the default role model", () => {
  withDefaultConfig(() => {
    const api = initModelRolesAPI(registry, currentModel);

    const resolved = api.resolveRole("missing-role");

    assert.equal(resolved.name, "missing-role");
    assert.equal(resolved.config.model, null);
    assert.equal(resolved.model, currentModel);
  });
});

test("unknown roles use the configured fallback model while retaining their name", async () => {
  const fallbackModel = { provider: "test", id: "fallback" };
  const fallbackRegistry = {
    getAvailable: () => [currentModel, fallbackModel],
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-key" };
    },
  };

  await withSettings(
    {
      modelRoles: {
        defaultRole: "fallback",
        roles: { fallback: { model: "test/fallback" } },
      },
    },
    async () => {
      const api = initModelRolesAPI(fallbackRegistry, currentModel);

      const resolved = api.resolveRole("missing-role");
      const resolvedAsync = await api.resolveRoleAsync("missing-role");

      assert.equal(resolved.name, "missing-role");
      assert.equal(resolved.model, fallbackModel);
      assert.equal(resolvedAsync.name, "missing-role");
      assert.equal(resolvedAsync.model, fallbackModel);
      assert.equal(resolvedAsync.apiKey, "test-key");
    },
  );
});

test("missing configured default role falls back to the built-in default role", async () => {
  await withSettings(
    { modelRoles: { defaultRole: "not-configured" } },
    async () => {
      const api = initModelRolesAPI(registry, currentModel);

      const resolved = api.resolveRole("missing-role");
      const resolvedAsync = await api.resolveRoleAsync("missing-role");

      assert.equal(resolved.name, "missing-role");
      assert.equal(resolved.config.model, null);
      assert.equal(resolved.model, currentModel);
      assert.equal(resolvedAsync.name, "missing-role");
      assert.equal(resolvedAsync.config.model, null);
      assert.equal(resolvedAsync.model, currentModel);
      assert.equal(resolvedAsync.apiKey, "test-key");
    },
  );
});

test("role calls use the registered provider stream with resolved auth and thinking", async () => {
  const override = { provider: "extension-provider", id: "model" };
  const context = { systemPrompt: "system", messages: [] };
  const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const requests: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }> = [];
  const authModels: unknown[] = [];
  const modelRegistry = {
    getAvailable: () => [currentModel, override],
    async getApiKeyAndHeaders(model: unknown) {
      authModels.push(model);
      return { ok: true, apiKey: "registered-key", headers: { "x-provider": "registered" } };
    },
    streamSimple(model: unknown, input: unknown, options: Record<string, unknown>) {
      requests.push({ model, context: input, options });
      return { result: async () => message };
    },
  };

  await withSettings(
    { modelRoles: { roles: { utility: { model: null, thinking: "off" } } } },
    async () => {
      const api = initModelRolesAPI(modelRegistry, currentModel);
      const stream = await api.streamWithRole("utility", context, { model: override as any, maxTokens: 100 });
      assert.equal(await stream.result(), message);
      assert.equal(
        await api.completeWithRole("utility", context, { model: override as any, reasoning: "high" }),
        message,
      );
    },
  );

  assert.deepEqual(authModels, [override, override]);
  assert.deepEqual(requests, [
    {
      model: override,
      context,
      options: {
        maxTokens: 100, reasoning: "off", apiKey: "registered-key",
        headers: { "x-provider": "registered" },
      },
    },
    {
      model: override,
      context,
      options: {
        reasoning: "high", apiKey: "registered-key",
        headers: { "x-provider": "registered" },
      },
    },
  ]);
});

test("role calls reject unavailable auth before returning a stream", async () => {
  const modelRegistry = {
    getAvailable: () => [currentModel],
    async getApiKeyAndHeaders() {
      return { ok: false, error: "expired" };
    },
    streamSimple() {
      assert.fail("stream must not start after failed authentication");
    },
  };
  await withDefaultConfig(async () => {
    const api = initModelRolesAPI(modelRegistry, currentModel);
    await assert.rejects(api.streamWithRole("default", { messages: [] }), /streamWithRole: auth failed.*expired/);
    await assert.rejects(api.completeWithRole("default", { messages: [] }), /completeWithRole: auth failed.*expired/);
  });
});
