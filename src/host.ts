import { createHash } from "node:crypto";
import type { ActionPlugin, Capability, Clarification, Command, CommandAccount, CommandSchema, Config, Contact, ExtractRequest, FieldSchema,
  MessageContext, PluginContext, PluginDb, PluginManifest, PluginState, Route, RouteCatalog, RuntimeTool, ToolDefinition } from "./contracts.js";
import { record } from "./config.js";
import type { Store } from "./store.js";

const RESERVED = new Set(["runtime", "continue", "clarify", "chat", "status", "pause", "resume", "cancel"]);
const CAPABILITIES = new Set<Capability>(["storage", "schedule", "network", "desktop"]);
const MAX_REPLY = 10_000;
type CatalogOption = RouteCatalog["options"][number];
const RUNTIME = { id: "runtime", route: { kind: "runtime" }, label: "work on it as a job",
  criteria: "Needs research, reasoning, several steps, code, or work in an app or website, rather than one quick action." } as const;
const CONTINUE = { id: "continue", route: { kind: "continue" }, label: "add it to an earlier job",
  criteria: "Adds to, changes, or asks about one of this contact's earlier requests that is still open." } as const;
const CLARIFY = { id: "clarify", route: { kind: "clarify" }, label: "do something else",
  criteria: "The intended outcome or essential details are too unclear to act on." } as const;
/** Options the engine handles itself, offered only in conversational catalogs. */
const CONVERSATIONAL: readonly CatalogOption[] = [
  { id: "chat", route: { kind: "chat" }, label: "just chat",
    criteria: "A greeting, thanks, feelings, small talk, or a question Nori can answer from what it is tracking, without changing anything." },
  { id: "status", route: { kind: "status" }, label: "show what I'm tracking",
    criteria: "Asks what is on their list, what is due, or what Nori is tracking or working on for them." },
  { id: "pause", route: { kind: "pause" }, label: "pause reminder messages", criteria: "Asks Nori to stop or hold its reminder messages for now." },
  { id: "resume", route: { kind: "resume" }, label: "resume reminder messages",
    criteria: "Asks Nori to start sending reminder messages again after a pause." },
  { id: "cancel", route: { kind: "cancel" }, label: "cancel a job", criteria: "Asks to cancel, drop, or stop one of their open jobs." },
];

/**
 * Routing options for a contact. The plain catalog offers permitted plugins with an interpret step, the runtime to the
 * owner, continue, and clarify. A conversational catalog offers only plugins that can also describe their commands,
 * the runtime to everyone (members' jobs stay queued), and the engine's own conversational options.
 */
export function routeCatalog(plugins: readonly ActionPlugin[], contact: Contact, options: { conversational?: boolean } = {},
  manifestOf: (plugin: ActionPlugin) => Readonly<PluginManifest> = plugin => plugin.manifest): RouteCatalog {
  const conversational = options.conversational ?? false;
  const actions = plugins.filter(plugin => plugin.interpret && (!conversational || plugin.describe)).map(manifestOf)
    .map(({ id, criteria, label }): CatalogOption => ({ id, criteria, route: { kind: "action", pluginId: id }, label: label ?? `use ${id}` }));
  const all = conversational ? [...actions, RUNTIME, CONTINUE, CLARIFY, ...CONVERSATIONAL]
    : [...actions, ...(contact.role === "owner" ? [RUNTIME] : []), CONTINUE, CLARIFY];
  const digest = createHash("sha256").update(JSON.stringify(all.map(o => [o.id, o.criteria]))).digest("hex");
  return { version: `catalog-${digest.slice(0, 12)}`, options: all };
}

/** The option id a route was chosen by: the plugin id for an action, otherwise the route kind. */
export function optionId(route: Route): string { return route.kind === "action" ? route.pluginId : route.kind; }

/** Where a dispatch came from. It scopes replies and timers and supplies the reference time. */
export interface DispatchSource {
  contact: Contact;
  /** Reference time for relative expressions: the message's sent time, or when the timer fired. */
  time: number;
  /** Current clock time, used for outbox availability. */
  now: number;
  /** Deterministic outbox key for the nth reply of this dispatch. */
  replyKey(n: number): string;
  /** Set for timer dispatches, whose messages are held by pause-all and quiet hours. */
  timer: { id: number; revision: number } | null;
  sourceGuid: string | null;
  /** When set, replies are collected here instead of enqueued. Tool calls and conversational changes use this. */
  capture?: string[];
  /** Set for a conversational interpret: the responder's extraction for this message. */
  extract?: (request: ExtractRequest) => Promise<unknown>;
}

