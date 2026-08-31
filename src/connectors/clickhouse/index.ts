import { createClient, type ClickHouseClient, type ClickHouseSettings } from "@clickhouse/client";
import type { Agent } from "node:https";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  SQLResultSet,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { requireDatabaseInDSN, MissingDatabaseError } from "../../utils/dsn-database.js";
import { SQLRowLimiter, type MaxRowsRewrite } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { getFirstKeyword } from "../../utils/allowed-keywords.js";
import { extractBracedParameterNames } from "../../utils/parameter-mapper.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import {
  applyClickHouseMaxRows,
  clickHouseStatementSettings,
  hasExplicitFormatClause,
  isNullableClickHouseType,
  parseFunctionParameterList,
  splitKeyExpression,
} from "./sql.js";

/** `@clickhouse/client`'s own default request_timeout, in seconds. */
const CLIENT_DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;

/** ClickHouse HTTP interface ports, used when the DSN omits one. */
const DEFAULT_HTTP_PORT = 8123;
const DEFAULT_HTTPS_PORT = 8443;

/**
 * DSN schemes that address a ClickHouse server. `http`/`https` are here because
 * DBHub talks to ClickHouse over the HTTP interface, so a plain endpoint URL is
 * already a complete DSN — see the DSN parser's doc comment.
 */
const DSN_SCHEMES = ["clickhouse://", "http://", "https://"];

/**
 * ClickHouse's native TCP protocol ports. `@clickhouse/client` speaks HTTP(S)
 * only, so a DSN pointing at one of these can never connect — it would fail as
 * an opaque socket hang rather than as a configuration mistake. Fail fast with
 * the HTTP port to use instead.
 */
const NATIVE_PROTOCOL_PORTS = new Map<number, number>([
  [9000, DEFAULT_HTTP_PORT],
  [9440, DEFAULT_HTTPS_PORT],
]);

/**
 * Engines that `system.tables` reports for view-like objects. Everything else
 * is a base table, which makes the table/view split below an exact partition
 * (no object can appear in both lists, and none can be missing from both).
 */
const VIEW_ENGINES = ["View", "MaterializedView", "LiveView", "WindowView"];

/**
 * Statements whose results are rows. Anything else is dispatched through
 * `command()`, which does not append a FORMAT clause and returns no data.
 * `values` covers ClickHouse's standalone `VALUES(...)` table expression.
 */
const ROW_RETURNING_KEYWORDS = new Set([
  "select",
  "with",
  "show",
  "describe",
  "desc",
  "explain",
  "exists",
  "values",
]);

/** Shape returned by the ClickHouse DSN parser, consumed by `connect()`. */
export interface ClickHouseConnectionConfig {
  url: string;
  username: string;
  password: string;
  database: string;
  requestTimeoutMs?: number;
  /** Set when the DSN asks for TLS without certificate verification (sslmode=require). */
  rejectUnauthorized: boolean;
}

/**
 * ClickHouse DSN Parser
 *
 * Handles DSN strings like:
 *   clickhouse://user:password@localhost:8123/dbname
 *   clickhouse://user:password@host:8443/dbname?secure=true
 *   clickhouse://user:password@host:8123/dbname?sslmode=disable
 *   http://user:password@localhost:8123/dbname
 *   https://user:password@abc123.eu-central-1.aws.clickhouse.cloud:8443/dbname
 *
 * `http`/`https` are accepted alongside `clickhouse` because ClickHouse is
 * spoken over its HTTP interface: the endpoint URL that ClickHouse Cloud and
 * container deployments hand out *is* the DSN, so it can be pasted verbatim.
 *
 * TLS is selected by, in order of precedence: an explicit `sslmode`, an
 * explicit `secure`, the DSN scheme (`https` implies TLS, `http` implies none),
 * then the port (8443 implies TLS). `sslmode=require` matches the rest of
 * DBHub: TLS without certificate verification.
 */
class ClickHouseDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<ClickHouseConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid ClickHouse DSN format.\nProvided: ${obfuscateDSNPassword(dsn)}\n` +
          `Expected: ${this.getSampleDSN()}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      const database = url.pathname ? url.pathname.substring(1) : "";
      requireDatabaseInDSN(database, dsn, "ClickHouse", DEFAULT_HTTP_PORT);

      const explicitPort = url.port ? Number.parseInt(url.port, 10) : undefined;
      if (explicitPort !== undefined && Number.isNaN(explicitPort)) {
        throw new Error(`Invalid port in ClickHouse DSN: ${url.port}`);
      }

      if (explicitPort !== undefined && NATIVE_PROTOCOL_PORTS.has(explicitPort)) {
        const httpPort = NATIVE_PROTOCOL_PORTS.get(explicitPort);
        throw new Error(
          `Port ${explicitPort} is ClickHouse's native TCP protocol, which DBHub does not speak. ` +
            `DBHub connects over the HTTP interface — use port ${httpPort} instead ` +
            `(the native and HTTP interfaces run side by side on the same server).`
        );
      }

      const { secure, rejectUnauthorized } = resolveTLSMode(url, explicitPort);
      const port = explicitPort ?? (secure ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
      const scheme = secure ? "https" : "http";

      return {
        url: `${scheme}://${url.hostname}:${port}`,
        username: url.username || "default",
        password: url.password,
        database,
        requestTimeoutMs: resolveRequestTimeoutMs(config),
        rejectUnauthorized,
      };
    } catch (error) {
      if (error instanceof MissingDatabaseError) {
        throw error;
      }
      throw new Error(
        `Failed to parse ClickHouse DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "clickhouse://default:password@localhost:8123/default";
  }

  isValidDSN(dsn: string): boolean {
    return typeof dsn === "string" && DSN_SCHEMES.some((scheme) => dsn.startsWith(scheme));
  }
}

/** Decide TLS from sslmode, then secure, then the DSN scheme, then the port. */
function resolveTLSMode(
  url: SafeURL,
  explicitPort: number | undefined
): { secure: boolean; rejectUnauthorized: boolean } {
  const sslmode = url.getSearchParam("sslmode");
  if (sslmode) {
    if (sslmode === "disable") {
      return { secure: false, rejectUnauthorized: true };
    }
    // "require" is DBHub-wide shorthand for TLS without certificate
    // verification; verify-ca / verify-full keep verification on.
    return { secure: true, rejectUnauthorized: sslmode !== "require" };
  }

  const secureParam = url.getSearchParam("secure");
  if (secureParam !== null) {
    const secure = secureParam === "true" || secureParam === "1";
    return { secure, rejectUnauthorized: true };
  }

  // An http/https DSN states the transport outright, so it outranks the port
  // heuristic that a scheme-less `clickhouse://` DSN has to fall back on.
  if (url.protocol === "https:") {
    return { secure: true, rejectUnauthorized: true };
  }
  if (url.protocol === "http:") {
    return { secure: false, rejectUnauthorized: true };
  }

  return { secure: explicitPort === DEFAULT_HTTPS_PORT, rejectUnauthorized: true };
}

/**
 * The client's `request_timeout` bounds the whole HTTP round trip. When a query
 * timeout is configured it is enforced server-side by `max_execution_time`, so
 * the socket deadline is set slightly later: the server then wins the race and
 * returns a proper "timeout exceeded" error instead of the connection dying.
 *
 * ClickHouse is addressed over HTTP, which has no separate connect phase the
 * client can bound, so `connection_timeout` can only raise this ceiling — see
 * the floor applied below.
 */
function resolveRequestTimeoutMs(config?: ConnectorConfig): number | undefined {
  const connect = config?.connectionTimeoutSeconds;
  const query = config?.queryTimeoutSeconds;
  if (connect === undefined && query === undefined) {
    return undefined;
  }
  const queryBudget = query === undefined ? 0 : query + 2;
  // Never shorter than the client's own default. `request_timeout` bounds the
  // whole round trip, so letting a small connection_timeout shrink it would
  // silently cap how long *any* query may run — a five-second connect budget
  // must not turn into a five-second query budget.
  return Math.max(connect ?? 0, queryBudget, CLIENT_DEFAULT_REQUEST_TIMEOUT_SECONDS) * 1000;
}

/**
 * ClickHouse Connector
 *
 * Notes specific to this engine:
 * - The HTTP interface runs one statement per request, so a multi-statement
 *   batch is executed sequentially, one result set per statement.
 * - There are no transactions, so the engine-level read-only backstop is the
 *   `readonly` setting rather than a READ ONLY transaction.
 * - There are no secondary indexes; `getTableIndexes` reports the primary key,
 *   the sorting key, and data-skipping indices instead (see the method).
 * - There are no stored procedures; `getStoredProcedures` reports user-defined
 *   functions and returns nothing for `routineType: "procedure"`.
 */
export class ClickHouseConnector implements Connector {
  id: ConnectorType = "clickhouse";
  name = "ClickHouse";
  dsnParser = new ClickHouseDSNParser();

  private client: ClickHouseClient | null = null;
  private sourceId: string = "default";
  private database: string = "default";
  private queryTimeoutSeconds?: number;
  /** ConnectorConfig.readonly, applied to every statement rather than to the client. */
  private connectionReadOnly = false;
  /**
   * The session's effective `readonly` setting, probed once at connect time.
   * ClickHouse rejects an attempt to change settings when the user's profile
   * already pins `readonly = 1`, and rejects any attempt to change `readonly`
   * itself when it is non-zero — so what DBHub may send depends on this value:
   *   0 → may send anything, including our own `readonly = 2` backstop
   *   2 → may send other settings, but not `readonly`
   *   1 → may send no settings at all (the server already enforces read-only)
   */
  private serverReadOnlySetting = 0;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new ClickHouseConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionConfig = await this.dsnParser.parse(dsn, config);
      this.database = connectionConfig.database;
      this.queryTimeoutSeconds = config?.queryTimeoutSeconds;

      // Connection-level read-only enforcement. Per-tool read-only is applied
      // per statement in executeSQL; this covers ConnectorConfig.readonly,
      // which is used when a connector is driven directly.
      this.connectionReadOnly = config?.readonly === true;

      this.client = createClient({
        url: connectionConfig.url,
        username: connectionConfig.username,
        password: connectionConfig.password,
        database: connectionConfig.database,
        application: "dbhub",
        ...(connectionConfig.requestTimeoutMs !== undefined
          ? { request_timeout: connectionConfig.requestTimeoutMs }
          : {}),
        ...(connectionConfig.rejectUnauthorized ? {} : { http_agent: await insecureHTTPSAgent() }),
      });

      // Validate with real SQL rather than /ping: ping is unauthenticated and
      // does not touch the database, so it would report success for bad
      // credentials or a database that does not exist.
      await this.rows("SELECT 1");

      // Probe the session's readonly setting separately, and only as a hint.
      // Reading system tables can be denied independently of the user's own
      // tables (ClickHouse's select_from_system_db_requires_grant), and
      // execute_sql works fine without it — so a failure here must not sink an
      // otherwise healthy connection. Falling back to 0 keeps the engine-level
      // read-only backstop switched on, which is the safe direction to guess.
      this.serverReadOnlySetting = await this.probeReadOnlySetting();

      if (initScript) {
        for (const statement of splitSQLStatements(initScript, "clickhouse")) {
          await this.client.command({ query: statement });
        }
      }
    } catch (err) {
      if (this.client) {
        const client = this.client;
        this.client = null;
        await closeQuietly(() => client.close());
      }
      console.error("Failed to connect to ClickHouse database:", err);
      throw err;
    }
  }

  /**
   * Read the session's effective `readonly` setting. Best-effort: returns 0
   * when the value cannot be read, which leaves the backstop enabled.
   */
  private async probeReadOnlySetting(): Promise<number> {
    try {
      const rows = await this.rows<{ value: string }>(
        "SELECT value FROM system.settings WHERE name = 'readonly'"
      );
      const probed = Number.parseInt(rows[0]?.value ?? "0", 10);
      return Number.isNaN(probed) ? 0 : probed;
    } catch (err) {
      // Worth surfacing: it also means the system tables backing
      // search_objects are unreadable, so object discovery will be degraded.
      console.error(
        "ClickHouse: could not read system.settings; assuming readonly=0. " +
          "Object discovery (search_objects) may also be unavailable.",
        err instanceof Error ? err.message : String(err)
      );
      return 0;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.close();
    }
  }

  /** The settings DBHub may attach to a statement, given the server's own readonly profile. */
  private settingsFor(options: ExecuteOptions): ClickHouseSettings | undefined {
    return clickHouseStatementSettings({
      serverReadOnlySetting: this.serverReadOnlySetting,
      readonly: options.readonly === true || this.connectionReadOnly,
      queryTimeoutSeconds: this.queryTimeoutSeconds,
    });
  }

  /** Run a statement that returns rows and hand back just the rows. */
  private async rows<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
    if (!this.client) {
      throw new Error("Not connected to database");
    }
    const resultSet = await this.client.query({ query, format: "JSON", query_params });
    const response = await resultSet.json<T>();
    return response.data ?? [];
  }

  /** Resolve an optional schema argument to a concrete database name. */
  private schemaOrDefault(schema?: string): string {
    return schema ?? this.database;
  }

  async getSchemas(): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(`
      SELECT name
      FROM system.databases
      WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
      ORDER BY name
    `);
    return rows.map((row) => row.name);
  }

  /**
   * ClickHouse databases are the schema concept, and a DSN always names one
   * (see requireDatabaseInDSN). Scoping to it keeps search_objects from
   * fanning out across every database on the server, matching MySQL/MariaDB.
   */
  async getDefaultSchema(): Promise<string | null> {
    return this.database;
  }

  async getTables(schema?: string): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      `SELECT name
       FROM system.tables
       WHERE database = {schema:String}
         AND engine NOT IN {viewEngines:Array(String)}
         AND is_temporary = 0
       ORDER BY name`,
      { schema: this.schemaOrDefault(schema), viewEngines: VIEW_ENGINES }
    );
    return rows.map((row) => row.name);
  }

  async getViews(schema?: string): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      `SELECT name
       FROM system.tables
       WHERE database = {schema:String}
         AND engine IN {viewEngines:Array(String)}
       ORDER BY name`,
      { schema: this.schemaOrDefault(schema), viewEngines: VIEW_ENGINES }
    );
    return rows.map((row) => row.name);
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const rows = await this.rows<{ found: string }>(
      `SELECT count() AS found
       FROM system.tables
       WHERE database = {schema:String} AND name = {table:String}`,
      { schema: this.schemaOrDefault(schema), table: tableName }
    );
    return Number(rows[0]?.found ?? 0) > 0;
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const rows = await this.rows<{
      column_name: string;
      data_type: string;
      default_kind: string;
      default_expression: string;
      comment: string;
    }>(
      `SELECT
         name               AS column_name,
         type               AS data_type,
         default_kind       AS default_kind,
         default_expression AS default_expression,
         comment            AS comment
       FROM system.columns
       WHERE database = {schema:String} AND table = {table:String}
       ORDER BY position`,
      { schema: this.schemaOrDefault(schema), table: tableName }
    );

    return rows.map((row) => ({
      column_name: row.column_name,
      data_type: row.data_type,
      // The interface models nullability as the information_schema "YES"/"NO"
      // string; in ClickHouse it is carried by the type itself.
      is_nullable: isNullableClickHouseType(row.data_type) ? "YES" : "NO",
      // MATERIALIZED and ALIAS columns are computed rather than defaulted, so
      // the kind is kept alongside the expression instead of being dropped.
      column_default: formatColumnDefault(row.default_kind, row.default_expression),
      description: row.comment || null,
    }));
  }

  /**
   * ClickHouse has no secondary indexes in the B-tree sense, so there is no
   * exact answer here. What it does have, and what a caller asking "how is
   * this table organised?" actually needs, is reported instead:
   *  - PRIMARY KEY — the sparse primary index. It is NOT unique (ClickHouse
   *    enforces no uniqueness), so is_unique is false.
   *  - ORDER BY — the sorting key, listed only when it differs from the
   *    primary key, which is the case whenever the two were declared apart.
   *  - data-skipping indices (minmax, set, bloom_filter, ...) by name.
   */
  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    const database = this.schemaOrDefault(schema);
    const tableRows = await this.rows<{ primary_key: string; sorting_key: string }>(
      `SELECT primary_key, sorting_key
       FROM system.tables
       WHERE database = {schema:String} AND name = {table:String}`,
      { schema: database, table: tableName }
    );

    const indexes: TableIndex[] = [];
    const primaryKey = splitKeyExpression(tableRows[0]?.primary_key ?? "");
    const sortingKey = splitKeyExpression(tableRows[0]?.sorting_key ?? "");

    if (primaryKey.length > 0) {
      indexes.push({
        index_name: "PRIMARY",
        column_names: primaryKey,
        is_unique: false,
        is_primary: true,
      });
    }
    if (sortingKey.length > 0 && sortingKey.join(",") !== primaryKey.join(",")) {
      indexes.push({
        index_name: "ORDER BY",
        column_names: sortingKey,
        is_unique: false,
        is_primary: false,
      });
    }

    // Older servers, and some engines, do not expose this table; a missing
    // skip-index list must not discard the keys gathered above.
    try {
      const skipIndexes = await this.rows<{ name: string; expr: string }>(
        `SELECT name, expr
         FROM system.data_skipping_indices
         WHERE database = {schema:String} AND table = {table:String}
         ORDER BY name`,
        { schema: database, table: tableName }
      );
      for (const index of skipIndexes) {
        indexes.push({
          index_name: index.name,
          column_names: splitKeyExpression(index.expr),
          is_unique: false,
          is_primary: false,
        });
      }
    } catch {
      // Skip-index metadata unavailable; keys above are still valid.
    }

    return indexes;
  }

  /**
   * ClickHouse has no stored procedures, so `routineType: "procedure"` is
   * empty by construction. It does have user-defined functions, which are
   * reported for the function case.
   *
   * UDFs are server-global rather than per-database, so the schema argument
   * does not filter them; with search_objects scoped to the connected database
   * (see getDefaultSchema) each one is still listed exactly once.
   */
  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    if (routineType === "procedure") {
      return [];
    }
    try {
      const rows = await this.rows<{ name: string }>(
        `SELECT name
         FROM system.functions
         WHERE origin != 'System'
         ORDER BY name`
      );
      return rows.map((row) => row.name);
    } catch {
      // system.functions predates the `origin` column on old servers.
      return [];
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    const rows = await this.rows<{
      name: string;
      origin: string;
      create_query: string;
      is_aggregate: number | string | null;
    }>(
      `SELECT name, origin, create_query, is_aggregate
       FROM system.functions
       WHERE name = {name:String}`,
      { name: procedureName }
    );

    const row = rows[0];
    if (!row) {
      throw new Error(`Function '${procedureName}' not found`);
    }

    return {
      procedure_name: row.name,
      // ClickHouse has no procedures, so anything found here is a function.
      procedure_type: "function",
      language: row.origin === "ExecutableUserDefined" ? "Executable" : "SQL",
      parameter_list: parseFunctionParameterList(row.create_query ?? ""),
      definition: row.create_query || undefined,
    };
  }

  /**
   * `total_rows` is maintained by the engine, so this stays O(1) where
   * COUNT(*) would scan. It is null for views and for engines that do not
   * track a row count, which the interface already models as "unknown".
   */
  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    const rows = await this.rows<{ total_rows: string | number | null }>(
      `SELECT total_rows
       FROM system.tables
       WHERE database = {schema:String} AND name = {table:String}`,
      { schema: this.schemaOrDefault(schema), table: tableName }
    );
    const total = rows[0]?.total_rows;
    return total === null || total === undefined ? null : Number(total);
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    const rows = await this.rows<{ comment: string }>(
      `SELECT comment
       FROM system.tables
       WHERE database = {schema:String} AND name = {table:String}`,
      { schema: this.schemaOrDefault(schema), table: tableName }
    );
    return rows[0]?.comment || null;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.client) {
      throw new Error("Not connected to database");
    }

    const statements = splitSQLStatements(sql, "clickhouse");
    if (statements.length === 0) {
      return { resultSets: [] };
    }
    if (parameters && parameters.length > 0 && statements.length > 1) {
      throw new Error("Parameters are not supported for multi-statement queries in ClickHouse");
    }

    const settings = this.settingsFor(options);
    const resultSets: SQLResultSet[] = [];

    // The HTTP interface runs exactly one statement per request, so a batch is
    // executed in order rather than sent as one string. Each statement keeps
    // its own result set: a caller needs to tell "SELECT 1 AS a" and
    // "SELECT 2 AS b" apart, not just see their rows concatenated.
    for (const statement of statements) {
      resultSets.push(await this.executeStatement(statement, options, settings, parameters));
    }

    return { resultSets };
  }

  private async executeStatement(
    statement: string,
    options: ExecuteOptions,
    settings: ClickHouseSettings | undefined,
    parameters?: any[]
  ): Promise<SQLResultSet> {
    const client = this.client!;
    const keyword = getFirstKeyword(statement, "clickhouse");

    if (!ROW_RETURNING_KEYWORDS.has(keyword)) {
      // Anything not known to return rows: writes, DDL, SET, and any leading
      // token this list does not name. `command()` is right for all of those,
      // but note the consequence for the last group — a statement that *would*
      // have returned rows under an unrecognised leading token (e.g. a
      // parenthesised `(SELECT ...)`) comes back as an empty result set rather
      // than an error. Read-only tools never reach that case: the classifier
      // rejects such a statement before the connector sees it.
      await client.command({
        query: statement,
        clickhouse_settings: settings,
        query_params: buildQueryParams(statement, parameters),
      });
      return { sql: statement, rows: [], rowCount: 0 };
    }

    if (hasExplicitFormatClause(statement)) {
      throw new Error(
        "An explicit FORMAT clause is not supported: DBHub requests JSON itself, " +
          "and ClickHouse rejects a query carrying two FORMAT clauses. " +
          "Remove the FORMAT clause — results are returned as structured rows either way."
      );
    }

    const rewrite: MaxRowsRewrite = applyClickHouseMaxRows(statement, options.maxRows);
    const resultSet = await client.query({
      query: rewrite.sql,
      format: "JSON",
      clickhouse_settings: settings,
      query_params: buildQueryParams(statement, parameters),
    });
    const response = await resultSet.json<Record<string, unknown>>();
    const rows = response.data ?? [];

    const result: SQLResultSet = { sql: statement, rows, rowCount: rows.length };
    SQLRowLimiter.flagTruncation(result, options.maxRows, rewrite.probeApplied);
    return result;
  }
}

