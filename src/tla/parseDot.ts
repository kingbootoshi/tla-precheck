import type { JsonValue, ResolvedMachineDef } from "../core/dsl.js";
import { NULL_VALUE } from "../core/proof.js";
import { stableStringify } from "../core/stable.js";

export interface ParsedTlcGraph {
  initial: readonly string[];
  states: ReadonlyMap<string, JsonValue>;
  edges: readonly { from: string; to: string; action: string }[];
}

const unescapeDotLabel = (value: string): string =>
  value
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

const canonicalizeActionLabel = (
  value: string,
  actionLabels: Readonly<Record<string, string>>
): string => {
  const canonical = unescapeDotLabel(value).trim();
  return actionLabels[canonical] ?? canonical;
};
const isInitialNodeSuffix = (value: string): boolean => /style\s*=\s*"?filled"?/.test(value);

interface Token {
  kind: string;
  text: string;
}

const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;

  const push = (kind: string, text: string): void => {
    tokens.push({ kind, text });
    index += text.length;
  };

  while (index < input.length) {
    const rest = input.slice(index);

    const whitespace = rest.match(/^\s+/);
    if (whitespace !== null) {
      index += whitespace[0].length;
      continue;
    }

    const symbol =
      rest.startsWith("<<")
        ? "<<"
        : rest.startsWith(">>")
          ? ">>"
          : rest.startsWith("@@")
            ? "@@"
            : rest.startsWith(":>")
              ? ":>"
              : rest.startsWith("|->")
                ? "|->"
                : null;

    if (symbol !== null) {
      push(symbol, symbol);
      continue;
    }

    const punctuator = rest[0];
    if ("{}[](),".includes(punctuator)) {
      push(punctuator, punctuator);
      continue;
    }

    const stringLiteral = rest.match(/^"(?:\\.|[^"\\])*"/);
    if (stringLiteral !== null) {
      push("string", stringLiteral[0]);
      continue;
    }

    const numberLiteral = rest.match(/^-?\d+/);
    if (numberLiteral !== null) {
      push("number", numberLiteral[0]);
      continue;
    }

    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier !== null) {
      push("identifier", identifier[0]);
      continue;
    }

    throw new Error(`Could not tokenize TLA value near: ${rest.slice(0, 40)}`);
  }

  return tokens;
};

class Cursor {
  private readonly tokens: readonly Token[];
  private position = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | null {
    return this.tokens[this.position] ?? null;
  }

  consume(expected?: string): Token {
    const token = this.tokens[this.position];
    if (token === undefined) {
      throw new Error(`Unexpected end of token stream; expected ${expected ?? "token"}`);
    }
    if (expected !== undefined && token.kind !== expected && token.text !== expected) {
      throw new Error(`Expected ${expected}, received ${token.text}`);
    }
    this.position += 1;
    return token;
  }
}

const parseAtomic = (cursor: Cursor): JsonValue => {
  const token = cursor.peek();
  if (token === null) {
    throw new Error("Unexpected end of TLA value");
  }

  if (token.kind === "string") {
    const value = JSON.parse(cursor.consume("string").text) as string;
    return value === NULL_VALUE ? null : value;
  }

  if (token.kind === "number") {
    return Number.parseInt(cursor.consume("number").text, 10);
  }

  if (token.kind === "identifier") {
    const text = cursor.consume("identifier").text;
    if (text === "TRUE") {
      return true;
    }
    if (text === "FALSE") {
      return false;
    }
    if (text === "Null") {
      return null;
    }
    return text;
  }

  if (token.text === "{") {
    cursor.consume("{");
    const items: JsonValue[] = [];
    while (cursor.peek()?.text !== "}") {
      items.push(parseValue(cursor));
      if (cursor.peek()?.text === ",") {
        cursor.consume(",");
      }
    }
    cursor.consume("}");
    return items.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  }

  if (token.text === "<<") {
    cursor.consume("<<");
    const items: JsonValue[] = [];
    while (cursor.peek()?.text !== ">>") {
      items.push(parseValue(cursor));
      if (cursor.peek()?.text === ",") {
        cursor.consume(",");
      }
    }
    cursor.consume(">>");
    return items;
  }

  if (token.text === "[") {
    cursor.consume("[");
    const out: Record<string, JsonValue> = {};
    while (cursor.peek()?.text !== "]") {
      const key = String(parseValue(cursor));
      cursor.consume("|->");
      out[key] = parseValue(cursor);
      if (cursor.peek()?.text === ",") {
        cursor.consume(",");
      }
    }
    cursor.consume("]");
    return out;
  }

  if (token.text === "(") {
    cursor.consume("(");
    const out: Record<string, JsonValue> = {};
    while (cursor.peek()?.text !== ")") {
      const key = String(parseValue(cursor));
      cursor.consume(":>");
      out[key] = parseValue(cursor);
      if (cursor.peek()?.text === "@@") {
        cursor.consume("@@");
      }
    }
    cursor.consume(")");
    return out;
  }

  throw new Error(`Unsupported token ${token.text}`);
};

