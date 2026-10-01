import type { LanguageModel, ModelRequest, ModelResult, TokenUsage, UsageMeter } from "./contracts.js";
import { object as record } from "./config.js";

/** Parses a model's JSON text, tolerating a Markdown code fence. Returns undefined when it is not JSON. */
export function parseJsonText(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
  try { return JSON.parse(body); } catch { return undefined; }
}

/**
 * OpenRouter chat completions with strict structured output. Routes only to providers that do not collect
 * prompts and that support every requested parameter. Reasoning is off: these are short, latency-sensitive turns.
 */
export class OpenRouterModel implements LanguageModel {
  constructor(private readonly options: { key: string; model: string; timeoutMs: number; fetch?: typeof fetch; meter?: UsageMeter }) {}
  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResult | null> {
    const { key, model, timeoutMs, meter } = this.options;
    if (meter && !meter.reserve("openrouter")) return null;
    let ok = false; let usage: TokenUsage | null = null;
    try {
      const response = await (this.options.fetch ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Nori" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        body: JSON.stringify({ model, temperature: 0.3, max_tokens: request.maxOutputTokens,
          messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
          response_format: { type: "json_schema", json_schema: { name: `nori_${request.purpose}`, strict: true, schema: request.schema } },
          reasoning: { enabled: false }, provider: { data_collection: "deny", require_parameters: true } }),
      });
      if (!response.ok) return null;
      const body = record(await response.json());
      const tokens = record(body?.usage);
      if (tokens && Number.isFinite(tokens.prompt_tokens)) usage = { input: Number(tokens.prompt_tokens), output: Number(tokens.completion_tokens) || 0 };
      const choice = record(Array.isArray(body?.choices) ? body.choices[0] : null);
      if (!choice || choice.error || ["length", "content_filter", "error"].includes(String(choice.finish_reason))) return null;
      const content = record(choice.message)?.content;
      if (typeof content !== "string") return null;
      const json = parseJsonText(content);
      if (json === undefined) return null;
      ok = true;
      return { model: typeof body?.model === "string" ? body.model : model, json, usage: usage ?? { input: 0, output: 0 } };
    } catch { return null; }
    finally { meter?.record("openrouter", { ok, usage }); }
  }
  close(): void {}
}
