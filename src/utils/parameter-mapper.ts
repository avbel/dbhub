/**
 * Parameter mapping utilities for custom tools
 * Maps tool parameters to connector-specific parameter syntax
 */

import { ConnectorType } from "../connectors/interface.js";
import { ParameterConfig } from "../types/config.js";
import { stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Parameter placeholder styles for different database connectors
 */
export const PARAMETER_STYLES = {
  postgres: "numbered", // $1, $2, $3
  mysql: "positional", // ?, ?, ?
  mariadb: "positional", // ?, ?, ?
  sqlserver: "named", // @p1, @p2, @p3
  sqlite: "positional", // ?, ?, ?
  clickhouse: "braced", // {name: Type}
} as const;

/**
 * ClickHouse placeholder: `{name: Type}`, where Type is any ClickHouse type
 * expression (`String`, `Array(UInt32)`, `Nullable(DateTime64(3))`, ...).
 * Anchored on an identifier followed by `:` so ordinary brace usage in other
 * dialects can never match — this pattern is only ever consulted for ClickHouse.
 */
const bracedParameterPattern = /\{\s*([A-Za-z_]\w*)\s*:\s*[A-Za-z_][^}]*\}/g;

/**
 * Extract ClickHouse placeholder names in order of first appearance, without
 * duplicates. This order is the contract that maps the positional
 * `parameters` array handed to `executeSQL` onto ClickHouse's named
 * `query_params` object: the Nth distinct placeholder takes the Nth value.
 */
