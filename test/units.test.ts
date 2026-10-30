import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { intFlag, list, parseArgs, type CommandSpec } from "../src/args.js";
import { buildMonitorQuery } from "../src/commands/monitors.js";
import { DOMAIN_SCOPES } from "../src/guide.js";
import { READ_OPERATIONS } from "../src/registry.js";
import { REDACTED, redact } from "../src/redact.js";
import { oneLine, rebuildCommand, truncate } from "../src/render.js";
import { normalizeSite } from "../src/sites.js";
import { formatWindow, parseTime, resolveWindow } from "../src/time.js";
import { NOW } from "./helpers.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AxiError ? error.code : "NOT_AXI";
  }
  return undefined;
}

const SPEC: CommandSpec = {
  name: "logs search",
  positionals: ["<query>"],
  flags: {
    "--from": { kind: "string", description: "" },
    "--full": { kind: "boolean", description: "" },
    "--index": { kind: "list", description: "" },
    "--limit": { kind: "string", description: "" },
  },
};

describe("parseArgs", () => {
  it("accepts --flag value and --flag=value, booleans and repeatable lists", () => {
    const parsed = parseArgs(SPEC, ["status:error", "--from", "1h", "--index=main", "--index", "a,b", "--full"]);
    expect(parsed.positionals).toEqual(["status:error"]);
    expect(parsed.flags["--from"]).toBe("1h");
    expect(parsed.flags["--full"]).toBe(true);
    expect(list(parsed, "--index")).toEqual(["main", "a", "b"]);
  });

  it("treats a Datadog exclusion query as a positional", () => {
    expect(parseArgs(SPEC, ["-status:info"]).positionals).toEqual(["-status:info"]);
  });

  it("rejects unknown flags, listing valid flags", () => {
    try {
      parseArgs(SPEC, ["q", "--frm", "1h"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AxiError);
      expect((error as AxiError).code).toBe("VALIDATION_ERROR");
      expect((error as AxiError).suggestions.join(" ")).toContain("--from");
    }
  });

  it("gives targeted hints for flags from other tools", () => {
    try {
      parseArgs(SPEC, ["q", "--context", "prod"]);
      expect.unreachable();
    } catch (error) {
      expect((error as AxiError).suggestions[0]).toContain("--org");
    }
  });

  it("suggests corrected commands for misplaced and misspelled flags", () => {
    const spec: CommandSpec = { name: "auth guide", flags: { "--site": { kind: "string", description: "" } } };
    for (const args of [
      ["site", "--us3.datadoghq.com"],
      ["--sit", "us3.datadoghq.com"],
    ]) {
      try {
        parseArgs(spec, args);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AxiError);
        expect((error as AxiError).code).toBe("VALIDATION_ERROR");
        expect((error as AxiError).suggestions.join(" ")).toContain("datadog-axi auth guide --site us3.datadoghq.com");
      }
    }
  });

  it("preserves positionals and flag values in correction hints", () => {
    const spec: CommandSpec = {
      name: "logs search",
      positionals: ["<query>"],
      flags: {
        "--site": { kind: "string", description: "" },
        "--org": { kind: "string", description: "" },
        "--from": { kind: "string", description: "" },
      },
    };
    for (const [args, expected] of [
      [["q", "--frm", "1h"], "logs search q --from 1h"],
      [["q", "--org", "prod", "--us3.datadoghq.com"], "logs search q --org prod --site us3.datadoghq.com"],
      [["q", "--org", "prod", "site", "us3.datadoghq.com"], "logs search q --org prod --site us3.datadoghq.com"],
    ] as const) {
      try {
        parseArgs(spec, [...args]);
        expect.unreachable();
      } catch (error) {
        expect((error as AxiError).suggestions.join(" ")).toContain(expected);
      }
    }
  });

  it("omits site corrections when --site is already present", () => {
    const spec: CommandSpec = {
      name: "auth guide",
      flags: { "--site": { kind: "string", description: "" } },
    };
    for (const args of [
      ["site", "us3.datadoghq.com", "--site", "eu1.datadoghq.com"],
      ["--us3.datadoghq.com", "--site", "eu1.datadoghq.com"],
    ]) {
      try {
        parseArgs(spec, args);
        expect.unreachable();
      } catch (error) {
        expect((error as AxiError).suggestions.join(" ")).not.toContain("Did you mean");
      }
    }
  });

  it("quotes spaced arguments in correction hints", () => {
    try {
      parseArgs(SPEC, ["service:web status:error", "--frm", "1h"]);
      expect.unreachable();
    } catch (error) {
      expect((error as AxiError).suggestions.join(" ")).toContain("'service:web status:error' --from 1h");
    }
  });

  it("does not suggest a correction for an unrelated extra argument", () => {
    try {
      parseArgs(SPEC, ["q", "nonsense"]);
      expect.unreachable();
    } catch (error) {
      expect((error as AxiError).code).toBe("VALIDATION_ERROR");
      expect((error as AxiError).suggestions.join(" ")).not.toContain("Did you mean");
    }
  });

  it("rejects repeats, empty values, missing values and extra positionals", () => {
    expect(codeOf(() => parseArgs(SPEC, ["q", "--from", "1h", "--from", "2h"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseArgs(SPEC, ["q", "--from="]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseArgs(SPEC, ["q", "--from"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseArgs(SPEC, ["q", "extra"]))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseArgs(SPEC, []))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => parseArgs(SPEC, ["q", "--full=yes"]))).toBe("VALIDATION_ERROR");
  });

  it("bounds numeric flags", () => {
    const parsed = parseArgs(SPEC, ["q", "--limit", "500"]);
    expect(codeOf(() => intFlag(parsed, "--limit", { default: 20, max: 200 }))).toBe("VALIDATION_ERROR");
    expect(intFlag(parseArgs(SPEC, ["q"]), "--limit", { default: 20, max: 200 })).toBe(20);
    expect(codeOf(() => intFlag(parseArgs(SPEC, ["q", "--limit", "ten"]), "--limit", { default: 20, max: 200 }))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("time windows", () => {
  it("accepts every documented form", () => {
    expect(parseTime("1h", "--from", NOW)).toBe(NOW - 3_600_000);
    expect(parseTime("now-15m", "--from", NOW)).toBe(NOW - 900_000);
    expect(parseTime("7d", "--from", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseTime("now", "--to", NOW)).toBe(NOW);
    expect(parseTime("2026-10-28T11:00:00Z", "--from", NOW)).toBe(NOW - 3_600_000);
    expect(parseTime("2026-10-28T13:00:00+02:00", "--from", NOW)).toBe(NOW - 3_600_000);
    expect(parseTime("1793228400", "--from", NOW)).toBe(1793228400000);
    expect(parseTime("1793228400000", "--from", NOW)).toBe(1793228400000);
  });

  it("rejects ambiguous input as a usage error", () => {
    for (const bad of ["yesterday", "2026-10-28", "2026-10-28T11:00:00", "12345", "1y", "-1h"]) {
      expect(
        codeOf(() => parseTime(bad, "--from", NOW)),
        bad,
      ).toBe("VALIDATION_ERROR");
    }
  });

  it("defaults to the last hour and echoes it in UTC", () => {
    expect(formatWindow(resolveWindow(undefined, undefined, NOW))).toBe("2026-10-28T11:00:00Z..2026-10-28T12:00:00Z");
  });

  it("rejects inverted and future windows", () => {
    expect(codeOf(() => resolveWindow("1h", "2h", NOW))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => resolveWindow("1h", "2026-10-29T00:00:00Z", NOW))).toBe("VALIDATION_ERROR");
  });
});

describe("redaction", () => {
  it("redacts values under sensitive keys at any depth and counts them", () => {
    const { value, redacted } = redact({
      a: { password: "x", nested: [{ api_key: "k", ok: 1 }] },
      DD_APPLICATION_KEY: "y",
      Authorization: "Bearer z",
      message: "fine",
      has_password: true,
    });
    expect(redacted).toBe(4);
    expect(JSON.stringify(value)).not.toMatch(/"x"|"k"|"y"|Bearer z/);
    expect((value as { message: string }).message).toBe("fine");
    expect((value as { has_password: boolean }).has_password).toBe(true);
  });

  it("redacts sensitive-looking key:value tags", () => {
    const { value, redacted } = redact({ tags: ["env:prod", "api_key:abc123", "secret_token:t"] });
    expect(value.tags).toEqual(["env:prod", `api_key:${REDACTED}`, `secret_token:${REDACTED}`]);
    expect(redacted).toBe(2);
  });

  it("leaves metadata keys that only look sensitive", () => {
    expect(redact({ passed: false, tokens: 12, compass: "n" }).redacted).toBe(0);
  });
});

describe("sites", () => {
  it("normalizes hosts, regions and pasted URLs", () => {
    expect(normalizeSite("EU1")).toBe("datadoghq.eu");
    expect(normalizeSite("https://app.us5.datadoghq.com/monitors")).toBe("us5.datadoghq.com");
    expect(normalizeSite("ddog-gov.com")).toBe("ddog-gov.com");
  });

  it("refuses unknown hosts so keys never go elsewhere", () => {
    expect(codeOf(() => normalizeSite("evil.example.com"))).toBe("VALIDATION_ERROR");
  });
});

describe("setup guide scopes", () => {
  it("names scopes for every domain a registered read belongs to", () => {
    const covered = new Set(DOMAIN_SCOPES.map((d) => d.domain));
    const domains = new Set(READ_OPERATIONS.map((op) => op.domain).filter((d) => d !== "auth"));
    expect([...domains].filter((d) => !covered.has(d))).toEqual([]);
    expect([...covered].filter((d) => !domains.has(d))).toEqual([]);
  });

  it("are all listed in the README", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf-8");
    const missing = DOMAIN_SCOPES.flatMap((d) => d.scopes).filter((s) => !readme.includes(`\`${s}\``));
    expect(missing).toEqual([]);
  });
});

describe("render helpers", () => {
  it("truncates with the total size only when cut", () => {
    expect(truncate("short", 10)).toEqual({ text: "short", truncated: false });
    expect(truncate("x".repeat(20), 10).text).toBe(`${"x".repeat(10)}... (truncated, 20 chars total)`);
    expect(oneLine("a\n b", 10)).toBe("a b");
    expect(oneLine(`${"y".repeat(15)}\n`, 10)).toBe(`${"y".repeat(10)}... (truncated, 15 chars total)`);
  });

  it("rebuilds a command without the dropped flags", () => {
    expect(
      rebuildCommand("datadog-axi logs search", ["service:web status:error", "--from", "1h", "--limit=5"], ["--from"]),
    ).toBe('datadog-axi logs search "service:web status:error" --limit=5');
  });
});

describe("monitor query building", () => {
  it("combines the raw query, statuses, tags and name in Datadog syntax", () => {
    expect(buildMonitorQuery("type:metric", ["alert"], ["env:prod"], 'cost $ "x"')).toBe(
      'type:metric status:alert tag:"env:prod" "cost $ \\"x\\""',
    );
  });

  it("rejects unknown statuses", () => {
    expect(codeOf(() => buildMonitorQuery(undefined, ["red"], []))).toBe("VALIDATION_ERROR");
  });
});
