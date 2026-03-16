/**
 * @fileoverview Beacon API Server
 *
 * Beacon is an autonomous research agent platform powered by Bankr LLM Gateway.
 * Built on top of the Claw Beacon architecture with added:
 *   - Multi-model LLM routing (gemini-flash → gemini-2-flash → claude-sonnet)
 *   - 3-step autonomous research pipeline
 *   - Research reports stored and served via REST + SSE
 *   - Economy tracking (LLM spend per agent)
 *
 * Reuses from Claw Beacon: db-adapter, auth, webhook, config-loader
 */

const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
const swagger = require('@fastify/swagger');
const swaggerUi = require('@fastify/swagger-ui');
const dbAdapter = require('./db-adapter');
const { withAuth, isAuthEnabled } = require('./auth');
const { dispatchWebhook, reloadWebhooks, getWebhooks, SUPPORTED_EVENTS } = require('./webhook');
const packageJson = require('../package.json');

const param = (i) => dbAdapter.isSQLite() ? '?' : `$${i}`;
let clients = [];

fastify.register(cors, { origin: '*' });

fastify.register(swagger, {
  openapi: {
    info: { title: 'Beacon API', description: 'Autonomous Research Agents — Bankr LLM Gateway', version: packageJson.version },
    tags: [
      { name: 'Research', description: 'Autonomous research pipeline' },
      { name: 'Agents', description: 'Agent management' },
      { name: 'Reports', description: 'Published research reports' },
      { name: 'Economy', description: 'LLM spend & token fee tracking' },
      { name: 'Stream', description: 'Real-time SSE' },
      { name: 'Health', description: 'Health check' },
    ],
  }
});

fastify.register(swaggerUi, { routePrefix: '/docs' });

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(payload));
}

// ── Bankr LLM Multi-Model Gateway + Smart Router ──────────────────────────

const BANKR_LLM_URL = 'https://llm.bankr.bot/v1/chat/completions';
const { routeRequest, CATALOG } = require('./router');
const { startFeeSync } = require('./fee-sync');

/**
 * Select model using the full Bankr Router (15-dimension scoring).
 * Falls back gracefully: hint → router → gemini-3-flash.
 *
 * @param {Array}  messages
 * @param {string} [hint]     'fast'|'medium'|'deep'|'json'|'eco'|'premium'
 * @param {string} [override] explicit model id
 * @param {number} [max_tokens]
 * @returns {{ model: string, reason: string, decision: object }}
 */
function selectModel(messages, hint, override, max_tokens = 1024) {
  if (override) return { model: override, reason: 'override', decision: null };

  // hint → profile / force mapping
  const hintToForce = {
    fast:    'gemini-3-flash',
    medium:  'gemini-2.5-flash',
    deep:    'claude-sonnet-4-20250514',
    json:    'deepseek-v3.2',
  };
  if (hint && hintToForce[hint]) {
    return { model: hintToForce[hint], reason: `hint:${hint}`, decision: null };
  }

  const profile = (hint === 'eco' || hint === 'premium') ? hint : 'auto';

  // Extract prompt + system prompt from messages array
  const userMsgs = messages.filter(m => m.role === 'user');
  const prompt   = userMsgs.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  const sysMsgs  = messages.filter(m => m.role === 'system');
  const systemPrompt = sysMsgs.map(m => typeof m.content === 'string' ? m.content : '').join('\n') || undefined;

  const hasVision = messages.some(m =>
    Array.isArray(m.content) && m.content.some(p => String(p.type || '').includes('image'))
  );

  try {
    const decision = routeRequest({ prompt, systemPrompt, maxOutputTokens: max_tokens, profile, hasVision });
    fastify.log.info(
      `[Router] model=${decision.model} tier=${decision.tier} ` +
      `conf=${decision.confidence.toFixed(2)} savings=${(decision.savings * 100).toFixed(0)}% | ${decision.reasoning}`
    );
    return { model: decision.model, reason: decision.reasoning, decision };
  } catch (err) {
    fastify.log.warn(`[Router] fallback: ${err.message}`);
    return { model: 'gemini-3-flash', reason: 'router-error-fallback', decision: null };
  }
}