/**
 * Map the positional `parameters` array onto ClickHouse's named `query_params`.
 *
 * ClickHouse placeholders are named (`{id: UInt32}`) while the Connector
 * interface passes values as an array, so the binding rule is positional by
 * first appearance: the Nth distinct placeholder in the statement takes the
 * Nth value. Custom tools declare their parameters in that same order (see
 * mapArgumentsToArray), so a tool whose statement and parameter list agree
 * binds correctly.
 */
function buildQueryParams(
  statement: string,
  parameters?: any[]
): Record<string, unknown> | undefined {
  if (!parameters || parameters.length === 0) {
    return undefined;
  }

  const names = extractBracedParameterNames(statement);
  if (names.length !== parameters.length) {
    throw new Error(
      `Parameter count mismatch: statement has ${names.length} placeholder(s) ` +
        `(${names.map((name) => `{${name}}`).join(", ") || "none"}), ` +
        `but ${parameters.length} value(s) were supplied.`
    );
  }

  return Object.fromEntries(names.map((name, index) => [name, parameters[index]]));
}

/**
 * Render a column default the way the interface's `column_default` expects.
 * ClickHouse splits this across two columns: DEFAULT carries an ordinary
 * default, while MATERIALIZED and ALIAS mean the value is computed — dropping
 * the kind would misreport those as plain defaults.
 */
function formatColumnDefault(kind: string, expression: string): string | null {
  if (!expression) {
    return null;
  }
  return kind && kind !== "DEFAULT" ? `${kind} ${expression}` : expression;
}

/**
 * An https.Agent that skips certificate verification, for `sslmode=require`.
 * Imported lazily so that the common (verifying) path never pulls in node:https.
 */
async function insecureHTTPSAgent(): Promise<Agent> {
  const https = await import("node:https");
  return new https.Agent({ rejectUnauthorized: false });
}

// Register the connector
const clickhouseConnector = new ClickHouseConnector();
ConnectorRegistry.register(clickhouseConnector);
