export interface WorkflowStep {
  readonly label: string;
  readonly path: string;
}

export interface WorkflowDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly overviewPath: string;
  readonly steps: readonly WorkflowStep[];
  readonly piVisibility: boolean;
  readonly legalTools?: ReadonlySet<string>;
}

export interface WorkflowDiagnostic {
  readonly path: string;
  readonly error: string;
}