const parseValue = (cursor: Cursor): JsonValue => parseAtomic(cursor);

const parseAssignmentLine = (line: string): [string, JsonValue] => {
  const normalized = line.replace(/^\/\\\s*/, "").trim();
  const separator = normalized.indexOf("=");
  if (separator === -1) {
    throw new Error(`Could not parse assignment line: ${line}`);
  }

  const name = normalized.slice(0, separator).trim();
  const valueText = normalized.slice(separator + 1).trim();
  const cursor = new Cursor(tokenize(valueText));
  const value = parseValue(cursor);
  return [name, value];
};

const parseNodeLabel = (machine: ResolvedMachineDef, rawLabel: string): JsonValue => {
  const lines = unescapeDotLabel(rawLabel)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const assignments: string[] = [];
  let current = "";

  for (const line of lines) {
    if (line.startsWith("/\\") || current.length === 0 || line.includes("=")) {
      if (current.length > 0) {
        assignments.push(current);
      }
      current = line;
      continue;
    }

    if (current.length === 0) {
      throw new Error(`Could not parse node label line without assignment prefix: ${line}`);
    }

    current = `${current} ${line}`;
  }

  if (current.length > 0) {
    assignments.push(current);
  }

  const parsed = Object.fromEntries(assignments.map((line) => parseAssignmentLine(line)));
  return Object.fromEntries(
    Object.keys(machine.variables)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, parsed[name] ?? null])
  );
};

export const parseTlcDot = (
  machine: ResolvedMachineDef,
  source: string,
  actionLabels: Readonly<Record<string, string>> = {}
): ParsedTlcGraph => {
  const nodePattern = /^\s*([\-\d]+) \[label="((?:\\.|[^"\\])*)"([^\]]*)\]/;
  const edgePattern = /^\s*([\-\d]+) -> ([\-\d]+) \[label="((?:\\.|[^"\\])*)"/;

  const nodeIdToCanon = new Map<string, string>();
  const states = new Map<string, JsonValue>();
  const initial = new Set<string>();
  const rawEdges: { fromId: string; toId: string; action: string }[] = [];
  const edges: { from: string; to: string; action: string }[] = [];

  for (const line of source.split(/\r?\n/)) {
    const nodeMatch = line.match(nodePattern);
    if (nodeMatch !== null) {
      const [, nodeId, rawLabel, suffix] = nodeMatch;
      const state = parseNodeLabel(machine, rawLabel);
      const canonical = stableStringify(state);
      nodeIdToCanon.set(nodeId, canonical);
      states.set(canonical, state);
      if (isInitialNodeSuffix(suffix)) {
        initial.add(canonical);
      }
      continue;
    }

    const edgeMatch = line.match(edgePattern);
    if (edgeMatch !== null) {
      const [, fromId, toId, rawAction] = edgeMatch;
      rawEdges.push({
        fromId,
        toId,
        action: canonicalizeActionLabel(rawAction, actionLabels)
      });
    }
  }

  for (const edge of rawEdges) {
    const from = nodeIdToCanon.get(edge.fromId);
    const to = nodeIdToCanon.get(edge.toId);
    if (from === undefined || to === undefined) {
      throw new Error(`Could not resolve DOT edge ${edge.fromId} -> ${edge.toId}`);
    }
    edges.push({ from, to, action: edge.action });
  }

  return {
    initial: [...initial].sort(),
    states,
    edges
  };
};
