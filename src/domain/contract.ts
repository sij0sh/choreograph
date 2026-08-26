import { canonicalJson, objectAt, type JsonValue } from "./json.ts";
import type { Workflow } from "./workflow.ts";
import { LIMITS } from "./limits.ts";

export type ContractErrors = readonly string[];

export interface ContractDescriptor {
  readonly id: string;
  readonly path: string;
  readonly schema?: JsonValue;
  readonly validate: (data: unknown) => ContractErrors;
}

export function contractError(workflow: Workflow, contractId: string | undefined, data: unknown, label: string): string | undefined {
  if (contractId === undefined) return undefined;
  const contract = workflow.contracts?.get(contractId);
  if (!contract) return `${label} references missing contract ${contractId}`;
  const errors = contract.validate(data === undefined ? {} : data);
  return errors.length > 0 ? `${label} violates contract ${contractId}: ${errors.join("; ")}` : undefined;
}

const TYPE_NAMES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
type TypeName = (typeof TYPE_NAMES)[number];

const SCHEMA_KEYS = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "additionalProperties",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "oneOf",
  "title",
  "description",
] as const;

const ONE_OF_MAX = 4;

type Validator = (value: unknown, pointer: string, errors: string[]) => void;

function at(pointer: string): string {
  return pointer === "" ? '""' : pointer;
}

function pointerJoin(pointer: string, token: string | number): string {
  const escaped = String(token).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${pointer}/${escaped}`;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(type: TypeName, value: unknown): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function stringBound(raw: Record<string, unknown>, key: "minLength" | "maxLength", label: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  return value;
}

function countBound(raw: Record<string, unknown>, key: "minItems" | "maxItems", label: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  return value;
}

function numberBound(raw: Record<string, unknown>, key: "minimum" | "maximum", label: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number`);
  }
  return value;
}

