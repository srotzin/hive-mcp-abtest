# hive-mcp-abtest

A/B experiment runner for the A2A network. An inbound-only MCP shim that gives autonomous agents a deterministic, sticky bucket assignment, a conversion-recording endpoint, and a two-proportion Z-test stat-sig calculator. Pricing is per call via x402 on Base USDC.

- `$0.001` per `abtest_assign`
- `$0.005` per `abtest_record_conversion`
- `abtest_results` is free and read-only

The shim does not run experiments on behalf of the caller. It records assignments and conversions for experiments the caller registers, and returns aggregate counts and a Z-test on demand.

## How bucket assignment works

Bucket is `SHA-256(experiment_id + "|" + agent_did)`, with the first four bytes read as an unsigned 32-bit integer, modulo the sum of variant weights. The first call writes the result. Subsequent calls return the same row, so assignment is sticky for the lifetime of the SQLite store.

A variant list is `[{ id, weight? }, ...]`. Weight defaults to `1` per variant. Pass `[{id:"control"},{id:"treatment",weight:3}]` for a 25/75 split.

## Stat-sig calculator

Two-proportion Z-test with pooled variance over the first two registered variants. Output includes `z_score`, two-sided `p_value`, `relative_lift`, and `significant_95` / `significant_99` boolean flags.

## MCP

- Transport: Streamable HTTP, JSON-RPC 2.0
- Protocol: `2024-11-05`
- Endpoint: `POST /mcp`

Tools:

| Tool | Tier | Price |
|---|---|---|
| `abtest_assign` | 3 | $0.001 |
| `abtest_record_conversion` | 3 | $0.005 |
| `abtest_results` | 0 | free |

## REST

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/abtest` | List experiments |
| POST | `/v1/abtest` | Create or upsert experiment `{ id, name?, variants }` |
| GET | `/v1/abtest/:id` | Get experiment |
| PUT | `/v1/abtest/:id` | Update experiment |
| DELETE | `/v1/abtest/:id` | Delete experiment |
| POST | `/v1/abtest/assign` | `{ experiment_id, agent_did, variants? }` — $0.001 |
| POST | `/v1/abtest/convert` | `{ experiment_id, agent_did, metric?, value? }` — $0.005 |
| GET | `/v1/abtest/results` | `?experiment_id=...&metric=...` — Z-test included |
| GET | `/v1/abtest/today` | UTC-day assignment + conversion counts |
| GET | `/health` | Liveness, version, and DB check |

## Storage

SQLite at `/tmp/abtest.db` with three tables: `experiments`, `assignments`, `conversions`. Override with `DB_PATH`.

## Environment

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `ENABLE` | `true` |
| `WALLET_ADDRESS` | `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` |
| `PRICE_ASSIGN_USDC` | `0.001` |
| `PRICE_CONVERT_USDC` | `0.005` |
| `DB_PATH` | `/tmp/abtest.db` |
| `X402_ENABLED` | `true` |

Set `X402_ENABLED=false` to bypass payment gating in local development.

## Quickstart

```bash
npm install
npm start
# in another shell
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/v1/abtest \
  -H 'content-type: application/json' \
  -d '{"id":"prompt_v2","name":"prompt v2","variants":[{"id":"control"},{"id":"treatment","weight":3}]}'
curl -s -X POST http://localhost:3000/v1/abtest/assign \
  -H 'content-type: application/json' -H 'x-payment: {}' \
  -d '{"experiment_id":"prompt_v2","agent_did":"did:hive:demo:1"}'
```

The first call without a paid x402 envelope returns a `402` body with a fresh `nonce`. Submit a tx hash and payer to `/v1/x402/submit` to mint a short-lived access token, then retry.

## License

MIT. See `LICENSE`.

## Author

Steve Rotzin · steve@thehiveryiq.com · https://www.thehiveryiq.com

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
