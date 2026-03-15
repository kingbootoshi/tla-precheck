export const NULL_SENTINEL = "__NULL__";
export const RESERVED_DOMAIN_VALUE = NULL_SENTINEL;
export const GENERATED_ACTION_PREFIX = "Action";
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

const RESERVED_COMPILER_NAMES = new Set([
  "Null",
  "TypeOK",
  "Init",
  "Next",
  "Spec",
  "EquivalenceNext",
  "EquivalenceSpec",
  "Symmetry",
  "vars"
]);

export const isValidIdentifier = (value: string): boolean => IDENTIFIER_PATTERN.test(value);

export const isReservedCompilerName = (value: string): boolean =>
  RESERVED_COMPILER_NAMES.has(value) || value.startsWith(GENERATED_ACTION_PREFIX);

export const assertIdentifier = (value: string, context: string): void => {
  if (!isValidIdentifier(value)) {
    throw new Error(`${context} must be a valid TLA identifier prefix; received ${JSON.stringify(value)}`);
  }
};
