import type {
  ActionDef,
  Expr,
  JsonValue,
  Primitive,
  ResolvedMachineDef,
  Update,
  VariableDef
} from "./dsl.js";
import { formatActionLabel } from "./actionLabels.js";
import { deepClone, deepEqual, stableStringify } from "./stable.js";

export type MachineState = Record<string, JsonValue>;
export type EvalEnv = Record<string, Primitive>;

export interface GraphEdge {
  from: string;
  to: string;
  action: string;
}

export interface StateGraph {
  initial: readonly string[];
  states: ReadonlyMap<string, MachineState>;
  edges: readonly GraphEdge[];
}

type FiniteMachineDef = Pick<
  ResolvedMachineDef,
  "actions" | "domains" | "moduleName" | "resolvedTier" | "variables"
>;

const asRecord = (value: JsonValue): Record<string, JsonValue> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected a record, received ${JSON.stringify(value)}`);
  }

  return value as Record<string, JsonValue>;
};

const asBoolean = (value: JsonValue): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean, received ${JSON.stringify(value)}`);
  }

  return value;
};

const asArray = (value: JsonValue): JsonValue[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array/set, received ${JSON.stringify(value)}`);
  }

  return value;
};

const cartesianProduct = (entries: readonly (readonly [string, readonly string[]])[]): EvalEnv[] => {
  if (entries.length === 0) {
    return [{}];
  }

  const [[headName, headDomain], ...tail] = entries;
  const tailBindings = cartesianProduct(tail);
  const out: EvalEnv[] = [];

  for (const value of headDomain) {
    for (const binding of tailBindings) {
      out.push({ ...binding, [headName]: value });
    }
  }

  return out;
};

const hasOwn = (record: Record<string, Primitive>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const envMatchesAction = (
  machine: FiniteMachineDef,
  action: ActionDef,
  env: EvalEnv
): boolean => {
  const actionParamNames = Object.keys(action.params);
  if (Object.keys(env).length !== actionParamNames.length) {
    return false;
  }

  return actionParamNames.every((name) => {
    if (!hasOwn(env, name)) {
      return false;
    }

    const domain = machine.domains[action.params[name]];
    if (domain === undefined) {
      throw new Error(`Unknown domain ${action.params[name]}`);
    }

    const value = env[name];
    return typeof value === "string" && domain.includes(value);
  });
};

export const canonicalizeState = (machine: FiniteMachineDef, state: MachineState): string => {
  const projected = Object.fromEntries(
    Object.keys(machine.variables)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, state[name]])
  );

  return stableStringify(projected);
};

export const evaluateExpr = (
  machine: FiniteMachineDef,
  state: MachineState,
  env: EvalEnv,
  expr: Expr
): JsonValue => {
  switch (expr.kind) {
    case "lit":
      return deepClone(expr.value);
    case "param": {
      const value = env[expr.name];
      if (value === undefined) {
        throw new Error(`Missing parameter ${expr.name}`);
      }
      return value;
    }
    case "var": {
      const value = state[expr.name];
      if (value === undefined) {
        throw new Error(`Missing variable ${expr.name}`);
      }
      return value;
    }
    case "index": {
      const target = asRecord(evaluateExpr(machine, state, env, expr.target));
      const key = String(evaluateExpr(machine, state, env, expr.key));
      return target[key] ?? null;
    }
    case "set":
      return expr.values.map((value) => evaluateExpr(machine, state, env, value));
    case "and":
      return expr.values.every((value) => asBoolean(evaluateExpr(machine, state, env, value)));
    case "or":
      return expr.values.some((value) => asBoolean(evaluateExpr(machine, state, env, value)));
    case "not":
      return !asBoolean(evaluateExpr(machine, state, env, expr.value));
    case "eq":
      return deepEqual(
        evaluateExpr(machine, state, env, expr.left),
        evaluateExpr(machine, state, env, expr.right)
      );
    case "lte": {
      const left = evaluateExpr(machine, state, env, expr.left);
      const right = evaluateExpr(machine, state, env, expr.right);
      if (typeof left !== "number" || typeof right !== "number") {
        throw new Error(`Expected numeric operands for lte, received ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
      }
      return left <= right;
    }
    case "in": {
      const needle = evaluateExpr(machine, state, env, expr.elem);
      const haystack = asArray(evaluateExpr(machine, state, env, expr.set));
      return haystack.some((candidate) => deepEqual(candidate, needle));
    }
    case "count": {
      const domain = machine.domains[expr.domain];
      if (domain === undefined) {
        throw new Error(`Unknown domain ${expr.domain}`);
      }
      let total = 0;
      for (const value of domain) {
        const nextEnv = { ...env, [expr.binder]: value };
        if (asBoolean(evaluateExpr(machine, state, nextEnv, expr.where))) {
          total += 1;
        }
      }
      return total;
    }
    case "forall": {
      const domain = machine.domains[expr.domain];
      if (domain === undefined) {
        throw new Error(`Unknown domain ${expr.domain}`);
      }
      for (const value of domain) {
        const nextEnv = { ...env, [expr.binder]: value };
        if (!asBoolean(evaluateExpr(machine, state, nextEnv, expr.where))) {
          return false;
        }
      }
      return true;
    }
  }
};

