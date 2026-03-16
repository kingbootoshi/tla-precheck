import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import type { MachineDef } from "../core/dsl.js";

const GENERATED_SOURCE_ROOT = resolve(process.cwd(), ".generated-machines", "source-modules");

const createDiagnosticHost = (): ts.FormatDiagnosticsHost => ({
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n"
});

const formatDiagnostics = (diagnostics: readonly ts.Diagnostic[]): string =>
  ts.formatDiagnosticsWithColorAndContext(diagnostics, createDiagnosticHost()).trim();

export const resolveMachineModulePath = (modulePath: string): string => {
  const absoluteModulePath = resolve(modulePath);
  if (existsSync(absoluteModulePath)) {
    return absoluteModulePath;
  }

  const candidates = [
    `${absoluteModulePath}.machine.ts`,
    `${absoluteModulePath}.machine.js`,
    `${absoluteModulePath}.ts`,
    `${absoluteModulePath}.js`
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return absoluteModulePath;
};

const compileSourceModule = async (
  modulePath: string,
  tsconfigPath: string
): Promise<string> => {
  const absoluteModulePath = resolve(modulePath);
  const relativeModulePath = relative(process.cwd(), absoluteModulePath);
  if (relativeModulePath.startsWith("..")) {
    throw new Error(
      `Source machine modules must be inside ${process.cwd()} when using the published CLI: ${absoluteModulePath}`
    );
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(formatDiagnostics([configFile.error]));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(formatDiagnostics(parsedConfig.errors));
  }

  const outputRoot = GENERATED_SOURCE_ROOT;
  const options: ts.CompilerOptions = {
    ...parsedConfig.options,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    noEmit: false,
    outDir: outputRoot,
    rootDir: process.cwd(),
    sourceMap: false
  };

  await mkdir(outputRoot, { recursive: true });

  const program = ts.createProgram({
    rootNames: [absoluteModulePath],
    options
  });
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);
  if (diagnostics.length > 0) {
    throw new Error(formatDiagnostics(diagnostics));
  }

  const emittedModulePath = resolve(outputRoot, relativeModulePath).replace(/\.ts$/, ".js");
  if (!existsSync(emittedModulePath)) {
    throw new Error(`TypeScript emit did not produce ${emittedModulePath}`);
  }
  return emittedModulePath;
};

export const loadMachine = async (
  modulePath: string,
  tsconfigPath: string
): Promise<MachineDef> => {
  const absoluteModulePath = resolveMachineModulePath(modulePath);
  const emittedPath = absoluteModulePath.endsWith(".ts")
    ? await compileSourceModule(absoluteModulePath, tsconfigPath)
    : absoluteModulePath;

  const loaded = (await import(pathToFileURL(emittedPath).href)) as Record<string, unknown>;
  const machine = (loaded.default ?? loaded.machine ?? Object.values(loaded)[0]) as
    | MachineDef
    | undefined;
  if (machine === undefined) {
    throw new Error(`Could not find a machine export in ${absoluteModulePath}`);
  }
  return machine;
};
