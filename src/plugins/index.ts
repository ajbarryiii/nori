import type { ActionPlugin } from "../contracts.js";
import { reminders } from "./reminders.js";

/** Reviewed in-process plugins, in grammar priority order. */
export const builtinPlugins: readonly ActionPlugin[] = [reminders];
