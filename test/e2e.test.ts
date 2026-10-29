import { execFile } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSkillMarkdown } from "../src/skill.js";
import { VERSION } from "../src/version.js";
import { fixture } from "./helpers.js";

/**
 * End to end: the compiled binaries (`npm test` builds first) run as child
 * processes against a local fake Datadog server, exactly as an agent runs
 * them. The environment is built from scratch, so no real credential,
 * keychain entry or config is ever read.
 */

const ROOT = join(import.meta.dirname, "..");
const BIN = join(ROOT, "dist", "bin", "datadog-axi.js");
const CTX_BIN = join(ROOT, "dist", "bin", "datadog-axi-ctx.js");

const requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/api/v1/monitor/search") return send(200, fixture("monitor-search.json"));
      if (url.pathname === "/api/v2/incidents/search") return send(200, fixture("incidents-search.json"));
      if (url.pathname === "/api/v1/monitor/999") return send(404, { errors: ["Monitor not found"] });
      return send(404, { errors: ["no fake route"] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "datadog-axi-e2e-"));
  // A pup on the developer's PATH must never run: tests opt in with a fake one.
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    DATADOG_AXI_PUP: "off",
    ...extra,
  };
}

const CREDS = { DD_API_KEY: "a".repeat(32), DD_APP_KEY: "b".repeat(40), DD_SITE: "datadoghq.eu" };

