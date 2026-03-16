import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { MachineDef, ResolvedMachineDef } from "../core/dsl.js";
import {
  assertSafeForGraphEquivalence,
  assertWithinBudgets,
  estimateMachine,
  formatEstimate,
  resolveMachine
} from "../core/proof.js";
import { assertValidMachine } from "../core/validate.js";
import { writeGeneratedAdapter } from "../db/generateAdapter.js";
import {
  verifyPostgresStorageContract,
  writeGeneratedStorageContract
} from "../db/postgres.js";
import { lintNoRawMachineWrites } from "../lint/noRawMachineWrites.js";
import type { LintViolation } from "../lint/noRawMachineWrites.js";
import type { VerificationCertificate } from "../tla/compare.js";
import { writeGeneratedMachine } from "../tla/generate.js";
import { verifyGeneratedMachineArtifacts } from "../tla/verify.js";
import { discoverMachineModules } from "./discoverMachines.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { loadMachine } from "./loadMachine.js";
import { runSetup } from "./setup.js";
import { PACKAGE_VERSION } from "./version.js";

interface ParsedArgs {
  command:
    | "estimate"
    | "generate"
    | "generate-db"
    | "lint"
    | "lint-all"
    | "verify"
    | "verify-db"
    | "verify-all"
    | "verify-db-all"
    | "agent-build"
    | "check"
    | "build";
  modulePath: string;
  tier?: string;
  allTiers: boolean;
  outputRoot: string;
  tsconfigPath: string;
}

interface VerifyCommandOutput {
  generated: Awaited<ReturnType<typeof writeGeneratedMachine>>;
  certificatePath: string;
  estimate: ResolvedMachineDef["estimate"];
  certificate: VerificationCertificate;
}

interface VerifyDbCommandOutput {
  generated: Awaited<ReturnType<typeof writeGeneratedStorageContract>>;
  certificatePath: string;
  certificate: Awaited<ReturnType<typeof verifyPostgresStorageContract>>;
}

interface AgentBuildOutput {
  success: boolean;
  certificate: VerificationCertificate | null;
  adapterPath: string | null;
  errors: readonly string[];
}

