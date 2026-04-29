#!/usr/bin/env node
/**
 * hive-mcp-abtest — A/B experiment runner for the A2A network.
 *
 * Deterministic bucket assignment by SHA-256(agent_did, experiment_id).
 * Tier-3 endpoints quote micropayments via x402:
 *   - $0.001 per assignment
 *   - $0.005 per conversion-recorded
 *
 * Stat-sig calculator endpoint runs a two-proportion Z-test on assignment
 * and conversion counts. The test is read-only and free.
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Mode : Inbound only. ENABLE=true default.
 */

import express from 'express';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';

const app = express();
app.use(express.json({ limit: '128kb' }));

const PORT = process.env.PORT || 3000;
const ENABLE = String(process.env.ENABLE ?? 'true').toLowerCase() === 'true';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const PRICE_ASSIGN = Number(process.env.PRICE_ASSIGN_USDC) || 0.001;
const PRICE_CONVERT = Number(process.env.PRICE_CONVERT_USDC) || 0.005;
const DB_PATH = process.env.DB_PATH || '/tmp/abtest.db';
const BRAND_GOLD = '#C08D23';

// ─── Storage ────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    variants_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assignments (
    experiment_id TEXT NOT NULL,
    agent_did TEXT NOT NULL,
    variant TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (experiment_id, agent_did)
  );
  CREATE INDEX IF NOT EXISTS idx_assign_exp_var ON assignments (experiment_id, variant);
  CREATE INDEX IF NOT EXISTS idx_assign_day ON assignments (assigned_at);
  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL,
    agent_did TEXT NOT NULL,
    variant TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 1,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_exp_var ON conversions (experiment_id, variant);
  CREATE INDEX IF NOT EXISTS idx_conv_day ON conversions (recorded_at);
