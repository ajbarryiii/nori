import { spawnSync } from "node:child_process";

export type SecretName = "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY";
/** Keychain generic-password service names in the assistant profile's login keychain. */
export const KEYCHAIN_SERVICES: Record<SecretName, string> = { TYPESAFE_API_KEY: "ai.nori.typesafe", OPENROUTER_API_KEY: "ai.nori.openrouter" };

/** The environment for child processes (imsg, Codex): everything except Nori's own API keys. */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of Object.keys(KEYCHAIN_SERVICES)) delete copy[name];
  return copy;
}

type Runner = (command: string, args: string[]) => { status: number | null; stdout: string | null };

/**
 * Reads an API key from the environment, then (macOS only) the login Keychain. Keys never appear in
 * config files, plists, or command-line arguments, and are never logged.
 */
export function readSecret(name: SecretName, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: Runner } = {}): string | null {
  const fromEnv = (options.env ?? process.env)[name]?.trim();
  if (fromEnv) return fromEnv;
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const run: Runner = options.run ?? ((command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }));
  try {
    const result = run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICES[name], "-w"]);
    const secret = result.status === 0 ? String(result.stdout ?? "").trim() : "";
    return secret || null;
  } catch { return null; }
}
