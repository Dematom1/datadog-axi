/**
 * Best-effort redaction of sensitive values (S12).
 *
 * Any object value whose key looks sensitive is replaced with `[redacted]`
 * and counted, so output can say how many fields were hidden. There is no
 * reveal flag. Free-text bodies (log messages, span resource names) cannot be
 * covered by key matching; that limit is documented in the README and skill.
 *
 * This runs on every response at the seam, including `api`, so no path can
 * skip it.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)|pwd|secret|token|api[_-]?key|app(lication)?[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|credential|authorization|auth[_-]?header|cookie|session[_-]?id|bearer|signature|x[_-]?api[_-]?key|dd[_-]?api[_-]?key)/i;

/** Keys that match the pattern but only ever hold metadata, never secrets. */
const SAFE_KEYS = new Set([
  "token_count",
  "tokens",
  "password_last_changed",
  "has_password",
  "api_key_name",
  "application_key_name",
  "credentials_type",
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !SAFE_KEYS.has(key.toLowerCase());
}

export interface RedactionResult<T> {
  value: T;
  redacted: number;
}

export function redact<T>(input: T): RedactionResult<T> {
  let count = 0;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (isSensitiveKey(key) && value !== null && value !== "" && typeof value !== "boolean") {
          out[key] = REDACTED;
          count++;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    }
    if (typeof node === "string") {
      return redactTagString(node, () => count++);
    }
    return node;
  };

  return { value: walk(input) as T, redacted: count };
}

/**
 * Datadog carries a lot of data as `key:value` tag strings. A tag whose key
 * looks sensitive (`api_key:abc`) is redacted the same way an object key is.
 */
function redactTagString(value: string, onRedact: () => void): string {
  const match = /^([A-Za-z0-9_.\-/@]+):(.+)$/s.exec(value);
  if (match && isSensitiveKey(match[1] as string)) {
    onRedact();
    return `${match[1]}:${REDACTED}`;
  }
  return value;
}