/** Fails closed on registry, allowlist, and Jev route mistakes before any plugin runs. */
export function checkPlugins(config: Config, plugins: readonly ActionPlugin[]): void {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const { id, stateVersion, capabilities, roles, criteria } = plugin.manifest;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`Plugin id "${id}" must use lowercase letters, digits, and hyphens.`);
    if (RESERVED.has(id)) throw new Error(`Plugin id ${id} is reserved for routing options.`);
    if (ids.has(id)) throw new Error(`Duplicate plugin id ${id}.`);
    ids.add(id);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) throw new Error(`Plugin ${id} needs a positive stateVersion.`);
    if (!roles.length || roles.some(role => role !== "owner" && role !== "member")) throw new Error(`Plugin ${id} has invalid roles.`);
    if (capabilities.some(capability => !CAPABILITIES.has(capability))) throw new Error(`Plugin ${id} declares an unknown capability.`);
    if (!criteria.trim()) throw new Error(`Plugin ${id} needs routing criteria.`);
    if (Object.values(plugin.schema).some(fields => Object.hasOwn(fields, "kind"))) throw new Error(`Plugin ${id} cannot declare a field named kind.`);
    for (const tool of plugin.tools ?? []) {
      if (!Object.hasOwn(plugin.schema, tool.kind)) throw new Error(`Plugin ${id} exports tool ${tool.kind} without a matching command.`);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(tool.kind) || !tool.description.trim() || (tool.impact !== "low" && tool.impact !== "high"))
        throw new Error(`Plugin ${id} exports an invalid tool ${tool.kind}.`);
    }
  }
  for (const contact of config.contacts)
    for (const id of contact.plugins) if (!ids.has(id)) throw new Error(`Contact ${contact.id} allows unknown plugin ${id}.`);
  for (const id of Object.keys(config.jev?.routes ?? {})) {
    const plugin = plugins.find(p => p.manifest.id === id);
    if (!plugin) throw new Error(`Jev route names unknown plugin ${id}.`);
    if (!plugin.interpret) throw new Error(`Jev route ${id} needs a plugin with an interpret step.`);
  }
}

/** Returns a copy holding exactly the schema's fields, or null. */
export function validateCommand(schema: CommandSchema, value: unknown): Command | null {
  if (!record(value) || typeof value.kind !== "string" || !Object.hasOwn(schema, value.kind)) return null;
  const fields = schema[value.kind]!;
  if (Object.keys(value).length !== Object.keys(fields).length + 1) return null;
  const command: Command = { kind: value.kind };
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, name)) return null;
    const v = value[name];
    if (field.type === "string") { if (typeof v !== "string" || !v.trim() || v.length > field.maxLength) return null; }
    else if (v === null) { if (!field.nullable) return null; }
    else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < field.minimum || v > field.maximum) return null;
    command[name] = v;
  }
  return command;
}

function jsonSchema(field: FieldSchema): Record<string, unknown> {
  const description = field.description ? { description: field.description } : {};
  if (field.type === "string") return { type: "string", minLength: 1, maxLength: field.maxLength, ...description };
  return { type: field.nullable ? ["integer", "null"] : "integer", minimum: field.minimum, maximum: field.maximum, ...description };
}

export function isClarification(value: unknown): value is Clarification {
  return record(value) && typeof value.clarify === "string" && !!value.clarify.trim() && Object.keys(value).length === 1;
}

function refusePromise(id: string, value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function") {
    Promise.resolve(value).catch(() => { /* The dispatch already failed; do not crash on its late rejection. */ });
    throw new Error(`Plugin ${id} returned a promise from a synchronous hook.`);
  }
}

