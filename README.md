# datadog-axi

Read-first Datadog for agents. `datadog-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI: it calls the Datadog REST API directly and prints compact [TOON](https://toonformat.dev/) built for agents. That means problems first, a few columns per row, totals, explicit empty states, and next-step hints.

```sh
$ datadog-axi
bin: ~/.local/bin/datadog-axi
description: Read-first Datadog for agents: ...
ctx:
  org: prod
  site: datadoghq.eu (EU1)
  credentials: keychain (stored by auth login)
  writes: none (read-only v1)
  version: 0.1.0
  config: ~/.config/datadog-axi/config.json
monitor_counts:
  Alert: 3
  Warn: 1
  "No Data": 2
  OK: 120
alerting[3]{id,name,status,type}:
  102,Checkout error rate,Alert,query alert
  ...
incidents: 1 active
help[4]:
  Run `datadog-axi monitors --status alert` for every alerting monitor
  ...
```

Not affiliated with or endorsed by Datadog, Inc.

## Status

v1 is read-only. It sends no writes, and write-like requests are refused with a reason. The [roadmap](ROADMAP.md) describes the planned write tier and the future list.

## Install

Requires Node.js 20 or newer.

```sh
npm install -g datadog-axi    # or run on demand: npx -y datadog-axi
```

## Credentials

Credentials are resolved in this order. A secret is never accepted as a flag, never echoed, and never read from another tool's config.

1. `--org <name>`: an org stored in the OS keychain, using the site that org is pinned to.
2. Environment: `DD_ACCESS_TOKEN` (sent as a bearer), or `DD_API_KEY` plus `DD_APP_KEY` (or `DD_APPLICATION_KEY`). The site comes from `--site`, then `DD_SITE`, then `datadoghq.com`. This shows as org `env`.
3. The current stored org.

To store an org, a human pipes both keys on stdin, API key first and application key second. A terminal on stdin is refused.

```sh
printf '%s\n%s\n' "$DD_API_KEY" "$DD_APP_KEY" | datadog-axi auth login --org prod --site datadoghq.eu --api-key-stdin
datadog-axi auth status --org prod   # which domains the key can read
```

Each Datadog site is fully independent, so the same query on the wrong site just returns nothing. A stored org is pinned to one site, and passing a different `--site` with it fails with `WRONG_SITE`. Accepted sites: `datadoghq.com` (US1), `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu` (EU1), `ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, `ddog-gov.com` (US1-FED), `us2.ddog-gov.com` (US2-FED). Region names such as `EU1` work too. Keys are only ever sent to `https://api.<site>`.

## Commands

| Command                                                       | What it shows                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `datadog-axi`                                                 | Live home view: org, site, monitor counts by status, up to 5 alerting or no-data monitors, open incidents           |
| `monitors [search] [<query>]`                                 | Monitor search with `--status`, `--tag`, `--name`; problems first, with status counts and totals                    |
| `monitors view <id>`                                          | Query, message, tags and the non-OK groups                                                                          |
| `logs search "<query>"`                                       | Events (time, service, status, message); `--from`, `--to`, `--index`, `--limit` (20, max 200), `--sort`, `--cursor` |
| `logs aggregate "<query>" [--by <facet>]`                     | Counts, optionally grouped by `status`, `service`, `host` or `@attribute`                                           |
| `logs view <id>`                                              | One event with its attributes                                                                                       |
| `metrics query "<expr>"`                                      | Per-series summary (n, min, avg, max, last); `--points` for raw values                                              |
| `metrics list`, `search <text>`, `view <name>`, `tags <name>` | Names, metadata and volume, tag cardinality                                                                         |
| `traces search "<query>"`                                     | Spans (service, resource, duration, error)                                                                          |
| `traces view <trace_id>`                                      | Summarized span tree                                                                                                |
| `services list`, `view <name>`                                | Ownership, contacts and links from the service catalog                                                              |
| `dashboards list`, `view <id>`                                | Widget titles and queries; the full JSON with `--full`                                                              |
| `incidents list`, `view <id>`                                 | Open incidents by default (`--status active,stable,resolved`)                                                       |
| `events list`, `search "<query>"`                             | Events by `--tags`, `--priority` and `--sources`, or an event query                                                 |
| `hosts list`                                                  | Up and muted state, down hosts first                                                                                |
| `slos list`, `view <id>`, `status <id>`                       | Targets, and the current SLI and error budget                                                                       |
| `downtimes list`                                              | Current downtimes (`--all` includes ended ones)                                                                     |
| `synthetics list`, `view <id>`, `results <id>`                | Tests and their latest results (never triggers a run)                                                               |
| `notebooks list`, `view <id>`                                 | Notebooks, cell by cell                                                                                             |
| `api [GET\|POST] <path>`                                      | Allowlisted read-only endpoints with no dedicated command                                                           |
| `auth login\|status\|list\|logout`                            | Credential management                                                                                               |
| `doctor`                                                      | Key validity, site reachability, readable domains, rate-limit headroom, whether the key could write                 |
| `ctx`                                                         | Offline org, site and credential source                                                                             |
| `setup hooks [--project]`                                     | Agent session hooks                                                                                                 |
| `update`                                                      | Self-update (from axi-sdk-js)                                                                                       |

Run `datadog-axi --help`, or `datadog-axi <command> --help` for one command's flags and examples.

### Conventions

