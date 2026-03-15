import {
  and,
  defineMachine,
  enumType,
  eq,
  lit,
  not,
  scalarVar,
  setVar,
  variable
} from "../core/dsl.js";

const mode = variable("mode");
const temper = variable("temper");

export const dogMachine = defineMachine({
  version: 2,
  moduleName: "Dog",
  variables: {
    mode: scalarVar(enumType("sleeping", "awake", "eating"), lit("sleeping")),
    temper: scalarVar(enumType("calm", "angry"), lit("calm"))
  },
  actions: {
    wakeUp: {
      params: {},
      guard: eq(mode, lit("sleeping")),
      updates: [setVar("mode", lit("awake"))]
    },
    fallAsleep: {
      params: {},
      guard: and(eq(mode, lit("awake")), eq(temper, lit("calm"))),
      updates: [setVar("mode", lit("sleeping"))]
    },
    serveFood: {
      params: {},
      guard: and(eq(mode, lit("awake")), eq(temper, lit("calm"))),
      updates: [setVar("mode", lit("eating"))]
    },
    finishEating: {
      params: {},
      guard: eq(mode, lit("eating")),
      updates: [setVar("mode", lit("awake"))]
    },
    annoy: {
      params: {},
      guard: and(eq(mode, lit("awake")), eq(temper, lit("calm"))),
      updates: [setVar("temper", lit("angry"))]
    },
    calmDown: {
      params: {},
      guard: eq(temper, lit("angry")),
      updates: [setVar("temper", lit("calm"))]
    }
  },
  invariants: {
    sleepingDogsAreCalm: {
      description: "Sleeping dogs are never angry",
      formula: not(and(eq(mode, lit("sleeping")), eq(temper, lit("angry"))))
    },
    eatingDogsAreCalm: {
      description: "Eating dogs are never angry",
      formula: not(and(eq(mode, lit("eating")), eq(temper, lit("angry"))))
    }
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {},
        budgets: {
          maxEstimatedStates: 10,
          maxEstimatedBranching: 10
        }
      }
    }
  }
});

export default dogMachine;
