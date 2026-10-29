import { TARGET_FLAGS, type CommandSpec } from "./args.js";

/**
 * Per-command help, rendered from the same `CommandSpec`s the parser
 * enforces, so help can never list a flag the parser rejects or miss one it
 * accepts.
 */

export interface HelpSubcommand {
  spec: CommandSpec;
  summary: string;
}

export interface HelpInput {
  command: string;
  description: string;
  subcommands: HelpSubcommand[];
  examples: string[];
  notes?: string[];
}

export function renderHelp(input: HelpInput): string {
  const lines: string[] = [`command: ${input.command}`, `description: ${input.description}`];

  lines.push(`subcommands[${input.subcommands.length}]:`);
  for (const { spec, summary } of input.subcommands) {
    lines.push(`  ${signature(spec)}: ${summary}`);
  }

  const targetSpecs = new Set(Object.values(TARGET_FLAGS));
  let takesTarget = false;
  for (const { spec } of input.subcommands) {
    const all = Object.entries(spec.flags);
    takesTarget ||= all.some(([, flag]) => targetSpecs.has(flag));
    const entries = all.filter(([, flag]) => !targetSpecs.has(flag));
    if (entries.length === 0) {
      continue;
    }
    lines.push(`flags{${spec.name}}:`);
    for (const [name, flag] of entries) {
      const value = flag.kind === "boolean" ? "" : ` ${flag.value ?? "<value>"}`;
      const repeat = flag.kind === "list" ? " (repeatable)" : "";
      lines.push(`  ${name}${value}: ${flag.description}${repeat}`);
    }
  }

  if (takesTarget) {
    lines.push("flags{target}:");
    for (const [name, flag] of Object.entries(TARGET_FLAGS)) {
      lines.push(`  ${name} ${flag.value}: ${flag.description}`);
    }
  }

  if (input.notes && input.notes.length > 0) {
    lines.push(`notes[${input.notes.length}]:`);
    for (const note of input.notes) {
      lines.push(`  ${note}`);
    }
  }

  lines.push(`examples[${input.examples.length}]:`);
  for (const example of input.examples) {
    lines.push(`  ${example}`);
  }

  return `${lines.join("\n")}\n`;
}

function signature(spec: CommandSpec): string {
  const pos = (spec.positionals ?? []).map((p) => (p.endsWith("?") ? `[${p.slice(0, -1)}]` : p)).join(" ");
  return pos ? `${spec.name} ${pos}` : spec.name;
}
