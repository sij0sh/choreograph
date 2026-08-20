export type StepKind = "static" | "planner" | "executor";

export interface StepRoutes {
  readonly pass?: string;
  readonly rework?: string;
  readonly replan?: string;
}

export interface WorkflowStep {
  /** Absolute path to the step's Markdown file. */
  readonly path: string;
  /** Display label derived from the file name. */
  readonly label: string;
  /** Stable routing identifier; defaults to the derived label. */
  readonly id: string;
  /** Static unless explicitly declared planner or executor. */
  readonly kind: StepKind;
  /** Tool ceiling for this step; undefined inherits the enclosing ceiling. */
  readonly tools?: ReadonlySet<string>;
  /** Optional `provider/model-id` selector applied while this step runs. */
  readonly model?: string;
  /** Criterion IDs required for a passing transition. */
  readonly done?: readonly string[];
  /** Non-default transition destinations. */
  readonly on?: StepRoutes;
}

export interface OperatorDescriptor {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly tools?: ReadonlySet<string>;
}

export interface WorkflowDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly overviewPath: string;
  readonly steps: readonly WorkflowStep[];
  readonly piVisibility: boolean;
  /** Workflow tool ceiling; undefined means the captured baseline. */
  readonly tools?: ReadonlySet<string>;
  /** Optional `provider/model-id` default for steps. */
  readonly model?: string;
  /** True when any step is a structured mapping rather than a path string. */
  readonly structured: boolean;
  /** Trusted operator registry keyed by operator ID. */
  readonly operators: ReadonlyMap<string, OperatorDescriptor>;
}

export interface WorkflowDiagnostic {
  readonly path: string;
  readonly error: string;
}

// --- Dynamic execution domain (shared by state, plan, and runtime) ---

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Checkpoint {
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly data?: JsonValue;
}

export interface NodeResult {
  readonly id: string;
  readonly summary: string;
  readonly evidence?: readonly string[];
  readonly decisions?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly data?: JsonValue;
}

export interface DynamicPlanNode {
  readonly id: string;
  readonly operator: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly evidence?: readonly string[];
  readonly done: readonly string[];
  readonly tools?: readonly string[];
}

export interface DynamicPlan {
  readonly version: 1;
  readonly nodes: readonly DynamicPlanNode[];
}

export interface ExecutionState {
  readonly plan: DynamicPlan;
  readonly revision: number;
  readonly replans: number;
  readonly results: Readonly<Record<string, NodeResult>>;
}

export interface WorkflowMemory {
  readonly steps: Readonly<Record<string, Checkpoint>>;
  readonly execution?: ExecutionState;
}

export type RunPosition =
  | { readonly kind: "step"; readonly stepId: string }
  | { readonly kind: "node"; readonly stepId: string; readonly revision: number; readonly nodeId: string; readonly attempt: number };

export const LIMITS = {
  stepFileBytes: 128_000,
  checkpointSummaryBytes: 4_096,
  checkpointBytes: 16_384,
  nodeResultBytes: 8_192,
  planBytes: 32_768,
  memoryBytes: 131_072,
  planNodes: 8,
  nodeAttempts: 2,
  replans: 2,
  jsonDepth: 8,
  checkpointListItems: 8,
  checkpointItemBytes: 512,
  planNodeObjectiveBytes: 512,
  planNodeListItems: 8,
} as const;

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.keys(entry as Record<string, unknown>).sort().reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = (entry as Record<string, unknown>)[key];
        return sorted;
      }, {});
    }
    return entry;
  });
}

export function canonicalJsonBytes(value: JsonValue): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(jsonDepth));
  const entries = Object.values(value as Record<string, unknown>);
  return 1 + Math.max(0, ...entries.map(jsonDepth));
}
