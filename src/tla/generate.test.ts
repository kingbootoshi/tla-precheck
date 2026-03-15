import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveMachine } from "../core/proof.js";
import { agentRunsMachine } from "../examples/agentRuns.machine.js";
import { dogMachine } from "../examples/dog.machine.js";
import { generateCfg, generateTlaModule } from "./generate.js";

describe("TLA generation", () => {
  test("renders tier-aware constants and symmetry in cfg", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const cfg = generateCfg(machine);

    assert.match(cfg, /CONSTANTS/);
    assert.match(cfg, /Users = \{u1, u2\}/);
    assert.match(cfg, /Runs = \{"r1", "r2", "r3"\}/);
    assert.match(cfg, /INVARIANT/);
    assert.match(cfg, /TypeOK/);
    assert.match(cfg, /oneActivePerUser/);
    assert.match(cfg, /SYMMETRY Symmetry/);
    assert.match(cfg, /CHECK_DEADLOCK FALSE/);
  });

  test("renders abstract domains as TLA constants", () => {
    const machine = resolveMachine(agentRunsMachine, "pr");
    const tla = generateTlaModule(machine);

    assert.match(tla, /CONSTANTS Users, Runs/);
    assert.match(tla, /Symmetry == Permutations\(Users\)/);
    assert.doesNotMatch(tla, /Users == \{/);
    assert.doesNotMatch(tla, /Runs == \{/);
  });

  test("omits the cfg constants section for scalar-only machines", () => {
    const machine = resolveMachine(dogMachine, "pr");
    const cfg = generateCfg(machine);
    const tla = generateTlaModule(machine);

    assert.doesNotMatch(cfg, /^CONSTANTS$/m);
    assert.match(cfg, /INVARIANT/);
    assert.match(cfg, /sleepingDogsAreCalm/);
    assert.match(tla, /^wakeUp ==$/m);
    assert.doesNotMatch(tla, /^wakeUp\(\) ==$/m);
  });
});