- Flags go after the command. Unknown flags are rejected with exit 2 and the valid flags are listed. Flags carried over from other tools get a targeted hint, for example `--state` points to `--status` and `--context` points to `--org`.
- Flag names follow Datadog's own vocabulary: `--org`, `--site`, `--from`/`--to`, `--index`, `--status`, `--tags`, `--priority`, `--cursor`.
- Time windows accept `15m`, `1h`, `7d`, `now-1h`, RFC3339 with a zone, or epoch seconds/milliseconds. The default is the last hour, and every result echoes the absolute UTC window. Ambiguous input, such as a date with no zone, is a usage error.
- Queries are Datadog query strings and are passed through unchanged. A query that starts with `-` can follow `--`.
- Lists show 3-4 columns. `--fields` adds more, validated against a known set. Long text is truncated with its total size, and `--full` is suggested only when something was cut.
- Zero results state the site, window, query and indexes, give two ways to widen, and are distinct from a permission error.
- Nothing streams or follows. Every request has a timeout, and reads retry a short rate limit or a 502-504 at most twice before failing.

### Errors and exit codes

Errors are printed on stdout as `error`, `code` and `help`. Exit code 0 means success, including an empty result or an alerting monitor (unhealthy state is data, not an error). Exit 1 is an error and exit 2 is a usage error.

| Code                                                     | Meaning                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                                       | Bad flag, argument, time or query (exit 2)                                                           |
| `AUTH_REQUIRED`                                          | No credentials, or Datadog rejected them                                                             |
| `FORBIDDEN`                                              | The key's scopes or user role do not allow the read, naming the missing permission when Datadog does |
| `NOT_FOUND`                                              | The id does not exist on this site or in this window                                                 |
| `RATE_LIMITED`                                           | Datadog's limit was reached; includes the reset time                                                 |
| `SERVER_UNREACHABLE`                                     | Network failure, timeout or 502-504 after retries                                                    |
| `UPSTREAM_ERROR`                                         | Any other Datadog server error                                                                       |
| `REFUSED`                                                | A write, credential or unregistered request                                                          |
| `WRONG_SITE`                                             | `--site` disagrees with the org's pinned site                                                        |
| `CONFIG_INVALID`, `KEYCHAIN_UNAVAILABLE`, `SETUP_FAILED` | Local problems                                                                                       |

## Safety model

- **Read-only by construction.** Every request goes through one HTTP seam (`src/seam.ts`), which accepts only operation ids from the registry (`src/registry.ts`). Each operation is keyed by method, path and body type, not by HTTP verb, because Datadog runs searches as POST and also performs writes as POST. A test fails if any other module calls `fetch` or if source code uses an unregistered operation.
- **Refusal registry.** Known writes and side effects (create, edit, delete, mute, post, trigger, page responders, ingest) and all credential endpoints are refused with a reason and the human alternative. Paths that are neither refused nor allowlisted are refused as unregistered.
- **Write gate, ready for the roadmap.** Write operations are a separate class in the registry, and v1 registers none. Each future write must name its org explicitly, the org must be listed under `writable` in the config file (empty by default, and no command adds to it), and without the operation's execute flag only a preview is printed and nothing is sent.
- **Redaction.** Every response is passed through redaction before any command sees it, including `api`. Values under sensitive-looking keys (`password`, `secret`, `token`, `api_key`, `authorization` and similar) and `key:value` tags with such keys are replaced, and the output reports how many fields were hidden. There is no reveal flag. This is best effort: free text such as a log message is not scanned.
- **Network hygiene.** Keys go only to `https://api.<site>` for a known site. Redirects are never followed. `DATADOG_AXI_API_URL` (for test servers) is accepted only for a loopback host.

## Agent integration

There are two ways to give an agent datadog-axi context, and you only need one.

1. **Session hook (recommended).** `datadog-axi setup hooks` installs a SessionStart hook for Claude Code, Codex and OpenCode, at user scope or with `--project` for this repository. The hook runs `datadog-axi-ctx`, which prints the org, site, credential source and write status from local config only. It makes no keychain read and no network call. Re-running `setup hooks` repairs moved paths.
2. **Skill.** Install the generated skill ([`skills/datadog-axi/SKILL.md`](skills/datadog-axi/SKILL.md)) with `npx skills add Dematom1/datadog-axi --skill datadog-axi`. It loads on demand and runs commands through `npx -y datadog-axi`.

## Configuration

`~/.config/datadog-axi/config.json` (or `$XDG_CONFIG_HOME/datadog-axi/config.json`) holds org names, each org's pinned site, the current org, and the `writable` allowlist. It never holds a secret.

```json
{
  "current": "prod",
  "orgs": { "prod": { "site": "datadoghq.eu" }, "sandbox": { "site": "us5.datadoghq.com" } },
  "writable": []
}
```

## Development

```sh
npm ci
npm run lint && npm run format:check && npm run typecheck
npm test              # builds, then runs unit and end-to-end tests
npm run build:skill   # regenerate skills/datadog-axi/SKILL.md (CI runs check:skill)
```

Tests never reach a real Datadog endpoint, keychain or credential. Unit tests inject a fake `fetch`, an in-memory keychain and a scratch environment. End-to-end tests run the compiled binaries against a local fake server via the loopback-only `DATADOG_AXI_API_URL`. Fixtures in `test/fixtures` are hand-written in the shapes the Datadog API reference documents, not recordings.

### Not yet verified against a real org

The response shapes and some behavior come from Datadog's API documentation. The first real verification pass, against a sandbox org with read-scoped keys, is a separate step that the maintainer approves. It should confirm:

- the monitor search syntax for several statuses (`(status:alert OR status:"no data")`) and the `counts` shape
- that monitor search `sort=status,asc` puts alerting and no-data monitors first across pages (the local severity sort only orders within a page)
- `logs view` through the v1 list API's `startAt`
- how span errors are marked across tracers, and trace-by-id via `trace_id:` search
- incident `state`/`severity` attribute placement, SLO history `error_budget_remaining`, and synthetic result shapes
- scope names behind `doctor`'s write-capability check, rate-limit header names, and permissions for POST-based reads

## License

[MIT](LICENSE)
