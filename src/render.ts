import { AxiError } from "axi-sdk-js";
import { list, type ParsedArgs } from "./args.js";

/**
 * Output shaping helpers shared by every command (S10, S11): projection to a
 * few fields per row, truncation with total size, count lines, redaction
 * notes and `help` hints. Commands return plain objects; the SDK encodes TOON.
 */

export type Row = Record<string, string | number | boolean | null>;
export type Extractor<T> = (item: T) => string | number | boolean | null | undefined;

export interface FieldSet<T> {
  all: Record<string, Extractor<T>>;
  defaults: string[];
}

/** Defaults plus any `--fields` extras, validated against the known set. */
export function selectFields<T>(parsed: ParsedArgs, set: FieldSet<T>, command: string): string[] {
  const extra = list(parsed, "--fields");
  const unknown = extra.filter((f) => !(f in set.all));
  if (unknown.length > 0) {
    throw new AxiError(
      `Unknown field${unknown.length > 1 ? "s" : ""} for \`${command}\`: ${unknown.join(", ")}`,
      "VALIDATION_ERROR",
      [`Valid fields: ${Object.keys(set.all).join(", ")}`],
    );
  }
  return [...new Set([...set.defaults, ...extra])];
}

export function project<T>(items: T[], set: FieldSet<T>, fields: string[]): Row[] {
  return items.map((item) => {
    const row: Row = {};
    for (const field of fields) {
      const value = (set.all[field] as Extractor<T>)(item);
      row[field] = value === undefined ? null : value;
    }
    return row;
  });
}

export const LIST_TEXT_LIMIT = 200;
export const DETAIL_TEXT_LIMIT = 1000;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Truncate, appending the total size only when something was cut. */
export function truncate(text: string, limit: number): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, limit)}... (truncated, ${text.length} chars total)`,
    truncated: true,
  };
}

/** Single-line preview for list rows. */
export function oneLine(text: string | undefined | null, limit = LIST_TEXT_LIMIT): string {
  if (!text) {
    return "";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return truncate(flat, limit).text;
}

export function countLine(shown: number, total: number | undefined, noun: string): string {
  if (total === undefined) {
    return `${shown} ${noun}`;
  }
  return `${shown} of ${total} total`;
}

export function redactionNote(count: number): Record<string, string> {
  return count > 0 ? { redacted: `${count} field${count === 1 ? "" : "s"} with sensitive keys hidden` } : {};
}

export function withHelp<T extends Record<string, unknown>>(output: T, hints: string[]): T {
  const filtered = hints.filter((h) => h.length > 0);
  return filtered.length > 0 ? { ...output, help: filtered } : output;
}

export function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `--org` carried forward into follow-up commands when the user named one. */
export function orgSuffix(target: { org: string; explicit: boolean }): string {
  return target.explicit ? ` --org ${target.org}` : "";
}

export function iso(value: unknown): string | null {
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}

export function tagsText(tags: unknown, limit = 6): string {
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }
  const strings = tags.filter((t): t is string => typeof t === "string");
  const shown = strings.slice(0, limit).join(" ");
  return strings.length > limit ? `${shown} (+${strings.length - limit} more)` : shown;
}

/**
 * Reprint the command the agent ran, minus the named flags, so a follow-up
 * hint carries every other filter forward (AXI §9).
 */
export function rebuildCommand(base: string, args: string[], dropFlags: string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (dropFlags.includes(name)) {
      if (!arg.includes("=")) {
        i++;
      }
      continue;
    }
    kept.push(/^[\w@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg));
  }
  return kept.length > 0 ? `${base} ${kept.join(" ")}` : base;
}
