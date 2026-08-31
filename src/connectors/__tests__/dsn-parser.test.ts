import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PostgresConnector } from '../postgres/index.js';
import { MySQLConnector } from '../mysql/index.js';
import { MariaDBConnector } from '../mariadb/index.js';
import { SQLServerConnector } from '../sqlserver/index.js';
import { ClickHouseConnector } from '../clickhouse/index.js';

describe('DSN Parser - PostgreSQL SSL Modes', () => {
  const connector = new PostgresConnector();
  const parser = connector.dsnParser;
  let tempDir: string;
  let certPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-ssl-test-'));
    certPath = path.join(tempDir, 'ca-bundle.pem');
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should set ssl = false for sslmode=disable', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=disable');
    expect(config.ssl).toBe(false);
  });

  it('should set rejectUnauthorized = false for sslmode=require', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=require');
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should set rejectUnauthorized = true and skip hostname check for sslmode=verify-ca', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=verify-ca');
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.checkServerIdentity).toBe('function');
    expect((ssl.checkServerIdentity as Function)()).toBeUndefined();
  });

  it('should set rejectUnauthorized = true and verify hostname for sslmode=verify-full', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=verify-full');
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it('should read CA cert file for sslmode=verify-ca with sslrootcert', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });

  it('should read CA cert file for sslmode=verify-full with sslrootcert', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-full&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n',
    });
  });

  it('should expand ~ in sslrootcert path', async () => {
    const mockHomedir = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    fs.writeFileSync(path.join(tempDir, 'ca.pem'), 'test-ca-content');

    try {
      const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=${encodeURIComponent('~/ca.pem')}`;
      const config = await parser.parse(dsn);
      const ssl = config.ssl as Record<string, unknown>;
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toBe('test-ca-content');
    } finally {
      mockHomedir.mockRestore();
    }
  });

  it('should throw when sslrootcert points to nonexistent file', async () => {
    const dsn = 'postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=/nonexistent/ca.pem';
    await expect(parser.parse(dsn)).rejects.toThrow("Failed to read SSL root certificate at '/nonexistent/ca.pem'");
  });

  it('should ignore sslrootcert when sslmode=require', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=require&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should ignore sslrootcert when sslmode=disable', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=disable&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toBe(false);
  });
});

describe('DSN Parser - AWS IAM Authentication', () => {
  describe('MySQL', () => {
    const connector = new MySQLConnector();
    const parser = connector.dsnParser;

    it('should detect AWS IAM token and configure cleartext plugin with SSL', async () => {
      const awsToken = 'mydb.abc123.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=myuser&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/rds-db/aws4_request&X-Amz-Date=20240101T000000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456';
      const dsn = `mysql://myuser:${encodeURIComponent(awsToken)}@mydb.abc123.us-east-1.rds.amazonaws.com:3306/mydb`;

      const config = await parser.parse(dsn);

      // Should have authPlugins configured with cleartext plugin
      expect(config.authPlugins).toBeDefined();
      expect(config.authPlugins?.mysql_clear_password).toBeDefined();

      // Should auto-enable SSL for AWS IAM authentication
      expect(config.ssl).toEqual({ rejectUnauthorized: false });

      // Plugin should return password with null terminator
      if (config.authPlugins?.mysql_clear_password) {
        const pluginFunc = config.authPlugins.mysql_clear_password();
        const result = pluginFunc();
        expect(result).toBeInstanceOf(Buffer);
        expect(result.toString()).toBe(awsToken + '\0');
      }
    });

    it('should not configure cleartext plugin for normal passwords', async () => {
      const dsn = 'mysql://myuser:regularpassword@localhost:3306/mydb';

      const config = await parser.parse(dsn);

      expect(config.authPlugins).toBeUndefined();
      expect(config.ssl).toBeUndefined();
    });
  });

  describe('MariaDB', () => {
    const connector = new MariaDBConnector();
    const parser = connector.dsnParser;

    it('should detect AWS IAM token and auto-enable SSL', async () => {
      const awsToken = 'mydb.abc123.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=myuser&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/rds-db/aws4_request&X-Amz-Date=20240101T000000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456';
      const dsn = `mariadb://myuser:${encodeURIComponent(awsToken)}@mydb.abc123.us-east-1.rds.amazonaws.com:3306/mydb`;

      const config = await parser.parse(dsn);

      // SSL should be auto-enabled for AWS IAM auth
      // MariaDB connector includes mysql_clear_password in default permitted plugins
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('should not auto-enable SSL for normal passwords', async () => {
      const dsn = 'mariadb://myuser:regularpassword@localhost:3306/mydb';

      const config = await parser.parse(dsn);

      expect(config.ssl).toBeUndefined();
    });
  });
});

