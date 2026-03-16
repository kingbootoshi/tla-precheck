import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { commandText, heading, statusLabel } from "./ui.js";

const toPascalCase = (value: string): string =>
  value
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");

const generateTemplate = (name: string): string => {
  const pascalName = toPascalCase(name);
  const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);

  return `import {
  defineMachine,
  enumType,
  eq,
  lit,
  not,
  scalarVar,
  setVar,
  variable
} from "tla-precheck";

const status = variable("status");

export const ${camelName}Machine = defineMachine({
  version: 2,
  moduleName: "${pascalName}",
  variables: {
    status: scalarVar(enumType("draft", "active", "cancelled"), lit("draft"))
  },
  actions: {
    activate: {
      params: {},
      guard: eq(status, lit("draft")),
      updates: [setVar("status", lit("active"))]
    },
    cancel: {
      params: {},
      guard: eq(status, lit("active")),
      updates: [setVar("status", lit("cancelled"))]
    },
    reset: {
      params: {},
      guard: eq(status, lit("cancelled")),
      updates: [setVar("status", lit("draft"))]
    }
  },
  invariants: {
    // Example: an invariant that is always checked across every reachable state
    // noCancelledDrafts: {
    //   description: "Cancelled items were once active",
    //   formula: not(eq(status, lit("impossible")))
    // }
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {},
        budgets: {
          maxEstimatedStates: 100,
          maxEstimatedBranching: 10
        }
      }
    }
  }
});

export default ${camelName}Machine;
`;
};

export const runInit = async (nameArg: string | undefined): Promise<void> => {
  let requestedName = nameArg;
  if (requestedName === undefined || requestedName.length === 0) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n${heading("TLA PreCheck Init")}\n\nMachine name or path ${commandText("(example: billing or src/machines/subscription)")} `
    );
    rl.close();
    requestedName = answer.trim();
  }

  if (requestedName.length === 0) {
    console.error("Usage: tla-precheck init <name>");
    console.error("Example: tla-precheck init billing");
    console.error("         tla-precheck init src/machines/subscription");
    process.exitCode = 1;
    return;
  }

  const normalized = requestedName.replace(/\.machine\.ts$/, "");
  const filePath = resolve(process.cwd(), `${normalized}.machine.ts`);
  const machineName = basename(normalized);

  if (existsSync(filePath)) {
    console.error(`File already exists: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, generateTemplate(machineName), "utf8");

  console.log(`\n${heading("Machine created")}`);
  console.log(`  ${statusLabel("ok")} ${filePath}`);
  console.log("");
  console.log(heading("Next steps"));
  console.log("  1. Edit the machine - add your states, transitions, and invariants");
  console.log(`  2. Run: ${commandText(`npx tla-precheck check ${normalized}`)}`);
  console.log("  3. Fix any design issues the model checker finds");
  console.log("  4. Add metadata.runtimeAdapter plus ownedTables and ownedColumns if you want build to generate a database adapter");
  console.log(`  5. Run: ${commandText(`npx tla-precheck build ${normalized}`)}`);
  console.log("");
};
