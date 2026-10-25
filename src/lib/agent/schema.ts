import "server-only";

/**
 * A deliberately small JSON-Schema subset used to describe and validate tool
 * arguments. Tool arguments come from the model, so they are untrusted input.
 */
/** An error whose message is safe to show to the user and the model. */
export class ToolError extends Error {}

export type PropertySchema =
  | { type: "string"; description?: string; maxLength?: number; enum?: string[] }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "number"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  /** Fixed-length list of numbers, e.g. [x, y, z]. */
  | { type: "array"; description?: string; items: { type: "number"; minimum?: number; maximum?: number }; minItems: number; maxItems: number };

export type ObjectSchema = {
  type: "object";
  properties: Record<string, PropertySchema>;
  required: string[];
  additionalProperties: false;
};

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function validateArgs(schema: ObjectSchema, input: unknown): ValidationResult {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Arguments must be a JSON object." };
  const args = input as Record<string, unknown>;

  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      return { ok: false, error: `Unknown argument "${key}". Allowed: ${Object.keys(schema.properties).join(", ") || "none"}.` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined || value === null) {
      if (schema.required.includes(key)) return { ok: false, error: `Missing required argument "${key}".` };
      continue;
    }
    switch (prop.type) {
      case "string":
        if (typeof value !== "string") return { ok: false, error: `Argument "${key}" must be a string.` };
        if (prop.maxLength !== undefined && value.length > prop.maxLength) {
          return { ok: false, error: `Argument "${key}" is too long (max ${prop.maxLength} characters).` };
        }
        if (prop.enum && !prop.enum.includes(value)) {
          return { ok: false, error: `Argument "${key}" must be one of: ${prop.enum.join(", ")}.` };
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, error: `Argument "${key}" must be a whole number.` };
        if (prop.minimum !== undefined && value < prop.minimum) return { ok: false, error: `Argument "${key}" must be at least ${prop.minimum}.` };
        if (prop.maximum !== undefined && value > prop.maximum) return { ok: false, error: `Argument "${key}" must be at most ${prop.maximum}.` };
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `Argument "${key}" must be a number.` };
        if (prop.minimum !== undefined && value < prop.minimum) return { ok: false, error: `Argument "${key}" must be at least ${prop.minimum}.` };
        if (prop.maximum !== undefined && value > prop.maximum) return { ok: false, error: `Argument "${key}" must be at most ${prop.maximum}.` };
        break;
      case "boolean":
        if (typeof value !== "boolean") return { ok: false, error: `Argument "${key}" must be true or false.` };
        break;
      case "array": {
        const n = prop.minItems === prop.maxItems ? `${prop.minItems}` : `${prop.minItems}-${prop.maxItems}`;
        if (!Array.isArray(value) || value.length < prop.minItems || value.length > prop.maxItems) {
          return { ok: false, error: `Argument "${key}" must be a list of ${n} numbers.` };
        }
        const { minimum, maximum } = prop.items;
        for (const v of value) {
          if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `Argument "${key}" must contain only numbers.` };
          if ((minimum !== undefined && v < minimum) || (maximum !== undefined && v > maximum)) {
            return { ok: false, error: `Values in "${key}" must be between ${minimum ?? "-∞"} and ${maximum ?? "∞"}.` };
          }
        }
        break;
      }
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}
