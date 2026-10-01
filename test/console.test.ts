import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { assemble, evalUnderstander } from "../src/assemble.js";
import { CONSOLE_CONTACT, parseConfig } from "../src/config.js";
import { Conversation } from "../src/conversation.js";
import { ConsoleTransport } from "../src/console.js";
import { evaluate, parseCases } from "../src/eval.js";
import { Store } from "../src/store.js";
import type { Route, TurnContext, Understander, Understanding } from "../src/contracts.js";
import { config, epoch, owner } from "./helpers.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const live = { ...config, contacts: [{ ...owner, handles: ["owner@example.com"] }] };

test("console transport turns input lines into the console contact's messages and prints replies", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let printed = "";
  output.on("data", chunk => { printed += String(chunk); });
  const transport = new ConsoleTransport({ input, output, startRowId: 5, clock: () => epoch });
  input.write("hello there\n\n  \nsecond\n"); await tick();
  const first = await transport.readAfter(CONSOLE_CONTACT.conversation, 5);
  assert.deepEqual(first.messages.map(x => [x.rowId, x.text]), [[6, "hello there"], [7, "second"]]);
  assert.equal(first.nextCursor, 7); assert.equal(first.hasMore, false);
  const [m] = first.messages;
  assert.deepEqual({ chatId: m!.chatId, chatGuid: m!.chatGuid, sender: m!.sender, sentAt: m!.sentAt },
    { ...CONSOLE_CONTACT.conversation, sender: CONSOLE_CONTACT.handles[0], sentAt: epoch });
  assert.deepEqual((await transport.readAfter(CONSOLE_CONTACT.conversation, 7)).messages, []);
  assert.equal((await transport.send(CONSOLE_CONTACT.conversation, "hi")).status, "sent");
  assert.match(printed, /Nori: hi/);
  input.end(); await transport.ended;
  assert.equal(transport.lastRowId, 7);
});

test("the chat harness runs the real service without iMessage or macOS", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-chat-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "state");
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "chat", "--data-dir", data],
    { encoding: "utf8", input: "note buy milk\nlist\n", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nori: Saved locally #1: buy milk/);
  assert.match(result.stdout, /Nori: 1 active tasks/);
  assert.match(result.stdout, /development/i);
  assert.equal(statSync(join(data, "console.sqlite")).isFile(), true);
  // A second session reuses the same console store.
  const again = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "chat", "--data-dir", data],
    { encoding: "utf8", input: "list\n", timeout: 20_000 });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Nori: 1 active tasks:\n#1: buy milk/);
});

test("the chat harness accepts a live configuration file but uses only its models and clock settings", t => {
  const dir = mkdtempSync(join(tmpdir(), "nori-chat-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...live, timezone: "UTC", dataDir: "/Users/nori/Library/Application Support/Nori" }));
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "chat", "--config", path, "--data-dir", join(dir, "state")],
    { encoding: "utf8", input: "status\n", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 active tasks/);
});

test("model wiring needs keys for configured providers and stays model-free without them", t => {
  const store = new Store(":memory:"); t.after(() => store.close());
  const none = assemble(parseConfig(live), store, { secret: () => null, dataDir: "/tmp" });
  assert.deepEqual([none.conversation, none.router], [undefined, undefined]);
  const jevOnly = parseConfig({ ...live, jev: { model: "jev-1.13.0" } });
  assert.throws(() => assemble(jevOnly, store, { secret: () => null, dataDir: "/tmp" }), /TYPESAFE_API_KEY/);
  const routed = assemble(jevOnly, store, { secret: () => "k", dataDir: "/tmp" });
  assert.ok(routed.router); assert.equal(routed.conversation, undefined);
  const full = parseConfig({ ...live, jev: { model: "jev-1.13.0" }, responder: { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" } });
  assert.throws(() => assemble(full, store, { secret: name => name === "TYPESAFE_API_KEY" ? "k" : null, dataDir: "/tmp" }), /OPENROUTER_API_KEY/);
  const built = assemble(full, store, { secret: () => "k", dataDir: "/tmp" });
  assert.ok(built.conversation instanceof Conversation); assert.ok(built.router); built.close();
});

const routeOf = (label: string): Route => label === "reminders" ? { kind: "action", pluginId: label } : { kind: label } as Route;

test("routing evaluation applies the production gate and counts confident wrong changes", async () => {
  const cases = parseCases([{ text: "remind me to call mom at 5", label: "reminders" }, { text: "thanks!", label: "chat" },
    { text: "email Sam the notes", label: "runtime", outbound: true }, { text: "done", label: "reminders", tracking: ["#3: stretch"],
      turns: [{ from: "nori", text: "Reminder: stretch (#3)." }] }, { text: "remind me to call mom in an hour; add eggs to my list", label: "runtime" }]);
  const answers: Record<string, [string, number]> = { "remind me to call mom at 5": ["reminders", 0.95], "thanks!": ["pause", 0.9],
    "email Sam the notes": ["runtime", 0.7], done: ["reminders", 0.9], "remind me to call mom in an hour; add eggs to my list": ["reminders", 0.95] };
  const seen: TurnContext[] = [];
  const understander: Understander = { understand: async (c: TurnContext): Promise<Understanding> => {
    seen.push(c); const [label, confidence] = answers[c.text]!;
    return { model: "jev-test", catalogVersion: c.catalog.version, route: routeOf(label), confidence, probabilities: {}, multiAction: false,
      outbound: c.text.startsWith("email") ? 0.9 : 0 };
  } };
  const report = await evaluate(cases, understander, { thresholds: { act: 0.8, clarify: 0.5, verify: 0.6 }, routes: { reminders: 0.8 } },
    { timezone: "UTC", now: epoch });
  assert.equal(report.total, 5); assert.equal(report.correct, 3);
  // As in production, explicit compound markers keep a message whole as a job whatever Jev answers.
  assert.deepEqual(report.rows.map(x => x.gate), ["act", "act", "job", "act", "job"]);
  assert.equal(report.confidentWrongActions, 1);
  assert.equal(report.flagErrors, 0);
  assert.deepEqual(seen[3]!.summary, ["#3: stretch"]); assert.deepEqual(seen[3]!.turns.map(x => x.from), ["nori"]);
  assert.ok(seen[0]!.catalog.options.some(o => o.id === "reminders"));
  assert.throws(() => parseCases([{ text: "x", label: "launch" }]));
});

test("the shipped evaluation cases are well formed", () => {
  const cases = parseCases(JSON.parse(readFileSync(resolve("eval/cases.json"), "utf8")));
  assert.ok(cases.length >= 50);
});

test("evaluation runs are metered by the Jev daily ceiling", async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return Response.json({ model: "jev-1.13.0", answers: {} }); }) as typeof globalThis.fetch;
  const understander = evalUnderstander(parseConfig({ ...live, jev: { model: "jev-1.13.0", dailyLimit: 2 } }), "k", { fetch });
  const context = { contact: CONSOLE_CONTACT, text: "x", sentAt: epoch, now: epoch, timezone: "UTC", catalog: { version: "v", options: [] },
    summary: [], jobs: [], turns: [], paused: "none" } as TurnContext;
  for (let n = 0; n < 3; n++) await understander.understand(context, new AbortController().signal);
  assert.equal(calls, 2);
});
