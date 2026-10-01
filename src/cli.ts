#!/usr/bin/env node
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assemble, evalUnderstander, type Assembly } from "./assemble.js";
import { CONSOLE_CONTACT, parseConfig, parseConsoleConfig, requireAssistantUser } from "./config.js";
import { CodexProbe, CodexRuntime, codexConnection, codexEnvironment, codexHome } from "./codex.js";
import { ConsoleTransport } from "./console.js";
import type { Config } from "./contracts.js";
import { demo } from "./demo.js";
import { evaluate, formatReport, parseCases } from "./eval.js";
import { checkPlugins } from "./host.js";
import { ImessageTransport } from "./imsg.js";
import { localDay } from "./parser.js";
import { builtinPlugins } from "./plugins/index.js";
import { StdioRpc } from "./rpc.js";
import { acquireLock, assertIdentity, databaseIdentity } from "./runtime.js";
import { readSecret } from "./secrets.js";
import { enroll, runService } from "./service.js";
import { Store } from "./store.js";

const HELP = `Nori
  demo
  doctor | status | run --config /absolute/path/config.json
  enroll --config /absolute/path/config.json --contact <id>
  probe-codex --config /absolute/path/config.json [--codex /absolute/path/codex]
Live commands must run in the configured assistant macOS profile.

Development only (any OS; never uses iMessage):
  chat [--config file.json] [--data-dir /path]   talk to Nori in this terminal
  eval --config file.json [--cases file.json]    score Jev routing on labelled messages (sends them to TypeSafe)`;

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Cannot read valid JSON from the configuration file."); }
}

function describeModels(config: Config): string {
  return config.responder && config.jev ? `Conversational replies via ${config.responder.provider} ${config.responder.model}, understood by ${config.jev.model}.`
    : config.jev ? "Grammar and template replies; Jev routes queued jobs." : "Grammar and template replies; no models.";
}

/** Waits until every typed line is ingested, understood, and answered, so piped input exits cleanly. */
async function drained(store: Store, transport: ConsoleTransport, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!signal.aborted && Date.now() < deadline) {
    const busy = (store.enrollment(CONSOLE_CONTACT.id)?.cursor ?? 0) < transport.lastRowId || store.hasPendingMessages()
      || store.outbox().some(x => x.kind === "reply" && ["drafting", "pending", "sending"].includes(x.status));
    if (!busy) return;
    await delay(100);
  }
}

async function chat(configPath: string | undefined, dataDirArg: string | undefined): Promise<void> {
  const dataDir = resolve(dataDirArg ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "nori-console"));
  const config = parseConsoleConfig(configPath ? readJson(configPath) : {}, { dataDir, username: userInfo().username });
  const release = acquireLock(config.dataDir);
  let store: Store | undefined; let models: Assembly | undefined; let transport: ConsoleTransport | undefined;
  const controller = new AbortController();
  try {
    store = new Store(join(config.dataDir, "console.sqlite"));
    if (!store.enrollment(CONSOLE_CONTACT.id)) store.enroll("console", CONSOLE_CONTACT.id, CONSOLE_CONTACT.conversation, 0);
    if (store.identity() !== "console") throw new Error("This data directory does not hold a console store.");
    models = assemble(config, store, { secret: readSecret, dataDir: config.dataDir });
    transport = new ConsoleTransport({ input: process.stdin, output: process.stdout, startRowId: store.enrollment(CONSOLE_CONTACT.id)!.cursor });
    const stop = () => controller.abort();
    const [s, t] = [store, transport];
    void t.ended.then(async () => {
      try { await drained(s, t, controller.signal); } catch { /* The service already stopped and closed the store. */ }
      controller.abort();
    });
    process.once("SIGINT", stop);
    console.log(`Nori console (development only; iMessage is not used). ${describeModels(config)}\nState: ${join(config.dataDir, "console.sqlite")}. Type a message; Ctrl-D or Ctrl-C quits.`);
    try {
      await runService({ config, store, transport, checkIdentity: () => {}, signal: controller.signal,
        router: models.router, conversation: models.conversation });
    } finally { process.removeListener("SIGINT", stop); }
  } finally { controller.abort(); transport?.close(); models?.close(); store?.close(); release(); }
}

