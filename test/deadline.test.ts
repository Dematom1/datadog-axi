import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPup, PupFailure } from "../src/pup.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function stub(source: string): Promise<{ dir: string; bin: string }> {
  const dir = await mkdtemp(join(tmpdir(), "datadog-deadline-"));
  dirs.push(dir);
  const bin = join(dir, "pup.mjs");
  await writeFile(bin, source);
  return { dir, bin };
}

describe("runPup deadline", () => {
  it("kills the process group and settles at the deadline", async () => {
    const { dir, bin } = await stub(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'survived'), 1800)", process.argv[2]], { stdio: "ignore" });
      writeFileSync(process.argv[2] + ".pid", String(child.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();
    await expect(runPup(process.execPath, [bin, join(dir, "side-effect")], process.env, 300)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 1900));
    await expect(readFile(join(dir, "side-effect"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles at the deadline when an escaped descendant keeps output pipes open", async () => {
    const { bin } = await stub(`
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
    `);
    const started = Date.now();
    await expect(runPup(process.execPath, [bin], process.env, 300)).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("uses direct-child killing on Windows", async () => {
    const { bin } = await stub('setInterval(() => {}, 1000);');
    const kill = vi.spyOn(process, "kill");
    vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
    try {
      await expect(runPup(process.execPath, [bin], process.env, 100)).rejects.toMatchObject({ kind: "timeout" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      kill.mockRestore();
    }
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("cleans up on %s", async (signal, code) => {
    const { bin } = await stub('setInterval(() => {}, 1000);');
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const running = runPup(process.execPath, [bin], process.env, 3000);
    process.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(code);
    await expect(running).rejects.toMatchObject({ kind: "failed" });
    exit.mockRestore();
  });

  it("removes signal listeners after normal completion", async () => {
    const { bin } = await stub('process.stdout.write("ok");');
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(runPup(process.execPath, [bin], process.env, 3000)).resolves.toBe("ok");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("rejects output overflow instead of misreporting it as a timeout", async () => {
    const { bin } = await stub('process.stdout.write("x".repeat(1024 * 1024 + 1));');
    await expect(runPup(process.execPath, [bin], process.env, 3000)).rejects.toEqual(
      expect.objectContaining({ kind: "failed" }),
    );
  });

  it("keeps ordinary command failures distinct from deadline failures", async () => {
    const { bin } = await stub('console.error("pup failed"); process.exitCode = 2;');
    await expect(runPup(process.execPath, [bin], process.env, 3000)).rejects.toEqual(
      expect.objectContaining({ kind: "failed", message: "pup failed" }),
    );
  });

  it("reports missing executables", async () => {
    await expect(runPup("/not/a/real/pup", [], process.env, 3000)).rejects.toBeInstanceOf(PupFailure);
  });
});
