import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJsonShape {
  version?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, "../..", "package.json");

const readPackageVersion = (): string => {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as PackageJsonShape;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Could not determine package version from ${packageJsonPath}`);
  }
  return parsed.version;
};

export const PACKAGE_VERSION = readPackageVersion();
