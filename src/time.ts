import { AxiError } from "axi-sdk-js";

/**
 * One time grammar for every command, normalized to epoch milliseconds.
 * Endpoints disagree on units (metrics v1 and SLO history want seconds,
 * v2 search APIs want milliseconds), so callers convert from `Window` at the
 * request boundary and every result echoes the absolute UTC window.
 *
 * Accepted forms: `15m`, `1h`, `7d`, `2w` (ago), `now`, `now-1h`, RFC3339 /
 * ISO 8601 with a zone, 10-digit epoch seconds, 13-digit epoch milliseconds.
 * Anything else, including zone-less dates, is ambiguous and rejected.
 */

export interface Window {
  fromMs: number;
  toMs: number;
}

export const DEFAULT_WINDOW = "1h";

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const GRAMMAR_HINT =
  "Use 15m, 1h, 7d, now-1h, an RFC3339 time with a zone (2026-10-28T12:00:00Z), or epoch seconds/milliseconds";

export function parseTime(input: string, flag: string, nowMs: number): number {
  const raw = input.trim();

  if (raw === "now") {
    return nowMs;
  }

  const relative = /^(?:now-)?(\d+)([smhdw])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2] as string] as number;
    return nowMs - amount * unit;
  }

  if (/^\d{10}$/.test(raw)) {
    return Number(raw) * 1000;
  }
  if (/^\d{13}$/.test(raw)) {
    return Number(raw);
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }

  throw new AxiError(`Ambiguous or invalid time for ${flag}: ${input}`, "VALIDATION_ERROR", [GRAMMAR_HINT]);
}

export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  nowMs: number,
  defaultFrom = DEFAULT_WINDOW,
): Window {
  // Relative times resolve against whole seconds so the echoed window stays readable.
  const now = Math.floor(nowMs / 1000) * 1000;
  const toMs = to === undefined ? now : parseTime(to, "--to", now);
  const fromMs = parseTime(from ?? defaultFrom, "--from", now);

  if (fromMs >= toMs) {
    throw new AxiError("--from must be earlier than --to", "VALIDATION_ERROR", [
      "Pass e.g. `--from 1h` (one hour ago) and omit `--to` for now",
    ]);
  }
  if (toMs > now + 60_000) {
    throw new AxiError("--to is in the future", "VALIDATION_ERROR", ["Omit `--to` to end the window now"]);
  }

  return { fromMs, toMs };
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** `2026-10-28T11:00:00Z..2026-10-28T12:00:00Z` */
export function formatWindow(window: Window): string {
  return `${isoUtc(window.fromMs)}..${isoUtc(window.toMs)}`;
}

/** Flags that reproduce this exact window in a follow-up command. */
export function windowFlags(window: Window): string {
  return `--from ${isoUtc(window.fromMs)} --to ${isoUtc(window.toMs)}`;
}

export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}
