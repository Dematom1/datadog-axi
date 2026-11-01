import { AxiError } from "axi-sdk-js";
import { afterEach, describe, expect, it } from "vitest";
import { updateCommand } from "../src/cli.js";

const originalEntry = process.argv[1];
afterEach(() => {
  process.argv[1] = originalEntry;
});

describe("update command", () => {
  it("refuses an unknown installation with UPDATE_ERROR and its update instruction", async () => {
    process.argv[1] = "/custom/yarn/node_modules/datadog-axi/bin/cli.js";

    await expect(updateCommand([])).rejects.toMatchObject({
      code: "UPDATE_ERROR",
      message: expect.stringContaining(
        "unknown installation at /custom/yarn/node_modules/datadog-axi/bin/cli.js: Cannot safely identify the installation manager",
      ),
    } satisfies Partial<AxiError>);
  });
});
