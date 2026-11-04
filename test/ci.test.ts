import { describe, expect, it } from "vitest";
import { ciCommand } from "../src/commands/ci.js";
import { deniedScopes, setupGuide } from "../src/guide.js";
import { createRegistry } from "../src/registry.js";
import { ENV_KEYS, fakeFetch, fixture, makeRuntime, run } from "./helpers.js";

const fixtures = fixture<Record<string, unknown>>("ci-visibility.json");
const env = { ...ENV_KEYS, DD_SITE: "datadoghq.eu" };
const window = ["--from", "2026-10-28T11:00:00Z", "--to", "2026-10-28T12:00:00Z"];
function runtime(kind: "pipelines" | "tests", response = fixtures[kind], counts: unknown = fixtures.total) {
  const fetch = fakeFetch({
    [`POST /api/v2/ci/${kind}/events/search`]: (req) => {
      if (!/AND -?@(ci|test)\.status/.test(JSON.stringify(req.body))) return { body: response };
      if (!response || typeof response !== "object" || !("data" in response) || !Array.isArray(response.data))
        return { body: response };
      const other = JSON.stringify(req.body).includes("AND -@");
      const data = response.data.filter((event) => {
        const failure =
          event &&
          typeof event === "object" &&
          "id" in event &&
          typeof event.id === "string" &&
          event.id.endsWith("-fail");
        return other ? !failure : failure;
      });
      return {
        body: {
          data,
          meta:
            response === fixtures.pipelines
              ? other
                ? { status: "done", page: { after: "fixture-next-page" } }
                : { status: "done" }
              : "meta" in response
                ? response.meta
                : { status: "done" },
        },
      };
    },
    [`POST /api/v2/ci/${kind}/analytics/aggregate`]: Array.isArray(counts) ? counts : { body: counts },
  });
  return { fetch, rt: makeRuntime({ env, fetch }) };
}