describe('DSN Parser - SQL Server Named Instance Configuration', () => {
  it('should parse instanceName from query parameter', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV1');

    expect(config.options?.instanceName).toBe('ENV1');
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('testdb');
  });

  it('should parse instanceName with other query parameters', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV2&sslmode=disable');

    expect(config.options?.instanceName).toBe('ENV2');
    expect(config.options?.encrypt).toBe(false);
  });

  it('should work without instanceName (backward compatibility)', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb');

    expect(config.options?.instanceName).toBeUndefined();
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
  });
});

describe('DSN Parser - SQL Server SSL/TLS Configuration', () => {
  it('should parse sslmode=disable correctly', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=disable');

    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(false);
  });

  it('should parse sslmode=require correctly', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=require');

    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
  });

  it('should default to unencrypted when no sslmode specified', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db');

    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(false);
  });
});

describe('DSN Parser - SQL Server NTLM Authentication', () => {
  const connector = new SQLServerConnector();
  const parser = connector.dsnParser;

  it('should configure NTLM authentication when authentication=ntlm and domain are provided', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP';

    const config = await parser.parse(dsn);

    expect(config.authentication).toEqual({
      type: 'ntlm',
      options: {
        domain: 'CORP',
        userName: 'jsmith',
        password: 'secret',
      },
    });
    // Credentials should only be in authentication object, not at top level
    expect(config.user).toBeUndefined();
    expect(config.password).toBeUndefined();
  });

  it('should preserve other options when using NTLM authentication', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP&sslmode=require&instanceName=PROD';

    const config = await parser.parse(dsn);

    expect(config.authentication).toEqual({
      type: 'ntlm',
      options: {
        domain: 'CORP',
        userName: 'jsmith',
        password: 'secret',
      },
    });
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
    expect(config.options?.instanceName).toBe('PROD');
  });

  it('should throw error when authentication=ntlm but domain is missing', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm';

    await expect(parser.parse(dsn)).rejects.toThrow("NTLM authentication requires 'domain' parameter");
  });

  it('should throw error when domain is provided without authentication=ntlm', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?domain=CORP';

    await expect(parser.parse(dsn)).rejects.toThrow("Parameter 'domain' requires 'authentication=ntlm'");
  });

  it('should not configure NTLM for normal SQL authentication', async () => {
    const dsn = 'sqlserver://sa:password@localhost:1433/mydb';

    const config = await parser.parse(dsn);

    expect(config.authentication).toBeUndefined();
    expect(config.user).toBe('sa');
    expect(config.password).toBe('password');
  });
});