`);
// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(process.env.BOGO_DB_PATH || '/tmp/bogo_abtest.db');
_bogoDB.pragma('journal_mode = WAL');
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS did_call_count ' +
  '(did TEXT PRIMARY KEY, paid_calls INTEGER NOT NULL DEFAULT 0)'
);

const _bogoGetStmt = _bogoDB.prepare(
  'SELECT paid_calls FROM did_call_count WHERE did = ?'
);
const _bogoUpsertStmt = _bogoDB.prepare(
  'INSERT INTO did_call_count (did, paid_calls) VALUES (?, 1) ' +
  'ON CONFLICT(did) DO UPDATE SET paid_calls = paid_calls + 1'
);

function _bogoCheck(did) {
  if (!did) return { free: false };
  const row = _bogoGetStmt.get(did);
  const n   = row ? row.paid_calls : 0;
  if (n === 0)        return { free: true, reason: 'first_call_free' };
  if (n % 6 === 0)    return { free: true, reason: 'loyalty_freebie' };
  return { free: false };
}

function _bogoIncrement(did) {
  if (did) _bogoUpsertStmt.run(did);
}

const BOGO_BLOCK = {
  first_call_free: true,
  loyalty_threshold: 6,
  loyalty_message:
    "Every 6th paid call is free. Present your DID via 'x-hive-did' header to track progress.",
};
// ─────────────────────────────────────────────────────────────────────────

async function _verifyUsdcPayment(tx_hash, min_usd) {
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return { ok: false, reason: 'invalid_tx_hash' };
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  let receipt;
  try   { receipt = await provider.getTransactionReceipt(tx_hash); }
  catch (err) { return { ok: false, reason: `rpc_error: ${err.message}` }; }
  if (!receipt)            return { ok: false, reason: 'tx_not_found_or_pending' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };
  const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_ADDR  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const XFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (log.topics?.[0] !== XFER_TOPIC) continue;
    if (('0x' + log.topics[2].slice(26).toLowerCase()) !== WALLET_ADDR.toLowerCase()) continue;
    total += BigInt(log.data);
  }
  if (total === 0n)  return { ok: false, reason: 'no_transfer_to_wallet' };
  const amount_usd = Number(total) / 1e6;
  if (amount_usd + 1e-9 < min_usd) return { ok: false, reason: 'underpaid', amount_usd };
  return { ok: true, amount_usd };
}


const STMT = {
  upsertExperiment: db.prepare(
    'INSERT INTO experiments (id, name, variants_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, variants_json = excluded.variants_json, updated_at = excluded.updated_at'
  ),
  getExperiment: db.prepare('SELECT id, name, variants_json, created_at, updated_at FROM experiments WHERE id = ?'),
  listExperiments: db.prepare('SELECT id, name, variants_json, created_at, updated_at FROM experiments ORDER BY created_at DESC'),
  deleteExperiment: db.prepare('DELETE FROM experiments WHERE id = ?'),
  getAssignment: db.prepare('SELECT variant, bucket, assigned_at FROM assignments WHERE experiment_id = ? AND agent_did = ?'),
  putAssignment: db.prepare(
    'INSERT INTO assignments (experiment_id, agent_did, variant, bucket, assigned_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(experiment_id, agent_did) DO NOTHING'
  ),
  countAssignByVariant: db.prepare('SELECT variant, COUNT(*) AS n FROM assignments WHERE experiment_id = ? GROUP BY variant'),
  countConvByVariant: db.prepare(
    'SELECT variant, COUNT(*) AS n, SUM(value) AS total FROM conversions WHERE experiment_id = ? AND metric = ? GROUP BY variant'
  ),
  insertConversion: db.prepare(
    'INSERT INTO conversions (experiment_id, agent_did, variant, metric, value, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  countAssignToday: db.prepare(
    'SELECT experiment_id, COUNT(*) AS n FROM assignments WHERE assigned_at >= ? GROUP BY experiment_id'
  ),
  countConvToday: db.prepare(
    'SELECT experiment_id, COUNT(*) AS n FROM conversions WHERE recorded_at >= ? GROUP BY experiment_id'
  ),
};

// ─── Bucket math ────────────────────────────────────────────────────────────
function normalizeVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('variants must be a non-empty array');
  }
  const out = [];
  for (const v of variants) {
    if (!v || typeof v.id !== 'string' || !v.id) {
      throw new Error('each variant requires a non-empty id');
    }
    const weight = Number.isFinite(v.weight) && v.weight > 0 ? Math.floor(v.weight) : 1;
    out.push({ id: v.id, weight });
  }
  return out;
}

function totalWeight(variants) {
  return variants.reduce((s, v) => s + v.weight, 0);
}

function deterministicBucket(experimentId, agentDid, totalW) {
  const h = crypto.createHash('sha256').update(`${experimentId}|${agentDid}`).digest();
  // Take first 4 bytes as unsigned 32-bit int
  const v = h.readUInt32BE(0);
  return v % totalW;
}

function variantForBucket(variants, bucket) {
  let cursor = 0;
  for (const v of variants) {
    cursor += v.weight;
    if (bucket < cursor) return v.id;
  }
  return variants[variants.length - 1].id;
}

// ─── Two-proportion Z-test ──────────────────────────────────────────────────
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function zTestTwoProportions({ conversions_a, samples_a, conversions_b, samples_b }) {
  if (samples_a <= 0 || samples_b <= 0) {
    return { ok: false, error: 'samples_required' };
  }
  const p1 = conversions_a / samples_a;
  const p2 = conversions_b / samples_b;
  const pPool = (conversions_a + conversions_b) / (samples_a + samples_b);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / samples_a + 1 / samples_b));
  let z = 0;
  if (se > 0) z = (p2 - p1) / se;
  const pTwoSided = 2 * (1 - normalCdf(Math.abs(z)));
  const lift = p1 > 0 ? (p2 - p1) / p1 : null;
  return {
    ok: true,
    rate_a: round(p1, 6),
    rate_b: round(p2, 6),
    pooled_rate: round(pPool, 6),
    z_score: round(z, 4),
    p_value: round(pTwoSided, 6),
    confidence: round(1 - pTwoSided, 6),
    relative_lift: lift === null ? null : round(lift, 6),
    significant_95: pTwoSided < 0.05,
    significant_99: pTwoSided < 0.01,
  };
}

function round(n, d) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ─── Experiment helpers ─────────────────────────────────────────────────────
function loadExperiment(id) {
  const row = STMT.getExperiment.get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    variants: JSON.parse(row.variants_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function saveExperiment({ id, name, variants }) {
  const v = normalizeVariants(variants);
  const now = Date.now();
  const existing = STMT.getExperiment.get(id);
  const created = existing ? existing.created_at : now;
  STMT.upsertExperiment.run(id, name || id, JSON.stringify(v), created, now);
  return loadExperiment(id);
}

function assignBucket({ experiment_id, agent_did, variants }) {
  const cached = STMT.getAssignment.get(experiment_id, agent_did);
  if (cached) {
    return { ...cached, sticky: true };
  }
  let v = variants;
  if (!v) {
    const exp = loadExperiment(experiment_id);
    if (!exp) throw new Error('unknown_experiment_and_no_variants_supplied');
    v = exp.variants;
  } else {
    v = normalizeVariants(v);
    // auto-create experiment record so results endpoint works
    if (!loadExperiment(experiment_id)) {
      saveExperiment({ id: experiment_id, name: experiment_id, variants: v });
    }
  }
  const tw = totalWeight(v);
  const bucket = deterministicBucket(experiment_id, agent_did, tw);
  const variant = variantForBucket(v, bucket);
  const now = Date.now();
  STMT.putAssignment.run(experiment_id, agent_did, variant, bucket, now);
  // re-read in case of race
  const stored = STMT.getAssignment.get(experiment_id, agent_did) || { variant, bucket, assigned_at: now };
  return { ...stored, sticky: false };
}

function recordConversion({ experiment_id, agent_did, metric, value }) {
  const a = STMT.getAssignment.get(experiment_id, agent_did);
  if (!a) {
    return { ok: false, error: 'agent_not_assigned' };
  }
  const m = metric || 'conversion';
  const v = Number.isFinite(value) ? value : 1;
  STMT.insertConversion.run(experiment_id, agent_did, a.variant, m, v, Date.now());
  return { ok: true, experiment_id, agent_did, variant: a.variant, metric: m, value: v };
}

function buildResults(experiment_id, metric = 'conversion') {
  const exp = loadExperiment(experiment_id);
  if (!exp) return null;
  const assignRows = STMT.countAssignByVariant.all(experiment_id);
  const convRows = STMT.countConvByVariant.all(experiment_id, metric);
  const assignMap = new Map(assignRows.map(r => [r.variant, r.n]));
  const convMap = new Map(convRows.map(r => [r.variant, { n: r.n, total: r.total }]));
  const variants = exp.variants.map(v => {
    const samples = assignMap.get(v.id) || 0;
    const c = convMap.get(v.id) || { n: 0, total: 0 };
    const rate = samples > 0 ? c.n / samples : 0;
    return {
      id: v.id,
      weight: v.weight,
      samples,
      conversions: c.n,
      conversion_value_total: c.total || 0,
      conversion_rate: round(rate, 6),
    };
  });
  let stat_test = null;
  if (variants.length >= 2) {
    const a = variants[0];
    const b = variants[1];
    stat_test = {
      a: a.id,
      b: b.id,
      metric,
      ...zTestTwoProportions({
        conversions_a: a.conversions,
        samples_a: a.samples,
        conversions_b: b.conversions,
        samples_b: b.samples,
      }),
    };
  }
  return {
    experiment_id,
    name: exp.name,
    metric,
    variants,
    stat_test,
    note: variants.length > 2 ? 'stat_test compares first two variants only' : undefined,
  };
}

function todaySnapshot() {
  const dayStart = startOfUtcDay();
  const a = STMT.countAssignToday.all(dayStart);
  const c = STMT.countConvToday.all(dayStart);
  return {
    utc_day_start: new Date(dayStart).toISOString(),
    assignments_today: a,
    conversions_today: c,
    totals: {
      assignments: a.reduce((s, r) => s + r.n, 0),
      conversions: c.reduce((s, r) => s + r.n, 0),
    },
  };
}

function startOfUtcDay() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ─── x402 envelopes ────────────────────────────────────────────────────────
const nonces = new Map();
const tokens = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires_at * 1000 < now) nonces.delete(k);
  for (const [k, v] of tokens) if (v.expires_at < now) tokens.delete(k);
}
setInterval(gc, 60_000).unref?.();

function paymentEnvelope(product, priceUsd) {
  const nonce = randomUUID();
  const expires_at = Math.floor((Date.now() + NONCE_TTL_MS) / 1000);
  nonces.set(nonce, { expires_at, paid: false, product });
  return {
    error: 'payment_required',
    payment: {
      nonce,
      amount_usd: priceUsd,
      accepts: [{ chain: 'base', asset: 'USDC', recipient: WALLET_ADDRESS }],
      expires_at,
      product,
    },
  };
}

function submitProof({ nonce, payer, chain, tx_hash } = {}) {
  if (!nonce || !payer || !chain || !tx_hash) {
    return { ok: false, status: 400, error: 'missing_fields' };
  }
  const n = nonces.get(nonce);
  if (!n) return { ok: false, status: 404, error: 'unknown_or_expired_nonce' };
  if (n.expires_at * 1000 < Date.now()) {
    nonces.delete(nonce);
    return { ok: false, status: 410, error: 'nonce_expired' };
  }
  // Validate payer address shape via ethers (real-rails wiring point)
  try {
    ethers.getAddress(payer);
  } catch {
    return { ok: false, status: 400, error: 'invalid_payer_address' };
  }
  n.paid = true;
  const token = `hive_${randomUUID().replace(/-/g, '')}`;
  tokens.set(token, { payer, chain, tx_hash, expires_at: Date.now() + TOKEN_TTL_MS, product: n.product });
  return { ok: true, access_token: token, expires_in: Math.floor(TOKEN_TTL_MS / 1000) };
}

function checkAccess(req, product) {
  if (process.env.X402_ENABLED && String(process.env.X402_ENABLED).toLowerCase() === 'false') {
    return { ok: true, bypass: 'disabled' };
  }
  const inline = req.headers['x-payment'];
  if (inline) {
    try {
      const env = typeof inline === 'string' ? JSON.parse(inline) : inline;
      if (env?.nonce && env?.payer && env?.chain && env?.tx_hash) {
        const r = submitProof(env);
        if (r.ok) return { ok: true, mint: r };
      }
    } catch { /* fall through */ }
  }
  const hdr = req.headers['x-hive-access'];
  if (hdr && tokens.has(hdr)) {
    const t = tokens.get(hdr);
    if (t.expires_at > Date.now() && (!product || t.product === product)) {
      return { ok: true, token: hdr };
    }
    if (t.expires_at <= Date.now()) tokens.delete(hdr);
  }
  return { ok: false };
}

// ─── MCP tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'abtest_assign',
    description:
      'Assign an agent DID to a variant for an experiment. Bucket is deterministic via SHA-256(experiment_id, agent_did) modulo total weight, sticky across calls. $0.001/assignment via x402.',
    inputSchema: {
      type: 'object',
      required: ['experiment_id', 'agent_did'],
      properties: {
        experiment_id: { type: 'string', description: 'Stable experiment identifier.' },
        agent_did: { type: 'string', description: 'DID or any opaque agent identifier.' },
        variants: {
          type: 'array',
          description: 'Optional. Required only on first call when the experiment has not been registered. Items: { id, weight? }.',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, weight: { type: 'number' } } },
        },
      },
    },
  },
  {
    name: 'abtest_record_conversion',
    description:
      'Record a conversion event for an agent that was previously assigned. Variant is read from the assignment, not supplied by caller. $0.005/event via x402.',
    inputSchema: {
      type: 'object',
      required: ['experiment_id', 'agent_did'],
      properties: {
        experiment_id: { type: 'string' },
        agent_did: { type: 'string' },
        metric: { type: 'string', description: "Optional metric label. Default 'conversion'." },
        value: { type: 'number', description: 'Optional numeric value. Default 1.' },
      },
    },
  },
  {
    name: 'abtest_results',
    description:
      'Return per-variant samples, conversions, conversion rate, and a two-proportion Z-test on the first two variants. Free, read-only.',
    inputSchema: {
      type: 'object',
      required: ['experiment_id'],
      properties: {
        experiment_id: { type: 'string' },
        metric: { type: 'string', description: "Optional metric label. Default 'conversion'." },
      },
    },
  },
];

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpToolCall(name, args, req) {
  if (name === 'abtest_assign') {
    const gate = checkAccess(req, 'abtest_assign');
    if (!gate.ok) return { type: 'payment', body: paymentEnvelope('abtest_assign', PRICE_ASSIGN) };
    try {
      const a = assignBucket({
        experiment_id: args.experiment_id,
        agent_did: args.agent_did,
        variants: args.variants,
      });
      return { type: 'ok', body: { experiment_id: args.experiment_id, agent_did: args.agent_did, ...a } };
    } catch (e) {
      return { type: 'err', code: -32602, message: e.message };
    }
  }
  if (name === 'abtest_record_conversion') {
    const gate = checkAccess(req, 'abtest_record_conversion');
    if (!gate.ok) return { type: 'payment', body: paymentEnvelope('abtest_record_conversion', PRICE_CONVERT) };
    const r = recordConversion({
      experiment_id: args.experiment_id,
      agent_did: args.agent_did,
      metric: args.metric,
      value: args.value,
    });
    if (!r.ok) return { type: 'err', code: -32602, message: r.error };
    return { type: 'ok', body: r };
  }
  if (name === 'abtest_results') {
    const out = buildResults(args.experiment_id, args.metric || 'conversion');
    if (!out) return { type: 'err', code: -32602, message: 'unknown_experiment' };
    return { type: 'ok', body: out };
  }
  return { type: 'err', code: -32601, message: 'unknown_tool' };
}

// ─── REST surface ───────────────────────────────────────────────────────────
function requireEnabled(req, res, next) {
  if (!ENABLE) return res.status(503).json({ error: 'shim_disabled' });
  next();
}

app.use(requireEnabled);

// /v1/abtest experiment CRUD
app.get('/v1/abtest', (req, res) => {
  const rows = STMT.listExperiments.all();
  res.json({
    count: rows.length,
    experiments: rows.map(r => ({
      id: r.id,
      name: r.name,
      variants: JSON.parse(r.variants_json),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

app.post('/v1/abtest', (req, res) => {
  const { id, name, variants } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id_required' });
  try {
    const exp = saveExperiment({ id, name, variants });
    res.status(201).json(exp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/v1/abtest/:id', (req, res) => {
  const exp = loadExperiment(req.params.id);
  if (!exp) return res.status(404).json({ error: 'not_found' });
  res.json(exp);
});

app.put('/v1/abtest/:id', (req, res) => {
  const { name, variants } = req.body || {};
  try {
    const exp = saveExperiment({ id: req.params.id, name, variants });
    res.json(exp);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/v1/abtest/:id', (req, res) => {
  const r = STMT.deleteExperiment.run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, deleted: req.params.id });
});

// /v1/abtest/assign
app.post('/v1/abtest/assign', (req, res) => {
  const gate = checkAccess(req, 'abtest_assign');
  if (!gate.ok) return res.status(402).json(paymentEnvelope('abtest_assign', PRICE_ASSIGN));
  const { experiment_id, agent_did, variants } = req.body || {};
  if (!experiment_id || !agent_did) return res.status(400).json({ error: 'experiment_id_and_agent_did_required' });
  try {
    const a = assignBucket({ experiment_id, agent_did, variants });
    res.json({ experiment_id, agent_did, ...a });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// /v1/abtest/convert
app.post('/v1/abtest/convert', (req, res) => {
  const gate = checkAccess(req, 'abtest_record_conversion');
  if (!gate.ok) return res.status(402).json(paymentEnvelope('abtest_record_conversion', PRICE_CONVERT));
  const { experiment_id, agent_did, metric, value } = req.body || {};
  if (!experiment_id || !agent_did) return res.status(400).json({ error: 'experiment_id_and_agent_did_required' });
  const r = recordConversion({ experiment_id, agent_did, metric, value });
  if (!r.ok) return res.status(409).json(r);
  res.json(r);
});

// /v1/abtest/results
app.get('/v1/abtest/results', (req, res) => {
  const id = req.query.experiment_id;
  if (!id) return res.status(400).json({ error: 'experiment_id_required' });
  const out = buildResults(String(id), String(req.query.metric || 'conversion'));
  if (!out) return res.status(404).json({ error: 'unknown_experiment' });
  res.json(out);
});

// ─── POST /v1/abtest/run — pay-front for A/B test evaluation ────────────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment: runs assignBucket(), records revenue, returns 200 + assignment.
app.post('/v1/abtest/run', async (req, res) => {
  const PRICE = 0.001;
  const did      = req.headers['x-hive-did'] || req.body?.agent_did || null;
  const tx_hash  = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    const { experiment_id, variants } = req.body || {};
    let assignment = null;
    if (experiment_id && did) {
      try { assignment = assignBucket({ experiment_id, agent_did: did, variants }); }
      catch { /* experiment not registered yet — caller can create first */ }
    }
    return res.json({
      ok: true, bogo_applied: bogo.reason,
      experiment_id: experiment_id || null, agent_did: did, assignment,
    });
  }

  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'abtest_run',
        asking_usd: 0.001, accept_min_usd: 0.001,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
      },
      bogo: BOGO_BLOCK,
      bogo_first_call_free: true,
      bogo_loyalty_threshold: 6,
      bogo_pitch: "Pay this once, your 6th call is on the house. New here? Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking 0.001 USDC on Base to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e.`,
      did: did || null,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  const { experiment_id, variants } = req.body || {};
  let assignment = null;
  if (experiment_id && did) {
    try { assignment = assignBucket({ experiment_id, agent_did: did, variants }); }
    catch (e) { assignment = { error: e.message }; }
  }
  res.json({
    ok: true, billed_usd: v.amount_usd, tx_hash,
    experiment_id: experiment_id || null, agent_did: did, assignment,
  });
});

