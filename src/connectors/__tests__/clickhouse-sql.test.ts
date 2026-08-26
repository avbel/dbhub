import { describe, it, expect } from "vitest";
import {
  applyClickHouseMaxRows,
  clickHouseStatementSettings,
  hasExplicitFormatClause,
  isNullableClickHouseType,
  parseFunctionParameterList,
  splitKeyExpression,
} from "../clickhouse/sql.js";

describe("isNullableClickHouseType", () => {
  it("treats an outermost Nullable as a nullable column", () => {
    expect(isNullableClickHouseType("Nullable(String)")).toBe(true);
    expect(isNullableClickHouseType("Nullable(Decimal(10, 2))")).toBe(true);
    expect(isNullableClickHouseType("Nullable(DateTime64(3, 'UTC'))")).toBe(true);
  });

  it("unwraps LowCardinality, which is storage-only", () => {
    expect(isNullableClickHouseType("LowCardinality(Nullable(String))")).toBe(true);
    expect(isNullableClickHouseType("LowCardinality(String)")).toBe(false);
  });

  it("does not treat a nullable element type as a nullable column", () => {
    // The array itself can never be null, only its elements.
    expect(isNullableClickHouseType("Array(Nullable(Int32))")).toBe(false);
    expect(isNullableClickHouseType("Map(String, Nullable(UInt8))")).toBe(false);
    expect(isNullableClickHouseType("Tuple(Nullable(Int8), String)")).toBe(false);
  });

  it("reports plain types as non-nullable", () => {
    expect(isNullableClickHouseType("UInt64")).toBe(false);
    expect(isNullableClickHouseType("String")).toBe(false);
    expect(isNullableClickHouseType("")).toBe(false);
  });
});

describe("splitKeyExpression", () => {
  it("splits only at top-level commas", () => {
    expect(splitKeyExpression("toYYYYMM(ts), user_id")).toEqual(["toYYYYMM(ts)", "user_id"]);
    expect(splitKeyExpression("cityHash64(a, b), c")).toEqual(["cityHash64(a, b)", "c"]);
  });

  it("treats an empty key and ORDER BY tuple() as no key", () => {
    expect(splitKeyExpression("")).toEqual([]);
    expect(splitKeyExpression("   ")).toEqual([]);
    expect(splitKeyExpression("tuple()")).toEqual([]);
    expect(splitKeyExpression("tuple( )")).toEqual([]);
  });

  it("handles a single component", () => {
    expect(splitKeyExpression("id")).toEqual(["id"]);
  });
});

describe("parseFunctionParameterList", () => {
  it("extracts the lambda parameter list from CREATE FUNCTION", () => {
    expect(parseFunctionParameterList("CREATE FUNCTION add AS (a, b) -> a + b")).toBe("(a, b)");
    expect(parseFunctionParameterList("CREATE FUNCTION noop AS () -> 1")).toBe("()");
  });

  it("returns an empty string when there is no lambda form", () => {
    expect(parseFunctionParameterList("")).toBe("");
    expect(parseFunctionParameterList("CREATE FUNCTION exec_udf")).toBe("");
  });
});

describe("hasExplicitFormatClause", () => {
  it("detects a trailing FORMAT clause", () => {
    expect(hasExplicitFormatClause("SELECT * FROM t FORMAT JSON")).toBe(true);
    expect(hasExplicitFormatClause("SELECT * FROM t FORMAT CSVWithNames;")).toBe(true);
    expect(hasExplicitFormatClause("SELECT * FROM t\nFORMAT  TabSeparated\n")).toBe(true);
  });

  it("does not match the format() function or format-prefixed identifiers", () => {
    expect(hasExplicitFormatClause("SELECT format('{}!', name) FROM t")).toBe(false);
    expect(hasExplicitFormatClause("SELECT formatDateTime(ts, '%F') FROM t")).toBe(false);
    expect(hasExplicitFormatClause("SELECT format_version FROM t")).toBe(false);
  });

  it("does not match FORMAT inside a string literal", () => {
    expect(hasExplicitFormatClause("SELECT 'FORMAT JSON'")).toBe(false);
  });

  it("does not match a FORMAT that is not at the end", () => {
    expect(hasExplicitFormatClause("SELECT * FROM t FORMAT JSON UNION ALL SELECT 1")).toBe(false);
  });
});

