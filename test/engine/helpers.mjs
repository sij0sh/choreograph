export function task(id, options = {}) {
  return { kind: "task", id, instructionPath: `steps/${id}.md`, ...options };
}

export function sequence(id, children) {
  return { kind: "sequence", id, children };
}

export function workflow(children, options = {}) {
  return {
    name: options.name ?? "demo",
    title: options.title ?? "Demo",
    description: options.description ?? "A test workflow.",
    overviewPath: "WORKFLOW.md",
    piVisibility: false,
    root: sequence(options.rootId ?? "root", children),
    operators: new Map(),
    ...options,
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
