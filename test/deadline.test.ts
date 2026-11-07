import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPup, PupFailure } from "../src/pup.js";

const realProcess = process;
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function stub(source: string): Promise<{ dir: string; bin: string }> {
  const dir = await mkdtemp(join(tmpdir(), "datadog-deadline-"));
  dirs.push(dir);
  const bin = join(dir, "pup.mjs");
  await writeFile(bin, source);
  return { dir, bin };
}

async function expectGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      realProcess.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} still exists`);
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`PID file ${path} was not written`);
}

describe("runPup deadline", () => {
  it("kills the process group and settles at the deadline", async () => {
    const { dir, bin } = await stub(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'survived'), 1800)", process.argv[2]], { stdio: "ignore" });
      writeFileSync(process.argv[2] + ".pid", String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const sideEffect = join(dir, "side-effect");
    const started = Date.now();
    await expect(runPup(process.execPath, [bin, sideEffect], process.env, 300)).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    await expectGone(Number(await readFile(sideEffect + ".pid", "utf8")));
    await new Promise((resolve) => setTimeout(resolve, 1900));
    await expect(readFile(sideEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles at the deadline when an escaped descendant keeps output pipes open", async () => {
    const { dir, bin } = await stub(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
      writeFileSync(process.argv[2], String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const pidFile = join(dir, "escaped.pid");
    const running = runPup(realProcess.execPath, [bin, pidFile], realProcess.env, 300);
    const pid = await readPid(pidFile);
    const started = Date.now();
    try {
      await expect(running).rejects.toMatchObject({ kind: "timeout" });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(() => realProcess.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        realProcess.kill(-pid, "SIGKILL");
      } catch {
        // The group may already have exited.
      }
    }
    await expectGone(pid);
  });

  it("kills the direct child on Windows", async () => {
    const { dir, bin } = await stub(`
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const pidFile = join(dir, "pid");
    const originalProcess = globalThis.process;
    const kill = vi.spyOn(realProcess, "kill");
    vi.stubGlobal("process", Object.create(originalProcess, { platform: { value: "win32" } }));
    try {
      await expect(runPup(realProcess.execPath, [bin, pidFile], realProcess.env, 100)).rejects.toMatchObject({
        kind: "timeout",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
    kill.mockRestore();
    await expectGone(pid);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("kills child and grandchild and removes handlers on %s", async (signal, code) => {
    const { dir, bin } = await stub(`
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const marker = process.argv[2];
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'grandchild'), 1200)", marker], { stdio: "ignore" });
      writeFileSync(marker + ".grandchild-pid", String(grandchild.pid));
      writeFileSync(marker + ".child-pid", String(process.pid));
      setTimeout(() => writeFileSync(marker, "child"), 1200);
      setInterval(() => {}, 1000);
    `);
    const marker = join(dir, "signal-side-effect");
    const before = [realProcess.listenerCount("SIGINT"), realProcess.listenerCount("SIGTERM")];
    const exit = vi.spyOn(realProcess, "exit").mockImplementation((() => undefined) as never);
    try {
      const running = runPup(realProcess.execPath, [bin, marker], realProcess.env, 3000);
      const interrupted = expect(running).rejects.toMatchObject({ kind: "failed" });
      const childPid = await readPid(marker + ".child-pid");
      const grandchildPid = await readPid(marker + ".grandchild-pid");
      realProcess.emit(signal);
      await interrupted;
      expect(exit).toHaveBeenCalledWith(code);
      expect([realProcess.listenerCount("SIGINT"), realProcess.listenerCount("SIGTERM")]).toEqual(before);
      await Promise.all([expectGone(childPid), expectGone(grandchildPid)]);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      exit.mockRestore();
    }
  });

  it("removes signal listeners after normal completion", async () => {
    const { bin } = await stub('process.stdout.write("ok");');
    const before = [realProcess.listenerCount("SIGINT"), realProcess.listenerCount("SIGTERM")];
    await expect(runPup(realProcess.execPath, [bin], realProcess.env, 3000)).resolves.toBe("ok");
    expect([realProcess.listenerCount("SIGINT"), realProcess.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("decodes UTF-8 characters split across output chunks", async () => {
    const { bin } = await stub(`
      const bytes = Buffer.from("🍣");
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => process.stdout.write(bytes.subarray(2)), 10);
    `);
    await expect(runPup(realProcess.execPath, [bin], realProcess.env, 3000)).resolves.toBe("🍣");
  });

  it("rejects output overflow instead of misreporting it as a timeout", async () => {
    const { bin } = await stub('process.stdout.write("x".repeat(1024 * 1024 + 1));');
    await expect(runPup(realProcess.execPath, [bin], realProcess.env, 3000)).rejects.toEqual(
      expect.objectContaining({ kind: "failed" }),
    );
  });

  it("keeps ordinary command failures distinct from deadline failures", async () => {
    const { bin } = await stub('console.error("pup failed"); process.exitCode = 2;');
    await expect(runPup(realProcess.execPath, [bin], realProcess.env, 3000)).rejects.toEqual(
      expect.objectContaining({ kind: "failed", message: "pup failed" }),
    );
  });

  it("reports missing executables", async () => {
    await expect(runPup("/not/a/real/pup", [], realProcess.env, 3000)).rejects.toBeInstanceOf(PupFailure);
  });
});
