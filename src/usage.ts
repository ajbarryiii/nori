import type { Provider, TokenUsage, UsageMeter } from "./contracts.js";
import { localDay } from "./parser.js";
import type { Store } from "./store.js";

/** Daily call ceilings kept in SQLite so restarts cannot reset them. A provider without a limit is refused. */
export class StoreMeter implements UsageMeter {
  constructor(private readonly store: Store,
    private readonly options: { timezone: string; limits: Partial<Record<Provider, number>>; clock?: () => number }) {}
  private day(): string { return localDay((this.options.clock ?? Date.now)(), this.options.timezone); }
  reserve(provider: Provider): boolean {
    const limit = this.options.limits[provider];
    return limit !== undefined && this.store.reserveCall(this.day(), provider, limit);
  }
  record(provider: Provider, result: { ok: boolean; usage: TokenUsage | null }): void {
    this.store.recordCall(this.day(), provider, result.ok, result.usage);
  }
}
