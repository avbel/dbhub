> [!NOTE]  
> Brought to you by [Bytebase](https://www.bytebase.com/), open-source database governance platform.

<p align="center">
 <a href="https://www.star-history.com/bytebase/dbhub">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending" />
   <img alt="GitHub Trending Repository of the Day" src="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending" />
  </picture>
 </a>
</p>

<p align="center">
<a href="https://dbhub.ai/" target="_blank">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-dark.svg" width="75%">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%">
  <img src="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%" alt="DBHub Logo">
</picture>
</a>
</p>

```bash
            +------------------+    +--------------+    +------------------+
            |                  |    |              |    |                  |
            |                  |    |              |    |                  |
            |  Claude Desktop  +--->+              +--->+    PostgreSQL    |
            |                  |    |              |    |                  |
            |  Claude Code     +--->+              +--->+    SQL Server    |
            |                  |    |              |    |                  |
            |  Cursor          +--->+    DBHub     +--->+    SQLite        |
            |                  |    |              |    |                  |
            |  VS Code         +--->+              +--->+    MySQL         |
            |                  |    |              |    |                  |
            |  Copilot CLI     +--->+              +--->+    MariaDB       |
            |                  |    |              |    |                  |
            |                  |    |              +--->+    ClickHouse    |
            |                  |    |              |    |                  |
            |                  |    |              |    |                  |
            +------------------+    +--------------+    +------------------+
                 MCP Clients           MCP Server             Databases
```

DBHub is a minimal MCP server: token-efficient, zero-dependency, and just two tools by default with opt-in extras. This lightweight gateway allows MCP-compatible clients to connect to and explore different databases:

- **Minimal**: Zero dependency, token efficient with a minimal set of MCP tools to maximize context window
- **Multi-Database**: PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, and ClickHouse through a single interface
- **Multi-Connection**: Connect to multiple databases simultaneously with TOML configuration
- **Guardrails**: Read-only mode, row limiting, and query timeout to prevent runaway operations
- **Secure Access**: SSH tunneling and SSL/TLS encryption

> DBHub is the official example in the [Claude Code docs](https://code.claude.com/docs/en/mcp#example-query-your-postgresql-database) for connecting to PostgreSQL via MCP.

## Token Efficiency

DBHub loads just 2 tools by default at **1.4k tokens** — 13-14x fewer than alternatives — keeping the context window open for your actual work.

| MCP Server | Default Config | Default Tools |
|------------|---------------|--------------|
| **DBHub** | **1.4k** | 2 (`execute_sql`, `search_objects`) |
| MCP Toolbox | 19.0k | 28 |
| Supabase MCP | 19.3k | all |

## Use Cases

- **Local Development**: Schema exploration, query validation, and data debugging with Claude Code, VS Code, Cursor, etc.
- **Non-Technical Access**: Expose curated, read-only views to non-technical staff via Claude Desktop, VS Code, Cursor, etc.
- **Multi-Database Consolidation**: Replace separate MCP servers for each database with a single DBHub process
- **Production Troubleshooting**: Read-only diagnostics with guardrails against runaway queries

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, SQLite, and ClickHouse.

### ClickHouse

DBHub connects over ClickHouse's **HTTP interface** — port `8123`, or `8443` for
TLS. The native TCP ports (`9000`, `9440`) are not supported and are rejected at
startup with the HTTP port to use instead. The DSN must name a database:
ClickHouse databases are the schema concept, and naming one scopes object
discovery to it.

Because the transport *is* HTTP, an `http://` or `https://` endpoint URL is
accepted as a ClickHouse DSN in its own right — paste the URL a ClickHouse Cloud
service or container hands out, no `clickhouse://` rewrite needed. The scheme
also decides TLS on its own, so `https://` needs no `?secure=true`.

Single source, straight from the command line:

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 \
  --dsn "clickhouse://default:password@localhost:8123/analytics"
```

Read-only, with a row cap — the usual shape for handing an analytics cluster to
an agent (`dbhub.toml`):

```toml
[[sources]]
id = "analytics"
description = "ClickHouse events cluster"
dsn = "clickhouse://reader:password@ch.example.com:8443/events?secure=true"
query_timeout = 60          # Enforced server-side via max_execution_time

[[tools]]
name = "execute_sql"
source = "analytics"
readonly = true             # Also sets the engine-level `readonly = 2` session setting
max_rows = 1000

[[tools]]
name = "search_objects"
source = "analytics"
```

Connection options:

| Form | Meaning |
|------|---------|
| `?secure=true` | TLS; the port defaults to `8443` when the DSN omits one |
| `?sslmode=require` | TLS **without** certificate verification (self-signed certs) |
| `?sslmode=disable` | Plain HTTP, even on port 8443 |
| Individual params | Use `type = "clickhouse"` with `host`/`port`/`database`/`user`/`password` when the password contains `@`, `:`, or `/` |

Notes specific to this engine:

- **Read-only is enforced by the engine**, not just the SQL classifier: ClickHouse
  has no transactions, so read-only statements run with the session setting
  `readonly = 2`, which rejects DML *and* DDL. If the connected account's own
  profile already pins `readonly`, DBHub leaves it alone.
- **`Decimal` and 64-bit integers are returned as strings**, so token amounts,
  prices, and `UInt256` balances survive intact instead of being rounded through
  a JavaScript double.
- **`search_objects` reports what ClickHouse actually has**: the primary key
  (marked non-unique — ClickHouse enforces no uniqueness), the sorting key when
  it differs, and data-skipping indices. There are no stored procedures, so the
  `function` object type reports user-defined functions instead.
- **Batches are not atomic.** With no transactions, a multi-statement batch runs
  one statement at a time; if the third fails, the first two have applied.

## MCP Tools

DBHub implements MCP tools for database operations:

- **[execute_sql](https://dbhub.ai/tools/execute-sql)**: Execute SQL queries with transaction support and safety controls
- **[search_objects](https://dbhub.ai/tools/search-objects)**: Search and explore database schemas, tables, columns, indexes, and procedures with progressive disclosure
- **[explain_sql](https://dbhub.ai/tools/explain-sql)** (opt-in): Show a query's execution plan without running it
- **[health_check](https://dbhub.ai/tools/health-check)** (opt-in): Report connection pool state and buffer cache hit ratio
- **[Custom Tools](https://dbhub.ai/tools/custom-tools)**: Define reusable, parameterized SQL operations in your `dbhub.toml` configuration file

## Workbench

DBHub includes a [built-in web interface](https://dbhub.ai/workbench/overview) for interacting with your database tools. It provides a visual way to execute queries, run custom tools, and view request traces without requiring an MCP client.

![workbench](https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/workbench/workbench.webp)

## Installation

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

Also available as:

- [Docker image](https://dbhub.ai/installation#docker)
- [MCP Bundle](https://dbhub.ai/mcpb) (one-click install, read-only)
- [Claude Code plugin](https://dbhub.ai/claude-code-plugin)

See the [Installation Guide](https://dbhub.ai/installation) for all options, [Command-Line Options](https://dbhub.ai/config/command-line) for parameters, and [Multi-Database Configuration](https://dbhub.ai/config/toml) for connecting several databases at once.

## Development

Requires Node.js >= 22.5.0 (DBHub uses the built-in `node:sqlite` module).

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build and run for production
pnpm build && pnpm start --transport stdio --dsn "postgres://user:password@localhost:5432/dbname"
```

See [Testing](.claude/skills/testing/SKILL.md) and [Debug](https://dbhub.ai/config/debug).