function runBin(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: 15_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, code: 0 });
        return;
      }
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "number") {
        // A kill (timeout) or spawn failure is never a successful run.
        reject(new Error(`${bin} ${args.join(" ")} did not exit normally: ${error.message}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

describe("compiled binary", () => {
  it("prints the bare version on every version flag", async () => {
    for (const flag of ["--version", "-v", "-V"]) {
      const { stdout, code } = await runBin(BIN, [flag], cleanEnv());
      expect(code).toBe(0);
      expect(stdout).toBe(`${VERSION}\n`);
    }
  });

  it("answers --version without loading the command graph", async () => {
    const copy = mkdtempSync(join(tmpdir(), "datadog-axi-fastpath-"));
    cpSync(join(ROOT, "dist"), join(copy, "dist"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(copy, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "dir");
    rmSync(join(copy, "dist", "src", "cli.js"));
    const bin = join(copy, "dist", "bin", "datadog-axi.js");

    const version = await runBin(bin, ["--version"], cleanEnv());
    expect(version.code).toBe(0);
    expect(version.stdout).toBe(`${VERSION}\n`);
    expect((await runBin(bin, ["ctx"], cleanEnv())).code).not.toBe(0);
  });

  it("renders the live home view against the fake server, sending keys only to it", async () => {
    const before = requests.length;
    const { stdout, code } = await runBin(BIN, [], cleanEnv({ ...CREDS, DATADOG_AXI_API_URL: baseUrl }));
    expect(code).toBe(0);
    expect(stdout).toContain("description: ");
    expect(stdout).toContain("site: datadoghq.eu (EU1)");
    expect(stdout).toContain("incidents: 2 open");
    const mine = requests.slice(before);
    expect(mine.length).toBe(3);
    expect(mine.every((r) => r.headers["dd-api-key"] === CREDS.DD_API_KEY)).toBe(true);
  });

  it("exits 1 with a structured error on stdout for API errors", async () => {
    const { stdout, stderr, code } = await runBin(
      BIN,
      ["monitors", "view", "999"],
      cleanEnv({ ...CREDS, DATADOG_AXI_API_URL: baseUrl }),
    );
    expect(code).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
    expect(stderr).toBe("");
  });

  it("exits 2 for usage errors", async () => {
    const { stdout, code } = await runBin(BIN, ["monitors", "--nope"], cleanEnv());
    expect(code).toBe(2);
    expect(stdout).toContain("code: VALIDATION_ERROR");
  });

  it("refuses a non-loopback API URL override", async () => {
    const { stdout, code } = await runBin(
      BIN,
      ["monitors"],
      cleanEnv({ ...CREDS, DATADOG_AXI_API_URL: "https://example.com" }),
    );
    expect(code).toBe(2);
    expect(stdout).toContain("loopback");
  });

  it("the session hook binary is offline and always exits 0", async () => {
    const before = requests.length;
    const { stdout, code } = await runBin(CTX_BIN, [], cleanEnv({ ...CREDS, DATADOG_AXI_API_URL: baseUrl }));
    expect(code).toBe(0);
    expect(stdout).toContain("org: env");
    expect(stdout).toContain("writes: none (read-only v1)");
    expect(requests.length).toBe(before);
  });
});

/**
 * A fake pup on disk, so the compiled binary runs a real child process. It
 * logs its argv (one call per line) and answers `auth token` and `auth status`
 * like pup does; `mode=expired` fails `auth token` the way pup reports it.
 */
function fakePupBin(mode: "ok" | "expired"): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "datadog-axi-fake-pup-"));
  const bin = join(dir, "pup");
  const log = join(dir, "calls.log");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "auth token")
    if [ "${mode}" = expired ]; then
      echo "Error: token is expired — run 'pup auth login' to refresh" >&2
      exit 1
    fi
    echo "${PUP_TOKEN}" ;;
  "auth status")
    printf '{"authenticated":true,"site":"%s","org":null,"status":"valid","expires_at":"2026-10-29T14:00:00+00:00","scopes":["incident_read","monitors_read"]}\n' "\${DD_SITE:-datadoghq.com}" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const PUP_TOKEN = "pupfaketoken".padEnd(48, "x");

describe.skipIf(process.platform === "win32")("pup as the credential source", () => {
  it("sends pup's token as a bearer, only to the fake server, and never prints it", async () => {
    const pup = fakePupBin("ok");
    const before = requests.length;
    const env = cleanEnv({ DATADOG_AXI_PUP: pup.bin, DD_SITE: "datadoghq.eu", DATADOG_AXI_API_URL: baseUrl });
    const { stdout, code } = await runBin(BIN, ["monitors"], env);
    expect(code).toBe(0);
    expect(stdout).not.toContain(PUP_TOKEN);
    const mine = requests.slice(before);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.headers.authorization === `Bearer ${PUP_TOKEN}`)).toBe(true);
    expect(mine.every((r) => r.headers["dd-api-key"] === undefined)).toBe(true);
    expect(readFileSync(pup.log, "utf-8")).toBe("auth token\nauth status\n");

    const status = await runBin(BIN, ["auth", "status"], env);
    expect(status.stdout).toContain("org: pup");
    expect(status.stdout).toContain("site: datadoghq.eu");
    expect(status.stdout).toContain('credentials: "pup auth token (OAuth login, expires 2026-10-29T14:00:00+00:00)"');
    expect(status.stdout).not.toContain(PUP_TOKEN);
  });

  it("reports an expired pup token with the refresh command, and the hook never runs pup", async () => {
    const pup = fakePupBin("expired");
    const env = cleanEnv({ DATADOG_AXI_PUP: pup.bin, DATADOG_AXI_API_URL: baseUrl });
    const { stdout, code } = await runBin(BIN, ["monitors"], env);
    expect(code).toBe(1);
    expect(stdout).toContain("code: AUTH_REQUIRED");
    expect(stdout).toContain("pup's Datadog token has expired");
    expect(stdout).toContain("pup auth refresh");

    const hook = await runBin(CTX_BIN, [], env);
    expect(hook.code).toBe(0);
    expect(hook.stdout).toContain("org: pup");
    expect(readFileSync(pup.log, "utf-8")).toBe("auth token\n");
  });
});

describe("packaging", () => {
  it("keeps version.ts in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(VERSION).toBe(pkg.version);
    expect(pkg.dependencies["axi-sdk-js"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the committed skill matches the generator", () => {
    expect(readFileSync(join(ROOT, "skills", "datadog-axi", "SKILL.md"), "utf-8")).toBe(createSkillMarkdown());
  });
});