// /v1/abtest/today
app.get('/v1/abtest/today', (req, res) => {
  res.json(todaySnapshot());
});

// x402 proof submission
app.post('/v1/x402/submit', (req, res) => {
  const r = submitProof(req.body || {});
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
});

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch { /* db wedged */ }
  res.json({
    ok: true,
    service: 'hive-mcp-abtest',
    version: '1.0.0',
    enabled: ENABLE,
    db_ok: dbOk,
    mcp_protocol: '2024-11-05',
    pricing: { assign_usd: PRICE_ASSIGN, convert_usd: PRICE_CONVERT, chain: 'base', asset: 'USDC' },
  });
});

// ─── MCP transport ─────────────────────────────────────────────────────────
async function handleJsonRpc(body, req) {
  if (!body || body.jsonrpc !== '2.0') {
    return jsonRpcErr(body?.id ?? null, -32600, 'invalid_request');
  }
  const { id, method, params } = body;
  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hive-mcp-abtest', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const r = mcpToolCall(name, args, req);
    if (r.type === 'err') return jsonRpcErr(id, r.code, r.message);
    if (r.type === 'payment') {
      return jsonRpcOk(id, {
        content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }],
        isError: true,
      });
    }
    return jsonRpcOk(id, {
      content: [{ type: 'text', text: JSON.stringify(r.body, null, 2) }],
    });
  }
  if (method === 'ping') return jsonRpcOk(id, {});
  return jsonRpcErr(id, -32601, 'method_not_found');
}