export function extractBracedParameterNames(statement: string): string[] {
  const cleanedSQL = stripCommentsAndStrings(statement);
  const names: string[] = [];
  for (const match of cleanedSQL.matchAll(bracedParameterPattern)) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Detect the parameter style used in a SQL statement.
 * Strips comments and string literals first to avoid false positives.
 * @param statement SQL statement to analyze
 * @returns The detected parameter style
 */
export function detectParameterStyle(
  statement: string,
  connectorType?: ConnectorType
): "numbered" | "positional" | "named" | "braced" | "none" {
  // Strip comments and strings to avoid matching parameters inside them
  const cleanedSQL = stripCommentsAndStrings(statement);

  // ClickHouse is checked separately, and only for ClickHouse: `{name: Type}`
  // is the sole placeholder form there, and confining the check this way keeps
  // every other dialect's detection byte-for-byte unchanged.
  if (connectorType === "clickhouse") {
    if (extractBracedParameterNames(statement).length > 0) {
      return "braced";
    }
    // No ClickHouse placeholder. Still name an unmistakably foreign one so the
    // mismatch surfaces when the tool is configured rather than at run time.
    // A bare `?` is deliberately NOT checked: ClickHouse has a ternary
    // conditional operator (`cond ? a : b`), so `?` is ordinary SQL here.
    if (/\$\d+/.test(cleanedSQL)) {
      return "numbered";
    }
    if (/@p\d+/.test(cleanedSQL)) {
      return "named";
    }
    return "none";
  }

  // Check for PostgreSQL-style numbered parameters ($1, $2, etc.)
  if (/\$\d+/.test(cleanedSQL)) {
    return "numbered";
  }

  // Check for SQL Server-style named parameters (@p1, @p2, etc.)
  if (/@p\d+/.test(cleanedSQL)) {
    return "named";
  }

  // Check for positional parameters (?)
  if (/\?/.test(cleanedSQL)) {
    return "positional";
  }

  return "none";
}

/**
 * Validate that the SQL statement's parameter style matches the connector type
 * @param statement SQL statement
 * @param connectorType Database connector type
 * @throws Error if parameter style doesn't match connector
 */
export function validateParameterStyle(
  statement: string,
  connectorType: ConnectorType
): void {
  const detectedStyle = detectParameterStyle(statement, connectorType);
  const expectedStyle = PARAMETER_STYLES[connectorType];

  if (detectedStyle === "none") {
    // No parameters in statement - this is valid
    return;
  }

  if (detectedStyle !== expectedStyle) {
    const examples = {
      numbered: "$1, $2, $3",
      positional: "?, ?, ?",
      named: "@p1, @p2, @p3",
      braced: "{id: UInt32}, {name: String}",
    };

    throw new Error(
      `Invalid parameter syntax for ${connectorType}. ` +
        `Expected ${expectedStyle} style (${examples[expectedStyle]}), ` +
        `but found ${detectedStyle} style in statement.`
    );
  }
}

/**
 * Count the number of parameters in a SQL statement and validate they are sequential.
 * Strips comments and string literals first to avoid false positives.
 * @param statement SQL statement
 * @returns Number of parameter placeholders required (highest index for numbered/named)
 * @throws Error if numbered/named parameters are not sequential starting from 1
 */
export function countParameters(statement: string, connectorType?: ConnectorType): number {
  const style = detectParameterStyle(statement, connectorType);
  // Strip comments and strings to avoid matching parameters inside them
  const cleanedSQL = stripCommentsAndStrings(statement);

  switch (style) {
    case "braced": {
      // Distinct names, not occurrences: ClickHouse placeholders are named, so
      // repeating `{id: UInt32}` twice still binds a single value.
      return extractBracedParameterNames(statement).length;
    }
    case "numbered": {
      // Extract all $N parameters and get unique indices
      const matches = cleanedSQL.match(/\$\d+/g);
      if (!matches) return 0;
      const numbers = matches.map((m) => parseInt(m.slice(1), 10));
      const uniqueIndices = Array.from(new Set(numbers)).sort((a, b) => a - b);

      // Validate parameters are sequential starting from 1
      const maxIndex = Math.max(...uniqueIndices);
      for (let i = 1; i <= maxIndex; i++) {
        if (!uniqueIndices.includes(i)) {
          throw new Error(
            `Non-sequential numbered parameters detected. Found placeholders: ${uniqueIndices.map(n => `$${n}`).join(', ')}. ` +
            `Parameters must be sequential starting from $1 (missing $${i}).`
          );
        }
      }

      return maxIndex;
    }
    case "named": {
      // Extract all @pN parameters and get unique indices
      const matches = cleanedSQL.match(/@p\d+/g);
      if (!matches) return 0;
      const numbers = matches.map((m) => parseInt(m.slice(2), 10));
      const uniqueIndices = Array.from(new Set(numbers)).sort((a, b) => a - b);

      // Validate parameters are sequential starting from 1
      const maxIndex = Math.max(...uniqueIndices);
      for (let i = 1; i <= maxIndex; i++) {
        if (!uniqueIndices.includes(i)) {
          throw new Error(
            `Non-sequential named parameters detected. Found placeholders: ${uniqueIndices.map(n => `@p${n}`).join(', ')}. ` +
            `Parameters must be sequential starting from @p1 (missing @p${i}).`
          );
        }
      }

      return maxIndex;
    }
    case "positional": {
      // Count question marks (positional parameters don't have this issue)
      return (cleanedSQL.match(/\?/g) || []).length;
    }
    default:
      return 0;
  }
}

/**
 * Validate that parameter definitions match the SQL statement
 * @param statement SQL statement
 * @param parameters Parameter definitions
 * @param connectorType Database connector type
 * @throws Error if validation fails
 */
export function validateParameters(
  statement: string,
  parameters: ParameterConfig[] | undefined,
  connectorType: ConnectorType
): void {
  // Validate parameter style matches connector
  validateParameterStyle(statement, connectorType);

  const paramCount = countParameters(statement, connectorType);
  const definedCount = parameters?.length || 0;

  if (paramCount !== definedCount) {
    throw new Error(
      `Parameter count mismatch: SQL statement has ${paramCount} parameter(s), ` +
        `but ${definedCount} parameter(s) defined in tool configuration.`
    );
  }
}

/**
 * Map user-provided arguments to an array suitable for connector execution
 * Handles default values and validates required parameters
 * @param parameters Parameter definitions
 * @param args User-provided arguments
 * @returns Array of parameter values in order
 */
export function mapArgumentsToArray(
  parameters: ParameterConfig[] | undefined,
  args: Record<string, any>
): any[] {
  if (!parameters || parameters.length === 0) {
    return [];
  }

  return parameters.map((param) => {
    const value = args[param.name];

    // Use provided value if available
    if (value !== undefined) {
      return value;
    }

    // Use default value if parameter is optional
    if (param.default !== undefined) {
      return param.default;
    }

    // This should be caught by Zod validation, but add a safety check
    if (param.required !== false) {
      throw new Error(
        `Required parameter '${param.name}' is missing and has no default value.`
      );
    }

    // Optional parameter with no default
    return null;
  });
}
