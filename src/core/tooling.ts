import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const HOMEBREW_JAVA_PATH = "/opt/homebrew/opt/openjdk/bin/java";
export const TLA_CACHE_DIR = resolve(homedir(), ".tla-precheck");
export const TLA_CACHE_PATH = resolve(TLA_CACHE_DIR, "tla2tools.jar");

export interface JavaStatus {
  found: boolean;
  version: string;
  command: string;
}

export const resolveJavaCommand = (): string =>
  existsSync(HOMEBREW_JAVA_PATH) ? HOMEBREW_JAVA_PATH : "java";

export const detectJava = (): JavaStatus => {
  const command = resolveJavaCommand();
  const result = spawnSync(command, ["-version"], { encoding: "utf8" });
  if (result.status !== 0) {
    return { found: false, version: "not found", command };
  }

  const output = `${result.stdout}${result.stderr}`;
  const match = output.match(/version "(\d+)/);
  return {
    found: true,
    version: match?.[1] ?? "unknown",
    command
  };
};

export const resolveTlcJarPath = (): string | null => {
  const envJar = process.env.TLA2TOOLS_JAR;
  if (envJar !== undefined && envJar.length > 0 && existsSync(envJar)) {
    return envJar;
  }
  return existsSync(TLA_CACHE_PATH) ? TLA_CACHE_PATH : null;
};
