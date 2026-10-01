import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CodexModel, codexHome, codexResponderConnection } from "./codex.js";
import type { Config, ConversationPort, IntentRouter, LanguageModel, RpcHandlers, RpcPort, Understander } from "./contracts.js";
import { Conversation } from "./conversation.js";
import { JevJudge, JevRouter, JevUnderstander } from "./jev.js";
import { OpenRouterModel } from "./openrouter.js";
import type { SecretName } from "./secrets.js";
import { Store } from "./store.js";
import { StoreMeter } from "./usage.js";

export interface Assembly { conversation: ConversationPort | undefined; router: IntentRouter | undefined; close(): void }

const missing = (name: SecretName, what: string) => new Error(`${what} is configured but ${name} is missing. `
  + "Set it in the environment or the assistant profile's Keychain (see docs/RUNBOOK.md), or remove it from config.");

/**
 * Builds the configured model ports. Every conversational request shares one durable daily meter; routing calls are
 * counted when a task is claimed. Without `jev` nothing leaves the machine; with `jev` but no `responder`, only routing
 * of queued tasks runs.
 */
export function assemble(config: Config, store: Store, deps: { secret: (name: SecretName) => string | null; dataDir: string;
  fetch?: typeof fetch; connectCodex?: (codexPath: string) => (handlers: RpcHandlers) => RpcPort; clock?: () => number }): Assembly {
  if (!config.jev) return { conversation: undefined, router: undefined, close() {} };
  const key = deps.secret("TYPESAFE_API_KEY");
  if (!key) throw missing("TYPESAFE_API_KEY", "Jev");
  const fetch = deps.fetch ? { fetch: deps.fetch } : {};
  const router = new JevRouter({ key, model: config.jev.model, timeoutMs: config.jev.timeoutMs, ...fetch });
  const { responder } = config;
  if (!responder) return { conversation: undefined, router, close() {} };
  const meter = new StoreMeter(store, { timezone: config.timezone, ...(deps.clock ? { clock: deps.clock } : {}),
    limits: { jev: config.jev.dailyLimit, [responder.provider]: responder.dailyLimit } });
  const jev = { key, model: config.jev.model, timeoutMs: config.jev.timeoutMs, meter, ...fetch };
  let model: LanguageModel;
  if (responder.provider === "openrouter") {
    const openrouterKey = deps.secret("OPENROUTER_API_KEY");
    if (!openrouterKey) throw missing("OPENROUTER_API_KEY", "The OpenRouter responder");
    model = new OpenRouterModel({ key: openrouterKey, model: responder.model, timeoutMs: responder.timeoutMs, meter, ...fetch });
  } else {
    const cwd = join(deps.dataDir, "codex-scratch");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const connect = deps.connectCodex?.(responder.codexPath)
      ?? codexResponderConnection(responder.codexPath, codexHome(deps.dataDir), responder.timeoutMs);
    model = new CodexModel({ model: responder.model, timeoutMs: responder.timeoutMs, cwd, meter, connect });
  }
  const conversation = new Conversation({ understander: new JevUnderstander(jev), judge: new JevJudge(jev), model });
  return { conversation, router, close: () => model.close() };
}

/**
 * Jev understanding for `eval`. It is metered by its own in-memory ceiling of `jev.dailyLimit` per run, separate from
 * the live service's durable daily usage.
 */
export function evalUnderstander(config: Config, key: string, deps: { fetch?: typeof fetch } = {}): Understander {
  if (!config.jev) throw new Error("eval needs a jev section in the configuration.");
  const meter = new StoreMeter(new Store(":memory:"), { timezone: config.timezone, limits: { jev: config.jev.dailyLimit } });
  return new JevUnderstander({ key, model: config.jev.model, timeoutMs: Math.max(config.jev.timeoutMs, 5_000), meter,
    ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}
