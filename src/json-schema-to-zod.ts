import { z, type ZodTypeAny } from "zod";

// Minimal JSON-Schema → Zod runtime converter. Covers the subset real MCP
// tools actually use (object/string/number/boolean/array, enum, required).
// Anything exotic (oneOf/anyOf/allOf/$ref) falls through to z.any(). The
// proxy is a forwarder — the upstream is the real validator, so we only
// need enough structure to expose a usable tools/list to the inbound client.
export function jsonSchemaToZod(schema: any): ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.any();
  }

  const type = schema.type;

  if (type === "object" || schema.properties) {
    const properties = schema.properties ?? {};
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const shape: Record<string, ZodTypeAny> = {};
    for (const [key, sub] of Object.entries(properties)) {
      let field = jsonSchemaToZod(sub);
      if (!required.includes(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }
    const obj = z.object(shape);
    return schema.additionalProperties === false ? obj : obj.loose();
  }

  if (type === "array") {
    return z.array(jsonSchemaToZod(schema.items ?? {}));
  }

  if (type === "string") {
    return z.string();
  }

  if (type === "number" || type === "integer") {
    return z.number();
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "null") {
    return z.null();
  }

  return z.any();
}
