import type { TokenUsage, UsageMeter } from "./contracts.js";
import { object as record } from "./config.js";

export interface TypeSafeOptions { key: string; model: string; timeoutMs: number; fetch?: typeof fetch; meter?: UsageMeter }

/**
 * One metered TypeSafe System One request. Returns the answers map, or null on budget stop, HTTP failure,
 * model mismatch, abort, or malformed output. Never throws and never logs request content.
 */
export async function systemOne(options: TypeSafeOptions, request: { state: unknown; questions: Record<string, unknown> },
  signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (options.meter && !options.meter.reserve("jev")) return null;
  let ok = false; let usage: TokenUsage | null = null;
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
      method: "POST", headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ model: options.model, state: request.state, questions: request.questions }),
    });
    if (!response.ok) return null;
    const body = record(await response.json());
    const tokens = record(body?.usage);
    if (tokens && Number.isFinite(tokens.input_tokens)) usage = { input: Number(tokens.input_tokens), output: Number(tokens.output_tokens) || 0 };
    const answers = record(body?.answers);
    if (body?.model !== options.model || !answers) return null;
    ok = true; return answers;
  } catch { return null; }
  finally { options.meter?.record("jev", { ok, usage }); }
}

export function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A Choice answer whose choice and full distribution cover exactly `options` and sum to one. */
export function choiceAnswer<T extends string>(answers: Record<string, unknown>, key: string, options: readonly T[]):
  { choice: T; confidence: number; probabilities: Record<T, number> } | null {
  const answer = record(answers[key]); const probabilities = record(answer?.probabilities);
  if (answer?.type !== "choice" || !options.includes(answer.choice as T) || !probability(answer.confidence) || !probabilities
    || !options.every(x => probability(probabilities[x]))
    || Math.abs(options.reduce((sum, x) => sum + Number(probabilities[x]), 0) - 1) > 0.01) return null;
  return { choice: answer.choice as T, confidence: answer.confidence,
    probabilities: Object.fromEntries(options.map(x => [x, Number(probabilities[x])])) as Record<T, number> };
}

export function noulAnswer(answers: Record<string, unknown>, key: string): number | null {
  const answer = record(answers[key]);
  return answer?.type === "noul" && probability(answer.noul) ? answer.noul : null;
}
