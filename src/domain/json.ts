export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.keys(entry as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
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

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return true;
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
