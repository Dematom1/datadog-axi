import { AxiError } from "axi-sdk-js";

/**
 * Strict, single-pass flag parser shared by every command.
 *
 * Every subcommand declares its own flags. Unknown flags, repeated
 * single-value flags, missing or empty values and extra positionals are all
 * rejected as `VALIDATION_ERROR` (exit 2) before any credential or network
 * access, and the error lists the subcommand's valid flags.
 */

export type FlagKind = "string" | "boolean" | "list";

export interface FlagSpec {
  kind: FlagKind;
  /** Placeholder shown in help, e.g. `<site>`. */
  value?: string;
  description: string;
}

export interface CommandSpec {
  /** Display name used in errors, e.g. `logs search`. */
  name: string;
  flags: Record<string, FlagSpec>;
  /** Positional argument names in order; a trailing `?` marks optional. */
  positionals?: string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

/** Flags carried over from other CLIs that get a targeted correction. */
const RENAMED_FLAGS: Record<string, string> = {
  "--context": "datadog-axi uses Datadog's term: pass `--org <name>` to select a stored org",
  "--state": "use `--status` (Datadog's monitor status facet), e.g. `--status alert,warn`",
  "--json": "output is TOON only; there is no JSON mode",
  "--output": "output is TOON only; there is no output-format flag",
  "-o": "output is TOON only; there is no output-format flag",
  "--follow": "datadog-axi never streams; re-run the command with a newer `--from`",
  "-f": "datadog-axi never streams; re-run the command with a newer `--from`",
  "--tail": "datadog-axi never streams; use `--limit` and `--from`",
  "--watch": "datadog-axi never streams; re-run the command to refresh",
  "--yes": "datadog-axi v1 is read-only and never prompts; there is nothing to confirm",
  "-y": "datadog-axi v1 is read-only and never prompts; there is nothing to confirm",
  "--confirm": "datadog-axi v1 is read-only; writes are on the roadmap (see ROADMAP.md)",
  "--apply": "datadog-axi v1 is read-only; writes are on the roadmap (see ROADMAP.md)",
  "--reveal": "redaction has no reveal flag; sensitive values are never printed",
  "--api-key":
    "secrets are never accepted in argv; pipe them to `auth login --org <name> --site <site> --api-key-stdin`",
  "--app-key":
    "secrets are never accepted in argv; pipe them to `auth login --org <name> --site <site> --api-key-stdin`",
  "--tags-query": "use `--tag <tag>` (one tag)",
};

const FLAG_SHAPE = /^(--[a-zA-Z][\w-]*(=.*)?|-[a-zA-Z])$/s;

export function parseArgs(spec: CommandSpec, args: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;

    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    // A Datadog exclusion query such as `-status:info` is a positional, not a
    // flag; only `--name`, `--name=value` and `-x` shapes are parsed as flags.
    if (!FLAG_SHAPE.test(arg)) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;
    const flag = spec.flags[name];

    if (!flag) {
      const misplaced = misplacedValueHint(spec, args, i, name);
      throw misplaced
        ? new AxiError(`Unknown flag ${name} for \`${spec.name}\``, "VALIDATION_ERROR", [
            misplaced,
            validFlagsHint(spec),
          ])
        : unknownFlagError(spec, name);
    }

    if (flag.kind === "boolean") {
      if (inlineValue !== undefined) {
        throw new AxiError(`${name} does not take a value`, "VALIDATION_ERROR", [`Pass \`${name}\` on its own`]);
      }
      if (flags[name] !== undefined) {
        throw repeatedFlagError(spec, name);
      }
      flags[name] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new AxiError(`${name} requires a value`, "VALIDATION_ERROR", [
          `Pass \`${name} ${flag.value ?? "<value>"}\``,
        ]);
      }
      value = next;
      i++;
    }

    if (value.trim() === "") {
      throw new AxiError(`${name} must not be empty`, "VALIDATION_ERROR", [
        `Pass \`${name} ${flag.value ?? "<value>"}\``,
      ]);
    }

