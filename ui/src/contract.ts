type Schema = Record<string, unknown>;

/** What the form draws for one property of a contract. */
export type Shape = "yes-no" | "tick" | "one-of" | "number" | "string" | "lines" | "json";

/** A property whose shape the form can draw, or `json` for any other shape. */
export function shapeOf(field: Schema): Shape {
  if (Array.isArray(field.enum)) return "one-of";
  if (field.type === "boolean") return "yes-no";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "string") return "string";
  if (field.type === "array") {
    const of = field.items as Schema | undefined;
    return of === undefined || of.type === "string" ? "lines" : "json";
  }
  return "json";
}

/** Required names that a person has not answered. An empty value is an answer. */
export function missingRequired(value: Record<string, unknown>, required: string[]): string[] {
  return required.filter((key) => !Object.hasOwn(value, key) || value[key] === undefined);
}

/** Empty values that a required text or list field can send under JSON Schema. */
export function requiredDefaults(
  properties: Record<string, Schema>,
  required: string[],
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const key of required) {
    const shape = shapeOf(properties[key] ?? {});
    if (shape === "string") value[key] = "";
    if (shape === "lines") value[key] = [];
  }
  return value;
}

/** Writes one answered field. An undefined field stays absent from the request. */
export function writeField(value: Record<string, unknown>, key: string, next: unknown): Record<string, unknown> {
  const written = { ...value };
  if (next === undefined) delete written[key];
  else written[key] = next;
  return written;
}

/** Reads the JSON editor before the page returns to the contract form. */
export function readFields(text: string): { value: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (problem) {
    return { error: `That is not JSON: ${problem instanceof Error ? problem.message : String(problem)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "The form takes one JSON object." };
  }
  return { value: value as Record<string, unknown> };
}

/** Names fields that still hold draft text instead of a JSON value. */
export function unreadableFields(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => typeof value[key] === "symbol");
}

/** Starts JSON editing, or keeps exact field drafts when a value is unreadable. */
export function beginJsonEdit(
  value: Record<string, unknown>,
  drafts: Record<string, string>,
): { raw: true; text: string } | { raw: false; error: string; drafts: Record<string, string> } {
  const unreadable = unreadableFields(value);
  if (unreadable.length > 0) {
    return {
      raw: false,
      error: `${unreadable.join(", ")} holds something that is not JSON.`,
      drafts,
    };
  }
  return { raw: true, text: JSON.stringify(value, null, 2) };
}
