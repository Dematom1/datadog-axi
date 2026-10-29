/**
 * OS keychain access, one entry per stored org.
 *
 * The native keyring module is imported lazily, so `ctx`, the session hook,
 * `--help` and `--version` never load it. Tests inject an in-memory keychain
 * and never touch the real one.
 */

export interface StoredKeys {
  apiKey: string;
  appKey: string;
}

export interface Keychain {
  get(org: string): Promise<StoredKeys | null>;
  set(org: string, keys: StoredKeys): Promise<void>;
  delete(org: string): Promise<boolean>;
}

const SERVICE = "datadog-axi";

export function osKeychain(): Keychain {
  const entry = async (org: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(SERVICE, org);
  };

  return {
    async get(org) {
      const raw = await (await entry(org)).getPassword();
      if (raw === null || raw === undefined) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<StoredKeys>;
        if (typeof parsed.apiKey === "string" && typeof parsed.appKey === "string") {
          return { apiKey: parsed.apiKey, appKey: parsed.appKey };
        }
      } catch {
        // fall through: an unreadable entry is treated as missing
      }
      return null;
    },
    async set(org, keys) {
      await (await entry(org)).setPassword(JSON.stringify(keys));
    },
    async delete(org) {
      return (await entry(org)).deletePassword();
    },
  };
}

export function memoryKeychain(initial: Record<string, StoredKeys> = {}): Keychain {
  const store = new Map(Object.entries(initial));
  return {
    async get(org) {
      return store.get(org) ?? null;
    },
    async set(org, keys) {
      store.set(org, keys);
    },
    async delete(org) {
      return store.delete(org);
    },
  };
}
