import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { emptyConfig, loadConfig, saveConfig, type Config } from "../src/config.js";
import { memoryKeychain, type Keychain } from "../src/keychain.js";
import { describeTarget, resolveTarget } from "../src/target.js";
import { ENV_KEYS, makeRuntime } from "./helpers.js";

const CONFIG: Config = {
  current: "prod",
  orgs: { prod: { site: "datadoghq.eu" }, sandbox: { site: "us5.datadoghq.com" } },
  writable: [],
};

const KEYS = { apiKey: "p".repeat(32), appKey: "q".repeat(40) };

/** A keychain that fails the test if it is ever read. */
const forbiddenKeychain: Keychain = {
  get: async () => {
    throw new Error("keychain must not be read");
  },
  set: async () => {
    throw new Error("keychain must not be written");
  },
  delete: async () => {
    throw new Error("keychain must not be written");
  },
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AxiError ? error.code : "NOT_AXI";
  }
  return undefined;
}

describe("target resolution", () => {
  it("an explicit --org wins over environment credentials and uses its pinned site", async () => {
    const target = await resolveTarget({ org: "sandbox" }, ENV_KEYS, CONFIG, memoryKeychain({ sandbox: KEYS }));
    expect(target).toMatchObject({ org: "sandbox", site: "us5.datadoghq.com", source: "keychain", explicit: true });
    expect(target.auth).toEqual({ kind: "keys", ...KEYS });
  });

  it("environment credentials come next, with DD_SITE", async () => {
    const target = await resolveTarget({}, { ...ENV_KEYS, DD_SITE: "datadoghq.eu" }, CONFIG, forbiddenKeychain);
    expect(target).toMatchObject({ org: "env", site: "datadoghq.eu", source: "env", explicit: false });
  });

  it("DD_ACCESS_TOKEN becomes a bearer credential", async () => {
    const target = await resolveTarget({}, { DD_ACCESS_TOKEN: "tok" }, emptyConfig(), forbiddenKeychain);
    expect(target.auth).toEqual({ kind: "bearer", token: "tok" });
  });

  it("accepts DD_APPLICATION_KEY as the application key", async () => {
    const target = await resolveTarget(
      {},
      { DD_API_KEY: "a".repeat(32), DD_APPLICATION_KEY: "c".repeat(40) },
      emptyConfig(),
      forbiddenKeychain,
    );
    expect(target.auth).toEqual({ kind: "keys", apiKey: "a".repeat(32), appKey: "c".repeat(40) });
  });

  it("an API key without an application key is AUTH_REQUIRED", async () => {
    expect(await codeOf(resolveTarget({}, { DD_API_KEY: "a".repeat(32) }, emptyConfig(), forbiddenKeychain))).toBe(
      "AUTH_REQUIRED",
    );
  });

  it("falls back to the current stored org", async () => {
    const target = await resolveTarget({}, {}, CONFIG, memoryKeychain({ prod: KEYS }));
    expect(target).toMatchObject({ org: "prod", site: "datadoghq.eu", explicit: false });
  });

  it("a stored org pins its site: a different --site is WRONG_SITE", async () => {
    expect(await codeOf(resolveTarget({ org: "prod", site: "US1" }, {}, CONFIG, memoryKeychain({ prod: KEYS })))).toBe(
      "WRONG_SITE",
    );
    expect(
      await codeOf(resolveTarget({ org: "prod", site: "EU1" }, {}, CONFIG, memoryKeychain({ prod: KEYS }))),
    ).toBeUndefined();
  });

  it("reports missing orgs, missing keychain entries and no credentials", async () => {
    expect(await codeOf(resolveTarget({ org: "nope" }, {}, CONFIG, memoryKeychain()))).toBe("NOT_FOUND");
    expect(await codeOf(resolveTarget({ org: "prod" }, {}, CONFIG, memoryKeychain()))).toBe("AUTH_REQUIRED");
    expect(await codeOf(resolveTarget({}, {}, emptyConfig(), memoryKeychain()))).toBe("AUTH_REQUIRED");
  });

  it("describeTarget is offline: it never touches the keychain", () => {
    expect(describeTarget({}, {}, CONFIG)).toMatchObject({
      org: "prod",
      credentials: "keychain (stored by auth login)",
    });
    expect(describeTarget({}, ENV_KEYS, CONFIG)).toMatchObject({
      org: "env",
      credentials: "env DD_API_KEY + application key",
    });
    expect(describeTarget({}, {}, emptyConfig())).toMatchObject({ org: "none", source: "none" });
  });
});

describe("config file", () => {
  it("round-trips without ever holding a secret", () => {
    const rt = makeRuntime();
    saveConfig(rt.configPath, CONFIG);
    expect(loadConfig(rt.configPath)).toEqual(CONFIG);
  });

  it("rejects malformed files with CONFIG_INVALID", () => {
    const rt = makeRuntime({ config: { orgs: { bad: {} as never } } });
    expect(() => loadConfig(rt.configPath)).toThrow(/has no site/);
  });
});

describe("hardening", () => {
  it("refuses a hand-edited config whose site is not a Datadog site", () => {
    const rt = makeRuntime({ config: { orgs: { prod: { site: "evil.example.com" } } } });
    expect(() => loadConfig(rt.configPath)).toThrow(/unknown site/);
  });

  it("normalizes a stored region name to its site", () => {
    const rt = makeRuntime({ config: { orgs: { prod: { site: "EU1" } } } });
    expect(loadConfig(rt.configPath).orgs.prod).toEqual({ site: "datadoghq.eu" });
  });

  it("never resolves inherited names such as constructor as orgs", async () => {
    expect(await codeOf(resolveTarget({ org: "constructor" }, {}, CONFIG, memoryKeychain()))).toBe("NOT_FOUND");
    const current = { ...CONFIG, current: "toString" };
    expect(describeTarget({}, {}, current)).toMatchObject({ source: "none" });
  });
});
