<h1 align="center">datadog-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/datadog-axi"><img alt="npm" src="https://img.shields.io/npm/v/datadog-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/datadog-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/datadog-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/datadog-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/datadog-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-Linux-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-Linux-blue?style=flat-square" /></a>
  <a href="https://x.com/dematom1"><img alt="X" src="https://img.shields.io/badge/X-@dematom1-black?style=flat-square" /></a>
</p>

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
incidents: 1 open
help[4]:
  Run `datadog-axi monitors --status alert` for every alerting monitor
  ...
```

Not affiliated with or endorsed by Datadog, Inc.

## Status

v1 is read-only. It sends no writes, and write-like requests are refused with a reason. The [roadmap](ROADMAP.md) describes the planned write tier and the future list.

## Install

Requires Node.js 20.19+ or 22.12+.

```sh
npm install -g datadog-axi    # or run on demand: npx -y datadog-axi
```

## Credentials

Credentials are resolved in this order. A secret is never accepted as a flag, never echoed, and never read from another tool's files: pup's token comes only from pup itself.

1. `--org <name>`: an org stored in the OS keychain, using the site that org is pinned to.
2. Environment: `DD_ACCESS_TOKEN` (sent as a bearer), or `DD_API_KEY` plus `DD_APP_KEY` (or `DD_APPLICATION_KEY`). The site comes from `--site`, then `DD_SITE`, then `datadoghq.com`. This shows as org `env`.
3. The current stored org.
4. [Pup](https://docs.datadoghq.com/cli/), Datadog's CLI, when it is on `PATH` and nothing above is configured. datadog-axi runs `pup auth token` for the current token of pup's browser login, which also refreshes it, and `pup auth status` for its site, session and scopes. The token stays in memory: it is never written to disk, passed in argv or printed. Pup's own variables apply (`DD_SITE`, and `DD_ORG` for a named session), and `--site` is passed to pup as `DD_SITE`. `DATADOG_AXI_PUP=<path>` names the binary, and `DATADOG_AXI_PUP=off` turns this source off. This shows as org `pup`.

`auth status` and `doctor` show which source is in use. For pup they also show the session and expiry, and `doctor` judges write capability from the token's scopes.

### Setting up

`datadog-axi auth guide --site <site> --org <name>` prints the setup steps for that site. It runs offline and never reads the keychain or runs pup. The home view prints the same guide when no credentials are configured, and `AUTH_REQUIRED` errors point to it. Without `--site` it uses `DD_SITE`, then US1.

- **Route A (recommended): pup.** Install it (`brew tap datadog-labs/pack && brew install datadog-labs/pack/pup`, or `npm install -g @datadog/pup`), then log in once in the browser with only the scopes below, for example `pup auth login --site datadoghq.eu --scopes monitors_read,logs_read_data,...`. There is nothing to copy: datadog-axi reads pup's token when it needs it. Pup's access token lasts about an hour and pup refreshes it for 30 days. After that, run `pup auth login` again (`pup auth refresh` forces a refresh). If the token has expired and could not be refreshed, datadog-axi says so and names the command to run.
- **Route B (fallback): an API key and application key** in the OS keychain, which do not expire. The guide links to the key pages on your site and prints the `auth login` command below.

Select only the read scopes datadog-axi needs, for the pup login or the application key:

| Domain                        | Scopes                                   |
| ----------------------------- | ---------------------------------------- |
| monitors (and the home view)  | `monitors_read`                          |
| logs                          | `logs_read_data`, `logs_read_index_data` |
| metrics                       | `metrics_read`, `timeseries_query`       |
| traces                        | `apm_read`                               |
| services                      | `apm_service_catalog_read`               |
| dashboards                    | `dashboards_read`                        |
| incidents (and the home view) | `incident_read`                          |
| events                        | `events_read`                            |
| hosts                         | `hosts_read`                             |
| slos                          | `slos_read`                              |
| synthetics                    | `synthetics_read`                        |
| notebooks                     | `notebooks_read`                         |
| downtimes (optional)          | `monitors_downtime`                      |

Datadog's downtime list requires `monitors_downtime` (Manage Downtimes), which can also mute monitors. So it is not read-only, and `doctor` reports a key that has it as able to write. Leave it out unless you need `downtimes list`. When a domain is denied, `auth status` and `doctor` name the scopes that would allow it.

Instead of an API key and application key, you can create a [Personal Access Token](https://docs.datadoghq.com/account_management/personal-access-tokens.md) with the same scopes and set it as `DD_ACCESS_TOKEN`. A PAT is a single scoped credential with an expiry. datadog-axi has no browser login of its own: Datadog's OAuth clients for third parties need partner registration, so the browser login is pup's.

### Storing an org

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
| `auth guide\|login\|status\|list\|logout`                     | Credential setup guide (pup login or keys) and credential management                                                |
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

- **Read-only by construction.** Every request goes through one HTTP seam (`src/seam.ts`), which accepts only operation ids from the registry (`src/registry.ts`). Operations are matched by method and path, never by HTTP verb alone, because Datadog runs searches as POST and also performs writes as POST; each POST read also declares the body type it expects. Path parameters of `.` or `..` are rejected, and the seam refuses any built URL whose path no longer matches the operation's template. A test runs every request-capable command against a fake server and fails if any request is not on the allowlist, if the global `fetch` is called, or if a registered read is never reached.
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

## Releasing

The release workflow stages each package version on npm. The `npm-publish` GitHub environment restricts publishing to `main` and `v*` tags, and the npm trusted publisher must use that environment. After the workflow runs, approve each staged version with 2FA by running `npm stage approve <id>` or using [npmjs.com](https://www.npmjs.com/). A staged version is not live on npm until you approve it.

## License

[MIT](LICENSE)
