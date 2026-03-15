import { createHash } from "node:crypto";

import type { ResolvedMachineDef } from "../core/dsl.js";
import type { StateGraph } from "../core/interpreter.js";
import type { ParsedTlcGraph } from "./parseDot.js";

export interface GraphComparisonResult {
  graphHash: string;
  tsStateCount: number;
  tlcStateCount: number;
  tsEdgeCount: number;
  tlcEdgeCount: number;
  equivalent: boolean;
}

export interface VerificationCertificate {
  certificateVersion: 2;
  machine: string;
  tier: string;
  machineSha256: string;
  checkedAt: string;
  proofPassed: boolean;
  proofSpecification: "Spec";
  graphEquivalenceAttempted: boolean;
  graphEquivalenceSpecification?: "EquivalenceSpec";
  invariantsChecked: readonly string[];
  propertiesChecked: readonly string[];
  deadlockChecked: boolean;
  symmetryUsedInProof: boolean;
  equivalent: boolean | null;
  graphHash?: string;
  tsStateCount?: number;
  tlcStateCount?: number;
  tsEdgeCount?: number;
  tlcEdgeCount?: number;
  proofOutput?: string;
  equivalenceOutput?: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const edgeSet = (graph: { edges: readonly { from: string; to: string; action: string }[] }): Set<string> =>
  new Set(graph.edges.map((edge) => `${edge.from}::${edge.action}::${edge.to}`));

const stateSet = (graph: { states: ReadonlyMap<string, unknown> }): Set<string> => new Set(graph.states.keys());

export const compareGraphs = (
  tsGraph: StateGraph,
  tlcGraph: ParsedTlcGraph
): GraphComparisonResult => {
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
    graphHash: hash(graphMaterial),
    tsStateCount: tsStates.size,
    tlcStateCount: tlcStates.size,
    tsEdgeCount: tsEdges.size,
    tlcEdgeCount: tlcEdges.size,
    equivalent: equalStates && equalEdges && equalInitial
  };
};

interface BuildVerificationCertificateOptions {
  machine: ResolvedMachineDef;
  proofPassed: boolean;
  graphEquivalenceAttempted: boolean;
  graphComparison?: GraphComparisonResult;
  proofOutput?: string;
  equivalenceOutput?: string;
}

export const buildVerificationCertificate = ({
  machine,
  proofPassed,
  graphEquivalenceAttempted,
  graphComparison,
  proofOutput,
  equivalenceOutput
}: BuildVerificationCertificateOptions): VerificationCertificate => {
  const equivalent = graphComparison?.equivalent ?? null;

  return {
    certificateVersion: 2,
    machine: machine.moduleName,
    tier: machine.resolvedTier.name,
    machineSha256: hash(JSON.stringify(machine)),
    checkedAt: new Date().toISOString(),
    proofPassed,
    proofSpecification: "Spec",
    graphEquivalenceAttempted,
    graphEquivalenceSpecification: graphEquivalenceAttempted ? "EquivalenceSpec" : undefined,
    invariantsChecked: machine.resolvedTier.invariants,
    propertiesChecked: machine.resolvedTier.properties,
    deadlockChecked: machine.resolvedTier.checks.deadlock,
    symmetryUsedInProof: machine.resolvedTier.symmetryDomains.length > 0,
    equivalent,
    graphHash: graphComparison?.graphHash,
    tsStateCount: graphComparison?.tsStateCount,
    tlcStateCount: graphComparison?.tlcStateCount,
    tsEdgeCount: graphComparison?.tsEdgeCount,
    tlcEdgeCount: graphComparison?.tlcEdgeCount,
    proofOutput,
    equivalenceOutput
  };
};
