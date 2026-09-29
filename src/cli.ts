#!/usr/bin/env node
import { accessSync, constants, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseConfig, requireAssistantUser } from "./config.js";
import { CodexProbe, CodexRuntime, codexConnection, codexEnvironment, codexHome } from "./codex.js";
import { demo } from "./demo.js";
import { checkPlugins } from "./host.js";
import { ImessageTransport } from "./imsg.js";
import { JevRouter } from "./jev.js";
import { builtinPlugins } from "./plugins/index.js";
import { StdioRpc } from "./rpc.js";
import { acquireLock, assertIdentity, databaseIdentity } from "./runtime.js";
import { enroll, runService } from "./service.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { config: { type: "string" }, codex: { type: "string" }, contact: { type: "string" }, help: { type: "boolean" } } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log("Nori\n  demo\n  doctor | status | run --config /absolute/path/config.json\n  enroll --config /absolute/path/config.json --contact <id>\n  probe-codex --config /absolute/path/config.json [--codex /absolute/path/codex]\nLive commands must run in the configured assistant macOS profile."); return;
  }
  if (positionals.length !== 1) throw new Error("Expected one command. Use --help.");
  if (command === "demo") { await demo(); return; }
  if (!["doctor", "enroll", "status", "probe-codex", "run"].includes(command)) throw new Error("Unknown command. Use --help.");
  if (!values.config) throw new Error("Provide --config /absolute/path/config.json.");
  let input: unknown;
  try { input = JSON.parse(readFileSync(values.config, "utf8")); } catch { throw new Error("Cannot read valid JSON from the configuration file."); }
  const config = parseConfig(input);
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
  let store: Store | undefined; let transport: ImessageTransport | undefined;
  try {
    store = new Store(join(config.dataDir, "state.sqlite"));
    if (command === "status") {
      console.log(JSON.stringify({ contacts: config.contacts.map(c => ({ id: c.id, enrolled: store!.enrollment(c.id) !== null,
        cursor: store!.enrollment(c.id)?.cursor ?? null, pause: store!.setting(`pause:${c.id}`) ?? "none" })),
        ...store.counts(), outbox: store.outbox().map(x => ({ id: x.id, contact: x.contactId, kind: x.kind, status: x.status, attempts: x.attempts })) }, null, 2)); return;
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
      console.log(JSON.stringify({ profile: config.assistantUser, messages: readiness,
        contacts: config.contacts.map(c => ({ id: c.id, role: c.role, enrolled: store!.enrollment(c.id) !== null })),
        identityMatches: store.identity() === identity(), plugins: builtinPlugins.map(p => p.manifest.id),
        calendarReminders: "not connected",
        codexExecution: config.runtime ? "configured; owner only, sandboxed per task, approvals by iMessage" : "not connected",
        jev: !config.jev ? "disabled" : routes.length ? `configured; acting routes: ${routes.join(", ")}` : "configured; shadow only" }, null, 2)); return;
    }
    if (command === "enroll") {
      await enroll(config, store, transport, identity, values.contact!);
      console.log(`Enrolled ${values.contact} at cursor ${store.enrollment(values.contact!)?.cursor}. Past messages were not executed. New messages from this contact will be processed by 'run'.`); return;
    }
    if (!store.enrollments().length) throw new Error("Enroll at least one contact before running. See docs/RUNBOOK.md.");
    const expected = store.identity(); const checkIdentity = () => assertIdentity(expected, identity()); checkIdentity();
    if (config.jev && !process.env.TYPESAFE_API_KEY) throw new Error("Jev is configured but TYPESAFE_API_KEY is missing. Set it or disable Jev in config.");
    if (config.runtime) {
      try { accessSync(config.runtime.codexPath, constants.X_OK); } catch { throw new Error("runtime.codexPath must be an executable Codex CLI."); }
    }
    const runtime = config.runtime ? new CodexRuntime({ connect: codexConnection(config.runtime.codexPath, codexHome(config.dataDir)),
      model: config.runtime.model, workspaceDir: config.runtime.workspaceDir, timezone: config.timezone }) : undefined;
    const controller = new AbortController(); const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log(`Nori is running in the assistant profile for ${store.enrollments().length} enrolled contact(s). Local reminders enabled; ${runtime ? "Codex runs the owner's other requests." : "Codex execution is not connected."}`);
    try {
      await runService({ config, store, transport, checkIdentity, signal: controller.signal, ...(runtime ? { runtime } : {}),
        ...(config.jev ? { router: new JevRouter({ key: process.env.TYPESAFE_API_KEY!, ...config.jev }) } : {}) });
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally { transport?.close(); store?.close(); release(); }
}

main().catch(error => {
  // Provider errors are redacted in their adapters. No stacks, message bodies, or environment dumps.
  console.error(`Nori: ${error instanceof Error ? error.message : "Operation failed."}`); process.exitCode = 1;
});
