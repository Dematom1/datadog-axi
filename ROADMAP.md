# Roadmap

## Writes

v1 is read-only, but its design is read-first with a small, named set of gated writes. Writes are the next tier. The candidates, in order:

1. `events post`: deploy and change markers. It is the most useful and lowest-risk write.
2. `monitors mute` / `unmute`, scoped and time-bound.
3. `monitors create` / `edit` / `delete`.

Every write goes through the gate that already exists in the seam (`Seam.write` in `src/seam.ts`, covered by the gate tests):

- **Preview by default.** Without the operation's execute flag, nothing is sent. The preview prints the org, site, request and change, plus the exact command to run it.
- **Execute flags in Datadog's own vocabulary.** Each write uses Datadog's verb for its action rather than a generic `--confirm` or `--apply`.
- **Explicit target.** A write needs `--org <name>`, and the write result prints the org and site.
- **Local allowlist.** The org must be listed under `writable` in the config file. The list is empty by default and no command adds to it.
- **Idempotent.** Asking for a state that already exists is an in-band no-op with exit 0. Commands that create something take or derive a deterministic key, so a retried call reports "already exists" instead of duplicating work.

Adding a write means registering an `access: "write"` operation with its `executeFlag` in `WRITE_OPERATIONS`, removing the matching entry from `REFUSALS`, and adding tests for the preview, the gate and idempotency. The registry test that pins `WRITE_OPERATIONS` as empty changes in the same pull request.

## Future list

- **Friendlier filter syntax.** Optional structured filters layered over Datadog's query strings. Queries keep passing through unchanged.
- **DDSQL.** Running DDSQL queries.

## Verification

- **Real verification pass.** One pass against a sandbox org with read-scoped keys confirms the shapes the fixtures assume (see the README's "Not yet verified" list). It then replaces the hand-written fixtures with sanitized recordings. Each real pass is a separate task that the maintainer approves first.

## Distribution

- **AXI catalog.** Submit datadog-axi to the community catalog after v1.