async function runEval(configPath: string | undefined, casesPath: string | undefined): Promise<void> {
  if (!configPath) throw new Error("Provide --config with a jev section.");
  const config = parseConsoleConfig(readJson(configPath), { dataDir: tmpdir(), username: userInfo().username });
  if (!config.jev) throw new Error("eval needs a jev section in the configuration.");
  const key = readSecret("TYPESAFE_API_KEY");
  if (!key) throw new Error("eval needs TYPESAFE_API_KEY in the environment or Keychain.");
  const cases = parseCases(JSON.parse(readFileSync(casesPath ?? fileURLToPath(new URL("../eval/cases.json", import.meta.url)), "utf8")));
  console.log(formatReport(await evaluate(cases, evalUnderstander(config, key), config.jev, { timezone: config.timezone, now: Date.now() })));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, codex: { type: "string" },
    contact: { type: "string" }, "data-dir": { type: "string" }, cases: { type: "string" }, help: { type: "boolean" } } });
  const command = positionals[0];
  if (values.help || !command) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new Error("Expected one command. Use --help.");
  if (command === "demo") { await demo(); return; }
  if (command === "chat") { await chat(values.config, values["data-dir"]); return; }
  if (command === "eval") { await runEval(values.config, values.cases); return; }
  if (!["doctor", "enroll", "status", "probe-codex", "run"].includes(command)) throw new Error("Unknown command. Use --help.");
  if (!values.config) throw new Error("Provide --config /absolute/path/config.json.");
  const config = parseConfig(readJson(values.config));
  requireAssistantUser(config);
  checkPlugins(config, builtinPlugins);
  if (process.platform !== "darwin") throw new Error("Live Nori service requires macOS.");
  if (command === "enroll" && !values.contact) throw new Error("Provide --contact <id> naming one configured contact to enroll.");
  if (command === "probe-codex") {
    const rpc = new StdioRpc({ command: values.codex ?? config.runtime?.codexPath ?? "codex", args: ["app-server"], timeoutMs: 15_000,
      env: codexEnvironment(process.env, codexHome(config.dataDir)) });
    try { const result = await new CodexProbe(rpc).inspect(); console.log(JSON.stringify(result, null, 2)); if (!result.connected) process.exitCode = 1; }
    finally { rpc.close(); } return;
  }
  const release = acquireLock(config.dataDir);
  let store: Store | undefined; let transport: ImessageTransport | undefined; let runtime: CodexRuntime | undefined; let models: Assembly | undefined;
  try {
    store = new Store(join(config.dataDir, "state.sqlite"));
    if (command === "status") {
      console.log(JSON.stringify({ contacts: config.contacts.map(c => ({ id: c.id, enrolled: store!.enrollment(c.id) !== null,
        cursor: store!.enrollment(c.id)?.cursor ?? null, pause: store!.setting(`pause:${c.id}`) ?? "none" })),
        ...store.counts(), pendingMessages: store.pendingMessageCount(), modelUsageToday: store.usage(localDay(Date.now(), config.timezone)),
        outbox: store.outbox().map(x => ({ id: x.id, contact: x.contactId, kind: x.kind, status: x.status, attempts: x.attempts })) }, null, 2)); return;
    }
    const databasePath = join(userInfo().homedir, "Library", "Messages", "chat.db");
    try { accessSync(config.imsgPath, constants.X_OK); accessSync(databasePath, constants.R_OK); }
    catch { throw new Error("imsg must be executable and this profile's Messages database readable. See docs/RUNBOOK.md for Full Disk Access setup."); }
    const identity = () => databaseIdentity(config.assistantUser, databasePath);
    const rpc = new StdioRpc({ command: config.imsgPath, args: ["rpc", "--db", databasePath], timeoutMs: 120_000, jsonrpc: true });
    transport = new ImessageTransport(rpc, config.contacts.map(c => c.conversation));
    const readiness = await transport.readiness();
    if (!readiness.ready) throw new Error(readiness.detail);
    if (command === "doctor") {
      const routes = Object.keys(config.jev?.routes ?? {});
      const key = (name: "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY") => readSecret(name) ? "present" : "missing";
      const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
      const { responder } = config;
      console.log(JSON.stringify({ profile: config.assistantUser, messages: readiness,
        contacts: config.contacts.map(c => ({ id: c.id, role: c.role, enrolled: store!.enrollment(c.id) !== null })),
        identityMatches: store.identity() === identity(), plugins: builtinPlugins.map(p => p.manifest.id),
        calendarReminders: "not connected",
        codexExecution: config.runtime ? "configured; owner only, sandboxed per task, approvals by iMessage" : "not connected",
        jev: !config.jev ? "disabled" : `${routes.length ? `configured; acting routes: ${routes.join(", ")}` : "configured; shadow only"}; key ${key("TYPESAFE_API_KEY")}`,
        replies: !responder ? "templates (no responder configured)" : responder.provider === "openrouter"
          ? `conversational via OpenRouter ${responder.model}; key ${key("OPENROUTER_API_KEY")}`
          : `conversational via Codex ${responder.model}; executable ${executable(responder.codexPath) ? "found" : "missing"}; sign-in not checked (run probe-codex)`,
      }, null, 2)); return;
    }
    if (command === "enroll") {
      await enroll(config, store, transport, identity, values.contact!);
      console.log(`Enrolled ${values.contact} at cursor ${store.enrollment(values.contact!)?.cursor}. Past messages were not executed. New messages from this contact will be processed by 'run'.`); return;
    }
    if (!store.enrollments().length) throw new Error("Enroll at least one contact before running. See docs/RUNBOOK.md.");
    const expected = store.identity(); const checkIdentity = () => assertIdentity(expected, identity()); checkIdentity();
    if (config.runtime) {
      try { accessSync(config.runtime.codexPath, constants.X_OK); } catch { throw new Error("runtime.codexPath must be an executable Codex CLI."); }
    }
    models = assemble(config, store, { secret: readSecret, dataDir: config.dataDir });
    runtime = config.runtime ? new CodexRuntime({ connect: codexConnection(config.runtime.codexPath, codexHome(config.dataDir)),
      model: config.runtime.model, workspaceDir: config.runtime.workspaceDir, timezone: config.timezone }) : undefined;
    const controller = new AbortController(); const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log(`Nori is running in the assistant profile for ${store.enrollments().length} enrolled contact(s). ${describeModels(config)} ${runtime ? "Codex runs the owner's other requests." : "Codex execution is not connected."}`);
    try {
      await runService({ config, store, transport, checkIdentity, signal: controller.signal, ...(runtime ? { runtime } : {}),
        router: models.router, conversation: models.conversation });
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally {
    models?.close(); transport?.close(); store?.close();
    // Codex commands may still be running, so the lock stays until the operator has checked (docs/RUNBOOK.md).
    if (runtime?.halted) console.error(`Nori: kept ${join(config.dataDir, "service.lock")}. Remove it only after confirming no Codex commands are still running.`);
    else release();
  }
}

main().catch(error => {
  // Provider errors are redacted in their adapters. No stacks, message bodies, or environment dumps.
  console.error(`Nori: ${error instanceof Error ? error.message : "Operation failed."}`); process.exitCode = 1;
});
