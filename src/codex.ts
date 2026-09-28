import type { CodexWorker, RpcPort } from "./contracts.js";
import { object as record } from "./config.js";

/** Protocol inspection only. Desktop Computer Use is not assumed to be exposed by app-server. */
export class CodexProbe implements CodexWorker {
  constructor(private readonly rpc: RpcPort) {}
  async inspect(): ReturnType<CodexWorker["inspect"]> {
    try {
      const response = record(await this.rpc.request("initialize", { clientInfo: { name: "nori", title: "Nori", version: "0.1.0" } }));
      if (!response || typeof response.userAgent !== "string") throw new Error("Invalid initialization result.");
      this.rpc.notify("initialized", {});
      return { connected: true, computerUse: "unverified", detail: "Codex app-server handshake succeeded. No task was started. Computer Use requires a separate capability check." };
    } catch {
      return { connected: false, computerUse: "unverified", detail: "Codex app-server initialization failed. No task was started." };
    }
  }
}
