import type { ActionDef, Primitive, ResolvedMachineDef } from "./dsl.js";

export type ActionLabelEnv = Record<string, Primitive>;

type LabelMachine = Pick<ResolvedMachineDef, "actions" | "domains" | "resolvedTier">;

export const renderBindingValue = (
  machine: LabelMachine,
  domainName: string,
  value: Primitive
): string => {
  const domain = machine.resolvedTier.domains[domainName];
  if (domain === undefined) {
    throw new Error(`Unknown domain ${domainName}`);
  }

  if (typeof value !== "string") {
    throw new Error(`Action parameter ${domainName} must resolve to a string value`);
  }

  return domain.kind === "modelValues" ? value : JSON.stringify(value);
};

export const formatActionLabel = (
  machine: LabelMachine,
  actionName: string,
  env: ActionLabelEnv
): string => {
  const action: ActionDef | undefined = machine.actions[actionName];
  if (action === undefined) {
    throw new Error(`Unknown action ${actionName}`);
  }

  const paramNames = Object.keys(action.params);
  if (paramNames.length === 0) {
    return actionName;
  }

  const renderedBindings = paramNames.map((name) =>
    renderBindingValue(machine, action.params[name], env[name])
  );
  return `${actionName}(${renderedBindings.join(",")})`;
};
