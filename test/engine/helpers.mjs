import { compileContract } from "../../src/domain/contract.ts";

export function task(id, options = {}) {
  return { kind: "task", id, instructionPath: `steps/${id}.md`, ...options };
}

export function sequence(id, children) {
  return { kind: "sequence", id, children };
}

export function contractOf(id, schema) {
  return { id, path: `contracts/${id}.schema.json`, schema, validate: compileContract(schema, `contracts/${id}`) };
}

function contractsOf(map) {
  return new Map(Object.entries(map).map(([id, schema]) => [id, contractOf(id, schema)]));
}

export function workflow(children, options = {}) {
  const { contracts = {}, inputEdges = {}, ...rest } = options;
  return {
    name: options.name ?? "demo",
    title: options.title ?? "Demo",
    description: options.description ?? "A test workflow.",
    overviewPath: "WORKFLOW.md",
    piVisibility: false,
    root: sequence(options.rootId ?? "root", children),
    operators: new Map(),
    contracts: contractsOf(contracts),
    inputEdges: new Map(Object.entries(inputEdges)),
    ...rest,
  };
}

export function completed(checkpoint, met) {
  return { status: "completed", ...(met ? { met } : {}), checkpoint };
}

export function needsWork(checkpoint, issues) {
  return { status: "needs-work", checkpoint, ...(issues ? { issues } : {}) };
}

export function blocked(checkpoint) {
  return { status: "blocked", checkpoint };
}

export function cp(summary, data) {
  return { summary, ...(data !== undefined ? { data } : {}) };
}
