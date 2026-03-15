import { createHash } from "node:crypto";

import type { ResolvedMachineDef } from "../core/dsl.js";
import type { StateGraph } from "../core/interpreter.js";
import type { ParsedTlcGraph } from "./parseDot.js";

export interface VerificationCertificate {
  certificateVersion: 1;
  machine: string;
  tier: string;
  machineSha256: string;
  graphHash: string;
  tsStateCount: number;
  tlcStateCount: number;
  tsEdgeCount: number;
  tlcEdgeCount: number;
  equivalent: boolean;
  checkedAt: string;
  tlcOutput?: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const edgeSet = (graph: { edges: readonly { from: string; to: string; action: string }[] }): Set<string> =>
  new Set(graph.edges.map((edge) => `${edge.from}::${edge.action}::${edge.to}`));

const stateSet = (graph: { states: ReadonlyMap<string, unknown> }): Set<string> => new Set(graph.states.keys());

export const compareGraphs = (
  machine: ResolvedMachineDef,
  tsGraph: StateGraph,
  tlcGraph: ParsedTlcGraph,
  tlcOutput?: string
): VerificationCertificate => {
  const tsStates = stateSet(tsGraph);
  const tlcStates = stateSet(tlcGraph);
  const tsEdges = edgeSet(tsGraph);
  const tlcEdges = edgeSet(tlcGraph);

  const equalStates = tsStates.size === tlcStates.size && [...tsStates].every((state) => tlcStates.has(state));
  const equalEdges = tsEdges.size === tlcEdges.size && [...tsEdges].every((edge) => tlcEdges.has(edge));
  const equalInitial =
    tsGraph.initial.length === tlcGraph.initial.length &&
    tsGraph.initial.every((state) => tlcGraph.initial.includes(state));

  const graphMaterial = JSON.stringify({
    initial: [...tsGraph.initial].sort(),
    states: [...tsStates].sort(),
    edges: [...tsEdges].sort()
  });

  return {
    certificateVersion: 1,
    machine: machine.moduleName,
    tier: machine.resolvedTier.name,
    machineSha256: hash(JSON.stringify(machine)),
    graphHash: hash(graphMaterial),
    tsStateCount: tsStates.size,
    tlcStateCount: tlcStates.size,
    tsEdgeCount: tsEdges.size,
    tlcEdgeCount: tlcEdges.size,
    equivalent: equalStates && equalEdges && equalInitial,
    checkedAt: new Date().toISOString(),
    tlcOutput
  };
};
