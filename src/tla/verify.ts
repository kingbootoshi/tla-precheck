import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ResolvedMachineDef } from "../core/dsl.js";
import { assertSafeForGraphEquivalence } from "../core/proof.js";
import { exploreGraph } from "../core/interpreter.js";
import { buildVerificationCertificate, compareGraphs, type VerificationCertificate } from "./compare.js";
import { generateCfg, type GeneratedPaths } from "./generate.js";
import { parseTlcDot } from "./parseDot.js";

const TLC_TIMEOUT_MS = 60_000;
const TLC_MAX_HEAP = "4G";
const MAX_DOT_BYTES = 50 * 1024 * 1024;
const MAX_TLC_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TLC_METADIR_BYTES = 1 * 1024 * 1024 * 1024;

interface TlcRunResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

const appendChunk = (
  chunks: Buffer[],
  state: { capturedBytes: number; truncated: boolean },
  chunk: Buffer | string
): void => {
  if (state.capturedBytes >= MAX_TLC_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }

  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_TLC_OUTPUT_BYTES - state.capturedBytes;
  if (buffer.byteLength <= remaining) {
    chunks.push(buffer);
    state.capturedBytes += buffer.byteLength;
    return;
  }

  chunks.push(buffer.subarray(0, remaining));
  state.capturedBytes += remaining;
  state.truncated = true;
};

const formatOutput = (chunks: readonly Buffer[], truncated: boolean): string => {
  const output = Buffer.concat(chunks).toString("utf8").trim();
  if (!truncated) {
    return output;
  }
  return [output, `[tlc-output-truncated-after-${MAX_TLC_OUTPUT_BYTES}-bytes]`]
    .filter((part) => part.length > 0)
    .join("\n");
};

const runTlc = async (
  cwd: string,
  args: readonly string[],
  metadir: string
): Promise<TlcRunResult> => {
  await mkdir(metadir, { recursive: true });

  return new Promise((resolveRun, reject) => {
    const child = spawn("java", ["-Xmx4G", "-jar", ...args], { cwd });
    const chunks: Buffer[] = [];
    const state = {
      capturedBytes: 0,
      truncated: false
    };
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TLC_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      appendChunk(chunks, state, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      appendChunk(chunks, state, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode: exitCode ?? -1,
        output: formatOutput(chunks, state.truncated),
        timedOut
      });
    });
  });
};

const directorySize = async (directoryPath: string): Promise<number> => {
  const entry = await stat(directoryPath).catch(() => null);
  if (entry === null) {
    return 0;
  }
  if (!entry.isDirectory()) {
    return entry.size;
  }

  const { readdir } = await import("node:fs/promises");
  const children = await readdir(directoryPath, { withFileTypes: true });
  let total = 0;
  for (const child of children) {
    const childPath = resolve(directoryPath, child.name);
    if (child.isDirectory()) {
      total += await directorySize(childPath);
      continue;
    }
    const childStat = await stat(childPath);
    total += childStat.size;
  }
  return total;
};

const assertMetadirWithinCap = async (metadir: string): Promise<void> => {
  const size = await directorySize(metadir);
  if (size > MAX_TLC_METADIR_BYTES) {
    throw new Error(
      `[tlc-metadir-too-large] TLC metadata directory ${metadir} exceeded ${MAX_TLC_METADIR_BYTES} bytes`
    );
  }
};

const cleanupDirectory = async (directoryPath: string): Promise<void> => {
  await rm(directoryPath, { recursive: true, force: true });
};

const readActionLabels = async (
  actionLabelsPath: string
): Promise<Readonly<Record<string, string>>> =>
  JSON.parse(await readFile(actionLabelsPath, "utf8")) as Record<string, string>;

export const verifyGeneratedMachineArtifacts = async (
  machine: ResolvedMachineDef,
  generated: GeneratedPaths
): Promise<VerificationCertificate> => {
  const tlaJar = process.env.TLA2TOOLS_JAR;
  if (tlaJar === undefined || tlaJar.length === 0) {
    throw new Error("TLA2TOOLS_JAR must point to tla2tools.jar");
  }

  const moduleFileName = `${machine.moduleName}.tla`;
  const proofMetadir = resolve(generated.outputDir, ".tlc-meta-proof");
  const proofRun = await runTlc(
    generated.outputDir,
    [
      tlaJar,
      "-workers",
      "auto",
      "-metadir",
      proofMetadir,
      "-config",
      basename(generated.cfgPath),
      moduleFileName
    ],
    proofMetadir
  );

  if (proofRun.timedOut) {
    await cleanupDirectory(proofMetadir);
    throw new Error(`[tlc-timeout] TLC proof run exceeded ${TLC_TIMEOUT_MS}ms`);
  }

  await assertMetadirWithinCap(proofMetadir);

  if (proofRun.exitCode !== 0) {
    return buildVerificationCertificate({
      machine,
      proofPassed: false,
      graphEquivalenceAttempted: false,
      proofOutput: proofRun.output
    });
  }

  if (machine.resolvedTier.graphEquivalence === false) {
    return buildVerificationCertificate({
      machine,
      proofPassed: true,
      graphEquivalenceAttempted: false,
      proofOutput: proofRun.output
    });
  }

  assertSafeForGraphEquivalence(machine);

  const equivalenceCfgPath = resolve(generated.outputDir, `${machine.moduleName}.equivalence.cfg`);
  await writeFile(
    equivalenceCfgPath,
    generateCfg(machine, {
      includeSymmetry: false,
      specification: "EquivalenceSpec",
      stringifyModelValues: true
    }),
    "utf8"
  );

  const dotPath = resolve(generated.outputDir, `${machine.moduleName}.dot`);
  const graphStem = resolve(generated.outputDir, machine.moduleName);
  const equivalenceMetadir = resolve(generated.outputDir, ".tlc-meta-equivalence");
  const equivalenceRun = await runTlc(
    generated.outputDir,
    [
      tlaJar,
      "-workers",
      "auto",
      "-metadir",
      equivalenceMetadir,
      "-dump",
      "dot,actionlabels",
      graphStem,
      "-config",
      basename(equivalenceCfgPath),
      moduleFileName
    ],
    equivalenceMetadir
  );

  if (equivalenceRun.timedOut) {
    await cleanupDirectory(equivalenceMetadir);
    throw new Error(`[tlc-timeout] TLC equivalence run exceeded ${TLC_TIMEOUT_MS}ms`);
  }

  await assertMetadirWithinCap(equivalenceMetadir);

  if (equivalenceRun.exitCode !== 0) {
    throw new Error(
      `[tlc-equivalence-failed] TLC equivalence run exited with code ${equivalenceRun.exitCode}\n${equivalenceRun.output}`
    );
  }

  const dotStat = await stat(dotPath);
  if (dotStat.size > MAX_DOT_BYTES) {
    await unlink(dotPath);
    throw new Error(`[dot-file-too-large] TLC DOT output exceeded ${MAX_DOT_BYTES} bytes`);
  }

  const [dotSource, actionLabels] = await Promise.all([
    readFile(dotPath, "utf8"),
    readActionLabels(generated.actionLabelsPath)
  ]);

  const tsGraph = exploreGraph(machine);
  const tlcGraph = parseTlcDot(machine, dotSource, actionLabels);
  const graphComparison = compareGraphs(tsGraph, tlcGraph);

  return buildVerificationCertificate({
    machine,
    proofPassed: true,
    graphEquivalenceAttempted: true,
    graphComparison,
    proofOutput: proofRun.output,
    equivalenceOutput: equivalenceRun.output
  });
};