const isRuntimeAdapterBuildError = (message: string): boolean =>
  message.startsWith("[build-requires-runtime-adapter]");

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const command = argv[2];
  const modulePath = argv[3];

  if (
    command !== "estimate" &&
    command !== "generate" &&
    command !== "generate-db" &&
    command !== "lint" &&
    command !== "lint-all" &&
    command !== "verify" &&
    command !== "verify-db" &&
    command !== "verify-all" &&
    command !== "verify-db-all" &&
    command !== "agent-build" &&
    command !== "check" &&
    command !== "build"
  ) {
    throw new Error(
      "Usage: tla-precheck <setup|doctor|init|check|build|estimate|generate|verify|...> [args]"
    );
  }

  if (modulePath === undefined) {
    throw new Error("Missing machine module or root path");
  }

  let tier: string | undefined;
  let allTiers = false;
  let outputRoot = resolve(process.cwd(), ".generated-machines");
  let tsconfigPath = resolve(process.cwd(), "tsconfig.json");

  for (let index = 4; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--tier") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --tier");
      }
      tier = value;
      index += 1;
      continue;
    }
    if (flag === "--all-tiers") {
      allTiers = true;
      continue;
    }
    if (flag === "--output-root") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --output-root");
      }
      outputRoot = resolve(value);
      index += 1;
      continue;
    }
    if (flag === "--tsconfig") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --tsconfig");
      }
      tsconfigPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown flag ${flag}`);
  }

  return {
    command,
    modulePath,
    tier,
    allTiers,
    outputRoot,
    tsconfigPath
  };
};

const resolveTierNames = (
  machine: MachineDef,
  tier: string | undefined,
  allTiers: boolean
): readonly string[] => {
  if (allTiers) {
    return Object.keys(machine.proof.tiers).sort((left, right) => left.localeCompare(right));
  }
  return [tier ?? machine.proof.defaultTier];
};

const writeVerificationCertificate = async (
  machine: ResolvedMachineDef,
  outputDir: string,
  certificate: VerificationCertificate
): Promise<string> => {
  const certificatePath = resolve(
    outputDir,
    `${machine.moduleName}.${machine.resolvedTier.name}.certificate.json`
  );
  await writeFile(certificatePath, JSON.stringify(certificate, null, 2), "utf8");
  return certificatePath;
};

const verifyMachine = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<VerifyCommandOutput> => {
  const resolvedMachine = resolveMachine(machine, tier);
  assertWithinBudgets(resolvedMachine.estimate);

  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);
  const certificate = await verifyGeneratedMachineArtifacts(resolvedMachine, generated);
  const certificatePath = await writeVerificationCertificate(
    resolvedMachine,
    generated.outputDir,
    certificate
  );

  return {
    generated,
    certificatePath,
    estimate: resolvedMachine.estimate,
    certificate
  };
};

const verifyDbMachine = async (
  machine: MachineDef,
  outputRoot: string
): Promise<VerifyDbCommandOutput> => {
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedStorageContract(machine, outputRoot);
  const certificate = await verifyPostgresStorageContract(machine);
  const certificatePath = resolve(
    generated.outputDir,
    `${machine.moduleName}.postgres.certificate.json`
  );
  await writeFile(certificatePath, JSON.stringify(certificate, null, 2), "utf8");

  return {
    generated,
    certificatePath,
    certificate
  };
};

const assertBunDbRuntime = (commandName: "verify-db" | "verify-db-all"): void => {
  if (process.versions.bun !== undefined) {
    return;
  }
  throw new Error(
    `[bun-required-for-${commandName}] ${commandName} uses Bun.SQL. Run it with 'bunx tla-precheck ${commandName} ...' or 'bun dist/cli/machine.js ${commandName} ...'.`
  );
};

const setVerifyExitCode = (certificate: VerificationCertificate): void => {
  if (!certificate.proofPassed) {
    process.exitCode = 1;
    return;
  }
  if (certificate.graphEquivalenceAttempted && certificate.equivalent !== true) {
    process.exitCode = 1;
  }
};

const runEstimate = async (machine: MachineDef, tier: string | undefined): Promise<void> => {
  const estimate = estimateMachine(machine, tier);
  console.log(formatEstimate(estimate));
  if (!estimate.withinBudget) {
    process.exitCode = 1;
  }
};

const runGenerate = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<void> => {
  const resolvedMachine = resolveMachine(machine, tier);
  assertWithinBudgets(resolvedMachine.estimate);
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);
  console.log(
    JSON.stringify(
      {
        generated,
        tier: resolvedMachine.resolvedTier.name,
        estimate: resolvedMachine.estimate
      },
      null,
      2
    )
  );
};

const runGenerateDb = async (machine: MachineDef, outputRoot: string): Promise<void> => {
  await mkdir(outputRoot, { recursive: true });
  const generated = await writeGeneratedStorageContract(machine, outputRoot);
  console.log(JSON.stringify({ generated }, null, 2));
};

const runLint = async (machine: MachineDef, tsconfigPath: string): Promise<void> => {
  const violations = lintNoRawMachineWrites(tsconfigPath, machine);
  console.log(JSON.stringify({ tsconfigPath, violations }, null, 2));
  if (violations.length > 0) {
    process.exitCode = 1;
  }
};

const runLintAll = async (rootPath: string, tsconfigPath: string): Promise<void> => {
  const modulePaths = await discoverMachineModules(rootPath);
  const results: Array<{
    modulePath: string;
    machine: string;
    violations: readonly LintViolation[];
  }> = [];

  for (const modulePath of modulePaths) {
    const machine = await loadMachine(modulePath, tsconfigPath);
    assertValidMachine(machine);
    const violations = lintNoRawMachineWrites(tsconfigPath, machine);
    results.push({
      modulePath,
      machine: machine.moduleName,
      violations
    });
    if (violations.length > 0) {
      process.exitCode = 1;
    }
  }

  console.log(JSON.stringify({ tsconfigPath, results }, null, 2));
};

const runVerify = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<void> => {
  const result = await verifyMachine(machine, tier, outputRoot);
  console.log(JSON.stringify(result, null, 2));
  setVerifyExitCode(result.certificate);
};

const runVerifyDb = async (machine: MachineDef, outputRoot: string): Promise<void> => {
  assertBunDbRuntime("verify-db");
  const result = await verifyDbMachine(machine, outputRoot);
  console.log(JSON.stringify(result, null, 2));
  if (!result.certificate.verified) {
    process.exitCode = 1;
  }
};

const runVerifyAll = async (
  rootPath: string,
  tier: string | undefined,
  allTiers: boolean,
  outputRoot: string,
  tsconfigPath: string
): Promise<void> => {
  const modulePaths = await discoverMachineModules(rootPath);
  const results: Array<{
    modulePath: string;
    machine: string;
    tier: string;
    certificatePath: string;
    proofPassed: boolean;
    graphEquivalenceAttempted: boolean;
    equivalent: boolean | null;
  }> = [];

  for (const modulePath of modulePaths) {
    const machine = await loadMachine(modulePath, tsconfigPath);
    assertValidMachine(machine);
    for (const tierName of resolveTierNames(machine, tier, allTiers)) {
      const result = await verifyMachine(machine, tierName, outputRoot);
      results.push({
        modulePath,
        machine: machine.moduleName,
        tier: tierName,
        certificatePath: result.certificatePath,
        proofPassed: result.certificate.proofPassed,
        graphEquivalenceAttempted: result.certificate.graphEquivalenceAttempted,
        equivalent: result.certificate.equivalent
      });
      setVerifyExitCode(result.certificate);
    }
  }

  console.log(JSON.stringify({ results }, null, 2));
};

const runVerifyDbAll = async (
  rootPath: string,
  outputRoot: string,
  tsconfigPath: string
): Promise<void> => {
  assertBunDbRuntime("verify-db-all");
  const modulePaths = await discoverMachineModules(rootPath);
  const results: Array<{
    modulePath: string;
    machine: string;
    certificatePath?: string;
    verified?: boolean;
    skipped: boolean;
  }> = [];

  for (const modulePath of modulePaths) {
    const machine = await loadMachine(modulePath, tsconfigPath);
    assertValidMachine(machine);
    if ((machine.metadata?.storageConstraints?.length ?? 0) === 0) {
      results.push({
        modulePath,
        machine: machine.moduleName,
        skipped: true
      });
      continue;
    }

    const result = await verifyDbMachine(machine, outputRoot);
    results.push({
      modulePath,
      machine: machine.moduleName,
      certificatePath: result.certificatePath,
      verified: result.certificate.verified,
      skipped: false
    });
    if (!result.certificate.verified) {
      process.exitCode = 1;
    }
  }

  console.log(JSON.stringify({ results }, null, 2));
};

const runCheck = async (
  machine: MachineDef,
  tier: string | undefined,
  outputRoot: string
): Promise<void> => {
  assertValidMachine(machine);

  const estimate = estimateMachine(machine, tier);
  console.log(formatEstimate(estimate));
  if (!estimate.withinBudget) {
    process.exitCode = 1;
    return;
  }

  console.log("\nEstimate passed. Running TLC verification...\n");
  const result = await verifyMachine(machine, tier, outputRoot);
  console.log(JSON.stringify(result, null, 2));
  setVerifyExitCode(result.certificate);
};

const runAgentBuild = async (
  modulePath: string,
  tier: string | undefined,
  outputRoot: string,
  tsconfigPath: string
): Promise<void> => {
  let certificate: VerificationCertificate | null = null;
  let adapterPath: string | null = null;
  const errors: string[] = [];

  try {
    const machine = await loadMachine(modulePath, tsconfigPath);
    assertValidMachine(machine);
    const resolvedMachine = resolveMachine(machine, tier);

    if (resolvedMachine.resolvedTier.graphEquivalence !== true) {
      errors.push(
        `[agent-build-requires-graph-equivalence-tier] Tier ${resolvedMachine.resolvedTier.name} is proof-only`
      );
      process.exitCode = 1;
      console.log(
        JSON.stringify(
          {
            success: false,
            certificate: null,
            adapterPath: null,
            errors
          } satisfies AgentBuildOutput,
          null,
          2
        )
      );
      return;
    }

    assertWithinBudgets(resolvedMachine.estimate);
    assertSafeForGraphEquivalence(resolvedMachine);

    await mkdir(outputRoot, { recursive: true });
    const generated = await writeGeneratedMachine(resolvedMachine, outputRoot);
    certificate = await verifyGeneratedMachineArtifacts(resolvedMachine, generated);
    await writeVerificationCertificate(resolvedMachine, generated.outputDir, certificate);

    if (!certificate.proofPassed || certificate.graphEquivalenceAttempted !== true || certificate.equivalent !== true) {
      process.exitCode = 1;
      console.log(
        JSON.stringify(
          {
            success: false,
            certificate,
            adapterPath: null,
            errors
          } satisfies AgentBuildOutput,
          null,
          2
        )
      );
      return;
    }

    await writeGeneratedStorageContract(machine, outputRoot);
    const adapter = await writeGeneratedAdapter(machine);
    adapterPath = adapter.adapterPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    if (certificate?.proofPassed === true && isRuntimeAdapterBuildError(message)) {
      errors.push(
        "build reached adapter generation after proof succeeded. Update the client machine definition with metadata.runtimeAdapter, metadata.ownedTables, and metadata.ownedColumns."
      );
    }
    process.exitCode = 1;
  }

  console.log(
    JSON.stringify(
      {
        success: errors.length === 0 && certificate?.proofPassed === true && certificate.equivalent === true,
        certificate,
        adapterPath,
        errors
      } satisfies AgentBuildOutput,
      null,
      2
    )
  );
};

export async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (command === "setup") {
    await runSetup(process.argv.slice(3));
    return;
  }
  if (command === "doctor") {
    await runDoctor();
    return;
  }
  if (command === "init") {
    await runInit(process.argv[3]);
    return;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(`
