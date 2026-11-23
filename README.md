# Fox Schema Multi SQL Queries (n8n community node)

Execute multiple SQL queries **serially (chained pipeline)** or **in parallel (concurrent)** in a single n8n node, powered by [`@foxschema/db`](https://foxschema.com).

Supports **PostgreSQL**, **CockroachDB**, **YugabyteDB**, **Amazon Redshift**, **MySQL**, **MariaDB**, **TiDB**, **SQL Server**, **Azure SQL**, **Oracle**, **SQLite**, **DuckDB**, and **ClickHouse**.

*(Db2 is intentionally excluded because native `ibm_db` cannot install through n8n's community-node installer.)*

## Features

- **Flexible Database Connections**:
  - **One Credential (All Queries)**: Attach a single **Fox Schema SQL Database API** credential for all queries.
  - **Multi-DB Vault Credential (Per Query)**: Store multiple encrypted database connections across different dialects in **Fox Schema Multi-DB Vault API** and route each query by alias (e.g. `main_pg`, `analytics_ch`, `billing_mysql`).
  - **Per-Query / Mixed Connection**: Combine default credential, vault aliases, and inline per-query connections (`dialect`, `connectionString`, or host/port/user/pass).
- **Serial (Pipeline) & Parallel Execution**:
  - **Serial Pipe**: Queries run in order; downstream queries can reference prior results via `{{ $pipeline.step1.data[0].id }}`, `{{ $prev.data }}`, `{{ $steps[0].data }}`, or `{{ $json.field }}`. Supports optional single-DB **Transactions**.
  - **Parallel**: Queries run concurrently up to `concurrencyLimit` across one or multiple databases.
- **Timeouts & Retries**: Node-level default `timeoutMs` (default `5000ms`), per-query timeout override, and configurable retry attempts.
- **Portable Parameterized SQL**: Write `?` placeholders with typed **Bind Parameters** (`string`, `number`, `boolean`, `date`, `json`, `null`, `sql`) — automatically rewritten to `$1`, `@p1`, `:1`, or `?` for the target dialect, including array expansion for `IN (?)`.
- **6 Response Output Modes** (matching `n8n-nodes-fox-schema-multi-endpoints`):
  - `Merge All Responses into an Object`
  - `Last Response Only`
  - `First Response Only`
  - `All Responses as Array`
  - `Split Each Response to New Item`
  - `Merge into Input Item`

## Runtime Drivers (Install on the n8n Host)

This package ships **no native database drivers** so community installation succeeds cleanly. Install only the driver(s) you use on your n8n host:

| Dialect | npm package |
|---|---|
| PostgreSQL / CockroachDB / YugabyteDB / Redshift | `pg` |
| MySQL / MariaDB / TiDB | `mysql2` |
| SQL Server / Azure SQL | `mssql` |
| Oracle | `oracledb` |
| SQLite | `better-sqlite3` |
| DuckDB | `@duckdb/node-api` |
| ClickHouse | `@clickhouse/client` |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm validate:n8n
pnpm scan:n8n
```
