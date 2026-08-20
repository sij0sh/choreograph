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
