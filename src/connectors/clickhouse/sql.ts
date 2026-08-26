/**
 * Pure ClickHouse SQL/type helpers used by the connector.
 *
 * Kept apart from index.ts so they can be unit-tested without a server: every
 * function here is a total function of its input.
 */

import type { ClickHouseSettings } from "@clickhouse/client";
import { SQLRowLimiter, type MaxRowsRewrite } from "../../utils/sql-row-limiter.js";
import { blankCommentsAndStrings } from "../../utils/sql-parser.js";

/**
 * Whether a ClickHouse column type makes the column itself nullable.
 *
 * Nullability is carried by the type in ClickHouse, and only an *outermost*
 * `Nullable(...)` applies to the column: `Array(Nullable(Int32))` is an array
 * that can hold nulls, but the column can never be null. `LowCardinality` is a
 * storage wrapper rather than a semantic one, so it is unwrapped first —
 * `LowCardinality(Nullable(String))` is a nullable column.
 */
export function isNullableClickHouseType(type: string): boolean {
  let remaining = type.trim();

  // Unwrap storage-only wrappers, which may nest (e.g. inside SimpleAggregateFunction).
  while (/^LowCardinality\s*\(/i.test(remaining)) {
    remaining = remaining.replace(/^LowCardinality\s*\(/i, "");
    remaining = remaining.replace(/\)\s*$/, "").trim();
  }

  return /^Nullable\s*\(/i.test(remaining);
}

/**
 * Split a ClickHouse key expression (`system.tables.primary_key`,
 * `sorting_key`, or a data-skipping index's `expr`) into its components.
 *
 * Splitting happens at top-level commas only, so a key built from function
 * calls survives intact: `toYYYYMM(ts), user_id` is two components, not three.
 * `tuple()` — how ClickHouse renders `ORDER BY tuple()`, i.e. no key at all —
 * yields an empty list rather than a phantom column.
 */
export function splitKeyExpression(expression: string): string[] {
  const trimmed = expression.trim();
  if (!trimmed || /^tuple\s*\(\s*\)$/i.test(trimmed)) {
    return [];
  }

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of trimmed) {
    if (char === "(") {
      depth++;
      current += char;
    } else if (char === ")") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());

  return parts.filter((part) => part.length > 0);
}

/**
 * Extract the parameter list from a `CREATE FUNCTION` statement, e.g.
 * `CREATE FUNCTION add AS (a, b) -> a + b` yields `(a, b)`. Returns an empty
 * string when the statement is absent or does not match the lambda form
 * (executable UDFs are declared without one).
 */
export function parseFunctionParameterList(createQuery: string): string {
  const match = /\bAS\s*(\([^)]*\))\s*->/i.exec(createQuery);
  return match ? match[1] : "";
}

/**
 * Whether a statement ends with its own `FORMAT <name>` clause.
 *
 * The client always appends `FORMAT JSON`, and ClickHouse rejects a query
 * carrying two FORMAT clauses, so this is detected up front to produce an
 * actionable error instead of a parser error. The trailing anchor plus the
 * `\s+identifier` shape keeps the `format(...)` function and columns such as
 * `format_version` from matching.
 */
export function hasExplicitFormatClause(sql: string): boolean {
  const blanked = blankCommentsAndStrings(sql, "clickhouse");
  return /\bformat\s+[A-Za-z_]\w*\s*;?\s*$/i.test(blanked);
}

/**
 * LIMIT forms that must not be rewritten in place.
 *
 * - `LIMIT n BY expr` caps rows *per group* and is unbounded overall; editing
 *   its number changes the result rather than capping it.
 * - `LIMIT n, m` puts the offset first, so rewriting the first number moves
 *   the window instead of shrinking it.
 */
const limitByPattern = /\blimit\s+\d+(?:\s*,\s*\d+)?\s+by\b/i;
const limitOffsetPairPattern = /\blimit\s+\d+\s*,\s*\d+/i;

