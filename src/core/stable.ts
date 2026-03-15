import type { JsonValue } from "./dsl.js";

const sortObject = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)])
    );
  }

  return value;
};

export const stableStringify = (value: JsonValue): string => JSON.stringify(sortObject(value));

export const deepClone = <T>(value: T): T => structuredClone(value);

export const deepEqual = (left: JsonValue, right: JsonValue): boolean =>
  stableStringify(left) === stableStringify(right);