export class PluginHost {
  private readonly entries: ReadonlyArray<{ plugin: ActionPlugin; manifest: Readonly<PluginManifest>; tools: readonly ToolDefinition[] }>;
  constructor(private readonly store: Store, plugins: readonly ActionPlugin[], private readonly timezone: string,
    private readonly conversational = false) {
    // Snapshot manifests and tools so a plugin cannot widen its roles or capabilities, or relax a tool's impact, later.
    this.entries = plugins.map(plugin => ({ plugin, manifest: Object.freeze(structuredClone(plugin.manifest)),
      tools: Object.freeze((plugin.tools ?? []).map(tool => Object.freeze({ ...tool }))) }));
    for (const { plugin, manifest: { id, stateVersion } } of this.entries) store.transaction(() => {
      const from = store.pluginVersion(id);
      if (from > stateVersion) throw new Error(`Stored state for plugin ${id} is newer than this installation.`);
      if (from === stateVersion) return;
      let open = true;
      const guard = () => { if (!open) throw new Error(`Plugin ${id} used its migration handle after migrating.`); };
      const db: PluginDb = {
        documents: () => { guard(); return store.pluginDocuments(id); },
        set: (contactId, key, value) => { guard(); store.stateSet(id, contactId, key, value); },
        delete: (contactId, key) => { guard(); store.stateDelete(id, contactId, key); },
      };
      try { refusePromise(id, plugin.migrate(db, from)); } finally { open = false; }
      store.setPluginVersion(id, stateVersion);
    });
  }

  /** Registry order, restricted to plugins the contact's allowlist names and whose manifest permits its role. */
  permitted(contact: Contact): ActionPlugin[] {
    return this.entries.filter(({ manifest }) => contact.plugins.includes(manifest.id) && manifest.roles.includes(contact.role))
      .map(entry => entry.plugin);
  }
  permits(contact: Contact, id: string): ActionPlugin | null {
    return this.permitted(contact).find(plugin => plugin.manifest.id === id) ?? null;
  }
  plugin(id: string): ActionPlugin | null { return this.entries.find(entry => entry.manifest.id === id)?.plugin ?? null; }
  examples(contact: Contact): string[] {
    return this.permitted(contact).flatMap(plugin => this.manifest(plugin).examples);
  }

  /** Routing options this contact may use, built from the registered manifests. Runtimes are owner-only by default. */
  catalog(contact: Contact, options: { conversational?: boolean } = {}): RouteCatalog {
    // The registered snapshot of each manifest, with the plugin itself so hooks defined on a class prototype are seen.
    return routeCatalog(this.permitted(contact), contact, options, plugin => this.manifest(plugin));
  }

  validate(plugin: ActionPlugin, value: unknown): Command | null { return validateCommand(plugin.schema, value); }