describe('DSN Parser - missing database component', () => {
  describe.each([
    { label: 'MySQL', connector: () => new MySQLConnector(), scheme: 'mysql' },
    { label: 'MariaDB', connector: () => new MariaDBConnector(), scheme: 'mariadb' },
  ])('$label', ({ label, connector, scheme }) => {
    const parser = connector().dsnParser;

    it.each([
      { form: 'trailing slash', dsn: `${scheme}://user:pass@localhost:3306/` },
      { form: 'no path', dsn: `${scheme}://user:pass@localhost:3306` },
      { form: 'query string only', dsn: `${scheme}://user:pass@localhost:3306/?sslmode=disable` },
    ])('rejects a DSN with $form', async ({ dsn }) => {
      await expect(parser.parse(dsn)).rejects.toThrow(`${label} DSN must name a database`);
    });

    it('points the user at the TOML config for multi-database setups', async () => {
      await expect(parser.parse(`${scheme}://user:pass@localhost:3306/`)).rejects.toThrow(
        /https:\/\/dbhub\.ai\/config\/toml/
      );
    });

    it('does not leak the password in the error message', async () => {
      // The error echoes the DSN back, so it must be obfuscated first
      await expect(parser.parse(`${scheme}://user:hunter2@localhost:3306/`)).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('hunter2'),
        })
      );
    });

    it('still accepts a DSN that names a database', async () => {
      const config = await parser.parse(`${scheme}://user:pass@localhost:3306/mydb`);
      expect(config.database).toBe('mydb');
    });
  });
});

