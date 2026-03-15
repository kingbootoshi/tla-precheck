import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { defineMachine } from "../core/dsl.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { lintNoRawMachineWrites } from "./noRawMachineWrites.js";

const SUPABASE_DECLARATION = `
declare const supabase: {
  from(table: string): {
    update(value: Record<string, unknown>): unknown;
  };
};
`;

describe("noRawMachineWrites lint", () => {
  test("flags forbidden writes and allows the generated adapter path", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "tla-precheck-lint-"));
    const machine = defineMachine({
      ...agentRunsMachine,
      metadata: {
        ...agentRunsMachine.metadata,
        allowedWriterModules: [],
        runtimeAdapter: {
          schema: "public",
          table: "agent_runs",
          rowDomain: "Runs",
          keyColumn: "id",
          keySqlType: "bigint"
        }
      }
    });

    try {
      await mkdir(join(projectDir, "src", "generated"), { recursive: true });
      await writeFile(
        join(projectDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        ),
        "utf8"
      );
      await writeFile(
        join(projectDir, "src", "forbidden.ts"),
        `${SUPABASE_DECLARATION}
supabase.from("agent_runs").update({ status: "running" });
supabase.from("agent_runs").update({ analytics_only: "ok" });
`,
        "utf8"
      );
      await writeFile(
        join(projectDir, "src", "generated", "AgentRuns.adapter.ts"),
        `${SUPABASE_DECLARATION}
supabase.from("agent_runs").update({ status: "running" });
`,
        "utf8"
      );

      const violations = lintNoRawMachineWrites(join(projectDir, "tsconfig.json"), machine);

      assert.equal(violations.length, 1);
      assert.match(violations[0]?.file ?? "", /src\/forbidden\.ts$/);
      assert.match(
        violations[0]?.message ?? "",
        /Raw write to machine-owned table agent_runs is forbidden/
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
