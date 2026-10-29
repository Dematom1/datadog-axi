import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import type { Config } from "../src/config.js";
import { memoryKeychain, type Keychain, type StoredKeys } from "../src/keychain.js";
import type { PupRunner } from "../src/pup.js";
import type { Runtime } from "../src/runtime.js";
import type { FetchLike } from "../src/seam.js";

/**
 * Test plumbing. Nothing here reaches a real Datadog endpoint, keychain,
 * credential or pup: HTTP goes to an in-process fake, the keychain is in
 * memory, pup is a scripted fake, the environment is built from scratch, and
 * config lives in a temp dir.
 */

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

/** 2026-10-28T12:00:00Z */
export const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

export const ENV_KEYS = {
  DD_API_KEY: "a".repeat(32),
  DD_APP_KEY: "b".repeat(40),
};

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit["redirect"];
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = FakeResponse | ((req: RecordedRequest) => FakeResponse);

/** Routes are keyed `METHOD /path` (no query string). Unknown routes return 404. */
export function fakeFetch(routes: Record<string, Route | Route[]>): FetchLike & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const counters = new Map<string, number>();
  const fn = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      url: parsed,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init.redirect,
    };
    calls.push(req);
    const key = `${req.method} ${parsed.pathname}`;
    let route = routes[key];
    if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      route = route[Math.min(n, route.length - 1)];
    }
    const res: FakeResponse =
      route === undefined
        ? { status: 404, body: { errors: [`no fake route for ${key}`] } }
        : typeof route === "function"
          ? route(req)
          : route;
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    });
  }) as FetchLike & { calls: RecordedRequest[] };
  fn.calls = calls;
  return fn;
}

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<Config>;
  keys?: Record<string, StoredKeys>;
  keychain?: Keychain;
  fetch?: FetchLike;
  stdin?: { isTTY: boolean; text: string };
  pup?: PupRunner;
}

export interface PupCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * A scripted pup: `auth token` and `auth status` answer from `replies`
 * (a string is stdout, an Error is a failure). Calls are recorded.
 */
export function fakePup(replies: { token?: string | Error; status?: unknown }): PupRunner & { calls: PupCall[] } {
  const calls: PupCall[] = [];
  return {
    calls,
    async run(_bin, args, env) {
      calls.push({ args, env });
      const reply = args.join(" ") === "auth token" ? replies.token : replies.status;
      if (reply instanceof Error) {
        throw reply;
      }
      if (reply === undefined) {
        throw new Error(`fake pup has no reply for ${args.join(" ")}`);
      }
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  };
}

/** A pup that fails the test if datadog-axi ever runs it. */
const forbiddenPup: PupRunner = {
  run: async () => {
    throw new Error("pup must not run in this test");
  },
};

export function makeRuntime(options: RuntimeOptions = {}): Runtime & { configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "datadog-axi-test-"));
  const configPath = join(dir, "datadog-axi", "config.json");
  if (options.config) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ orgs: {}, writable: [], ...options.config }));
  }
  return {
    env: options.env ?? {},
    now: () => NOW,
    configPath,
    keychain: options.keychain ?? memoryKeychain(options.keys ?? {}),
    fetch: options.fetch ?? fakeFetch({}),
    sleep: async () => {},
    readStdin: async () => options.stdin ?? { isTTY: true, text: "" },
    pup: options.pup ?? forbiddenPup,
  };
}

export async function run(argv: string[], runtime: Runtime): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  const previous = process.exitCode;
  process.exitCode = 0;
  await main({ argv, runtime, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previous;
  return { stdout, exitCode };
}
