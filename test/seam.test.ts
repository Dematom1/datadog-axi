import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { createRegistry, READ_OPERATIONS, REFUSALS, WRITE_OPERATIONS, type Operation } from "../src/registry.js";
import { resolveBaseUrl, Seam, type WritePreview } from "../src/seam.js";
import type { Target } from "../src/target.js";
import { fakeFetch } from "./helpers.js";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

const KEYS_TARGET: Target = {
  org: "env",
  site: "datadoghq.eu",
  source: "env",
  credentials: "env",
  explicit: false,
  auth: { kind: "keys", apiKey: "api-key-value-123456", appKey: "app-key-value-123456" },
};

function seamWith(
  fetch: ReturnType<typeof fakeFetch>,
  target: Target = KEYS_TARGET,
  extra: Partial<ConstructorParameters<typeof Seam>[0]> = {},
) {
  return new Seam({
    target,
    registry: createRegistry(),
    writable: [],
    fetch,
    sleep: async () => {},
    baseUrl: "https://api.datadoghq.eu",
    ...extra,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AxiError ? error.code : `NOT_AXI: ${String(error)}`;
  }
  return undefined;
}

describe("registry (read-only by construction)", () => {
  it("ships no write operations in v1", () => {
    expect(WRITE_OPERATIONS).toEqual([]);
    expect(READ_OPERATIONS.every((op) => op.access === "read")).toBe(true);
  });

  it("registers every POST read with its body type", () => {
    for (const op of READ_OPERATIONS.filter((o) => o.method === "POST")) {
      expect(op.bodyType, op.id).toBeTruthy();
    }
  });

  it("never lets the api escape hatch reach a refused path", () => {
    const registry = createRegistry();
    for (const op of READ_OPERATIONS.filter((o) => o.api)) {
      const concrete = op.path.replace(/\{[a-z_]+\}/g, "x1");
      const match = registry.match(op.method, concrete);
      expect(match.kind, `${op.method} ${op.path}`).toBe("allowed");
    }
  });

  it("classifies known writes as refused and unknown paths as unregistered", () => {
    const registry = createRegistry();
    expect(registry.match("POST", "/api/v1/monitor").kind).toBe("refused");
    expect(registry.match("POST", "/api/v1/monitor/12/mute").kind).toBe("refused");
    expect(registry.match("POST", "/api/v1/synthetics/tests/trigger").kind).toBe("refused");
    expect(registry.match("POST", "/api/v2/incidents/abc/relationships/responders/page").kind).toBe("refused");
    expect(registry.match("GET", "/api/v2/api_keys").kind).toBe("refused");
    expect(registry.match("GET", "/api/v1/api_key/abc").kind).toBe("refused");
    expect(registry.match("GET", "/api/v2/current_user/application_keys").kind).toBe("refused");
    expect(registry.match("DELETE", "/api/v1/dashboard/abc-def-ghi").kind).toBe("refused");
    expect(registry.match("GET", "/api/v2/users").kind).toBe("unregistered");
    expect(registry.match("PUT", "/api/v9/anything").kind).toBe("unregistered");
  });

  it("prefers literal paths over parameterized ones", () => {
    const match = createRegistry().match("GET", "/api/v1/monitor/search");
    expect(match.kind === "allowed" && match.operation.id).toBe("monitors.search");
  });

  it("every refusal has a reason and an alternative", () => {
    for (const refusal of REFUSALS) {
      expect(refusal.reason.length, refusal.path).toBeGreaterThan(0);
      expect(refusal.alternative.length, refusal.path).toBeGreaterThan(0);
    }
  });

  it("only the seam calls fetch", () => {
    const offenders = sourceFiles().filter(
      (file) => !file.endsWith("seam.ts") && /\bfetch\s*\(/.test(readFileSync(file, "utf-8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every operation id used in source is registered", () => {
    const registry = createRegistry();
    const used = new Set<string>();
    for (const file of sourceFiles()) {
      for (const m of readFileSync(file, "utf-8").matchAll(/\.call(?:<[^>]*>)?\(\s*"([a-z0-9_.]+)"/g)) {
        used.add(m[1] as string);
      }
      for (const m of readFileSync(file, "utf-8").matchAll(/operation:\s*"([a-z0-9_.]+)"/g)) {
        used.add(m[1] as string);
      }
    }
    expect(used.size).toBeGreaterThan(30);
    for (const id of used) {
      expect(registry.get(id), id).toBeDefined();
    }
  });
});

describe("seam requests", () => {
  it("sends key headers to the site host and never follows redirects", async () => {
    const fetch = fakeFetch({ "GET /api/v1/validate": { body: { valid: true } } });
    await seamWith(fetch).call("auth.validate");
    const call = fetch.calls[0]!;
    expect(call.url.host).toBe("api.datadoghq.eu");
    expect(call.headers["dd-api-key"]).toBe("api-key-value-123456");
    expect(call.headers["dd-application-key"]).toBe("app-key-value-123456");
    expect(call.headers.authorization).toBeUndefined();
  });

  it("uses a bearer header for DD_ACCESS_TOKEN", async () => {
    const fetch = fakeFetch({ "GET /api/v1/hosts/totals": { body: {} } });
    await seamWith(fetch, { ...KEYS_TARGET, auth: { kind: "bearer", token: "tok" } }).call("hosts.totals");
    expect(fetch.calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(fetch.calls[0]!.headers["dd-api-key"]).toBeUndefined();
  });

  it("refuses unregistered operation ids before any request", async () => {
    const fetch = fakeFetch({});
    expect(await codeOf(seamWith(fetch).call("monitors.delete"))).toBe("REFUSED");
    expect(fetch.calls).toHaveLength(0);
  });

  it("redacts every response and reports the count", async () => {
    const fetch = fakeFetch({ "GET /api/v1/monitor": { body: [{ name: "m", options: { secret: "s" } }] } });
    const result = await seamWith(fetch).call<Array<{ options: { secret: string } }>>("monitors.list");
    expect(result.data[0]!.options.secret).toBe("[redacted]");
    expect(result.redacted).toBe(1);
  });

  it("retries a short rate limit, then succeeds", async () => {
    const slept: number[] = [];
    const fetch = fakeFetch({
      "GET /api/v1/hosts/totals": [
        {
          status: 429,
          headers: { "x-ratelimit-reset": "2", "x-ratelimit-name": "hosts" },
          body: { errors: ["Rate limit"] },
        },
        { body: { total_up: 3 } },
      ],
    });
    const result = await seamWith(fetch, KEYS_TARGET, { sleep: async (ms) => void slept.push(ms) }).call(
      "hosts.totals",
    );
    expect(result.data).toEqual({ total_up: 3 });
    expect(slept).toEqual([2000]);
  });

  it("fails fast with RATE_LIMITED and the reset time when the wait is long", async () => {
    const fetch = fakeFetch({
      "POST /api/v2/spans/events/search": { status: 429, headers: { "x-ratelimit-reset": "1800" }, body: {} },
    });
    try {
      await seamWith(fetch).call("spans.search", { body: {} });
      expect.unreachable();
    } catch (error) {
      expect((error as AxiError).code).toBe("RATE_LIMITED");
      expect((error as AxiError).message).toContain("1800s");
      expect((error as AxiError).suggestions.join(" ")).toContain("300 requests per hour");
    }
    expect(fetch.calls).toHaveLength(1);
  });

  it("retries 503 a bounded number of times", async () => {
    const fetch = fakeFetch({ "GET /api/v1/hosts/totals": { status: 503, body: {} } });
    expect(await codeOf(seamWith(fetch).call("hosts.totals"))).toBe("SERVER_UNREACHABLE");
    expect(fetch.calls).toHaveLength(3);
  });

  it("translates HTTP errors to stable codes without leaking raw bodies", async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { errors: ["Invalid query: unexpected token at 'status:'"] }, "VALIDATION_ERROR"],
      [401, { errors: ["Unauthorized"] }, "AUTH_REQUIRED"],
      [
        403,
        { errors: [{ title: "Forbidden", detail: "Failed permission authorization checks: logs_read_data" }] },
        "FORBIDDEN",
      ],
      [404, { errors: ["Monitor not found"] }, "NOT_FOUND"],
      [500, "<html>stack trace</html>", "UPSTREAM_ERROR"],
    ];
    for (const [status, body, code] of cases) {
      const fetch = fakeFetch({ "GET /api/v1/hosts/totals": { status, body } });
      try {
        await seamWith(fetch).call("hosts.totals");
        expect.unreachable();
      } catch (error) {
        expect((error as AxiError).code, String(status)).toBe(code);
        expect((error as AxiError).message).not.toContain("stack trace");
        if (status === 403) {
          expect((error as AxiError).message).toContain("missing permission logs_read_data");
        }
      }
    }
  });

  it("reports network failures as SERVER_UNREACHABLE", async () => {
    const failing = Object.assign(
      async () => {
        throw new TypeError("fetch failed");
      },
      { calls: [] },
    );
    expect(await codeOf(seamWith(failing as never).call("hosts.totals"))).toBe("SERVER_UNREACHABLE");
  });

  it("accepts a base URL override only for loopback hosts", () => {
    expect(resolveBaseUrl("datadoghq.com", {})).toBe("https://api.datadoghq.com");
    expect(resolveBaseUrl("datadoghq.com", { DATADOG_AXI_API_URL: "http://127.0.0.1:9999/" })).toBe(
      "http://127.0.0.1:9999",
    );
    expect(() => resolveBaseUrl("datadoghq.com", { DATADOG_AXI_API_URL: "https://evil.example.com" })).toThrow(
      AxiError,
    );
  });
});

describe("write gate (S3)", () => {
  const FAKE_WRITE: Operation = {
    id: "test.monitor_mute",
    method: "POST",
    path: "/api/v1/monitor/{monitor_id}/mute",
    access: "write",
    domain: "monitors",
    api: false,
    executeFlag: "--mute",
  };
  const registry = createRegistry([...READ_OPERATIONS, FAKE_WRITE], []);
  const gate = { execute: false, command: "datadog-axi monitors mute 12 --org sandbox" };
  const explicit: Target = { ...KEYS_TARGET, org: "sandbox", source: "keychain", explicit: true };

  function gated(
    target: Target,
    writable: string[],
    fetch = fakeFetch({ "POST /api/v1/monitor/12/mute": { body: { id: 12 } } }),
  ) {
    return {
      fetch,
      seam: new Seam({ target, registry, writable, fetch, sleep: async () => {}, baseUrl: "https://api.datadoghq.eu" }),
    };
  }

  it("never lets a write through call()", async () => {
    const { seam, fetch } = gated(explicit, ["sandbox"]);
    expect(await codeOf(seam.call("test.monitor_mute"))).toBe("REFUSED");
    expect(fetch.calls).toHaveLength(0);
  });

  it("requires the org to be named explicitly", async () => {
    const { seam, fetch } = gated({ ...explicit, explicit: false }, ["sandbox"]);
    expect(await codeOf(seam.write("test.monitor_mute", { params: { monitor_id: "12" } }, gate))).toBe(
      "VALIDATION_ERROR",
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses orgs that are not on the writable allowlist (default none)", async () => {
    const { seam, fetch } = gated(explicit, []);
    expect(
      await codeOf(seam.write("test.monitor_mute", { params: { monitor_id: "12" } }, { ...gate, execute: true })),
    ).toBe("REFUSED");
    expect(fetch.calls).toHaveLength(0);
  });

  it("previews by default and sends nothing", async () => {
    const { seam, fetch } = gated(explicit, ["sandbox"]);
    const preview = (await seam.write("test.monitor_mute", { params: { monitor_id: "12" } }, gate)) as WritePreview;
    expect(preview).toMatchObject({
      preview: true,
      sent: false,
      target: { org: "sandbox", site: "datadoghq.eu" },
      request: "POST /api/v1/monitor/12/mute",
      run: "datadog-axi monitors mute 12 --org sandbox --mute",
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("sends only with the execute flag, an explicit org and the allowlist", async () => {
    const { seam, fetch } = gated(explicit, ["sandbox"]);
    const result = await seam.write("test.monitor_mute", { params: { monitor_id: "12" } }, { ...gate, execute: true });
    expect(result).toMatchObject({ data: { id: 12 } });
    expect(fetch.calls).toHaveLength(1);
  });
});
