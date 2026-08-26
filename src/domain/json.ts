export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.keys(entry as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          Object.defineProperty(sorted, key, { value: (entry as Record<string, unknown>)[key], enumerable: true, configurable: true, writable: true });
          return sorted;
        }, Object.create(null) as Record<string, unknown>);
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

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "string") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type === "object") return Object.values(value).every(isJsonValue);
  return false;
}

export function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (!isJsonValue(left) || !isJsonValue(right)) return false;
  return canonicalJson(left) === canonicalJson(right);
}

const JSON_POINTER_PATTERN = /^\/(?:[^~]|~[01])*$/;

export function isValidJsonPointer(pointer: string): boolean {
  return pointer === "" || JSON_POINTER_PATTERN.test(pointer);
}

export type PointerResult = { ok: true; value: JsonValue } | { ok: false; error: string };

export function jsonPointerGet(value: JsonValue, pointer: string): PointerResult {
  if (!isValidJsonPointer(pointer)) return { ok: false, error: `pointer ${pointer} is not valid JSON Pointer syntax` };
  if (pointer === "") return { ok: true, value };
  const tokens = pointer.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: JsonValue = value;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(token) ? Number(token) : -1;
      if (index < 0 || index >= current.length) {
        return { ok: false, error: `pointer ${pointer} does not resolve: index ${token} is out of bounds` };
      }
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, JsonValue>;
      if (!Object.hasOwn(record, token)) {
        return { ok: false, error: `pointer ${pointer} does not resolve: missing key ${token}` };
      }
      current = record[token];
      continue;
    }
    return { ok: false, error: `pointer ${pointer} does not resolve: ${token} targets a scalar` };
  }
  return { ok: true, value: current };
}