    if (flag.kind === "list") {
      const current = (flags[name] as string[] | undefined) ?? [];
      current.push(value);
      flags[name] = current;
    } else {
      if (flags[name] !== undefined) {
        throw repeatedFlagError(spec, name);
      }
      flags[name] = value;
    }
  }

  const declared = spec.positionals ?? [];
  const required = declared.filter((p) => !p.endsWith("?")).length;
  if (positionals.length > declared.length) {
    const extra = positionals.slice(declared.length);
    throw new AxiError(
      `Unexpected argument${extra.length > 1 ? "s" : ""} for \`${spec.name}\`: ${extra.join(" ")}`,
      "VALIDATION_ERROR",
      [
        unexpectedArgumentHint(spec, args, positionals) ?? usageLine(spec),
        'Quote a query that contains spaces, e.g. "service:web status:error"',
      ],
    );
  }
  if (positionals.length < required) {
    const missing = declared[positionals.length] as string;
    throw new AxiError(`Missing required argument ${missing} for \`${spec.name}\``, "VALIDATION_ERROR", [
      usageLine(spec),
    ]);
  }

  return { positionals, flags };
}

export function usageLine(spec: CommandSpec): string {
  const pos = (spec.positionals ?? []).map((p) => (p.endsWith("?") ? `[${p.slice(0, -1)}]` : p)).join(" ");
  return `Usage: datadog-axi ${spec.name}${pos ? ` ${pos}` : ""} [flags]`;
}

function validFlagsHint(spec: CommandSpec): string {
  const names = Object.keys(spec.flags);
  return names.length > 0
    ? `Valid flags for \`${spec.name}\`: ${names.join(", ")} (--help always allowed)`
    : `\`${spec.name}\` takes no flags (--help always allowed)`;
}

function misplacedValueHint(spec: CommandSpec, args: string[], index: number, name: string): string | undefined {
  const value = name.slice(2);
  const site = spec.flags["--site"];
  if (site && site.kind !== "boolean" && !hasSiteFlag(args) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
    return `Did you mean: ${commandLine(spec, [...args.slice(0, index), "--site", value, ...args.slice(index + 1)])}`;
  }
  const valueFlags = Object.entries(spec.flags).filter(([, flag]) => flag.kind !== "boolean");
  const exact = valueFlags.find(([flag]) => flag.slice(2) === value);
  const close = exact ?? valueFlags.find(([flag]) => editDistanceAtMostOne(flag.slice(2), value));
  if (close && /^[\w.-]+$/.test(value)) {
    return `Did you mean: ${commandLine(
      spec,
      args.map((arg, i) => (i === index ? close[0] : arg)),
    )}`;
  }
  if (/^[a-z][\w-]*$/i.test(value)) {
    const bare = valueFlags.find(([flag]) => flag.slice(2) === value);
    if (bare)
      return `Did you mean: ${commandLine(
        spec,
        args.map((arg, i) => (i === index ? bare[0] : arg)),
      )}`;
  }
  return undefined;
}

function unexpectedArgumentHint(spec: CommandSpec, args: string[], positionals: string[]): string | undefined {
  const declaredCount = spec.positionals?.length ?? 0;
  const extra = positionals.slice(declaredCount);
  const siteValue = extra[1]?.replace(/^--/, "");
  if (
    extra.length === 2 &&
    extra[0] === "site" &&
    siteValue !== undefined &&
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(siteValue) &&
    spec.flags["--site"] &&
    !hasSiteFlag(args)
  ) {
    const siteIndex = args.lastIndexOf("site");
    return `Did you mean: ${commandLine(spec, [...args.slice(0, siteIndex), "--site", siteValue, ...args.slice(siteIndex + 2)])}`;
  }
  if (extra.length !== 1) return undefined;
  const bare = extra[0];
  if (bare === undefined) return undefined;
  const flag = Object.keys(spec.flags).find((name) => name.slice(2) === bare);
  if (flag) {
    const index = args.lastIndexOf(bare);
    return `Did you mean: ${commandLine(spec, [...args.slice(0, index), flag, ...args.slice(index + 1)])}`;
  }
  const valueFlag = Object.entries(spec.flags).find(([name, def]) => def.kind !== "boolean" && name === "--site");
  if (valueFlag && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(bare)) {
    const index = args.lastIndexOf(bare);
    return `Did you mean: ${commandLine(spec, [...args.slice(0, index), valueFlag[0], bare, ...args.slice(index + 1)])}`;
  }
  const misspelled = Object.keys(spec.flags).find((name) => editDistanceAtMostOne(name.slice(2), bare));
  if (!misspelled) return undefined;
  const index = args.lastIndexOf(bare);
  return `Did you mean: ${commandLine(spec, [...args.slice(0, index), misspelled, ...args.slice(index + 1)])}`;
}

function hasSiteFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--site" || arg.startsWith("--site="));
}

function commandLine(spec: CommandSpec, args: string[]): string {
  const rendered = args.map((arg) =>
    /^[\w./:=,@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`,
  );
  return `Run \`datadog-axi ${spec.name}${rendered.length ? ` ${rendered.join(" ")}` : ""}\``;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function unknownFlagError(spec: CommandSpec, name: string): AxiError {
  const renamed = RENAMED_FLAGS[name];
  if (renamed) {
    return new AxiError(`Unknown flag ${name} for \`${spec.name}\``, "VALIDATION_ERROR", [
      renamed,
      validFlagsHint(spec),
    ]);
  }
  const hints = [validFlagsHint(spec)];
  if (!name.startsWith("--")) {
    hints.push("To pass a query that starts with `-`, put it after `--`");
  }
  return new AxiError(`Unknown flag ${name} for \`${spec.name}\``, "VALIDATION_ERROR", hints);
}

function repeatedFlagError(spec: CommandSpec, name: string): AxiError {
  return new AxiError(`${name} was given more than once for \`${spec.name}\``, "VALIDATION_ERROR", [
    `Pass \`${name}\` once`,
  ]);
}

export function str(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function bool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

/** A repeatable flag; each value may also be comma separated. A given flag must carry at least one value. */
export function list(parsed: ParsedArgs, name: string): string[] {
  const v = parsed.flags[name];
  if (!Array.isArray(v)) {
    return [];
  }
  const values = v
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values.length === 0) {
    throw new AxiError(`${name} needs at least one value`, "VALIDATION_ERROR", [
      `Pass a value to \`${name}\`, or drop the flag`,
    ]);
  }
  return values;
}

export function intFlag(
  parsed: ParsedArgs,
  name: string,
  options: { default: number; min?: number; max: number },
): number {
  const raw = str(parsed, name);
  if (raw === undefined) {
    return options.default;
  }
  if (!/^\d+$/.test(raw)) {
    throw new AxiError(`${name} must be a whole number`, "VALIDATION_ERROR", [`Pass \`${name} ${options.default}\``]);
  }
  const value = Number(raw);
  const min = options.min ?? 1;
  if (value < min || value > options.max) {
    throw new AxiError(`${name} must be between ${min} and ${options.max}`, "VALIDATION_ERROR", [
      `Pass \`${name} ${Math.min(options.max, Math.max(min, value))}\``,
    ]);
  }
  return value;
}

/** Flags every networked command accepts to pick its target. */
export const TARGET_FLAGS: Record<string, FlagSpec> = {
  "--org": {
    kind: "string",
    value: "<name>",
    description: "Stored org to use (default: env credentials, then the current org)",
  },
  "--site": {
    kind: "string",
    value: "<site>",
    description: "Datadog site; must match the org's pinned site",
  },
};

export const WINDOW_FLAGS: Record<string, FlagSpec> = {
  "--from": {
    kind: "string",
    value: "<time>",
    description: "Window start: 15m, 1h, 7d, now-1h, RFC3339, or epoch s/ms (default: 1h ago)",
  },
  "--to": {
    kind: "string",
    value: "<time>",
    description: "Window end, same grammar (default: now)",
  },
};
