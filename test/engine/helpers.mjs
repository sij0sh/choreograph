import { createHash } from "node:crypto";
import { compileContract } from "../../src/domain/contract.ts";

/**
 * An in-memory artifact sink provider for engine tests. Published references carry real
 * sha-256 digests of the JSON bytes, so identical runs stay identical.
 */
export function memoryStore() {
  const published = [];
  const sinkFor = (invocationKey) => ({
    publishJson(name, value) {
      const content = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      const ref = {
        invocationKey,
        output: name,
        checksum: `sha256-${createHash("sha256").update(content).digest("hex")}`,
        size: content.length,
        mediaType: "application/json",
      };
      published.push({ invocationKey, name, ref, value });
      return ref;
    },
  });
  return { sinkFor, published };
}

export function task(id, options = {}) {
  return { kind: "task", id, instructionPath: `steps/${id}.md`, ...options };
}

export function script(id, options = {}) {
  const { spec, ...rest } = options;
  return {
    kind: "script",
    id,
    script: {
      argv: ["node", "-e", "process.stdout.write('ok')"],
      cwd: ".",
      timeoutMs: 10_000,
      acceptedExitCodes: [0],
      stdout: "text",
      stderr: "none",
      maxCaptureBytes: 65_536,
      ...spec,
    },
    ...rest,
  };
}

export function sequence(id, children) {
  return { kind: "sequence", id, children };
}

export function loop(id, mode, options = {}) {
  const bodyStep = task(options.bodyId ?? `${id}-step`, options.body ?? {});
  return {
    kind: "loop",
    id,
    mode,
    body: sequence(`${id}-body`, [bodyStep]),
    maxIterations: options.maxIterations ?? 8,
    ...(mode === "for-each" ? { itemsBinding: options.itemsBinding ?? { from: "gather", select: "/data/files" } } : {}),
    ...(mode === "repeat-until" ? { condition: options.condition ?? { from: bodyStep.id, select: "/data/exitCode", op: "equals", value: 0 } } : {}),
  };
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
