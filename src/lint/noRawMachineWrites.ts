import { dirname } from "node:path";

import ts from "typescript";

import type { MachineDef } from "../core/dsl.js";

export interface LintViolation {
  file: string;
  line: number;
  column: number;
  message: string;
}

const getLiteralText = (node: ts.Node): string | null => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
};

const matchSupabaseMutation = (
  node: ts.CallExpression
): { tableName: string; methodName: string; objectArg: ts.ObjectLiteralExpression | null } | null => {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  const methodName = node.expression.name.text;
  if (!["insert", "update", "upsert", "delete"].includes(methodName)) {
    return null;
  }

  const fromCall = node.expression.expression;
  if (!ts.isCallExpression(fromCall) || !ts.isPropertyAccessExpression(fromCall.expression)) {
    return null;
  }

  if (fromCall.expression.name.text !== "from") {
    return null;
  }

  const tableName = fromCall.arguments[0] ? getLiteralText(fromCall.arguments[0]) : null;
  if (tableName === null) {
    return null;
  }

  const objectArg = node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0] : null;
  return { tableName, methodName, objectArg };
};

export const lintNoRawMachineWrites = (
  tsconfigPath: string,
  machine: MachineDef
): readonly LintViolation[] => {
  const configText = ts.sys.readFile(tsconfigPath);
  if (configText === undefined) {
    throw new Error(`Could not read ${tsconfigPath}`);
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    ts.parseConfigFileTextToJson(tsconfigPath, configText).config,
    ts.sys,
    dirname(tsconfigPath)
  );

  const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  const violations: LintViolation[] = [];
  const ownedTables = new Set(machine.metadata?.ownedTables ?? []);
  const allowedWriters = new Set(machine.metadata?.allowedWriterModules ?? []);
  if (machine.metadata?.runtimeAdapter !== undefined) {
    allowedWriters.add(`src/machine-adapters/${machine.moduleName}.adapter.ts`);
  }
  const ownedColumns = machine.metadata?.ownedColumns ?? {};

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    const normalizedPath = sourceFile.fileName.replace(/\\/g, "/");
    const isAllowedWriter = [...allowedWriters].some((allowed) => normalizedPath.endsWith(allowed));

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const match = matchSupabaseMutation(node);
        if (match !== null && ownedTables.has(match.tableName) && !isAllowedWriter) {
          const forbiddenColumns = new Set(ownedColumns[match.tableName] ?? []);
          const touchesOwnedColumns =
            match.objectArg === null ||
            match.objectArg.properties.some((property) => {
              if (!ts.isPropertyAssignment(property)) {
                return true;
              }
              const name = ts.isIdentifier(property.name)
                ? property.name.text
                : ts.isStringLiteral(property.name)
                  ? property.name.text
                  : null;
              return name === null || forbiddenColumns.size === 0 || forbiddenColumns.has(name);
            });

          if (touchesOwnedColumns) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            violations.push({
              file: sourceFile.fileName,
              line: position.line + 1,
              column: position.character + 1,
              message: `Raw write to machine-owned table ${match.tableName} is forbidden outside generated/interpreted adapters.`
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
};
