import { canonicalJson, type JsonValue } from "../domain/json.ts";
import { LIMITS } from "../domain/limits.ts";
import type { Execution } from "../domain/execution.ts";
import type { InputBinding, Workflow } from "../domain/workflow.ts";
import { resolveBinding } from "./artifacts.ts";

type InputLine =
  | { readonly kind: "value"; readonly name: string; readonly from: string; readonly value: JsonValue; readonly json: string; readonly bytes: number }
  | { readonly kind: "error"; readonly name: string; readonly from: string; readonly error: string };

const INPUT_HEADER = ["## Inputs", "Declared artifacts from earlier positions:"].join("\n");

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let clipped = value;
  while (Buffer.byteLength(clipped, "utf8") > maxBytes - 3) clipped = clipped.slice(0, Math.max(0, clipped.length - 16));
  return `${clipped}...`;
}

function valueHint(value: JsonValue): string {
  if (Array.isArray(value)) return `Array with ${value.length} items.`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return `Top-level keys: ${clip(keys.length > 0 ? keys.join(", ") : "(none)", 512)}.`;
  }
  return "Scalar value.";
}

function overBudgetError(line: Extract<InputLine, { kind: "value" }>): InputLine {
  return {
    kind: "error",
    name: line.name,
    from: line.from,
    error: `input exceeds the position input budget of ${LIMITS.positionInputsBytes} bytes; ${valueHint(line.value)} Narrow it with a select pointer.`,
  };
}

function renderInputLine(line: InputLine): string {
  const name = clip(line.name, 256);
  const from = clip(line.from, 256);
  if (line.kind === "error") return `- \`${name}\` from \`${from}\`: ${clip(line.error, 1_024)}`;
  return `- \`${name}\` from \`${from}\`:\n\n\`\`\`json\n${line.json}\n\`\`\``;
}

function renderedBytes(lines: readonly InputLine[]): number {
  return Buffer.byteLength([INPUT_HEADER, ...lines.map(renderInputLine)].join("\n"), "utf8");
}

function renderInputs(workflow: Workflow, state: Execution, bindings: Readonly<Record<string, InputBinding>>): InputLine[] {
  const current: InputLine[] = Object.entries(bindings).map(([name, binding]) => {
    const resolved = resolveBinding(workflow, state, binding);
    if (!resolved.ok) return { kind: "error", name, from: binding.from, error: resolved.error };
    const json = canonicalJson(resolved.value);
    return { kind: "value" as const, name, from: binding.from, value: resolved.value, json, bytes: Buffer.byteLength(json, "utf8") };
  });
  const byName = new Map(current.map((line, index) => [line.name, index]));
  const droppable = current
    .filter((line): line is Extract<InputLine, { kind: "value" }> => line.kind === "value")
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  for (const line of droppable) {
    if (renderedBytes(current) <= LIMITS.positionInputsBytes) break;
    current[byName.get(line.name)!] = overBudgetError(line);
  }
  return current;
}

export function inputSection(workflow: Workflow, state: Execution, bindings: Readonly<Record<string, InputBinding>> | undefined): string {
  if (!bindings || Object.keys(bindings).length === 0) return "";
  return [INPUT_HEADER, ...renderInputs(workflow, state, bindings).map(renderInputLine)].join("\n");
}
