import { AxiError } from "axi-sdk-js";
import { str, type ParsedArgs } from "./args.js";
import { configPath, loadConfig, type Config } from "./config.js";
import { osKeychain, type Keychain } from "./keychain.js";
import type { PupRunner } from "./pup.js";
import { createRegistry, type Registry } from "./registry.js";
import { resolveBaseUrl, Seam, type FetchLike } from "./seam.js";
import { resolveTarget } from "./target.js";

/**
 * Everything a command needs from the outside world, injected so tests run
 * against fakes: environment, clock, config path, keychain, HTTP, stdin and
 * the pup process.
 */
export interface Runtime {
  env: NodeJS.ProcessEnv;
  now: () => number;
  configPath: string;
  keychain: Keychain;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  readStdin: () => Promise<{ isTTY: boolean; text: string }>;
  registry?: Registry;
  pup?: PupRunner;
}

export function defaultRuntime(): Runtime {
  return {
    env: process.env,
    now: () => Date.now(),
    configPath: configPath(process.env),
    keychain: osKeychain(),
    readStdin: readProcessStdin,
  };
}

async function readProcessStdin(): Promise<{ isTTY: boolean; text: string }> {
  if (process.stdin.isTTY) {
    return { isTTY: true, text: "" };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return { isTTY: false, text: Buffer.concat(chunks).toString("utf-8") };
}

export function readConfig(rt: Runtime): Config {
  return loadConfig(rt.configPath);
}

/** Resolve the target org and open the seam. Reads the keychain when needed. */
export async function connect(rt: Runtime, parsed: ParsedArgs): Promise<Seam> {
  const config = readConfig(rt);
  const target = await resolveTarget(
    { org: str(parsed, "--org"), site: str(parsed, "--site") },
    rt.env,
    config,
    rt.keychain,
    rt.pup,
  );
  return new Seam({
    target,
    registry: rt.registry ?? createRegistry(),
    writable: config.writable,
    fetch: rt.fetch,
    sleep: rt.sleep,
    baseUrl: resolveBaseUrl(target.site, rt.env),
  });
}

/** Split `<noun> [<sub>] args` with a default subcommand. */
export function splitSubcommand(
  noun: string,
  args: string[],
  subcommands: readonly string[],
  fallback?: string,
): { sub: string; rest: string[] } {
  const first = args[0];
  if (first !== undefined && subcommands.includes(first)) {
    return { sub: first, rest: args.slice(1) };
  }
  if (fallback !== undefined && (first === undefined || first.startsWith("--"))) {
    return { sub: fallback, rest: args };
  }
  throw new AxiError(
    first === undefined ? `\`${noun}\` needs a subcommand` : `Unknown subcommand for \`${noun}\`: ${first}`,
    "VALIDATION_ERROR",
    [`Subcommands: ${subcommands.join(", ")}`, `Run \`datadog-axi ${noun} --help\``],
  );
}
