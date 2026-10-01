import type { Thresholds, Turn, TurnContext, Understander } from "./contracts.js";
import { CONSOLE_CONTACT, object as record } from "./config.js";
import { gate, type Gate } from "./conversation.js";
import { optionId, routeCatalog } from "./host.js";
import { builtinPlugins } from "./plugins/index.js";

/** A labelled message. `label` is the conversational catalog option that should handle it. */
export interface EvalCase { text: string; label: string; turns: Array<Pick<Turn, "from" | "text">>; tracking: string[];
  outbound: boolean | null; compound: boolean | null }
export interface EvalRow { text: string; expected: string; got: string | null; confidence: number | null; gate: Gate["kind"] | "error";
  correct: boolean; flagsCorrect: boolean }
export interface EvalReport { rows: EvalRow[]; total: number; correct: number; confidentWrongActions: number; flagErrors: number }

/** The owner's conversational catalog with the built-in plugins, as a live owner would see it. */
const CATALOG = routeCatalog(builtinPlugins, CONSOLE_CONTACT, { conversational: true });

export function parseCases(value: unknown): EvalCase[] {
  if (!Array.isArray(value)) throw new Error("Evaluation cases must be an array.");
  const labels = new Set(CATALOG.options.map(o => o.id));
  return value.map((item, index) => {
    const c = record(item);
    if (!c || typeof c.text !== "string" || !c.text.trim() || typeof c.label !== "string" || !labels.has(c.label))
      throw new Error(`Invalid evaluation case ${index}.`);
    const turns = Array.isArray(c.turns) ? c.turns.map(t => record(t)).filter(t => t && (t.from === "contact" || t.from === "nori") && typeof t.text === "string")
      .map(t => ({ from: t!.from as Turn["from"], text: String(t!.text) })) : [];
    const tracking = Array.isArray(c.tracking) ? c.tracking.filter((x): x is string => typeof x === "string") : [];
    return { text: c.text, label: c.label, turns, tracking,
      outbound: typeof c.outbound === "boolean" ? c.outbound : null, compound: typeof c.compound === "boolean" ? c.compound : null };
  });
}

/**
 * Runs Jev understanding over labelled cases and applies the same gate as production. The key safety number is
 * confidentWrongActions: messages that would go on to prepare a change for the wrong option.
 */
export async function evaluate(cases: EvalCase[], understander: Understander,
  policy: { thresholds: Thresholds; routes: Readonly<Record<string, number>> },
  options: { timezone: string; now: number; signal?: AbortSignal }): Promise<EvalReport> {
  const signal = options.signal ?? new AbortController().signal;
  const rows: EvalRow[] = [];
  for (const c of cases) {
    const context: TurnContext = { contact: CONSOLE_CONTACT, text: c.text, sentAt: options.now, now: options.now, timezone: options.timezone, catalog: CATALOG,
      summary: c.tracking, jobs: [], turns: c.turns.map((t, i) => ({ ...t, at: options.now - (c.turns.length - i) * 60_000 })), paused: "none" };
    const u = await understander.understand(context, signal);
    const got = u ? optionId(u.route) : null;
    const flagsCorrect = !u || ((c.outbound === null || (u.outbound >= 0.5) === c.outbound) && (c.compound === null || u.multiAction === c.compound));
    rows.push({ text: c.text, expected: c.label, got, confidence: u?.confidence ?? null,
      gate: u ? gate(u, policy.thresholds, policy.routes).kind : "error", correct: got === c.label, flagsCorrect });
  }
  return { rows, total: rows.length, correct: rows.filter(r => r.correct).length, flagErrors: rows.filter(r => !r.flagsCorrect).length,
    confidentWrongActions: rows.filter(r => r.gate === "act" && !r.correct).length };
}

export function formatReport(report: EvalReport): string {
  const lines = report.rows.map(r => `${r.correct ? "ok  " : "MISS"} ${r.expected.padEnd(10)} ${String(r.got).padEnd(10)} `
    + `${r.confidence === null ? "  -  " : r.confidence.toFixed(2)} ${r.gate.padEnd(8)} ${r.flagsCorrect ? "" : "[flags] "}${r.text}`);
  return [...lines, "", `Routing accuracy: ${report.correct}/${report.total}`,
    `Confident wrong changes (would be prepared for the wrong option): ${report.confidentWrongActions}`, `Flag mismatches: ${report.flagErrors}`].join("\n");
}
