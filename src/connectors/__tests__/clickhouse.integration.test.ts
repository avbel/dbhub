import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClickHouseContainer, StartedClickHouseContainer } from '@testcontainers/clickhouse';
import { ClickHouseConnector } from '../clickhouse/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class ClickHouseTestContainer implements TestContainer {
  constructor(private container: StartedClickHouseContainer) {}

  /**
   * The container hands back an `http://` URL, which DBHub accepts as-is; the
   * swap to the canonical `clickhouse://` scheme keeps this suite exercising
   * the scheme most deployments configure. Host, port, credentials and database
   * are unchanged. Both schemes are covered in dsn-parser.test.ts.
   */
  getConnectionUri(): string {
    return this.container.getConnectionUrl().replace(/^https?:\/\//, 'clickhouse://');
  }

  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class ClickHouseIntegrationTest extends IntegrationTestBase<ClickHouseTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['testdb'],
      expectedTables: ['users', 'orders', 'products'],
      expectedStoredProcedures: ['dbhub_add'],
      supportsComments: true,
    };
    super(config);
  }

  async createContainer(): Promise<ClickHouseTestContainer> {
    const container = await new ClickHouseContainer('clickhouse/clickhouse-server:24.8-alpine')
      // Lets the test create a second user whose profile pins readonly = 1,
      // which is how a locked-down ClickHouse read-only account is usually set up.
      .withEnvironment({ CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' })
      .withDatabase('testdb')
      .withUsername('dbhub')
      .withPassword('dbhubpass')
      .start();

    return new ClickHouseTestContainer(container);
  }

  createConnector(): Connector {
    return new ClickHouseConnector();
  }

  async setupTestData(connector: Connector): Promise<void> {
    // MergeTree with an explicit ORDER BY: that key is what getTableIndexes
    // reports as the (non-unique) primary index.
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS users (
        id UInt32,
        name String COMMENT 'Full name of the user',
        email String COMMENT 'Unique email address',
        age Nullable(UInt8)
      ) ENGINE = MergeTree
      ORDER BY id
      COMMENT 'Application users'
    `, {});

    // No table comment here: createCommentTests asserts getTableComment
    // returns null for a table without one.
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS orders (
        id UInt32,
        user_id UInt32,
        total Decimal(10, 2),
        created_at DateTime DEFAULT now()
      ) ENGINE = MergeTree
      ORDER BY id
    `, {});

    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS products (
        id UInt32,
        name String,
        price Decimal(10, 2)
      ) ENGINE = MergeTree
      ORDER BY id
    `, {});

    // A view, so the getTables/getViews partition has something to separate.
    await connector.executeSQL(`
      CREATE VIEW IF NOT EXISTS active_users AS
      SELECT id, name, email FROM users WHERE age IS NOT NULL
    `, {});

    // A data-skipping index: ClickHouse's nearest thing to a secondary index.
    await connector.executeSQL(`
      ALTER TABLE users ADD INDEX IF NOT EXISTS idx_email email TYPE bloom_filter GRANULARITY 4
    `, {});

    // ClickHouse has no stored procedures, but it does have user-defined
    // functions, which is what getStoredProcedures reports.
    await connector.executeSQL(
      'CREATE FUNCTION IF NOT EXISTS dbhub_add AS (a, b) -> a + b',
      {}
    );

    await connector.executeSQL(`
      INSERT INTO users (id, name, email, age) VALUES
      (1, 'John Doe', 'john@example.com', 30),
      (2, 'Jane Smith', 'jane@example.com', 25),
      (3, 'Bob Johnson', 'bob@example.com', 35)
    `, {});

    await connector.executeSQL(`
      INSERT INTO orders (id, user_id, total) VALUES
      (1, 1, 99.99),
      (2, 1, 12.50),
      (3, 2, 45.00)
    `, {});

    await connector.executeSQL(`
      INSERT INTO products (id, name, price) VALUES
      (1, 'Widget', 9.99),
      (2, 'Gadget', 19.99)
    `, {});
  }
}

const clickhouseTest = new ClickHouseIntegrationTest();

describe('ClickHouse Connector Integration Tests', () => {
  beforeAll(async () => {
    await clickhouseTest.setup();
  }, 120000);

  afterAll(async () => {
    await clickhouseTest.cleanup();
  }, 60000);

  clickhouseTest.createConnectionTests();
  clickhouseTest.createSchemaTests();
  clickhouseTest.createTableTests();
  clickhouseTest.createSQLExecutionTests();
  clickhouseTest.createStoredProcedureTests();
  clickhouseTest.createCommentTests();
  clickhouseTest.createErrorHandlingTests();

  describe('ClickHouse-specific metadata', () => {
    it('scopes the default schema to the database named in the DSN', async () => {
      expect(clickhouseTest.connector.getDefaultSchema).toBeDefined();
      expect(await clickhouseTest.connector.getDefaultSchema!()).toBe('testdb');
    });

    it('hides the system databases from getSchemas', async () => {
      const schemas = await clickhouseTest.connector.getSchemas();
      expect(schemas).not.toContain('system');
      expect(schemas).not.toContain('INFORMATION_SCHEMA');
      expect(schemas).not.toContain('information_schema');
    });

    it('lists the view under getViews, not getTables', async () => {
      expect(await clickhouseTest.connector.getViews()).toContain('active_users');
      expect(await clickhouseTest.connector.getTables()).not.toContain('active_users');
    });

    it('reports the sorting key as a non-unique primary index', async () => {
      const indexes = await clickhouseTest.connector.getTableIndexes('users');
      const primary = indexes.find((index) => index.is_primary);
      expect(primary).toBeDefined();
      expect(primary?.index_name).toBe('PRIMARY');
      expect(primary?.column_names).toEqual(['id']);
      // ClickHouse enforces no uniqueness on the primary key.
      expect(primary?.is_unique).toBe(false);
    });

    it('reports data-skipping indices alongside the key', async () => {
      const indexes = await clickhouseTest.connector.getTableIndexes('users');
      const skipIndex = indexes.find((index) => index.index_name === 'idx_email');
      expect(skipIndex).toBeDefined();
      expect(skipIndex?.column_names).toEqual(['email']);
      expect(skipIndex?.is_primary).toBe(false);
    });

    it('derives column nullability from the ClickHouse type', async () => {
      const schema = await clickhouseTest.connector.getTableSchema('users');
      expect(schema.find((col) => col.column_name === 'age')?.is_nullable).toBe('YES');
      expect(schema.find((col) => col.column_name === 'name')?.is_nullable).toBe('NO');
    });

    it('reports a row count from engine statistics rather than COUNT(*)', async () => {
      expect(clickhouseTest.connector.getTableRowCount).toBeDefined();
      const rowCount = await clickhouseTest.connector.getTableRowCount!('products');
      expect(rowCount).toBe(2);
    });

    it('returns no stored procedures, because ClickHouse has none', async () => {
      expect(await clickhouseTest.connector.getStoredProcedures(undefined, 'procedure')).toEqual([]);
    });

    it('reports user-defined functions and excludes the built-ins', async () => {
      const functions = await clickhouseTest.connector.getStoredProcedures(undefined, 'function');
      expect(functions).toContain('dbhub_add');
      // system.functions lists hundreds of built-ins; origin != 'System' filters them.
      expect(functions).not.toContain('toYYYYMM');
      expect(functions.length).toBeLessThan(20);
    });

    it('parses the lambda parameter list out of a UDF definition', async () => {
      const detail = await clickhouseTest.connector.getStoredProcedureDetail('dbhub_add');
      expect(detail.procedure_name).toBe('dbhub_add');
      expect(detail.procedure_type).toBe('function');
      expect(detail.language).toBe('SQL');
      expect(detail.parameter_list).toBe('(a, b)');
      expect(detail.definition).toContain('CREATE FUNCTION');
    });

    it('raises a clear error for a function that does not exist', async () => {
      await expect(
        clickhouseTest.connector.getStoredProcedureDetail('no_such_function')
      ).rejects.toThrow(/not found/);
    });
  });

  describe('ClickHouse SQL execution', () => {
    it('runs a multi-statement batch as one result set per statement', async () => {
      // The HTTP interface takes one statement per request, so the connector
      // sequences the batch itself.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT 1 AS a; SELECT 2 AS b',
        {}
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[0].rows[0].a).toBe(1);
      expect(result.resultSets[1].rows[0].b).toBe(2);
      expect(result.resultSets[0].sql).toBe('SELECT 1 AS a');
    });

    it('caps rows at max_rows and flags the result as truncated', async () => {
      const result = await clickhouseTest.connector.executeSQL('SELECT * FROM users', {
        maxRows: 2,
      });
      expect(result.resultSets[0].rows).toHaveLength(2);
      expect(result.resultSets[0].rowCount).toBe(2);
      expect(result.resultSets[0].truncated).toBe(true);
    });

    it('does not flag truncation when the result fits', async () => {
      // Scoped to the seeded ids: the shared SQL-execution suite inserts an
      // extra user, so an unfiltered count is not order-independent.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT * FROM users WHERE id IN (1, 2, 3)',
        { maxRows: 10 }
      );
      expect(result.resultSets[0].rows).toHaveLength(3);
      expect(result.resultSets[0].truncated).toBeUndefined();
    });

    it('caps a LIMIT n BY query without changing its per-group semantics', async () => {
      // Rewriting the 1 in place would change which rows come back; the
      // connector wraps the statement instead.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT user_id, total FROM orders ORDER BY total DESC LIMIT 1 BY user_id',
        { maxRows: 10 }
      );
      // One row per user_id, and both users still represented.
      expect(result.resultSets[0].rows).toHaveLength(2);
      expect(result.resultSets[0].truncated).toBeUndefined();
    });

    it('caps a query carrying a trailing SETTINGS clause', async () => {
      // `... SETTINGS max_threads = 1 LIMIT 3` would be a syntax error.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT * FROM users SETTINGS max_threads = 1',
        { maxRows: 2 }
      );
      expect(result.resultSets[0].rows).toHaveLength(2);
      expect(result.resultSets[0].truncated).toBe(true);
    });

    it('caps a WITH-led query', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'WITH ranked AS (SELECT * FROM users) SELECT * FROM ranked',
        { maxRows: 1 }
      );
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].truncated).toBe(true);
    });

    it('binds named query parameters positionally', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT name FROM users WHERE id = {id:UInt32}',
        {},
        [2]
      );
      expect(result.resultSets[0].rows[0].name).toBe('Jane Smith');
    });

    it('returns Decimal as a string so precision survives', async () => {
      // A Decimal(18, 6) does not survive a JSON double; node-postgres makes
      // the same choice for NUMERIC.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT total FROM orders WHERE id = 1',
        {}
      );
      expect(result.resultSets[0].rows[0].total).toBe('99.99');
    });

    it('returns 64-bit integers as strings so large values survive', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT toUInt64(18446744073709551615) AS big',
        {}
      );
      expect(result.resultSets[0].rows[0].big).toBe('18446744073709551615');
    });

    it('binds parameters on the command path too, not just on queries', async () => {
      // Non-row-returning statements go through command(); dropping their
      // parameters would leave the placeholder unbound at the server.
      await clickhouseTest.connector.executeSQL(
        'INSERT INTO products (id, name, price) VALUES ({id:UInt32}, {name:String}, 5.00)',
        {},
        [77, 'bound-param']
      );
      const check = await clickhouseTest.connector.executeSQL(
        'SELECT name FROM products WHERE id = 77',
        {}
      );
      expect(check.resultSets[0].rows[0].name).toBe('bound-param');
      await clickhouseTest.connector.executeSQL('DELETE FROM products WHERE id = 77', {});
    });

    it('rejects an explicit FORMAT clause with an actionable message', async () => {
      // The client appends FORMAT JSON itself; two FORMAT clauses is a parse error.
      await expect(
        clickhouseTest.connector.executeSQL('SELECT * FROM users FORMAT CSV', {})
      ).rejects.toThrow(/explicit FORMAT clause is not supported/);
    });
  });

  describe('Per-tool readonly engine backstop (options.readonly)', () => {
    // ClickHouse has no transactions, so the backstop is the `readonly`
    // setting rather than a READ ONLY transaction.
    it('blocks an INSERT that the keyword classifier never saw', async () => {
      await expect(
        clickhouseTest.connector.executeSQL(
          "INSERT INTO users (id, name, email) VALUES (99, 'ro', 'ro@ro.com')",
          { readonly: true }
        )
      ).rejects.toThrow(/readonly|read-only/i);

      const check = await clickhouseTest.connector.executeSQL(
        "SELECT count() AS c FROM users WHERE email = 'ro@ro.com'",
        {}
      );
      expect(Number(check.resultSets[0].rows[0].c)).toBe(0);
    });

    it('blocks DDL as well as DML', async () => {
      await expect(
        clickhouseTest.connector.executeSQL('DROP TABLE products', { readonly: true })
      ).rejects.toThrow(/readonly|read-only/i);

      expect(await clickhouseTest.connector.tableExists('products')).toBe(true);
    });

    it('leaves the connection writable for a non-readonly call afterwards', async () => {
      await clickhouseTest.connector.executeSQL(
        "INSERT INTO products (id, name, price) VALUES (99, 'rw', 1.00)",
        {}
      );
      const check = await clickhouseTest.connector.executeSQL(
        "SELECT count() AS c FROM products WHERE name = 'rw'",
        {}
      );
      expect(Number(check.resultSets[0].rows[0].c)).toBe(1);

      await clickhouseTest.connector.executeSQL("DELETE FROM products WHERE name = 'rw'", {});
    });

    it('works against an account whose own profile pins readonly = 1', async () => {
      // That profile rejects *any* attempt to change a setting, so the
      // connector must send none — not even its own readonly backstop, and not
      // the decimal-quoting setting. It is also stricter than the backstop, so
      // nothing is lost by standing down.
      await clickhouseTest.connector.executeSQL(
        "CREATE USER IF NOT EXISTS ro_user IDENTIFIED WITH plaintext_password BY 'ro_pass' SETTINGS readonly = 1",
        {}
      );
      await clickhouseTest.connector.executeSQL('GRANT SELECT ON testdb.* TO ro_user', {});
      await clickhouseTest.connector.executeSQL('GRANT SELECT ON system.* TO ro_user', {});

      const dsn = clickhouseTest.connectionString.replace(
        /\/\/[^@]+@/,
        '//ro_user:ro_pass@'
      );
      const restricted = new ClickHouseConnector();
      try {
        // Connecting must succeed even though no setting may be sent.
        await restricted.connect(dsn);

        const result = await restricted.executeSQL('SELECT count() AS c FROM users', {
          readonly: true,
        });
        expect(Number(result.resultSets[0].rows[0].c)).toBeGreaterThanOrEqual(3);

        // The server's own profile still rejects the write.
        await expect(
          restricted.executeSQL("INSERT INTO users (id, name, email) VALUES (98, 'x', 'x')", {
            readonly: true,
          })
        ).rejects.toThrow(/readonly|read-only|not enough privileges/i);
      } finally {
        await restricted.disconnect();
      }
    });

    it('still allows reads while readonly is engaged', async () => {
      const result = await clickhouseTest.connector.executeSQL('SELECT count() AS c FROM users', {
        readonly: true,
      });
      expect(Number(result.resultSets[0].rows[0].c)).toBeGreaterThanOrEqual(3);
    });
  });
});