/**
 * A trailing `SETTINGS` clause. `SELECT ... SETTINGS max_threads = 4 LIMIT 10`
 * is a syntax error, so an appended LIMIT has to go inside a subquery instead.
 */
const trailingSettingsPattern = /\bsettings\s+[A-Za-z_]\w*\s*=/i;

/** ClickHouse spells CTEs `WITH`, which the shared SELECT-only rewriter skips. */
const leadingWithPattern = /^\s*with\b/i;

/**
 * Apply a max-rows cap with a truncation probe, using ClickHouse syntax.
 *
 * Most statements go through the shared rewriter, which appends or tightens a
 * `LIMIT`. Three ClickHouse-specific shapes cannot be edited that way (see the
 * patterns above), plus `WITH`-led queries, which the shared rewriter declines
 * to touch because it tests for a leading `SELECT`. Those are wrapped in a
 * capped subquery instead — semantics preserved, cap applied.
 */
export function applyClickHouseMaxRows(sql: string, maxRows: number | undefined): MaxRowsRewrite {
  if (!maxRows) {
    return { sql, probeApplied: false };
  }

  const blanked = blankCommentsAndStrings(sql, "clickhouse");
  const needsWrapping =
    limitByPattern.test(blanked) ||
    limitOffsetPairPattern.test(blanked) ||
    trailingSettingsPattern.test(blanked) ||
    leadingWithPattern.test(blanked);

  if (!needsWrapping) {
    return SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, maxRows);
  }

  // The semicolon has to go: it would otherwise land inside the subquery.
  // The newline before `)` matters for the same reason it does in the shared
  // rewriter — a statement ending in a `--` comment would swallow it.
  const inner = sql.trim().replace(/;+\s*$/, "");
  return {
    sql: `SELECT * FROM (\n${inner}\n) AS dbhub_capped\nLIMIT ${maxRows + 1}`,
    probeApplied: true,
  };
}

/** Inputs to the per-statement settings decision. */
export interface StatementSettingsInput {
  /**
   * The session's effective `readonly` setting, probed at connect time.
   *   0 → anything may be sent, including our own `readonly = 2` backstop
   *   2 → other settings may be sent, but not `readonly` itself
   *   1 → nothing may be sent; the server already enforces read-only
   */
  serverReadOnlySetting: number;
  /** Read-only requested for this statement, or for the whole connection. */
  readonly: boolean;
  queryTimeoutSeconds?: number;
}

/**
 * The settings DBHub may attach to a statement.
 *
 * ClickHouse rejects *any* setting change when the session's `readonly` is 1,
 * and rejects a change to `readonly` itself whenever it is non-zero — so what
 * may be sent depends on the profile the connected user already carries.
 * Returning undefined for the `readonly = 1` case is not a downgrade in
 * enforcement: that profile is stricter than the backstop we would apply.
 */
export function clickHouseStatementSettings(
  input: StatementSettingsInput
): ClickHouseSettings | undefined {
  if (input.serverReadOnlySetting === 1) {
    return undefined;
  }

  const settings: ClickHouseSettings = {
    // Return Decimal as a JSON string rather than a JSON number. A
    // Decimal(38, 18) — a token amount, a price — does not survive a double,
    // and silently rounding a balance is worse than handing back a string.
    // This matches what node-postgres does with NUMERIC. (64-bit integers are
    // already quoted by ClickHouse's own default.)
    output_format_json_quote_decimals: 1,
  };

  if (input.readonly && input.serverReadOnlySetting === 0) {
    // 2 rather than 1: both reject writes, but 1 additionally forbids changing
    // any other setting, which would reject the two settings here.
    settings.readonly = "2";
  }

  if (input.queryTimeoutSeconds !== undefined) {
    settings.max_execution_time = input.queryTimeoutSeconds;
  }

  return settings;
}
