import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const isMachineModule = (path: string): boolean => path.endsWith(".machine.js");

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".generated-machines"]);

export const discoverMachineModules = async (
  rootPath: string
): Promise<readonly string[]> => {
  const resolvedRoot = resolve(rootPath);

  if (isMachineModule(resolvedRoot)) {
    return [resolvedRoot];
  }

  const discovered: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }
      if (entry.isFile() && isMachineModule(entryPath)) {
        discovered.push(entryPath);
      }
    }
  };

  await visit(resolvedRoot);
  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
};
