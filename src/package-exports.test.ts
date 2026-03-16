import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, test } from "node:test";

interface ExportTarget {
  import?: string;
  types?: string;
}

interface PackageJsonShape {
  exports?: Record<string, ExportTarget>;
}

describe("package exports", () => {
  test("publishes the public runtime subpaths used by consumers", async () => {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const raw = await readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(raw) as PackageJsonShape;

    assert.deepEqual(packageJson.exports?.["."], {
      import: "./dist/core/dsl.js",
      types: "./dist/core/dsl.d.ts"
    });
    assert.deepEqual(packageJson.exports?.["./interpreter"], {
      import: "./dist/core/interpreter.js",
      types: "./dist/core/interpreter.d.ts"
    });
    assert.deepEqual(packageJson.exports?.["./proof"], {
      import: "./dist/core/proof.js",
      types: "./dist/core/proof.d.ts"
    });
    assert.deepEqual(packageJson.exports?.["./db/adapterRuntime"], {
      import: "./dist/db/adapterRuntime.js",
      types: "./dist/db/adapterRuntime.d.ts"
    });
  });
});
