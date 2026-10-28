import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
  return { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

const CREDS = { DD_API_KEY: "a".repeat(32), DD_APP_KEY: "b".repeat(40), DD_SITE: "datadoghq.eu" };

function runBin(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: 15_000 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0;
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

  it("keeps the version fast path free of the command graph", () => {
    const source = readFileSync(join(ROOT, "bin", "datadog-axi.ts"), "utf-8");
    const staticImports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(["axi-sdk-js/fast-path", "../src/version.js"]);
  });

  it("renders the live home view against the fake server, sending keys only to it", async () => {
    const before = requests.length;
    const { stdout, code } = await runBin(BIN, [], cleanEnv({ ...CREDS, DATADOG_AXI_API_URL: baseUrl }));
    expect(code).toBe(0);
    expect(stdout).toContain("description: ");
    expect(stdout).toContain("site: datadoghq.eu (EU1)");
    expect(stdout).toContain("incidents: 2 active");
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