app.post('/mcp', async (req, res) => {
  const out = await handleJsonRpc(req.body, req);
  res.json(out);
});

app.get('/mcp', (req, res) => {
  res.json({ service: 'hive-mcp-abtest', transport: 'streamable-http', protocol: '2024-11-05', tools: TOOLS.map(t => t.name) });
});

// ─── Root HTML + JSON-LD ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(rootHtml());
});

function rootHtml() {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'hive-mcp-abtest',
    description: 'A/B experiment runner for the A2A network. Deterministic DID-hash bucket assignment, conversion recording, and Z-test stat-sig calculator.',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Cross-platform',
    offers: [
      { '@type': 'Offer', name: 'assignment', price: String(PRICE_ASSIGN), priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'conversion-recorded', price: String(PRICE_CONVERT), priceCurrency: 'USD' },
    ],
    author: { '@type': 'Person', name: 'Steve Rotzin', email: 'steve@thehiveryiq.com', url: 'https://www.thehiveryiq.com' },
    license: 'https://opensource.org/licenses/MIT',
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>hive-mcp-abtest — A/B experiment runner for the A2A network</title>
<meta name="description" content="A/B experiment runner for the A2A network. Deterministic bucket assignment by hash(agent_did, experiment_id). Z-test stat-sig calculator. Inbound MCP shim with x402 micropayments." />
<link rel="canonical" href="https://hive-mcp-abtest.onrender.com/" />
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; max-width: 760px; margin: 4rem auto; padding: 0 1.25rem; color: #111; }
  h1 { font-size: 1.65rem; margin: 0 0 0.5rem; color: ${BRAND_GOLD}; }
  h2 { font-size: 1.05rem; margin: 1.6rem 0 0.4rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  pre { background: #f5f3ee; padding: 0.85rem 1rem; border-left: 3px solid ${BRAND_GOLD}; overflow-x: auto; }
  a { color: ${BRAND_GOLD}; }
  .tag { display: inline-block; padding: 1px 8px; border: 1px solid ${BRAND_GOLD}; border-radius: 999px; font-size: 12px; color: ${BRAND_GOLD}; margin-right: 0.4rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.4rem 0 1rem; }
  th, td { text-align: left; border-bottom: 1px solid #e5e0d4; padding: 6px 8px; font-size: 0.93rem; }
  th { background: #faf7ef; }
</style>
</head>
<body>
<h1>hive-mcp-abtest</h1>
<p><span class="tag">MCP 2024-11-05</span><span class="tag">x402</span><span class="tag">Base USDC</span></p>
<p>A/B experiment runner for the A2A network. Agents register an experiment, request a deterministic variant assignment by DID, and record conversions. The shim returns a two-proportion Z-test on the first two variants for stat-sig at 95% and 99%.</p>

<h2>Pricing</h2>
<table>
<tr><th>Action</th><th>Price</th><th>Rail</th></tr>
<tr><td>abtest_assign</td><td>$${PRICE_ASSIGN.toFixed(3)}</td><td>USDC on Base via x402</td></tr>
<tr><td>abtest_record_conversion</td><td>$${PRICE_CONVERT.toFixed(3)}</td><td>USDC on Base via x402</td></tr>
<tr><td>abtest_results</td><td>free</td><td>read-only</td></tr>
</table>

<h2>MCP endpoint</h2>
<pre>POST https://hive-mcp-abtest.onrender.com/mcp
Content-Type: application/json
{ "jsonrpc":"2.0", "id":1, "method":"tools/list" }</pre>

<h2>REST endpoints</h2>
<pre>POST /v1/abtest                 register an experiment
GET  /v1/abtest                 list experiments
GET  /v1/abtest/:id             get experiment
PUT  /v1/abtest/:id             update experiment
DELETE /v1/abtest/:id           delete experiment
POST /v1/abtest/assign          deterministic variant assignment ($0.001)
POST /v1/abtest/convert         record a conversion ($0.005)
GET  /v1/abtest/results         per-variant samples + Z-test
GET  /v1/abtest/today           UTC-day assignment + conversion counts
GET  /health                    liveness + db check</pre>

<h2>Bucket assignment</h2>
<p>Deterministic. SHA-256 over <code>experiment_id|agent_did</code>, first four bytes read as a uint32, modulo the sum of variant weights. Sticky across calls. The same DID always lands in the same bucket.</p>

<h2>Stat-sig calculator</h2>
<p>Two-proportion Z-test with pooled variance. Returns <code>z_score</code>, <code>p_value</code> (two-sided), <code>relative_lift</code>, and significance flags at p&lt;0.05 and p&lt;0.01.</p>

<p>Source: <a href="https://github.com/srotzin/hive-mcp-abtest">github.com/srotzin/hive-mcp-abtest</a></p>
</body>
</html>`;
}

// ─── Boot ──────────────────────────────────────────────────────────────────
// ─── Schema discoverability (auto-injected) ──────────────────────────────
app.get('/.well-known/agent-card.json', (req, res) => res.json({
  name: 'hive-mcp-abtest',
  description: "Hive Civilization A/B test MCP \u2014 pay-per-experiment routing with x402 USDC settlement. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.",
  url: 'https://hive-mcp-abtest.onrender.com',
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  authentication: {
    schemes: ['x402'],
    credentials: { type:'x402', asset:'USDC', network:'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  extensions: {
    hive_pricing: {
      currency: 'USDC', network: 'base', model: 'per_call',
      first_call_free: true, loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
    claim_with: 'x-hive-did header'
  }
}));
app.get('/.well-known/ap2.json', (req, res) => res.json({
  ap2_version: '1',
  agent: {
    name: 'hive-mcp-abtest',
    did: 'did:web:hive-mcp-abtest.onrender.com',
    description: "Hive Civilization A/B test MCP \u2014 pay-per-experiment routing with x402 USDC settlement. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2."
  },
  endpoints: {
    mcp: 'https://hive-mcp-abtest.onrender.com/mcp',
    agent_card: 'https://hive-mcp-abtest.onrender.com/.well-known/agent-card.json'
  },
  payments: {
    schemes: ['x402'],
    primary: { scheme:'x402', network:'base', asset:'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house.",
    claim_with: 'x-hive-did header'
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' }
}));


if (!process.env.NO_LISTEN) {
  app.listen(PORT, () => {
    console.log(`hive-mcp-abtest listening on :${PORT} (db=${DB_PATH}, enabled=${ENABLE})`);
  });
}

export { app, db, deterministicBucket, normalizeVariants, zTestTwoProportions, buildResults };