async function callBankrLLM(BANKR_KEY, messages, systemPrompt, model, max_tokens = 1024) {
  const payload = {
    model,
    max_tokens,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages,
    ],
  };

  const response = await fetch(BANKR_LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + BANKR_KEY },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error('Bankr LLM error'), { status: response.status, data });
  return data;
}

// ── POST /api/ai/chat — Multi-model chat with auto routing ────────────────
fastify.register(async function routes(fastify) {

fastify.post('/api/ai/chat', {
  schema: {
    tags: ['Research'],
    summary: 'Chat with auto multi-model routing',
    body: {
      type: 'object',
      required: ['messages'],
      properties: {
        messages: { type: 'array' },
        systemPrompt: { type: 'string' },
        model: { type: 'string' },
        hint: { type: 'string', enum: ['fast', 'medium', 'deep', 'json'] },
        max_tokens: { type: 'number' },
      },
    },
  },
}, async (request, reply) => {
  const BANKR_KEY = process.env.BANKR_LLM_KEY || '';
  if (!BANKR_KEY) return reply.status(500).send({ error: 'BANKR_LLM_KEY not set' });

  const { messages, systemPrompt, model: override, hint, max_tokens = 1024, profile } = request.body;
  const hintOrProfile = hint || profile;
  const { model, reason, decision } = selectModel(messages, hintOrProfile, override, max_tokens);

  try {
    const data = await callBankrLLM(BANKR_KEY, messages, systemPrompt, model, max_tokens);
    return reply.send({
      ...data,
      _meta: {
        model,
        reason,
        tier:       decision?.tier       ?? null,
        confidence: decision?.confidence ?? null,
        savings:    decision?.savings    ?? null,
        signals:    decision?.signals    ?? [],
        agenticScore: decision?.agenticScore ?? null,
        ranked:     decision?.ranked?.slice(0, 3) ?? [],
      },
    });
  } catch (err) {
    return reply.status(err.status || 500).send({ error: err.data || 'LLM call failed' });
  }
});

// ── POST /api/ai/research — 3-step autonomous pipeline ───────────────────
fastify.post('/api/ai/research', {
  schema: {
    tags: ['Research'],
    summary: '3-step research pipeline: screen (gemini-flash) → analyze (claude-sonnet) → format (gemini-2-flash)',
    body: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic:    { type: 'string' },
        context:  { type: 'string' },
        agent_id: { type: 'integer' },
      },
    },
  },
}, async (request, reply) => {
  const BANKR_KEY = process.env.BANKR_LLM_KEY || '';
  if (!BANKR_KEY) return reply.status(500).send({ error: 'BANKR_LLM_KEY not set' });

  const { topic, context = '', agent_id } = request.body;
  const start = Date.now();
  const pipeline = [];

  try {
    // Step 1 — Smart Router selects cheapest eco-tier model (typically gemini-3-flash / gpt-5-nano)
    const step1Decision = routeRequest({ prompt: topic, systemPrompt: 'research screening', maxOutputTokens: 512, profile: 'eco' });
    const step1Model = step1Decision.model;
    fastify.log.info(`[Research] step=1 model=${step1Model} tier=${step1Decision.tier} savings=${(step1Decision.savings*100).toFixed(0)}%`);

    const s1 = await callBankrLLM(BANKR_KEY,
      [{ role: 'user', content: `Topic: ${topic}\nContext: ${context || 'None'}` }],
      'You are a research screener. Identify the 3-5 most important sub-questions, key data points needed, and any caveats. Be concise.',
      step1Model, 512
    );
    const screening = s1.choices?.[0]?.message?.content || '';
    pipeline.push({ step: 1, model: step1Model, role: 'screening', output: screening, tier: step1Decision.tier, savings: step1Decision.savings });

    // Step 2 — Smart Router selects premium reasoning model (claude-sonnet / gpt-5.2 / kimi-k2.5)
    const step2Decision = routeRequest({ prompt: `analyze deeply: ${topic}`, systemPrompt: 'expert research analyst', maxOutputTokens: 2048, profile: 'premium' });
    const step2Model = step2Decision.model;
    fastify.log.info(`[Research] step=2 model=${step2Model} tier=${step2Decision.tier} savings=${(step2Decision.savings*100).toFixed(0)}%`);

    const s2 = await callBankrLLM(BANKR_KEY,
      [{ role: 'user', content: `Original topic: ${topic}\n\nScreening notes:\n${screening}\n\nExtra context: ${context || 'None'}` }],
      [
        'You are an expert research analyst.',
        'Write a thorough analysis structured as:',
        '## Key Findings',
        '## Analysis',
        '## Evidence & Data Points',
        '## Risks & Caveats',
        '## Conclusion',
        'Be specific, use concrete numbers, connect insights to the topic.',
      ].join('\n'),
      step2Model, 2048
    );
    const analysis = s2.choices?.[0]?.message?.content || '';
    pipeline.push({ step: 2, model: step2Model, role: 'analysis', output: analysis, tier: step2Decision.tier, savings: step2Decision.savings });

    // Step 3 — Smart Router selects structured-output model (deepseek / gpt-5-mini)
    const step3Decision = routeRequest({ prompt: 'format as json output', systemPrompt: 'json formatter', maxOutputTokens: 512, profile: 'eco' });
    const step3Model = step3Decision.model;
    fastify.log.info(`[Research] step=3 model=${step3Model} tier=${step3Decision.tier} savings=${(step3Decision.savings*100).toFixed(0)}%`);

    const s3 = await callBankrLLM(BANKR_KEY,
      [{ role: 'user', content: `Topic: ${topic}\n\nAnalysis:\n${analysis}` }],
      'Convert the analysis to clean JSON. Reply ONLY with valid JSON, no markdown, no backticks.\nSchema: {"title":string,"summary":string,"key_findings":string[],"tags":string[],"confidence":"high"|"medium"|"low"}',
      step3Model, 512
    );
    const rawReport = s3.choices?.[0]?.message?.content || '{}';
    pipeline.push({ step: 3, model: step3Model, role: 'formatting', output: rawReport, tier: step3Decision.tier, savings: step3Decision.savings });

    // Parse report
    let report;
    try {
      report = JSON.parse(rawReport.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    } catch {
      report = { title: topic, summary: analysis.slice(0, 300), key_findings: [], tags: [], confidence: 'medium' };
    }

    // Persist report to DB
    const nowFn = dbAdapter.isSQLite() ? "datetime('now')" : 'NOW()';
    const tagsVal = dbAdapter.isSQLite() ? JSON.stringify(report.tags || []) : (report.tags || []);
    const findingsVal = dbAdapter.isSQLite() ? JSON.stringify(report.key_findings || []) : (report.key_findings || []);

    const { rows: saved } = await dbAdapter.query(
      `INSERT INTO research_reports
         (agent_id, topic, title, summary, key_findings, tags, confidence, analysis, models_used, duration_ms, created_at)
       VALUES (${param(1)},${param(2)},${param(3)},${param(4)},${param(5)},${param(6)},${param(7)},${param(8)},${param(9)},${param(10)},${nowFn})
       RETURNING *`,
      [
        agent_id || null,
        topic,
        report.title,
        report.summary,
        findingsVal,
        tagsVal,
        report.confidence || 'medium',
        analysis,
        dbAdapter.isSQLite()
          ? JSON.stringify([step1Model, step2Model, step3Model])
          : [step1Model, step2Model, step3Model],
        Date.now() - start,
      ]
    );

    // Track economy: increment llm_calls for agent
    if (agent_id) {
      await dbAdapter.query(
        `UPDATE agents SET llm_calls = COALESCE(llm_calls, 0) + 3 WHERE id = ${param(1)}`,
        [agent_id]
      ).catch(() => {});
    }

    const result = {
      success: true,
      report,
      analysis,
      pipeline,
      db_id: saved[0]?.id,
      meta: {
        topic,
        duration_ms: Date.now() - start,
        models_used: [step1Model, step2Model, step3Model],
        steps: 3,
        agent_id: agent_id || null,
      },
    };

    broadcast('report-created', { id: saved[0]?.id, title: report.title, agent_id, confidence: report.confidence, tags: report.tags });
    return reply.send(result);

  } catch (err) {
    fastify.log.error('[Research] pipeline error:', err);
    return reply.status(err.status || 500).send({ error: err.data || err.message || 'Pipeline failed', pipeline });
  }
});

// ── GET /api/ai/models ────────────────────────────────────────────────────
fastify.get('/api/ai/models', {
  schema: { tags: ['Research'], summary: 'List Bankr LLM Gateway catalog + routing info' }
}, async () => {
  return {
    catalog: CATALOG.map(m => ({
      id: m.id,
      contextWindow: m.contextWindow,
      supportsTools: m.supportsTools,
      supportsVision: (m.input || ['text']).includes('image'),
      costPer1MInput:  m.cost?.input,
      costPer1MOutput: m.cost?.output,
    })),
    tiers: {
      SIMPLE:    'Fast, cheap: Q&A, short tasks, simple questions',
      MEDIUM:    'Balanced: summaries, generation, mid-complexity',
      COMPLEX:   'Strong: coding, architecture, detailed analysis',
      REASONING: 'Best: math, proofs, multi-step planning, long context',
    },
    profiles: {
      auto:    'Default — cost-optimal within tier, agentic tasks use agentic tier set',
      eco:     'Minimum cost — always picks cheapest eligible model',
      premium: 'Quality first — Claude/GPT-5 preferred over cheaper alternatives',
    },
    routing_dimensions: [
      'tokenCount (0.08)',
      'codePresence (0.15)',
      'reasoningMarkers (0.18)',
      'technicalTerms (0.10)',
      'creativeMarkers (0.05)',
      'simpleIndicators (0.02)',
      'multiStepPatterns (0.12)',
      'questionComplexity (0.05)',
      'imperativeVerbs (0.03)',
      'constraintCount (0.04)',
      'outputFormat (0.03)',
      'referenceComplexity (0.02)',
      'negationComplexity (0.01)',
      'domainSpecificity (0.02)',
      'agenticTask (0.04)',
    ],
    demo: (() => {
      // Show a live routing example for transparency
      const examples = [
        { prompt: 'what is DeFi', profile: 'auto' },
        { prompt: 'analyze deeply the risk tradeoffs in Uniswap V4 liquidity provision', profile: 'auto' },
        { prompt: 'prove that this algorithm runs in O(n log n)', profile: 'auto' },
        { prompt: 'build me a smart contract for token staking, step 1: design the struct, step 2: implement deposit', profile: 'auto' },
      ];
      return examples.map(e => {
        try {
          const d = routeRequest({ prompt: e.prompt, maxOutputTokens: 1024, profile: e.profile });
          return { prompt: e.prompt.slice(0, 60), model: d.model, tier: d.tier, confidence: +d.confidence.toFixed(2), savings: +(d.savings*100).toFixed(0)+'%', signals: d.signals.slice(0,3) };
        } catch { return { prompt: e.prompt.slice(0,60), error: 'routing failed' }; }
      });
    })(),
  };
});

// ── Reports CRUD ──────────────────────────────────────────────────────────

fastify.get('/api/reports', {
  schema: {
    tags: ['Reports'],
    summary: 'List all published research reports',
    querystring: {
      type: 'object',
      properties: {
        agent_id:   { type: 'integer' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        limit:      { type: 'integer', default: 20, maximum: 100 },
        offset:     { type: 'integer', default: 0 },
      },
    },
  },
}, async (request) => {
  const { agent_id, confidence, limit = 20, offset = 0 } = request.query;
  let query = `SELECT r.*, a.name as agent_name FROM research_reports r LEFT JOIN agents a ON r.agent_id = a.id`;
  const params = [];
  const conds = [];

  if (agent_id) { params.push(agent_id); conds.push(`r.agent_id = ${param(params.length)}`); }
  if (confidence) { params.push(confidence); conds.push(`r.confidence = ${param(params.length)}`); }
  if (conds.length) query += ' WHERE ' + conds.join(' AND ');

  query += ' ORDER BY r.created_at DESC';
  params.push(limit); query += ` LIMIT ${param(params.length)}`;
  params.push(offset); query += ` OFFSET ${param(params.length)}`;

  const { rows } = await dbAdapter.query(query, params);
  return rows;
});

fastify.get('/api/reports/:id', {
  schema: { tags: ['Reports'], summary: 'Get a single report by ID' },
}, async (request, reply) => {
  const { rows } = await dbAdapter.query(
    `SELECT r.*, a.name as agent_name FROM research_reports r LEFT JOIN agents a ON r.agent_id = a.id WHERE r.id = ${param(1)}`,
    [request.params.id]
  );
  if (!rows.length) return reply.status(404).send({ error: 'Report not found' });
  return rows[0];
});

fastify.delete('/api/reports/:id', {
  ...withAuth,
  schema: { tags: ['Reports'], summary: 'Delete a report' },
}, async (request, reply) => {
  const { rows } = await dbAdapter.query(`DELETE FROM research_reports WHERE id = ${param(1)} RETURNING id`, [request.params.id]);
  if (!rows.length) return reply.status(404).send({ error: 'Report not found' });
  broadcast('report-deleted', { id: parseInt(request.params.id) });
  return { success: true };
});

// ── Agents CRUD (lean version) ────────────────────────────────────────────

fastify.post('/api/economy/sync', {
  schema: { tags: ['Economy'], summary: 'Manually trigger fee sync from Bankr' }
}, async (request, reply) => {
  const { syncFees } = require('./fee-sync');
  try {
    await syncFees({ dbAdapter, broadcast, logger: fastify.log });
    return { success: true, message: 'Fee sync triggered' };
  } catch (err) {
    return reply.status(500).send({ error: err.message });
  }
});

fastify.get('/api/agents', {
  schema: { tags: ['Agents'], summary: 'List all agents' },
}, async () => {
  const { rows } = await dbAdapter.query('SELECT * FROM agents ORDER BY created_at');
  return { success: true, data: rows };
});

fastify.post('/api/agents', {
  ...withAuth,
  schema: {
    tags: ['Agents'],
    body: {
      type: 'object', required: ['name'],
      properties: {
        name:        { type: 'string' },
        role:        { type: 'string' },
        description: { type: 'string' },
        token_symbol:{ type: 'string', description: 'Agent token symbol on Base (e.g. ALPHA)' },
        token_address:{ type: 'string', description: 'Token contract address on Base' },
        wallet_address:{ type: 'string', description: 'Bankr wallet address for fee collection' },
      },
    },
  },
}, async (request, reply) => {
  const { name, role = 'Research Agent', description, token_symbol, token_address, wallet_address } = request.body;
  const { rows } = await dbAdapter.query(
    `INSERT INTO agents (name, role, description, token_symbol, token_address, wallet_address)
     VALUES (${param(1)},${param(2)},${param(3)},${param(4)},${param(5)},${param(6)}) RETURNING *`,
    [name, role, description || null, token_symbol || null, token_address || null, wallet_address || null]
  );
  broadcast('agent-created', rows[0]);
  return reply.status(201).send({ success: true, data: rows[0] });
});

fastify.put('/api/agents/:id', {
  ...withAuth,
  schema: {
    tags: ['Agents'],
    summary: 'Update agent (including token & wallet info)',
    params: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', description: 'Agent ID' } }
    },
    body: {
      type: 'object',
      properties: {
        name:           { type: 'string' },
        role:           { type: 'string' },
        description:    { type: 'string' },
        status:         { type: 'string', enum: ['idle', 'working', 'offline'] },
        token_symbol:   { type: 'string' },
        token_address:  { type: 'string' },
        wallet_address: { type: 'string' },
        fee_balance:    { type: 'number' },
      }
    }
  },
}, async (request, reply) => {
  const { id } = request.params;
  const { name, role, description, status, token_symbol, token_address, wallet_address, fee_balance } = request.body;
  const nowFn = dbAdapter.isSQLite() ? "datetime('now')" : 'NOW()';
  const { rows } = await dbAdapter.query(
    `UPDATE agents SET
       name           = COALESCE(${param(1)}, name),
       role           = COALESCE(${param(2)}, role),
       description    = COALESCE(${param(3)}, description),
       status         = COALESCE(${param(4)}, status),
       token_symbol   = COALESCE(${param(5)}, token_symbol),
       token_address  = COALESCE(${param(6)}, token_address),
       wallet_address = COALESCE(${param(7)}, wallet_address),
       fee_balance    = COALESCE(${param(8)}, fee_balance),
       updated_at     = ${nowFn}
     WHERE id = ${param(9)} RETURNING *`,
    [name, role, description, status, token_symbol, token_address, wallet_address, fee_balance, id]
  );
  if (!rows.length) return reply.status(404).send({ error: 'Agent not found' });
  broadcast('agent-updated', rows[0]);
  return { success: true, data: rows[0] };
});

fastify.delete('/api/agents/:id', {
  ...withAuth,
  schema: { tags: ['Agents'] },
}, async (request, reply) => {
  const { rows } = await dbAdapter.query(`DELETE FROM agents WHERE id = ${param(1)} RETURNING id`, [request.params.id]);
  if (!rows.length) return reply.status(404).send({ error: 'Agent not found' });
  broadcast('agent-deleted', { id: parseInt(request.params.id) });
  return { success: true };
});

// ── Economy ───────────────────────────────────────────────────────────────

fastify.get('/api/economy', {
  schema: {
    tags: ['Economy'],
    summary: 'Aggregate economy stats: fee revenue, LLM spend, net balance per agent',
  },
}, async () => {
  const { rows: agents } = await dbAdapter.query('SELECT * FROM agents ORDER BY created_at');
  const { rows: reports } = await dbAdapter.query(
    'SELECT agent_id, COUNT(*) as report_count, AVG(duration_ms) as avg_duration FROM research_reports GROUP BY agent_id'
  );

  const reportMap = new Map(reports.map(r => [String(r.agent_id), r]));

  const economy = agents.map(a => {
    const r = reportMap.get(String(a.id)) || {};
    const feeRevenue = parseFloat(a.fee_balance || 0);
    const llmSpend   = (parseInt(a.llm_calls || 0) * 0.006); // ~$0.006 avg per call (mix of models)
    return {
      agent_id:     a.id,
      agent_name:   a.name,
      token_symbol: a.token_symbol,
      fee_revenue:  feeRevenue,
      llm_spend:    parseFloat(llmSpend.toFixed(4)),
      net_balance:  parseFloat((feeRevenue - llmSpend).toFixed(4)),
      self_sustaining: feeRevenue >= llmSpend,
      report_count: parseInt(r.report_count || 0),
      llm_calls:    parseInt(a.llm_calls || 0),
    };
  });

  const totals = economy.reduce((acc, a) => ({
    total_fee_revenue: acc.total_fee_revenue + a.fee_revenue,
    total_llm_spend:   acc.total_llm_spend   + a.llm_spend,
    total_net:         acc.total_net         + a.net_balance,
  }), { total_fee_revenue: 0, total_llm_spend: 0, total_net: 0 });

  return { agents: economy, totals };
});

// ── SSE Stream ────────────────────────────────────────────────────────────

fastify.get('/api/stream', {
  schema: { tags: ['Stream'], summary: 'SSE stream for real-time report & agent updates' },
}, (req, res) => {
  res.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  clients.push(res.raw);
  fastify.log.info(`SSE client connected. Total: ${clients.length}`);

  // Send initial snapshot
  Promise.all([
    dbAdapter.query('SELECT r.*, a.name as agent_name FROM research_reports r LEFT JOIN agents a ON r.agent_id = a.id ORDER BY r.created_at DESC LIMIT 20'),
    dbAdapter.query('SELECT * FROM agents ORDER BY created_at'),
  ]).then(([reports, agentsRes]) => {
    res.raw.write(`event: init\ndata: ${JSON.stringify({ reports: reports.rows, agents: agentsRes.rows })}\n\n`);
  });

  const heartbeat = setInterval(() => res.raw.write(':heartbeat\n\n'), 30000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c !== res.raw);
    fastify.log.info(`SSE client disconnected. Total: ${clients.length}`);
  });
});

