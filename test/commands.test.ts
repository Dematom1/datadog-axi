import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS, fakeFetch, fixture, makeRuntime, run } from "./helpers.js";

const EU = { ...ENV_KEYS, DD_SITE: "datadoghq.eu" };

describe("home view", () => {
  it("shows the offline ctx block and makes no request without credentials", async () => {
    const fetch = fakeFetch({});
    const { stdout, exitCode } = await run([], makeRuntime({ fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("bin: ");
    expect(stdout).toContain("credentials: none configured");
    expect(stdout).toContain("writes: none (read-only v1)");
    expect(stdout).toContain("live: unavailable - no credentials configured");
    expect(fetch.calls).toHaveLength(0);
  });

  it("adds monitor counts, alerting monitors and open incidents", async () => {
    const search = fixture<{ monitors: unknown[] }>("monitor-search.json");
    const fetch = fakeFetch({
      "GET /api/v1/monitor/search": (req) =>
        req.url.searchParams.get("query")
          ? { body: { ...search, monitors: search.monitors.slice(1) } }
          : { body: search },
      "GET /api/v2/incidents/search": { body: fixture("incidents-search.json") },
    });
    const { stdout, exitCode } = await run([], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("site: datadoghq.eu (EU1)");
    expect(stdout).toMatch(/monitor_counts:\n {2}Alert: 3\n {2}Warn: 1\n {2}"No Data": 2\n {2}OK: 120/);
    expect(stdout).toContain("102,Checkout error rate,Alert,query alert");
    const incidents = fetch.calls.find((c) => c.url.pathname === "/api/v2/incidents/search")!;
    expect(incidents.url.searchParams.get("query")).toBe("state:(active OR stable)");
    expect(stdout).toContain("incidents: 2 open");
  });

  it("degrades each live part to unavailable with exit 0", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/monitor/search": { status: 403, body: { errors: ["Forbidden: monitors_read"] } },
      "GET /api/v2/incidents/search": { status: 500, body: {} },
    });
    const { stdout, exitCode } = await run([], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain('monitor_counts: "unavailable - FORBIDDEN');
    expect(stdout).toContain('incidents: "unavailable - UPSTREAM_ERROR');
  });
});

describe("ctx", () => {
  it("is offline and shows the allowlist when set", async () => {
    const fetch = fakeFetch({});
    const rt = makeRuntime({
      fetch,
      config: { current: "prod", orgs: { prod: { site: "datadoghq.eu" } }, writable: ["prod"] },
    });
    const { stdout, exitCode } = await run(["ctx"], rt);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("org: prod");
    expect(stdout).toContain("writable_allowlist: prod");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("monitors", () => {
  it("searches problems first with counts, total and a next-page hint", async () => {
    const fetch = fakeFetch({ "GET /api/v1/monitor/search": { body: fixture("monitor-search.json") } });
    const { stdout, exitCode } = await run(
      ["monitors", "--status", "alert,no_data", "--tag", "env:prod", "--limit", "3"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(exitCode).toBe(0);
    const q = fetch.calls[0]!.url.searchParams;
    expect(q.get("query")).toBe('(status:alert OR status:"no data") tag:"env:prod"');
    expect(q.get("per_page")).toBe("3");
    expect(q.get("sort")).toBe("status,asc");
    expect(stdout).toContain("count: 3 of 126 total");
    const rows = stdout.split("\n").filter((l) => /^ {2}\d{3},/.test(l));
    expect(rows.map((r) => r.split(",")[0]!.trim())).toEqual(["102", "103", "101"]);
    expect(stdout).toContain("--page 1");
  });

  it("states a definitive empty result", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/monitor/search": { body: { monitors: [], counts: { status: [] }, metadata: { total_count: 0 } } },
    });
    const { stdout } = await run(["monitors", "search", "nothing-matches"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain('monitors: "0 matched on site datadoghq.eu');
  });

  it("views a monitor with its non-OK groups problems first", async () => {
    const fetch = fakeFetch({ "GET /api/v1/monitor/102": { body: fixture("monitor-get.json") } });
    const { stdout, exitCode } = await run(["monitors", "view", "102"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status: Alert");
    expect(stdout).toContain("groups_not_ok: 2 of 2");
    expect(stdout.indexOf("host:web-1")).toBeLessThan(stdout.indexOf("host:web-3"));
    expect(stdout).not.toContain("host:web-2");
  });
});

describe("logs", () => {
  it("searches with the normalized window and redacts sensitive attributes", async () => {
    const fetch = fakeFetch({ "POST /api/v2/logs/events/search": { body: fixture("logs-search.json") } });
    const { stdout, exitCode } = await run(
      ["logs", "search", "service:checkout status:error", "--from", "15m", "--fields", "id"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(exitCode).toBe(0);
    expect(fetch.calls[0]!.body).toMatchObject({
      filter: {
        query: "service:checkout status:error",
        from: "2026-10-28T11:45:00Z",
        to: "2026-10-28T12:00:00Z",
        indexes: ["*"],
      },
      page: { limit: 20 },
      sort: "-timestamp",
    });
    expect(stdout).toContain('window: "2026-10-28T11:45:00Z..2026-10-28T12:00:00Z"');
    expect(stdout).toContain(
      '"2026-10-28T11:58:00Z",checkout,error,payment provider timeout after 30s order=1234,AQAAAZLogOne',
    );
    expect(stdout).toContain("redacted: 2 fields with sensitive keys hidden");
    expect(stdout).not.toContain("hunter2");
    expect(stdout).toContain("--cursor eyJhZnRlciI6Ik5FWFQifQ");
  });

  it("gives a definitive empty state with site, window, query, indexes and two ways to widen", async () => {
    const fetch = fakeFetch({ "POST /api/v2/logs/events/search": { body: { data: [], meta: { page: {} } } } });
    const { stdout } = await run(
      ["logs", "search", "service:nope", "--index", "main"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(stdout).toContain("logs: 0 matched");
    expect(stdout).toContain("site: datadoghq.eu");
    expect(stdout).toContain('window: "2026-10-28T11:00:00Z..2026-10-28T12:00:00Z"');
    expect(stdout).toContain("indexes: main");
    expect(stdout).toContain("Widen the window");
    expect(stdout).toContain("Loosen the query");
  });

  it("aggregates by facet", async () => {
    const fetch = fakeFetch({ "POST /api/v2/logs/analytics/aggregate": { body: fixture("logs-aggregate.json") } });
    const { stdout } = await run(
      ["logs", "aggregate", "status:error", "--by", "service"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(fetch.calls[0]!.body).toMatchObject({ group_by: [{ facet: "service", limit: 10 }] });
    expect(stdout).toContain("total_in_groups: 454");
    expect(stdout).toContain("checkout,412");
  });

  it("views one event by id within the window", async () => {
    const fetch = fakeFetch({ "POST /api/v1/logs-queries/list": { body: fixture("logs-list-v1.json") } });
    const { stdout, exitCode } = await run(["logs", "view", "AQAAAZLogOne"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(fetch.calls[0]!.body).toMatchObject({ startAt: "AQAAAZLogOne", limit: 1 });
    expect(stdout).toContain("status: error");
    expect(stdout).not.toContain("Bearer abc");
  });

  it("reports NOT_FOUND when the id is outside the window", async () => {
    const fetch = fakeFetch({ "POST /api/v1/logs-queries/list": { body: { logs: [] } } });
    const { stdout, exitCode } = await run(["logs", "view", "AQAAmissing"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
  });

  it("rejects ambiguous time before any request", async () => {
    const fetch = fakeFetch({});
    const { stdout, exitCode } = await run(
      ["logs", "search", "*", "--from", "yesterday"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(exitCode).toBe(2);
    expect(stdout).toContain("code: VALIDATION_ERROR");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("metrics", () => {
  it("summarizes each series", async () => {
    const fetch = fakeFetch({ "POST /api/v2/query/timeseries": { body: fixture("metrics-timeseries.json") } });
    const { stdout } = await run(
      ["metrics", "query", "avg:system.cpu.user{*} by {host}"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(fetch.calls[0]!.body).toMatchObject({
      data: {
        attributes: {
          from: Date.UTC(2026, 9, 28, 11),
          to: Date.UTC(2026, 9, 28, 12),
          queries: [{ data_source: "metrics", query: "avg:system.cpu.user{*} by {host}" }],
        },
      },
    });
    expect(stdout).toContain('"host:web-1",3,10,20,30,30,percent');
    expect(stdout).toContain('"host:web-2",4,50,72.5,90,80,percent');
  });

  it("summarizes tag cardinality", async () => {
    const fetch = fakeFetch({
      "GET /api/v2/metrics/trace.hits/all-tags": {
        body: { data: { attributes: { tags: ["env:prod", "env:staging", "host:a", "host:b", "host:c"] } } },
      },
    });
    const { stdout } = await run(["metrics", "tags", "trace.hits"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain("host,3,a b c");
    expect(stdout).toContain("env,2,prod staging");
  });
});

describe("traces", () => {
  it("searches spans with four default columns", async () => {
    const fetch = fakeFetch({ "POST /api/v2/spans/events/search": { body: fixture("spans-trace.json") } });
    const { stdout, exitCode } = await run(["traces", "search", "service:web"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/spans\[\d+\]\{service,resource,duration_ms,error\}:/);
  });

  it("views a trace as a span tree with errors", async () => {
    const fetch = fakeFetch({ "POST /api/v2/spans/events/search": { body: fixture("spans-trace.json") } });
    const { stdout, exitCode } = await run(["traces", "view", "123456789"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(
      (fetch.calls[0]!.body as { data: { attributes: { filter: { query: string } } } }).data.attributes.filter.query,
    ).toBe("trace_id:123456789");
    expect(stdout).toContain("spans: 3");
    expect(stdout).toContain("errors: 1");
    expect(stdout).toContain("duration_ms: 1200");
    expect(stdout).toMatch(
      /0,web,GET \/checkout,1200,false\n {2}1,checkout,POST \/pay,1000,true\n {2}2,postgres,SELECT orders,50,false/,
    );
  });
});

describe("events", () => {
  it("mentions ingestion lag when nothing matched", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/events": { body: { events: [] } },
      "POST /api/v2/events/search": { body: { data: [] } },
    });
    for (const argv of [
      ["events", "list"],
      ["events", "search", "source:deploy"],
    ]) {
      const { stdout, exitCode } = await run(argv, makeRuntime({ env: EU, fetch }));
      expect(exitCode, argv.join(" ")).toBe(0);
      expect(stdout).toContain("events: 0 matched");
      expect(stdout).toContain("note: recent events can take a minute or more to become searchable");
    }
  });
});

describe("incidents, slos, dashboards", () => {
  it("lists open incidents, reading old and new field shapes", async () => {
    const fetch = fakeFetch({ "GET /api/v2/incidents/search": { body: fixture("incidents-search.json") } });
    const { stdout } = await run(["incidents"], makeRuntime({ env: EU, fetch }));
    expect(fetch.calls[0]!.url.searchParams.get("query")).toBe("state:(active OR stable)");
    expect(stdout).toContain("Checkout payments failing,SEV-2,active");
    expect(stdout).toContain("Search latency,SEV-4,stable");
  });

  it("checks an SLO against its target over its own timeframe", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/slo/slo123": { body: fixture("slo-get.json") },
      "GET /api/v1/slo/slo123/history": { body: fixture("slo-history.json") },
    });
    const { stdout } = await run(["slos", "status", "slo123"], makeRuntime({ env: EU, fetch }));
    const history = fetch.calls[1]!.url.searchParams;
    expect(Number(history.get("to_ts")) - Number(history.get("from_ts"))).toBe(30 * 86400);
    expect(stdout).toContain("meets_target: false");
    expect(stdout).toContain('error_budget_remaining: "-80%"');
  });

  it("views a dashboard as widget titles and queries", async () => {
    const fetch = fakeFetch({ "GET /api/v1/dashboard/abc-def-ghi": { body: fixture("dashboard-get.json") } });
    const { stdout } = await run(["dashboards", "view", "abc-def-ghi"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain("widget_count: 3");
    expect(stdout).toContain('Error rate,"sum:trace.http.request.errors{service:checkout}"\n');
    expect(stdout).toContain('url: "https://app.datadoghq.eu/dashboard/abc-def-ghi/checkout-overview"');
    expect(stdout).not.toContain("--full");
  });

  it("shows the total size of cut widget text and mentions --full only then", async () => {
    const dashboard = fixture<{ widgets: Array<{ definition: { title?: string } }> }>("dashboard-get.json");
    dashboard.widgets[0]!.definition.title = "t".repeat(150);
    const fetch = fakeFetch({ "GET /api/v1/dashboard/abc-def-ghi": { body: dashboard } });
    const { stdout } = await run(["dashboards", "view", "abc-def-ghi"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain(`${"t".repeat(120)}... (truncated, 150 chars total)`);
    expect(stdout).toContain("datadog-axi dashboards view abc-def-ghi --full");
  });
});

describe("view truncation", () => {
  it("mentions --full only when slos view or synthetics view cut text", async () => {
    const cases: Array<[string[], string, unknown, string]> = [
      [["slos", "view", "slo1"], "GET /api/v1/slo/slo1", { data: { id: "slo1", description: "d".repeat(1200) } }, "d"],
      [
        ["synthetics", "view", "abc-123-def"],
        "GET /api/v1/synthetics/tests/abc-123-def",
        { message: "m".repeat(600) },
        "m",
      ],
    ];
    for (const [argv, route, body, ch] of cases) {
      const fetch = fakeFetch({ [route]: { body } });
      const cut = await run(argv, makeRuntime({ env: EU, fetch }));
      expect(cut.stdout).toContain("chars total)");
      expect(cut.stdout).toContain(`datadog-axi ${argv.join(" ")} --full`);
      const full = await run([...argv, "--full"], makeRuntime({ env: EU, fetch }));
      expect(full.stdout).toContain(ch.repeat(argv[0] === "slos" ? 1200 : 600));
      expect(full.stdout).not.toContain("--full");
    }
  });
});

describe("api escape hatch", () => {
  it("allows registered reads with the same redaction", async () => {
    const fetch = fakeFetch({ "GET /api/v1/monitor": { body: [{ id: 1, options: { password: "p" } }] } });
    const { stdout, exitCode } = await run(
      ["api", "/api/v1/monitor?group_states=alert", "--query", "with_downtimes=true"],
      makeRuntime({ env: EU, fetch }),
    );
    expect(exitCode).toBe(0);
    expect(fetch.calls[0]!.url.searchParams.get("group_states")).toBe("alert");
    expect(fetch.calls[0]!.url.searchParams.get("with_downtimes")).toBe("true");
    expect(stdout).toContain("operation: monitors.list");
    expect(stdout).toContain("redacted: 1 field with sensitive keys hidden");
    expect(stdout).not.toContain(": p\n");
  });

  it("refuses writes, credential endpoints and unregistered paths before any request", async () => {
    const fetch = fakeFetch({});
    for (const argv of [
      ["api", "POST", "/api/v1/monitor"],
      ["api", "DELETE", "/api/v1/dashboard/abc-def-ghi"],
      ["api", "/api/v2/api_keys"],
      ["api", "/api/v2/users"],
      ["api", "/api/v2/current_user/application_keys"],
    ]) {
      const { stdout, exitCode } = await run(argv, makeRuntime({ env: EU, fetch }));
      expect(exitCode, argv.join(" ")).toBe(1);
      expect(stdout).toContain("code: REFUSED");
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects absolute URLs so the host always comes from the site", async () => {
    const { stdout, exitCode } = await run(
      ["api", "https://evil.example.com/api/v1/monitor"],
      makeRuntime({ env: EU }),
    );
    expect(exitCode).toBe(2);
    expect(stdout).toContain("absolute API path");
  });

  it("clamps long output unless --full", async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `monitor number ${i} with a fairly long name` }));
    const fetch = fakeFetch({ "GET /api/v1/monitor": { body: big } });
    const clamped = await run(["api", "/api/v1/monitor"], makeRuntime({ env: EU, fetch }));
    expect(clamped.stdout).toContain("(truncated,");
    expect(clamped.stdout).toContain("--full");
    const full = await run(["api", "/api/v1/monitor", "--full"], makeRuntime({ env: EU, fetch }));
    expect(full.stdout).not.toContain("(truncated,");
  });
});

describe("auth", () => {
  it("validates the config before writing to the keychain", async () => {
    const rt = makeRuntime({ stdin: { isTTY: false, text: `${"k".repeat(32)}\n${"s".repeat(40)}\n` } });
    mkdirSync(dirname(rt.configPath), { recursive: true });
    writeFileSync(rt.configPath, "{ not json");
    const { stdout, exitCode } = await run(["auth", "login", "--org", "prod", "--site", "EU1", "--api-key-stdin"], rt);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: CONFIG_INVALID");
    expect(await rt.keychain.get("prod")).toBeNull();
  });

  it("logs in from stdin only, stores keys in the keychain and never in config", async () => {
    const rt = makeRuntime({ stdin: { isTTY: false, text: `${"k".repeat(32)}\n${"s".repeat(40)}\n` } });
    const { stdout, exitCode } = await run(["auth", "login", "--org", "prod", "--site", "EU1", "--api-key-stdin"], rt);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("site: datadoghq.eu (EU1)");
    expect(stdout).not.toContain("kkkk");
    expect(await rt.keychain.get("prod")).toEqual({ apiKey: "k".repeat(32), appKey: "s".repeat(40) });
    const config = readFileSync(rt.configPath, "utf-8");
    expect(config).not.toContain("kkkk");
    expect(JSON.parse(config)).toEqual({ current: "prod", orgs: { prod: { site: "datadoghq.eu" } }, writable: [] });

    const listed = await run(["auth", "list"], rt);
    expect(listed.stdout).toContain("prod,datadoghq.eu,true");

    const out = await run(["auth", "logout", "--org", "prod"], rt);
    expect(out.stdout).toContain("removed: true");
    expect(await rt.keychain.get("prod")).toBeNull();
    const again = await run(["auth", "logout", "--org", "prod"], rt);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("no-op");
  });

  it("refuses a terminal on stdin and keys in argv", async () => {
    const tty = await run(["auth", "login", "--org", "prod", "--site", "EU1", "--api-key-stdin"], makeRuntime());
    expect(tty.exitCode).toBe(2);
    expect(tty.stdout).toContain("terminal");
    const argv = await run(["auth", "login", "--org", "prod", "--api-key", "abc"], makeRuntime());
    expect(argv.exitCode).toBe(2);
    expect(argv.stdout).toContain("never accepted in argv");
  });

  it("reports readable domains", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/validate": { body: { valid: true } },
      "GET /api/v1/monitor/search": { body: { monitors: [] } },
      "POST /api/v2/logs/events/search": { status: 403, body: { errors: ["Forbidden"] } },
    });
    const { stdout, exitCode } = await run(["auth", "status"], makeRuntime({ env: EU, fetch }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid: yes");
    expect(stdout).toContain("monitors,yes,ok");
    expect(stdout).toContain("logs,no,FORBIDDEN");
    expect(stdout).toContain("traces,not probed");
    expect(fetch.calls.some((c) => c.url.pathname.startsWith("/api/v2/spans"))).toBe(false);
  });
});

describe("doctor", () => {
  it("reports whether the key could write from its scopes, by last four characters only", async () => {
    const appKey = `${"b".repeat(36)}wxyz`;
    const fetch = fakeFetch({
      "GET /api/v1/validate": { body: { valid: true } },
      "GET /api/v2/current_user/application_keys": {
        body: {
          data: [
            {
              attributes: {
                last4: "wxyz",
                name: "agent",
                scopes: ["monitors_read", "monitors_write", "logs_read_data"],
              },
            },
          ],
        },
      },
      "GET /api/v1/monitor/search": {
        body: {},
        headers: { "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "998", "x-ratelimit-name": "monitor_search" },
      },
    });
    const { stdout } = await run(
      ["doctor"],
      makeRuntime({ env: { DD_API_KEY: "a".repeat(32), DD_APP_KEY: appKey }, fetch }),
    );
    expect(stdout).toContain('could_write: "yes - write scopes: monitors_write"');
    expect(stdout).toContain("monitors,monitor_search,998,1000");
  });

  it("classifies read scopes outside the _read suffix and leaves unrecognized scopes unknown", async () => {
    const appKey = "c".repeat(36) + "wxyz";
    const doctor = async (scopes: string[]) => {
      const fetch = fakeFetch({
        "GET /api/v1/validate": { body: { valid: true } },
        "GET /api/v2/current_user/application_keys": { body: { data: [{ attributes: { last4: "wxyz", scopes } }] } },
      });
      const { stdout } = await run(
        ["doctor"],
        makeRuntime({ env: { DD_API_KEY: "a".repeat(32), DD_APP_KEY: appKey }, fetch }),
      );
      return stdout;
    };
    const readOnly = [
      "monitors_read",
      "logs_read_index_data",
      "logs_read_archives",
      "logs_live_tail",
      "timeseries_query",
    ];
    expect(await doctor(readOnly)).toContain(`could_write: "no - every scope is read-only (${readOnly.join(", ")})"`);
    expect(await doctor(["monitors_read", "billing_thing"])).toContain(
      'could_write: "unknown - unrecognized scopes: billing_thing"',
    );
    expect(await doctor(["logs_read_data", "monitors_downtime"])).toContain(
      'could_write: "yes - write scopes: monitors_downtime"',
    );
  });
});

describe("flag hygiene", () => {
  it("rejects unknown flags with exit 2 before any credential lookup", async () => {
    const fetch = fakeFetch({});
    const { stdout, exitCode } = await run(["hosts", "list", "--watch"], makeRuntime({ fetch }));
    expect(exitCode).toBe(2);
    expect(stdout).toContain("never streams");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects flags before the command", async () => {
    const { exitCode } = await run(["--org", "prod", "monitors"], makeRuntime());
    expect(exitCode).toBe(2);
  });

  it("serves per-command help without credentials", async () => {
    const { stdout, exitCode } = await run(["monitors", "--help"], makeRuntime());
    expect(exitCode).toBe(0);
    expect(stdout).toContain("flags{monitors search}:");
    expect(stdout).toContain("flags{target}:");
  });
});

describe("review hardening", () => {
  it("labels a 1000-event v1 response as a lower bound", async () => {
    const events = Array.from({ length: 1000 }, (_, i) => ({ id: i, title: `e${i}`, date_happened: 1793228000 - i }));
    const fetch = fakeFetch({ "GET /api/v1/events": { body: { events } } });
    const { stdout } = await run(["events", "list"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain("50 of at least 1000 in window");
    expect(stdout).toContain("More events may exist");
  });

  it("counts SLOs with total_filtered_count when a filter is applied", async () => {
    const fetch = fakeFetch({
      "GET /api/v1/slo": {
        body: {
          data: [{ id: "s1", name: "Checkout" }],
          metadata: { page: { total_count: 90, total_filtered_count: 1 } },
        },
      },
    });
    const { stdout } = await run(["slos", "list", "checkout"], makeRuntime({ env: EU, fetch }));
    expect(stdout).toContain("count: 1 of 1 total");
    expect(stdout).not.toContain("--offset");
  });

  it("rejects inherited property names in --fields", async () => {
    for (const field of ["__proto__", "constructor", "valueOf"]) {
      const { stdout, exitCode } = await run(["hosts", "list", "--fields", field], makeRuntime({ env: EU }));
      expect(exitCode, field).toBe(2);
      expect(stdout).toContain("code: VALIDATION_ERROR");
    }
  });
});