function compileSchema(raw: Record<string, unknown>, label: string, depth: number): Validator {
  if (depth > LIMITS.jsonDepth) {
    throw new Error(`${label} nests more than ${LIMITS.jsonDepth} schema levels`);
  }
  for (const key of Object.keys(raw)) {
    if (!(SCHEMA_KEYS as readonly string[]).includes(key)) throw new Error(`${label} uses unsupported keyword: ${key}`);
  }

  let types: ReadonlySet<TypeName> | undefined;
  if (raw.type !== undefined) {
    const list = Array.isArray(raw.type) ? raw.type : [raw.type];
    if (list.length === 0) throw new Error(`${label}.type must not be empty`);
    const names = new Set<TypeName>();
    for (const entry of list) {
      if (typeof entry !== "string" || !(TYPE_NAMES as readonly string[]).includes(entry)) {
        throw new Error(`${label}.type must be one of: ${TYPE_NAMES.join(", ")}`);
      }
      names.add(entry as TypeName);
    }
    types = names;
  }

  let required: readonly string[] | undefined;
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) throw new Error(`${label}.required must be a list`);
    required = raw.required.map((entry, index) => {
      if (typeof entry !== "string") throw new Error(`${label}.required[${index}] must be a string`);
      return entry;
    });
    if (new Set(required).size !== required.length) throw new Error(`${label}.required must not contain duplicates`);
  }

  let properties: Readonly<Record<string, Validator>> | undefined;
  if (raw.properties !== undefined) {
    const source = objectAt(raw.properties, `${label}.properties`);
    const compiled: Record<string, Validator> = Object.create(null) as Record<string, Validator>;
    for (const key of Object.keys(source)) {
      compiled[key] = compileSchema(objectAt(source[key], `${label}.properties.${key}`), `${label}.properties.${key}`, depth + 1);
    }
    properties = compiled;
  }

  let enumForms: readonly string[] | undefined;
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) throw new Error(`${label}.enum must be a non-empty list`);
    enumForms = (raw.enum as JsonValue[]).map((entry) => canonicalJson(entry));
  }

  let constForm: string | undefined;
  if (raw.const !== undefined) constForm = canonicalJson(raw.const as JsonValue);

  let additionalProperties: boolean | undefined;
  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== "boolean") throw new Error(`${label}.additionalProperties must be a boolean`);
    additionalProperties = raw.additionalProperties;
  }

  for (const key of ["title", "description"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`${label}.${key} must be a string`);
  }

  const minLength = stringBound(raw, "minLength", label);
  const maxLength = stringBound(raw, "maxLength", label);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new Error(`${label}.minLength must not exceed ${label}.maxLength`);
  }

  const minItems = countBound(raw, "minItems", label);
  const maxItems = countBound(raw, "maxItems", label);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new Error(`${label}.minItems must not exceed ${label}.maxItems`);
  }

  const minimum = numberBound(raw, "minimum", label);
  const maximum = numberBound(raw, "maximum", label);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error(`${label}.minimum must not exceed ${label}.maximum`);
  }

  let pattern: RegExp | undefined;
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== "string") throw new Error(`${label}.pattern must be a string`);
    try {
      pattern = new RegExp(raw.pattern);
    } catch {
      throw new Error(`${label}.pattern is not a valid regular expression`);
    }
  }

  let items: Validator | undefined;
  if (raw.items !== undefined) {
    items = compileSchema(objectAt(raw.items, `${label}.items`), `${label}.items`, depth + 1);
  }

  let oneOf: readonly Validator[] | undefined;
  if (raw.oneOf !== undefined) {
    if (!Array.isArray(raw.oneOf) || raw.oneOf.length < 2 || raw.oneOf.length > ONE_OF_MAX) {
      throw new Error(`${label}.oneOf must contain 2 to ${ONE_OF_MAX} schemas`);
    }
    oneOf = raw.oneOf.map((entry, index) =>
      compileSchema(objectAt(entry, `${label}.oneOf[${index}]`), `${label}.oneOf[${index}]`, depth + 1),
    );
  }

  return (value: unknown, pointer: string, errors: string[]): void => {
    if (types) {
      const matches = [...types].some((type) => matchesType(type, value));
      if (!matches) errors.push(`${at(pointer)}: expected type ${[...types].join("|")}, got ${typeOf(value)}`);
    }
    if (enumForms && !enumForms.includes(canonicalJson(value as JsonValue))) {
      errors.push(`${at(pointer)}: value is not one of the enum values`);
    }
    if (constForm !== undefined && canonicalJson(value as JsonValue) !== constForm) {
      errors.push(`${at(pointer)}: value does not equal the const value`);
    }
    if (typeof value === "string") {
      const length = [...value].length;
      if (minLength !== undefined && length < minLength) errors.push(`${at(pointer)}: shorter than minLength ${minLength}`);
      if (maxLength !== undefined && length > maxLength) errors.push(`${at(pointer)}: longer than maxLength ${maxLength}`);
      if (pattern && !pattern.test(value)) errors.push(`${at(pointer)}: does not match pattern ${pattern.source}`);
    }
    if (typeof value === "number") {
      if (minimum !== undefined && value < minimum) errors.push(`${at(pointer)}: below minimum ${minimum}`);
      if (maximum !== undefined && value > maximum) errors.push(`${at(pointer)}: above maximum ${maximum}`);
    }
    if (Array.isArray(value)) {
      if (minItems !== undefined && value.length < minItems) errors.push(`${at(pointer)}: fewer than minItems ${minItems}`);
      if (maxItems !== undefined && value.length > maxItems) errors.push(`${at(pointer)}: more than maxItems ${maxItems}`);
      if (items) value.forEach((entry, index) => items!(entry, pointerJoin(pointer, index), errors));
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (required) {
        for (const key of required) {
          if (!Object.hasOwn(record, key)) errors.push(`${pointerJoin(pointer, key)}: required property is missing`);
        }
      }
      if (properties) {
        for (const [key, validator] of Object.entries(properties)) {
          if (Object.hasOwn(record, key)) validator(record[key], pointerJoin(pointer, key), errors);
        }
      }
      if (additionalProperties === false) {
        const known = properties ?? {};
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(known, key)) errors.push(`${pointerJoin(pointer, key)}: property ${key} is not accepted`);
        }
      }
    }
    if (oneOf) {
      const matches = oneOf.filter((validator) => {
        const probe: string[] = [];
        validator(value, pointer, probe);
        return probe.length === 0;
      }).length;
      if (matches !== 1) errors.push(`${at(pointer)}: matches ${matches} of ${oneOf.length} oneOf schemas; exactly one is required`);
    }
  };
}

export function compileContract(value: unknown, label: string): (data: unknown) => ContractErrors {
  const validator = compileSchema(objectAt(value, label), label, 0);
  return (data: unknown): ContractErrors => {
    const errors: string[] = [];
    validator(data, "", errors);
    return errors;
  };
}