// ── Health ────────────────────────────────────────────────────────────────

fastify.get('/health', {
  schema: { tags: ['Health'] },
}, async (request, reply) => {
  try {
    await dbAdapter.query('SELECT 1');
    return { status: 'healthy', db: dbAdapter.getDbType(), version: packageJson.version };
  } catch (err) {
    return reply.status(500).send({ status: 'unhealthy', error: err.message });
  }
});

}); // end routes plugin

// ── DB Schema + Migrations ────────────────────────────────────────────────

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS agents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  role           TEXT DEFAULT 'Research Agent',
  description    TEXT,
  status         TEXT DEFAULT 'idle',
  token_symbol   TEXT,
  token_address  TEXT,
  wallet_address TEXT,
  fee_balance    REAL DEFAULT 0,
  llm_calls      INTEGER DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  topic        TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  key_findings TEXT DEFAULT '[]',
  tags         TEXT DEFAULT '[]',
  confidence   TEXT DEFAULT 'medium',
  analysis     TEXT,
  models_used  TEXT DEFAULT '[]',
  duration_ms  INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_agent ON research_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON research_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_confidence ON research_reports(confidence);
`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS agents (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  role           TEXT DEFAULT 'Research Agent',
  description    TEXT,
  status         VARCHAR(50) DEFAULT 'idle',
  token_symbol   VARCHAR(20),
  token_address  VARCHAR(42),
  wallet_address VARCHAR(42),
  fee_balance    NUMERIC(18,6) DEFAULT 0,
  llm_calls      INTEGER DEFAULT 0,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_reports (
  id           SERIAL PRIMARY KEY,
  agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  topic        TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  key_findings TEXT[] DEFAULT '{}',
  tags         TEXT[] DEFAULT '{}',
  confidence   VARCHAR(10) DEFAULT 'medium',
  analysis     TEXT,
  models_used  TEXT[] DEFAULT '{}',
  duration_ms  INTEGER DEFAULT 0,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_agent ON research_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON research_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_confidence ON research_reports(confidence);
`;

async function runMigrations() {
  fastify.log.info(`Running migrations (${dbAdapter.getDbType()})...`);
  if (dbAdapter.isSQLite()) {
    const db = dbAdapter.getDb();
    SCHEMA_SQLITE.split(';').map(s => s.trim()).filter(Boolean).forEach(stmt => {
      try { db.exec(stmt + ';'); } catch (e) { if (!e.message.includes('already exists')) fastify.log.warn(e.message); }
    });
  } else {
    await dbAdapter.query(SCHEMA_PG);
  }
  fastify.log.info('Migrations complete');
}

// ── Start ─────────────────────────────────────────────────────────────────

const start = async () => {
  const PORT = process.env.PORT || 3001;

  await dbAdapter.query('SELECT 1');
  fastify.log.info(`DB connected (${dbAdapter.getDbType()})`);
  await runMigrations();

  if (isAuthEnabled()) fastify.log.info('Auth ENABLED');
  else fastify.log.info('Auth DISABLED (open mode)');

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Beacon API running on port ${PORT}`);

  // Start fee sync service
  startFeeSync({ dbAdapter, broadcast, logger: fastify.log });
};

module.exports = { start };