describe("CI Visibility", () => {
  it("renders recent pipeline runs failures first, with duration, branch, provider, totals and fixed-window pagination", async () => {
    const { rt, fetch } = runtime("pipelines");
    const out = await run(["ci", "pipelines", ...window, "--limit", "2"], rt);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.indexOf("pipeline-fail")).toBeLessThan(out.stdout.indexOf("pipeline-pass"));
    expect(out.stdout).toContain("45,fix-ci,gitlab");
    expect(out.stdout).toContain("2 of 3 total events");
    expect(out.stdout).toContain("--cursor");
    expect(out.stdout).toContain("fixture-next-page");
    expect(out.stdout).toContain("--site");
    expect(out.stdout).not.toContain("hidden-fixture");
    expect(out.stdout).toContain("redacted:");
    expect(fetch.calls[0]?.body).toMatchObject({
      filter: {
        query: "(ci_level:pipeline AND (*)) AND @ci.status:(error OR failed OR fail OR canceled)",
        from: "2026-10-28T11:00:00Z",
        to: "2026-10-28T12:00:00Z",
      },
      page: { limit: 2 },
      sort: "-timestamp",
    });
    expect(await run(["ci", "pipelines", ...window, "--limit", "2"], rt)).toEqual(out);
  });

  it("keeps failures ahead of newer successes across multiple pages", async () => {
    const event = (id: string, status: string) => ({ id, attributes: { attributes: { "ci.status": status } } });
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": [
        { body: { data: [event("older-failure", "error")], meta: { page: { after: "failure-token" } } } },
        { body: { data: [event("oldest-failure", "error")] } },
        { body: { data: [event("newest-success", "success")] } },
      ],
      "POST /api/v2/ci/pipelines/analytics/aggregate": { body: fixtures.total },
    });
    const rt = makeRuntime({ env, fetch });
    const first = await ciCommand(["pipelines", "--limit", "1", ...window], rt);
    expect(first.pipelines).toMatchObject([{ id: "older-failure" }]);
    expect(JSON.stringify(first.help)).toContain("failed:failure-token");
    const next = await ciCommand(["pipelines", "--limit", "2", "--cursor", "failed:failure-token", ...window], rt);
    expect(next.pipelines).toMatchObject([{ id: "oldest-failure" }, { id: "newest-success" }]);
    expect(fetch.calls[2]?.body).toMatchObject({ page: { cursor: "failure-token" } });
    expect(JSON.stringify(fetch.calls[3]?.body)).toContain("AND -@ci.status");
  });

  it("prioritizes canceled pipeline runs over successes across pagination partitions", async () => {
    const event = (id: string, status: string) => ({ id, attributes: { attributes: { "ci.status": status } } });
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": [
        { body: { data: [event("canceled-run", "canceled")] } },
        { body: { data: [event("successful-run", "success")] } },
      ],
      "POST /api/v2/ci/pipelines/analytics/aggregate": { body: fixtures.total },
    });
    const rt = makeRuntime({ env, fetch });
    const result = await ciCommand(["pipelines", "--limit", "2", ...window], rt);
    expect(result.pipelines).toMatchObject([{ id: "canceled-run" }, { id: "successful-run" }]);
    expect(fetch.calls[0]?.body).toMatchObject({
      filter: { query: "(ci_level:pipeline AND (*)) AND @ci.status:(error OR failed OR fail OR canceled)" },
    });
    expect(JSON.stringify(fetch.calls[1]?.body)).toContain("AND -@ci.status");
  });

  it("passes the cursor to the supported search page without following links", async () => {
    const { rt, fetch } = runtime("pipelines", fixtures.pipeline_next);
    const out = await ciCommand(["pipelines", ...window, "--cursor", "other:fixture-next-page"], rt);
    expect(out.count).toBe("1 of 3 total events");
    expect(fetch.calls[0]?.body).toMatchObject({ page: { cursor: "fixture-next-page" } });
  });

  it("includes passing flaky tests and counts failures over the full query/window, separating same-name suites", async () => {
    const { rt, fetch } = runtime("tests", fixtures.tests, [{ body: fixtures.total }, { body: fixtures.failures }]);
    const result = await ciCommand(
      ["tests", ...window, "--query", "@git.branch:main", "--fields", "suite,service"],
      rt,
    );
    expect(result.tests).toEqual([
      { id: "test-fail", name: "checkout", status: "fail", flaky: false, failures: 12, suite: "unit", service: "web" },
      {
        id: "test-flaky",
        name: "checkout",
        status: "pass",
        flaky: true,
        failures: 2,
        suite: "browser",
        service: "web",
      },
    ]);
    expect(fetch.calls[0]?.body).toMatchObject({
      filter: {
        query:
          "((test_level:test AND (@git.branch:main)) AND (@test.status:fail OR @test.is_flaky:true)) AND @test.status:fail",
      },
    });
    expect(fetch.calls[3]?.body).toMatchObject({
      group_by: [
        { facet: "@test.name", limit: 20 },
        { facet: "@test.suite", limit: 20 },
        { facet: "@test.service", limit: 20 },
      ],
    });
    expect(JSON.stringify(fetch.calls[3]?.body)).toContain("@test.status:fail");
    expect(result.redacted).toBeDefined();
  });

  it.each(["pipelines", "tests"] as const)(
    "states an empty %s org only after a successful unfiltered count",
    async (kind) => {
      const { rt } = runtime(kind, fixtures.empty, fixtures.zero);
      const out = await run(["ci", kind, ...window], rt);
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain("No CI Visibility data for this org in the time window");
      expect(out.stdout).toContain("total: 0");
    },
  );

  it("distinguishes no failing/flaky matches from no CI data", async () => {
    const { rt } = runtime("tests", fixtures.empty, [{ body: fixtures.zero }, { body: fixtures.total }]);
    const out = await run(["ci", "tests"], rt);
    expect(out.stdout).toContain("0 matching events (CI Visibility data exists)");
    expect(out.stdout).not.toContain("No CI Visibility data");
  });

  it("views exact IDs across pages, defaults to pipelines, and redacts even --full", async () => {
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": [{ body: fixtures.pipelines }, { body: fixtures.pipeline_next }],
    });
    const rt = makeRuntime({ env, fetch });
    const out = await run(["ci", "view", "pipeline-next", ...window], rt);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("pipeline-next");
    expect(fetch.calls[1]?.body).toMatchObject({ page: { cursor: "fixture-next-page", limit: 100 } });
    const tests = runtime("tests");
    const detail = await run(["ci", "view", "test-fail", "--kind", "tests", "--full", ...window], tests.rt);
    expect(detail.exitCode).toBe(0);
    expect(detail.stdout).toContain("assertion failed");
    expect(detail.stdout).not.toContain("hidden-test-secret");
  });

  it("does not claim not-found after a bounded incomplete scan", async () => {
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": Array.from({ length: 10 }, (_, page) => ({
        body: { data: [], meta: { page: { after: `page-${page + 1}` } } },
      })),
    });
    const rt = makeRuntime({ env, fetch });
    const out = await run(["ci", "view", "absent"], rt);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("SEARCH_LIMIT");
    expect(fetch.calls).toHaveLength(10);
  });

  it("rejects a stalled view cursor after two requests, not ten repeated requests", async () => {
    const { rt, fetch } = runtime("pipelines");
    const out = await run(["ci", "view", "absent"], rt);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("UPSTREAM_ERROR");
    expect(out.stdout).toContain("cursor that did not advance");
    expect(fetch.calls).toHaveLength(2);
  });

  it("rejects a stalled list cursor before returning a duplicate page", async () => {
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": { body: { data: [], meta: { page: { after: "stalled" } } } },
    });
    const out = await run(["ci", "pipelines", "--cursor", "failed:stalled"], makeRuntime({ env, fetch }));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("UPSTREAM_ERROR");
    expect(fetch.calls).toHaveLength(1);
  });

  it("reports not-found only after exhausting results", async () => {
    const { rt } = runtime("tests", fixtures.empty);
    const out = await run(["ci", "view", "absent", "--kind", "tests"], rt);
    expect(out.stdout).toContain("NOT_FOUND");
  });

  it.each([
    [403, "forbidden", "FORBIDDEN", "ci_visibility_read"],
    [403, "missing_scope", "FORBIDDEN", "ci_visibility_read"],
    [401, "forbidden", "AUTH_REQUIRED", "credentials"],
    [429, "rate_limited", "RATE_LIMITED", "Retry after 60s"],
  ])("keeps HTTP %i distinct from no-data", async (status, response, code, hint) => {
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": {
        status: Number(status),
        body: fixtures[response],
        headers: { "x-ratelimit-reset": "60" },
      },
    });
    const out = await run(["ci", "pipelines"], makeRuntime({ env, fetch }));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain(code);
    expect(out.stdout).toContain(hint);
    expect(out.stdout).not.toContain("No CI Visibility data");
  });

  it("names test scopes even for generic forbidden responses", async () => {
    const fetch = fakeFetch({ "POST /api/v2/ci/tests/events/search": { status: 403, body: fixtures.forbidden } });
    expect((await run(["ci", "tests"], makeRuntime({ env, fetch }))).stdout).toContain("test_optimization_read");
  });

  it("retries short read rate limits with the identical request body", async () => {
    const fetch = fakeFetch({
      "POST /api/v2/ci/pipelines/events/search": [
        { status: 429, body: fixtures.rate_limited, headers: { "x-ratelimit-reset": "1" } },
        { body: fixtures.pipeline_next },
      ],
      "POST /api/v2/ci/pipelines/analytics/aggregate": { body: fixtures.total },
    });
    expect((await run(["ci", "pipelines", ...window], makeRuntime({ env, fetch }))).exitCode).toBe(0);
    expect(fetch.calls[0]?.body).toEqual(fetch.calls[1]?.body);
  });

  it("counts missing identity facets without mixing them with other suites and escapes query values", async () => {
    const events = {
      data: [
        {
          id: "quoted",
          attributes: { attributes: { "test.name": 'a"b\\c', "test.status": "pass", "test.is_flaky": true } },
        },
      ],
    };
    const { rt, fetch } = runtime("tests", events, [{ body: fixtures.total }, { body: { data: { buckets: [] } } }]);
    const result = await ciCommand(["tests", ...window], rt);
    expect(result.tests).toEqual([{ id: "quoted", name: 'a"b\\c', status: "pass", flaky: true, failures: 0 }]);
    const body = JSON.stringify(fetch.calls[3]?.body);
    expect(body).toContain("-@test.suite:*");
    expect(body).toContain("-@test.service:*");
  });

  it.each([{}, { data: {} }])("rejects malformed successful events rather than claiming no data", async (response) => {
    const { rt } = runtime("tests", response);
    const out = await run(["ci", "tests"], rt);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("UPSTREAM_ERROR");
  });

  it("rejects missing aggregate counts rather than claiming no data", async () => {
    const { rt } = runtime("tests", fixtures.empty, { data: { buckets: [{ computes: {} }] } });
    const out = await run(["ci", "tests"], rt);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("UPSTREAM_ERROR");
  });

  it("never reports a definitive empty state for partial results", async () => {
    const { rt } = runtime("tests", { data: [], meta: { status: "timeout" } });
    const out = await run(["ci", "tests"], rt);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("partial CI Visibility");
  });

  it.each([
    ["pipelines", "--limt", "2"],
    ["tests", "--limit", "21"],
    ["tests", "--fields", "bogus"],
    ["view", "id", "--kind", "bogus"],
  ])("validates %j before auth or HTTP", async (...args) => {
    const fetch = fakeFetch({});
    expect((await run(["ci", ...args], makeRuntime({ fetch }))).exitCode).toBe(2);
    expect(fetch.calls).toHaveLength(0);
  });

  it("keeps key/PAT CI scopes minimal while preserving the tests-only alternative and OAuth exception", () => {
    const guide = setupGuide("datadoghq.eu");
    expect(guide.data.read_scopes).toContain("ci_visibility_read");
    expect(guide.data.read_scopes).not.toContain("test_optimization_read");
    expect(guide.data.oauth_read_scopes).toContain("ci_visibility_read");
    expect(guide.data.oauth_read_scopes).toContain("test_optimization_read");
    expect(guide.steps.find((step) => step.startsWith("A2."))).toContain("test_optimization_read");
    expect(guide.data.scopes).toContainEqual(
      expect.objectContaining({
        domain: "ci",
        scopes: "ci_visibility_read",
        note: expect.stringContaining("tests-only alternative: test_optimization_read"),
      }),
    );
    expect(deniedScopes(["ci"])).toBe("ci_visibility_read (ci)");
  });

  it.each([
    [["auth", "status"], 200],
    [["auth", "status"], 403],
    [["doctor"], 200],
    [["doctor"], 403],
  ] as const)("reports CI access through %j with response %i", async (args, status) => {
    const fetch = fakeFetch({
      "GET /api/v1/validate": { body: { valid: true } },
      "GET /api/v2/ci/pipelines/events": { status, body: status === 200 ? fixtures.empty : fixtures.forbidden },
      ...(status === 403 ? { "GET /api/v2/ci/tests/events": { status, body: fixtures.forbidden } } : {}),
    });
    const out = await run([...args], makeRuntime({ env, fetch }));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(status === 200 ? "ci,yes,ok" : "ci,no,FORBIDDEN");
    if (status === 403) expect(out.stdout).toContain("ci_visibility_read (ci)");
    const calls = fetch.calls.filter((call) => call.url.pathname === "/api/v2/ci/pipelines/events");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.searchParams.get("page[limit]")).toBe("1");
    expect(calls[0]?.url.searchParams.get("filter[from]")).toBe("2026-10-28T11:59:00Z");
    expect(calls[0]?.url.searchParams.get("filter[to]")).toBe("2026-10-28T12:00:00Z");
  });

  it("exposes all six documented reads via api but refuses ingestion and other verbs", async () => {
    const registry = createRegistry();
    for (const kind of ["pipelines", "tests"]) {
      for (const [method, suffix] of [
        ["GET", "events"],
        ["POST", "events/search"],
        ["POST", "analytics/aggregate"],
      ]) {
        const path = `/api/v2/ci/${kind}/${suffix}`;
        const match = registry.match(method ?? "", path);
        expect(match.kind).toBe("allowed");
        if (match.kind === "allowed") expect(match.operation.access).toBe("read");
        const fetch = fakeFetch({ [`${method} ${path}`]: { body: fixtures.empty } });
        const rt = makeRuntime({ env, fetch, stdin: { isTTY: false, text: "{}" } });
        const args = ["api", method ?? "", path, ...(method === "POST" ? ["--body-file", "-"] : [])];
        expect((await run(args, rt)).exitCode).toBe(0);
        expect(fetch.calls).toHaveLength(1);
        expect(registry.match("DELETE", path).kind).not.toBe("allowed");
      }
    }
    expect(registry.match("POST", "/api/v2/ci/pipeline").kind).not.toBe("allowed");
  });
});
