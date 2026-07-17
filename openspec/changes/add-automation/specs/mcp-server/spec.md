# mcp-server — delta

## ADDED Requirements

### Requirement: An MCP stdio server exposes the engine in-process

The engine SHALL ship a `lighthouse-mcp` binary (a non-Tauri workspace crate) that
serves the Model Context Protocol over stdio, in-process against `lighthouse-core` —
NOT by shelling the loopback server — so its tools inherit the ask chokepoint
directly and there is a single answer path to reason about. Its `ask_vault` tool
SHALL answer through `ask::run_headless_ask`, so an agent's ask is audited and
egress-attributed exactly as an app ask.

#### Scenario: An agent asks the vault as a tool

- **WHEN** an MCP client calls the `ask_vault` tool with a question over the stdio server
- **THEN** the answer is computed by `run_headless_ask` (the shared chokepoint), returned with its provenance and references, and recorded in the audit + egress ledger just as an app ask would be

#### Scenario: The server runs in-process, not against the loopback port

- **WHEN** the MCP server answers any tool call
- **THEN** it calls `lighthouse-core` functions directly in-process, opening no HTTP connection to `lighthouse-server`, so there is no second transport to separately audit or secure

### Requirement: The v1 tool set is small and read-only-leaning

The server SHALL expose a SMALL starter tool set — `ask_vault` (over the shared ask
helper), `list_files` (`vault::list_nodes`), `list_investigations`
(`investigations::listing`), and `run_analytics_sql` (`analytics::run_direct`, a
guarded read-only SELECT) — and SHALL expose NO vault- or store-mutating tool in v1
(no create/rename/archive/fork/export/defineMetric/exportChat/upload/move). A
`run_analytics_sql` request that is not a read-only SELECT SHALL be refused by the
analytics guard, not executed.

#### Scenario: Reads and a guarded query are available

- **WHEN** an MCP client lists files, lists investigations, or runs a read-only analytics SELECT
- **THEN** each tool returns its on-device result (the node list, the investigation views with derived membership, or the query markdown/chart/footer) without egress

#### Scenario: A mutating analytics query is refused

- **WHEN** a `run_analytics_sql` tool call passes SQL that is not a read-only SELECT
- **THEN** the analytics guard (`guard_sql`) refuses it with an error and nothing is written — the write surface is out of scope for v1

### Requirement: A future port adopts the loopback + token auth model

The v1 server SHALL be stdio-only (no listening port, hence no network-auth surface).
IF a future version binds a port, it SHALL bind loopback only and adopt `auth.rs`'s
model — a loopback-host allowlist (defeating DNS rebinding), same-port origin, and the
`LIGHTHOUSE_API_TOKEN` shared secret — never a bare LAN listener.

#### Scenario: v1 opens no port

- **WHEN** the v1 `lighthouse-mcp` server is running
- **THEN** it communicates only over stdin/stdout and binds no TCP port, so no other local process can reach it over the network

#### Scenario: A future port reuses the server auth model

- **WHEN** a later version of the MCP server binds a port instead of stdio
- **THEN** it binds loopback only and enforces the same loopback-host + same-port-origin + `LIGHTHOUSE_API_TOKEN` checks the loopback API server enforces, rather than inventing a weaker gate