describe("applyClickHouseMaxRows", () => {
  it("is a no-op without a cap", () => {
    const sql = "SELECT * FROM events";
    expect(applyClickHouseMaxRows(sql, undefined)).toEqual({ sql, probeApplied: false });
  });

  it("appends a probe LIMIT to an ordinary SELECT", () => {
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events", 10);
    expect(rewrite.probeApplied).toBe(true);
    expect(rewrite.sql).toContain("LIMIT 11");
  });

  it("leaves a smaller caller LIMIT alone and applies no probe", () => {
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events LIMIT 3", 10);
    expect(rewrite).toEqual({ sql: "SELECT * FROM events LIMIT 3", probeApplied: false });
  });

  it("wraps LIMIT n BY rather than rewriting its number", () => {
    // Editing the number would change which rows come back (n per group),
    // and would still leave the total unbounded.
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events LIMIT 1 BY user_id", 10);
    expect(rewrite.probeApplied).toBe(true);
    expect(rewrite.sql).toContain("LIMIT 1 BY user_id");
    expect(rewrite.sql).toMatch(/^SELECT \* FROM \(/);
    expect(rewrite.sql.trimEnd()).toMatch(/LIMIT 11$/);
  });

  it("wraps the LIMIT offset,count form rather than moving the offset", () => {
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events LIMIT 20, 30", 10);
    expect(rewrite.probeApplied).toBe(true);
    expect(rewrite.sql).toContain("LIMIT 20, 30");
    expect(rewrite.sql.trimEnd()).toMatch(/LIMIT 11$/);
  });

  it("wraps a query with a trailing SETTINGS clause", () => {
    // `... SETTINGS max_threads = 4 LIMIT 11` is a syntax error.
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events SETTINGS max_threads = 4", 10);
    expect(rewrite.probeApplied).toBe(true);
    expect(rewrite.sql).toContain("SETTINGS max_threads = 4");
    expect(rewrite.sql.trimEnd()).toMatch(/LIMIT 11$/);
  });

  it("does not mistake a system.settings query for a SETTINGS clause", () => {
    const rewrite = applyClickHouseMaxRows(
      "SELECT name FROM system.settings WHERE changed = 1",
      10
    );
    expect(rewrite.sql).not.toMatch(/^SELECT \* FROM \(/);
    expect(rewrite.sql).toContain("LIMIT 11");
  });

  it("caps a WITH-led query, which the shared SELECT-only rewriter skips", () => {
    const rewrite = applyClickHouseMaxRows("WITH x AS (SELECT 1 AS n) SELECT * FROM x", 10);
    expect(rewrite.probeApplied).toBe(true);
    expect(rewrite.sql).toMatch(/^SELECT \* FROM \(/);
    expect(rewrite.sql.trimEnd()).toMatch(/LIMIT 11$/);
  });

  it("drops the trailing semicolon when wrapping so it stays valid", () => {
    const rewrite = applyClickHouseMaxRows("SELECT * FROM events LIMIT 1 BY user_id;", 10);
    expect(rewrite.sql).not.toContain(";");
  });

  it("closes the wrapper on its own line so a trailing comment cannot swallow it", () => {
    const rewrite = applyClickHouseMaxRows("WITH x AS (SELECT 1 AS n) SELECT * FROM x -- note", 10);
    expect(rewrite.sql).toContain("-- note\n)");
  });
});

describe("clickHouseStatementSettings", () => {
  it("adds the readonly backstop when the session allows changing it", () => {
    expect(
      clickHouseStatementSettings({ serverReadOnlySetting: 0, readonly: true })
    ).toEqual({ output_format_json_quote_decimals: 1, readonly: "2" });
  });

  it("uses readonly=2, not 1, so other settings stay settable", () => {
    const settings = clickHouseStatementSettings({
      serverReadOnlySetting: 0,
      readonly: true,
      queryTimeoutSeconds: 30,
    });
    expect(settings?.readonly).toBe("2");
    expect(settings?.max_execution_time).toBe(30);
  });

  it("omits the backstop for a writable statement", () => {
    expect(
      clickHouseStatementSettings({ serverReadOnlySetting: 0, readonly: false })
    ).toEqual({ output_format_json_quote_decimals: 1 });
  });

  it("never tries to change readonly when the session already pins it", () => {
    // ClickHouse rejects a change to `readonly` whenever it is non-zero.
    const settings = clickHouseStatementSettings({
      serverReadOnlySetting: 2,
      readonly: true,
      queryTimeoutSeconds: 15,
    });
    expect(settings).not.toHaveProperty("readonly");
    // readonly=2 still permits every other setting.
    expect(settings?.max_execution_time).toBe(15);
    expect(settings?.output_format_json_quote_decimals).toBe(1);
  });

  it("sends nothing at all under a readonly=1 profile", () => {
    // That profile forbids changing any setting; it is also stricter than the
    // backstop we would otherwise apply.
    expect(
      clickHouseStatementSettings({
        serverReadOnlySetting: 1,
        readonly: true,
        queryTimeoutSeconds: 15,
      })
    ).toBeUndefined();
  });

  it("always asks for string decimals so precision survives", () => {
    expect(
      clickHouseStatementSettings({ serverReadOnlySetting: 0, readonly: false })
        ?.output_format_json_quote_decimals
    ).toBe(1);
  });
});