  /** Exported commands of the contact's permitted plugins, named `<pluginId>_<kind>`. */
  tools(contact: Contact): RuntimeTool[] {
    return this.permitted(contact).flatMap(plugin => this.entry(plugin).tools.map(tool => {
      const fields = plugin.schema[tool.kind]!;
      return { name: `${plugin.manifest.id}_${tool.kind}`, description: tool.description, inputSchema: { type: "object",
        properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, jsonSchema(field)])),
        required: Object.keys(fields), additionalProperties: false } };
    }));
  }
  /** Resolves a runtime tool name against what the contact may use right now. */
  tool(contact: Contact, name: string): { plugin: ActionPlugin; definition: ToolDefinition } | null {
    const split = name.indexOf("_");
    if (split < 1) return null;
    const plugin = this.permits(contact, name.slice(0, split));
    const definition = plugin && this.entry(plugin).tools.find(tool => tool.kind === name.slice(split + 1));
    return plugin && definition ? { plugin, definition } : null;
  }

  /** Whether contacts may write naturally. Plugins see it as `conversational`. */
  get isConversational(): boolean { return this.conversational; }

  match(plugin: ActionPlugin, text: string, ctx: MessageContext): Command | Clarification | null {
    const result = plugin.match(text, ctx);
    refusePromise(this.manifest(plugin).id, result);
    return result;
  }

  /** Runs a synchronous hook with a context that closes when the hook returns. */
  invoke<T>(plugin: ActionPlugin, source: DispatchSource, hook: (ctx: PluginContext) => T, writable = true): T {
    const { ctx, close } = this.context(plugin, source, writable);
    try {
      const result = hook(ctx);
      refusePromise(this.manifest(plugin).id, result);
      return result;
    } finally { close(); }
  }

  async interpret(plugin: ActionPlugin, source: DispatchSource, text: string): Promise<Command | Clarification | null> {
    const { ctx, close } = this.context(plugin, source, false);
    try { return await plugin.interpret!(text, ctx); } finally { close(); }
  }

  /** The plugin's account of a validated command, from a read-only context. Throws on a malformed account. */
  describe(plugin: ActionPlugin, source: DispatchSource, command: Command): CommandAccount {
    const account: unknown = this.invoke(plugin, source, ctx => plugin.describe!(command, ctx), false);
    if (!record(account) || typeof account.description !== "string" || !account.description.trim() || account.description.length > 500
      || !Array.isArray(account.times) || account.times.some(x => !Number.isSafeInteger(x))) throw new Error("Invalid command account.");
    return { description: account.description.trim(), times: account.times as number[] };
  }

  private entry(plugin: ActionPlugin) { return this.entries.find(entry => entry.plugin === plugin)!; }
  private manifest(plugin: ActionPlugin): Readonly<PluginManifest> { return this.entry(plugin).manifest; }

  private context(plugin: ActionPlugin, source: DispatchSource, writable: boolean): { ctx: PluginContext; close(): void } {
    const { id, capabilities } = this.manifest(plugin);
    const contactId = source.contact.id; const store = this.store;
    let open = true; let replies = 0;
    const check = (capability: Capability | null, write: boolean) => {
      if (!open) throw new Error(`Plugin ${id} used a context after its dispatch ended.`);
      if (write && !writable) throw new Error(`Plugin ${id} cannot write from a read-only context.`);
      if (capability && !capabilities.includes(capability)) throw new Error(`Plugin ${id} did not declare the ${capability} capability.`);
    };
    const key = (value: string) => {
      if (typeof value !== "string" || !value || value.length > 200) throw new Error(`Plugin ${id} used an invalid key.`);
      return value;
    };
    const state: PluginState = Object.freeze({
      get: <T>(k: string) => { check("storage", false); return store.stateGet<T>(id, contactId, key(k)); },
      set: (k: string, value: unknown) => { check("storage", true); store.stateSet(id, contactId, key(k), value); },
      delete: (k: string) => { check("storage", true); store.stateDelete(id, contactId, key(k)); },
      list: <T>(prefix: string) => { check("storage", false); return store.stateList<T>(id, contactId, String(prefix)); },
      nextId: (sequence: string) => { check("storage", true); return store.nextId(id, contactId, key(sequence)); },
    });
    const ctx: PluginContext = Object.freeze({
      contact: source.contact, time: source.time, timezone: this.timezone, conversational: this.conversational, state,
      extract: source.extract ? (request: ExtractRequest) => {
        check(null, false);
        return source.extract!(request);
      } : null,
      reply: (text: string) => {
        check(null, true);
        if (typeof text !== "string" || !text.trim() || text.length > MAX_REPLY) throw new Error(`Plugin ${id} sent an invalid reply.`);
        if (source.capture) { source.capture.push(text); return; }
        store.enqueue({ key: source.replyKey(replies++), contactId, target: source.contact.conversation, text,
          kind: source.timer ? "timer" : "reply", timer: source.timer }, source.now);
      },
      schedule: (k: string, at: number, payload: unknown) => {
        check("schedule", true);
        if (!Number.isSafeInteger(at) || at < 0) throw new Error(`Plugin ${id} scheduled an invalid time.`);
        store.schedule(id, contactId, key(k), at, payload);
      },
      cancelTimer: (k: string) => { check("schedule", true); store.cancelTimer(id, contactId, key(k)); },
      delegate: (text: string, hint?: string) => {
        check(null, true);
        if (typeof text !== "string" || !text.trim()) throw new Error(`Plugin ${id} delegated an empty request.`);
        return store.addTask({ contactId, sourceGuid: source.sourceGuid, text, time: source.time, hint: hint ?? null,
          failure: null, routable: false }).number;
      },
    });
    return { ctx, close: () => { open = false; } };
  }
}
