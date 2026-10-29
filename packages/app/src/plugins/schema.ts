/**
 * A contribution's config form from its JSON Schema (draft 7, as the daemon's
 * loader checks it). An object schema gives one field per property: text,
 * number, integer, yes/no, a choice for an `enum`, JSON for anything else. A
 * schema that is not an object of properties gives one JSON field for the whole
 * config; one that takes nothing (`true`, `{}`, an object without properties)
 * gives no field. The daemon checks the result against the schema before it
 * saves it: this only shapes the form.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type FieldKind = "text" | "number" | "integer" | "boolean" | "choice" | "json";
export interface ConfigField {
  /** The property's name; "" for a whole config that is not an object of properties. */
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  /** A choice's values, as the schema's `enum` gives them (a number stays a number). */
  options?: (string | number | boolean)[];
  /** The value the field starts with: the saved one, else the schema's default. */
  value: string;
}

type Schema = { [key: string]: unknown };
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function kindOf(schema: Schema): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.every((v) => ["string", "number", "boolean"].includes(typeof v)))
    return "choice";
  if (schema.type === "string") return "text";
  if (schema.type === "number" || schema.type === "integer") return schema.type;
  if (schema.type === "boolean") return "boolean";
  return "json";
}

function shown(value: unknown, kind: FieldKind): string {
  if (value === undefined) return "";
  if (kind === "json") return JSON.stringify(value);
  return String(value);
}

function field(name: string, schema: Schema, required: boolean, value: unknown): ConfigField {
  const kind = kindOf(schema);
  return {
    name,
    label: typeof schema.title === "string" ? schema.title : name,
    kind,
    required,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(kind === "choice" ? { options: schema.enum as (string | number | boolean)[] } : {}),
    value: shown(value === undefined ? schema.default : value, kind),
  };
}

export function configFields(schema: unknown, config: unknown): ConfigField[] {
  if (schema === true || (isObject(schema) && Object.keys(schema).length === 0)) return [];
  if (!isObject(schema)) return [];
  const properties = isObject(schema.properties) ? schema.properties : null;
  if (!properties) {
    if (schema.type === "object") return [];
    return [{ ...field("", schema, true, config), label: "Config" }];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const saved = isObject(config) ? config : {};
  return Object.entries(properties).map(([name, property]) =>
    field(name, isObject(property) ? property : {}, required.has(name), saved[name]),
  );
}

/**
 * The config the form's values say, over the saved one (properties the form
 * does not show are kept). An empty field is left out, for the schema to say
 * whether it is required; a number or JSON that does not parse names its field.
 */
export function configValue(
  fields: readonly ConfigField[],
  saved: unknown,
  read: (name: string) => string,
): { config: Json } | { problem: string } {
  const values: { [key: string]: Json } = isObject(saved) ? { ...(saved as { [key: string]: Json }) } : {};
  for (const f of fields) {
    const raw = read(f.name).trim();
    let value: Json | undefined;
    if (raw === "") value = undefined;
    else if (f.kind === "number" || f.kind === "integer") {
      value = Number(raw);
      if (!Number.isFinite(value) || (f.kind === "integer" && !Number.isInteger(value)))
        return { problem: `${f.label} must be ${f.kind === "integer" ? "a whole number" : "a number"}` };
    } else if (f.kind === "boolean") value = raw === "true";
    else if (f.kind === "json") {
      try {
        value = JSON.parse(raw) as Json;
      } catch {
        return { problem: `${f.label} must be JSON` };
      }
    } else if (f.kind === "choice") value = f.options?.find((option) => String(option) === raw) ?? raw;
    else value = raw;
    if (f.name === "") return { config: value ?? {} };
    if (value === undefined) delete values[f.name];
    else values[f.name] = value;
  }
  return { config: values };
}