const initialValueForVar = (machine: FiniteMachineDef, variableDef: VariableDef): JsonValue => {
  if (variableDef.kind === "scalar") {
    return evaluateExpr(machine, {}, {}, variableDef.initial);
  }

  const domain = machine.domains[variableDef.domain];
  if (domain === undefined) {
    throw new Error(`Unknown domain ${variableDef.domain}`);
  }

  return Object.fromEntries(
    domain.map((member) => [member, evaluateExpr(machine, {}, {}, variableDef.initial)])
  );
};

export const buildInitialState = (machine: FiniteMachineDef): MachineState => {
  const out: MachineState = {};
  for (const [name, variableDef] of Object.entries(machine.variables)) {
    out[name] = initialValueForVar(machine, variableDef);
  }
  return out;
};

const applyUpdate = (
  machine: FiniteMachineDef,
  state: MachineState,
  env: EvalEnv,
  update: Update
): void => {
  switch (update.kind) {
    case "setVar":
      state[update.name] = evaluateExpr(machine, state, env, update.value);
      break;
    case "setMap": {
      const nextMap = deepClone(asRecord(state[update.name]));
      const key = String(evaluateExpr(machine, state, env, update.key));
      nextMap[key] = evaluateExpr(machine, state, env, update.value);
      state[update.name] = nextMap;
      break;
    }
  }
};

export const enabled = (
  machine: FiniteMachineDef,
  state: MachineState,
  actionName: string,
  env: EvalEnv
): boolean => {
  const action = machine.actions[actionName];
  if (action === undefined) {
    throw new Error(`Unknown action ${actionName}`);
  }
  if (!envMatchesAction(machine, action, env)) {
    return false;
  }
  return asBoolean(evaluateExpr(machine, state, env, action.guard));
};

export const step = (
  machine: FiniteMachineDef,
  state: MachineState,
  actionName: string,
  env: EvalEnv
): MachineState | null => {
  const action = machine.actions[actionName];
  if (action === undefined) {
    throw new Error(`Unknown action ${actionName}`);
  }
  if (!enabled(machine, state, actionName, env)) {
    return null;
  }

  const nextState = deepClone(state);
  for (const update of action.updates) {
    applyUpdate(machine, nextState, env, update);
  }
  return nextState;
};

export const enumerateBindings = (machine: FiniteMachineDef, action: ActionDef): EvalEnv[] => {
  const paramDomains = Object.entries(action.params).map(([name, domainName]) => {
    const domain = machine.domains[domainName];
    if (domain === undefined) {
      throw new Error(`Unknown domain ${domainName}`);
    }
    return [name, domain] as const;
  });

  return cartesianProduct(paramDomains);
};

export const exploreGraph = (machine: FiniteMachineDef): StateGraph => {
  const initialState = buildInitialState(machine);
  const initialKey = canonicalizeState(machine, initialState);
  const states = new Map<string, MachineState>([[initialKey, initialState]]);
  const pending: string[] = [initialKey];
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  while (pending.length > 0) {
    const currentKey = pending.shift();
    if (currentKey === undefined) {
      break;
    }

    const currentState = states.get(currentKey);
    if (currentState === undefined) {
      throw new Error(`Missing explored state ${currentKey}`);
    }

    for (const [actionName, action] of Object.entries(machine.actions)) {
      for (const env of enumerateBindings(machine, action)) {
        const nextState = step(machine, currentState, actionName, env);
        if (nextState === null) {
          continue;
        }

        const nextKey = canonicalizeState(machine, nextState);
        if (!states.has(nextKey)) {
          states.set(nextKey, nextState);
          pending.push(nextKey);
        }

        const actionLabel = formatActionLabel(machine, actionName, env);
        const edgeKey = `${currentKey}::${actionLabel}::${nextKey}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({ from: currentKey, to: nextKey, action: actionLabel });
        }
      }
    }
  }

  return {
    initial: [initialKey],
    states,
    edges
  };
};
