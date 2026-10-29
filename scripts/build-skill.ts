import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

// Compiled to dist/scripts/build-skill.js; the repository root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = join(root, "skills", "datadog-axi", "SKILL.md");
const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf-8");
  } catch {
    // missing file is stale
  }
  if (current !== expected) {
    console.error("skills/datadog-axi/SKILL.md is stale; run `npm run build:skill`");
    process.exit(1);
  }
  console.error("skills/datadog-axi/SKILL.md is up to date");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected, "utf-8");
  console.error(`wrote ${target}`);
}