TLA PreCheck v${PACKAGE_VERSION} - Mathematically verified state machines

  setup                      Install agent skills and TLC
  doctor                     Check environment
  init [name]                Scaffold a new machine
  check <machine>            Validate + estimate + verify (.machine.ts or .machine.js)
  build <machine>            Check + generate adapter when metadata.runtimeAdapter is declared
  version                    Print the installed tla-precheck version

Advanced:
  estimate <machine>         Fast budget check (no Java needed)
  generate <machine>         Generate TLA+ artifacts
  generate-db <machine>      Generate Postgres storage constraints
  verify <machine>           Full TLC verification
  verify-all <root>          Verify all machines in directory
  verify-db <machine>        Verify live Postgres schema (Bun only)
  verify-db-all <root>       Verify all DB constraints (Bun only)
  lint <machine>             Lint for raw writes
  lint-all <root>            Lint all machines
  agent-build <machine>      Alias for build

Flags:
  --tier <name>              Proof tier (default: machine's defaultTier)
  --all-tiers                Run across all declared tiers
  --output-root <path>       Output directory (default: .generated-machines)
  --tsconfig <path>          tsconfig.json path for lint
`);
    return;
  }

  const args = parseArgs(process.argv);

  if (args.command === "lint-all") {
    await runLintAll(args.modulePath, args.tsconfigPath);
    return;
  }
  if (args.command === "verify-all") {
    await runVerifyAll(args.modulePath, args.tier, args.allTiers, args.outputRoot, args.tsconfigPath);
    return;
  }
  if (args.command === "verify-db-all") {
    await runVerifyDbAll(args.modulePath, args.outputRoot, args.tsconfigPath);
    return;
  }
  if (args.command === "agent-build" || args.command === "build") {
    await runAgentBuild(args.modulePath, args.tier, args.outputRoot, args.tsconfigPath);
    return;
  }

  const machine = await loadMachine(args.modulePath, args.tsconfigPath);
  assertValidMachine(machine);

  if (args.command === "estimate") {
    await runEstimate(machine, args.tier);
    return;
  }
  if (args.command === "generate") {
    await runGenerate(machine, args.tier, args.outputRoot);
    return;
  }
  if (args.command === "generate-db") {
    await runGenerateDb(machine, args.outputRoot);
    return;
  }
  if (args.command === "lint") {
    await runLint(machine, args.tsconfigPath);
    return;
  }
  if (args.command === "verify-db") {
    await runVerifyDb(machine, args.outputRoot);
    return;
  }
  if (args.command === "check") {
    await runCheck(machine, args.tier, args.outputRoot);
    return;
  }

  await runVerify(machine, args.tier, args.outputRoot);
}

const reportCliError = (error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(reportCliError);
}
