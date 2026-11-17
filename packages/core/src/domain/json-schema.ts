import { Ajv, type ErrorObject, type ValidateFunction } from "ajv"
import { Ajv2019 } from "ajv/dist/2019.js"
import { Ajv2020 } from "ajv/dist/2020.js"
import addFormatsModule from "ajv-formats"

import { ValidationError } from "./errors"

/**
 * JSON Schema support for tube `schemaDefinition` (plan §7.1).
 *
 * - Tube writes call `assertValidJsonSchema` so only compilable schemas are
 *   ever stored.
 * - Item pushes (ticket 04) call `validateJsonSchema(schema, payload)` and
 *   turn the returned issues into a 400.
 *
 * The draft is picked from `$schema`: 2020-12 (default when absent),
 * 2019-09 or draft-07/06/04-style (classic Ajv).
 */

type AnyAjv = InstanceType<typeof Ajv>

export type JsonSchemaIssue = {
  /** JSON Pointer to the offending value ("" = root). */
  path: string
  message: string
  keyword: string
}

const addFormats = addFormatsModule as unknown as (ajv: AnyAjv) => AnyAjv

// addUsedSchema: false → compiled schemas are not registered by `$id`, so
// two tubes may reuse the same `$id` without colliding.
const options = {
  allErrors: true,
  strict: false,
  addUsedSchema: false,
} as const
let instances: Record<"2020" | "2019" | "classic", AnyAjv> | undefined

function ajvFor(schema: Record<string, unknown>): AnyAjv {
  instances ??= {
    "2020": addFormats(new Ajv2020(options) as unknown as AnyAjv),
    "2019": addFormats(new Ajv2019(options) as unknown as AnyAjv),
    classic: addFormats(new Ajv(options)),
  }
  const dialect = typeof schema.$schema === "string" ? schema.$schema : ""
  if (dialect.includes("2019-09")) return instances["2019"]
  if (/draft-0\d/.test(dialect)) return instances.classic
  return instances["2020"]
}

function toIssues(errors: ErrorObject[] | null | undefined): JsonSchemaIssue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? "is invalid",
    keyword: e.keyword,
  }))
}

/** Compiled validators keyed by the schema's JSON text (schemas are small). */
const cache = new Map<string, ValidateFunction>()
const CACHE_LIMIT = 500

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema)
  const hit = cache.get(key)
  if (hit) return hit
  const ajv = ajvFor(schema)
  if (!ajv.validateSchema(schema)) {
    throw new ValidationError(
      "schemaDefinition is not a valid JSON Schema",
      toIssues(ajv.errors).map((i) => ({
        ...i,
        path: `schemaDefinition${i.path.replaceAll("/", ".")}`,
      }))
    )
  }
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new ValidationError("schemaDefinition is not a valid JSON Schema", [
      {
        path: "schemaDefinition",
        message: error instanceof Error ? error.message : String(error),
        keyword: "compile",
      },
    ])
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, validate)
  return validate
}

/** Throws `ValidationError` (→ 400) unless `schema` is a compilable JSON Schema. */
export function assertValidJsonSchema(schema: Record<string, unknown>): void {
  compile(schema)
}

/** Validates `data` against `schema`; returns `[]` when valid. */
export function validateJsonSchema(
  schema: Record<string, unknown>,
  data: unknown
): JsonSchemaIssue[] {
  const validate = compile(schema)
  return validate(data) ? [] : toIssues(validate.errors)
}