describe('DSN Parser - ClickHouse', () => {
  const parser = new ClickHouseConnector().dsnParser;

  it('accepts the clickhouse://, http:// and https:// schemes', () => {
    expect(parser.isValidDSN('clickhouse://user:pass@localhost:8123/db')).toBe(true);
    // DBHub reaches ClickHouse over its HTTP interface, so the endpoint URL a
    // deployment hands out is already a usable DSN. No other connector claims
    // http(s), so getConnectorForDSN stays unambiguous.
    expect(parser.isValidDSN('http://user:pass@localhost:8123/db')).toBe(true);
    expect(parser.isValidDSN('https://user:pass@host:8443/db')).toBe(true);
    expect(parser.isValidDSN('mysql://user:pass@localhost:3306/db')).toBe(false);
    expect(parser.isValidDSN('not-a-dsn')).toBe(false);
  });

  it('parses an http:// endpoint URL as a ClickHouse DSN', async () => {
    const config = await parser.parse('http://reader:secret@ch.internal:8123/analytics');
    expect(config.url).toBe('http://ch.internal:8123');
    expect(config.username).toBe('reader');
    expect(config.password).toBe('secret');
    expect(config.database).toBe('analytics');
    expect(config.rejectUnauthorized).toBe(true);
  });

  it('takes TLS from the scheme rather than the port', async () => {
    // https on ClickHouse's plain-HTTP port, and http on its TLS port: the
    // scheme is explicit, so it wins over the 8443 heuristic.
    expect((await parser.parse('https://u:p@host:8123/db')).url).toBe('https://host:8123');
    expect((await parser.parse('http://u:p@host:8443/db')).url).toBe('http://host:8443');
  });

  it('defaults the port from the scheme when none is given', async () => {
    expect((await parser.parse('http://u:p@host/db')).url).toBe('http://host:8123');
    expect((await parser.parse('https://u:p@host/db')).url).toBe('https://host:8443');
  });

  it('lets sslmode override the scheme', async () => {
    const config = await parser.parse('https://u:p@host:8443/db?sslmode=require');
    expect(config.url).toBe('https://host:8443');
    expect(config.rejectUnauthorized).toBe(false);
    expect((await parser.parse('https://u:p@host:8443/db?sslmode=disable')).url).toBe(
      'http://host:8443'
    );
  });

  it('rejects native protocol ports on an http:// DSN too', async () => {
    await expect(parser.parse('http://u:p@host:9000/db')).rejects.toThrow(
      /native TCP protocol/
    );
  });

  it('maps a plain DSN onto the HTTP interface', async () => {
    const config = await parser.parse('clickhouse://reader:secret@ch.internal:8123/analytics');
    expect(config.url).toBe('http://ch.internal:8123');
    expect(config.username).toBe('reader');
    expect(config.password).toBe('secret');
    expect(config.database).toBe('analytics');
    expect(config.rejectUnauthorized).toBe(true);
  });

  it('defaults the port to 8123, or 8443 when TLS is requested', async () => {
    expect((await parser.parse('clickhouse://u:p@host/db')).url).toBe('http://host:8123');
    expect((await parser.parse('clickhouse://u:p@host/db?secure=true')).url).toBe(
      'https://host:8443'
    );
  });

  it('defaults the username to ClickHouse\'s own default', async () => {
    const config = await parser.parse('clickhouse://host:8123/db');
    expect(config.username).toBe('default');
  });

  it('infers TLS from the 8443 port', async () => {
    const config = await parser.parse('clickhouse://u:p@host:8443/db');
    expect(config.url).toBe('https://host:8443');
  });

  it('honours sslmode ahead of the port', async () => {
    expect((await parser.parse('clickhouse://u:p@host:8443/db?sslmode=disable')).url).toBe(
      'http://host:8443'
    );

    const insecure = await parser.parse('clickhouse://u:p@host:8123/db?sslmode=require');
    expect(insecure.url).toBe('https://host:8123');
    // "require" is DBHub-wide shorthand for TLS without certificate verification.
    expect(insecure.rejectUnauthorized).toBe(false);

    const verified = await parser.parse('clickhouse://u:p@host:8123/db?sslmode=verify-full');
    expect(verified.url).toBe('https://host:8123');
    expect(verified.rejectUnauthorized).toBe(true);
  });

  it.each([
    { port: 9000, suggested: 8123 },
    { port: 9440, suggested: 8443 },
  ])('rejects the native protocol port $port with the HTTP port to use', async ({ port, suggested }) => {
    // The client speaks HTTP(S) only, so a native-protocol port would fail as
    // an opaque socket hang rather than a configuration mistake.
    await expect(parser.parse(`clickhouse://u:p@host:${port}/db`)).rejects.toThrow(
      new RegExp(`native TCP protocol[\\s\\S]*port ${suggested}`)
    );
  });

  it('requires the DSN to name a database', async () => {
    await expect(parser.parse('clickhouse://u:p@host:8123/')).rejects.toThrow(
      'ClickHouse DSN must name a database'
    );
    // The hint should show a ClickHouse port, not MySQL's.
    await expect(parser.parse('clickhouse://u:p@host:8123/')).rejects.toThrow(/\.\.\.:8123\/mydb/);
  });

  it('does not leak the password in error messages', async () => {
    await expect(parser.parse('clickhouse://u:hunter2@host:8123/')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    );
    await expect(parser.parse('clickhouse://u:hunter2@host:9000/db')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    );
  });

  it('derives the request timeout from the configured timeouts', async () => {
    expect((await parser.parse('clickhouse://u:p@host:8123/db')).requestTimeoutMs).toBeUndefined();

    // The socket deadline sits just past max_execution_time so the server wins
    // the race and returns a proper timeout error.
    const withQuery = await parser.parse('clickhouse://u:p@host:8123/db', {
      queryTimeoutSeconds: 30,
    });
    expect(withQuery.requestTimeoutMs).toBe(32000);

    const withBoth = await parser.parse('clickhouse://u:p@host:8123/db', {
      connectionTimeoutSeconds: 60,
      queryTimeoutSeconds: 30,
    });
    expect(withBoth.requestTimeoutMs).toBe(60000);
  });

  it('never lets a short connection timeout cap how long a query may run', async () => {
    // HTTP has no separate connect phase to bound, so connection_timeout can
    // only raise the ceiling. Without the floor, `connection_timeout = 5` would
    // silently abort every query after five seconds.
    const shortConnect = await parser.parse('clickhouse://u:p@host:8123/db', {
      connectionTimeoutSeconds: 5,
    });
    expect(shortConnect.requestTimeoutMs).toBe(30000);

    // A long query budget still wins over the floor.
    const longQuery = await parser.parse('clickhouse://u:p@host:8123/db', {
      connectionTimeoutSeconds: 5,
      queryTimeoutSeconds: 300,
    });
    expect(longQuery.requestTimeoutMs).toBe(302000);
  });

  it('keeps a password containing @ intact', async () => {
    const config = await parser.parse('clickhouse://user:p%40ss@host:8123/db');
    expect(config.password).toBe('p@ss');
    expect(config.url).toBe('http://host:8123');
  });
});
