/**
 * @fileoverview Beacon Smart Router — multi-model routing for Bankr LLM Gateway
 *
 * Scores each LLM request across 15 weighted dimensions and maps
 * the aggregate score to a tier (SIMPLE → MEDIUM → COMPLEX → REASONING).
 * Within a tier, selects the cheapest model that satisfies all constraints
 * (context window, vision, tools). Falls back gracefully down the chain.
 *
 * Usage:
 *   const { routeRequest, CATALOG } = require('./router');
 *   const decision = routeRequest({ prompt, systemPrompt, maxOutputTokens, profile });
 *   // decision.model  → e.g. "claude-sonnet-4-20250514"
 *   // decision.tier   → "COMPLEX"
 *   // decision.reasoning → human-readable explanation
 *   // decision.savings   → fraction saved vs claude-opus baseline
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Model Catalog — Bankr LLM Gateway available models with cost data
// Costs in USD per 1M tokens (input / output)
// ─────────────────────────────────────────────────────────────────────────────

// ── Bankr LLM Gateway — 23 models across 8 providers ────────────────────
// Prices in USD per 1M tokens. Data from Bankr model catalog.
const CATALOG = [
  // ── Anthropic ─────────────────────────────────────────────────────────────
  { id: 'claude-haiku-4.5',   contextWindow: 200_000,   maxTokens: 64_000,  supportsTools: true, input: ['text','image'], cost: { input: 1.00,  output: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  } },
  { id: 'claude-sonnet-4.5',  contextWindow: 1_000_000, maxTokens: 64_000,  supportsTools: true, input: ['text','image'], cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: 'claude-sonnet-4.6',  contextWindow: 1_000_000, maxTokens: 128_000, supportsTools: true, input: ['text','image'], cost: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  } },
  { id: 'claude-opus-4.5',    contextWindow: 200_000,   maxTokens: 64_000,  supportsTools: true, input: ['text','image'], cost: { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  } },
  { id: 'claude-opus-4.6',    contextWindow: 1_000_000, maxTokens: 128_000, supportsTools: true, input: ['text','image'], cost: { input: 5.00,  output: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  } },

  // ── Google ────────────────────────────────────────────────────────────────
  { id: 'gemini-3.1-flash-lite', contextWindow: 1_000_000, maxTokens: 66_000, supportsTools: true, input: ['text','image'], cost: { input: 0.25,  output: 1.50,  cacheRead: 0.03,  cacheWrite: 0.08  } },
  { id: 'gemini-3-flash',      contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text','image'], cost: { input: 0.50,  output: 3.00,  cacheRead: 0.05,  cacheWrite: 0.08  } },
  { id: 'gemini-2.5-flash',    contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text','image'], cost: { input: 0.30,  output: 2.50,  cacheRead: 0.03,  cacheWrite: 0.08  } },
  { id: 'gemini-2.5-pro',      contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text','image'], cost: { input: 1.25,  output: 10.00, cacheRead: 0.13,  cacheWrite: 0.38  } },
  { id: 'gemini-3-pro',        contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text','image'], cost: { input: 2.00,  output: 12.00, cacheRead: 0.20,  cacheWrite: 0.38  } },
  { id: 'gemini-3.1-pro',      contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text','image'], cost: { input: 2.00,  output: 12.00, cacheRead: 0.20,  cacheWrite: 0.38  } },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  { id: 'gpt-5-nano',          contextWindow: 400_000,   maxTokens: 128_000, supportsTools: true, input: ['text'],         cost: { input: 0.05,  output: 0.40,  cacheRead: 0.005  } },
  { id: 'gpt-5-mini',          contextWindow: 400_000,   maxTokens: 128_000, supportsTools: true, input: ['text'],         cost: { input: 0.25,  output: 2.00,  cacheRead: 0.03   } },
  { id: 'gpt-5.2',             contextWindow: 400_000,   maxTokens: 128_000, supportsTools: true, input: ['text'],         cost: { input: 1.75,  output: 14.00, cacheRead: 0.17   } },
  { id: 'gpt-5.2-codex',       contextWindow: 400_000,   maxTokens: 128_000, supportsTools: true, input: ['text'],         cost: { input: 1.75,  output: 14.00, cacheRead: 0.17   } },
  { id: 'gpt-5.4',             contextWindow: 1_100_000, maxTokens: 128_000, supportsTools: true, input: ['text','image'], cost: { input: 2.50,  output: 15.00, cacheRead: 0.25   } },

  // ── xAI ───────────────────────────────────────────────────────────────────
  { id: 'grok-4.1-fast',       contextWindow: 2_000_000, maxTokens: 30_000,  supportsTools: true, input: ['text'],         cost: { input: 0.20,  output: 0.50,  cacheRead: 0.05   } },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { id: 'deepseek-v3.2',       contextWindow: 164_000,   maxTokens: 66_000,  supportsTools: true, input: ['text'],         cost: { input: 0.26,  output: 0.38,  cacheRead: 0.13   } },

  // ── Alibaba ───────────────────────────────────────────────────────────────
  { id: 'qwen3.5-flash',       contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text'],         cost: { input: 0.10,  output: 0.40  } },
  { id: 'qwen3.5-plus',        contextWindow: 1_000_000, maxTokens: 66_000,  supportsTools: true, input: ['text'],         cost: { input: 0.26,  output: 1.56  } },
  { id: 'qwen3-coder',         contextWindow: 262_000,   maxTokens: 66_000,  supportsTools: true, input: ['text'],         cost: { input: 0.12,  output: 0.75,  cacheRead: 0.06   } },

  // ── Moonshot ──────────────────────────────────────────────────────────────
  { id: 'kimi-k2.5',           contextWindow: 262_000,   maxTokens: 66_000,  supportsTools: true, input: ['text'],         cost: { input: 0.45,  output: 2.20,  cacheRead: 0.23   } },

  // ── MiniMax ───────────────────────────────────────────────────────────────
  { id: 'minimax-m2.5',        contextWindow: 197_000,   maxTokens: 197_000, supportsTools: true, input: ['text'],         cost: { input: 0.27,  output: 0.95,  cacheRead: 0.03   } },
];

const CATALOG_MAP = new Map(CATALOG.map(m => [m.id, m]));

// ─────────────────────────────────────────────────────────────────────────────
// Tier definitions — primary + fallback chains per profile
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = {
  // Default (auto) profile — cost-optimal within tier
  auto: {
    SIMPLE:    { primary: 'gpt-5-nano',          fallback: ['gemini-3.1-flash-lite', 'qwen3.5-flash', 'grok-4.1-fast', 'deepseek-v3.2', 'gemini-3-flash'] },
    MEDIUM:    { primary: 'deepseek-v3.2',        fallback: ['grok-4.1-fast', 'qwen3.5-plus', 'minimax-m2.5', 'gpt-5-mini', 'kimi-k2.5'] },
    COMPLEX:   { primary: 'minimax-m2.5',         fallback: ['kimi-k2.5', 'qwen3-coder', 'gpt-5.2', 'gemini-2.5-pro', 'gemini-3-pro', 'claude-sonnet-4.6'] },
    REASONING: { primary: 'gpt-5.2',              fallback: ['kimi-k2.5', 'gemini-3-pro', 'gemini-3.1-pro', 'gpt-5.4', 'claude-sonnet-4.6', 'claude-opus-4.6'] },
  },
  // Eco profile — always cheapest eligible model
  eco: {
    SIMPLE:    { primary: 'gpt-5-nano',           fallback: ['gemini-3.1-flash-lite', 'qwen3.5-flash', 'grok-4.1-fast', 'deepseek-v3.2'] },
    MEDIUM:    { primary: 'deepseek-v3.2',         fallback: ['qwen3.5-flash', 'grok-4.1-fast', 'qwen3.5-plus', 'minimax-m2.5', 'gpt-5-mini'] },
    COMPLEX:   { primary: 'minimax-m2.5',          fallback: ['qwen3-coder', 'kimi-k2.5', 'deepseek-v3.2', 'gemini-2.5-flash', 'gpt-5-mini'] },
    REASONING: { primary: 'gpt-5.2',               fallback: ['kimi-k2.5', 'gemini-2.5-pro', 'gemini-3-pro', 'claude-sonnet-4.5'] },
  },
  // Premium profile — quality first (Claude / GPT-5 preferred)
  premium: {
    SIMPLE:    { primary: 'claude-haiku-4.5',      fallback: ['grok-4.1-fast', 'gemini-3-flash', 'gpt-5-mini'] },
    MEDIUM:    { primary: 'claude-sonnet-4.6',      fallback: ['claude-sonnet-4.5', 'gpt-5.2', 'gpt-5.2-codex', 'kimi-k2.5', 'gemini-3-pro'] },
    COMPLEX:   { primary: 'claude-sonnet-4.6',      fallback: ['gpt-5.4', 'claude-opus-4.6', 'claude-opus-4.5', 'gpt-5.2', 'gemini-3.1-pro'] },
    REASONING: { primary: 'claude-opus-4.6',        fallback: ['gpt-5.4', 'claude-opus-4.5', 'claude-sonnet-4.6', 'gpt-5.2', 'kimi-k2.5'] },
  },
  // Agentic profile — optimised for multi-step / coding tasks
  agentic: {
    SIMPLE:    { primary: 'gpt-5-mini',            fallback: ['grok-4.1-fast', 'gemini-3-flash', 'deepseek-v3.2'] },
    MEDIUM:    { primary: 'qwen3-coder',            fallback: ['minimax-m2.5', 'gpt-5.2-codex', 'deepseek-v3.2', 'claude-sonnet-4.6'] },
    COMPLEX:   { primary: 'gpt-5.2-codex',         fallback: ['qwen3-coder', 'claude-sonnet-4.6', 'gpt-5.4', 'minimax-m2.5', 'gemini-3.1-pro'] },
    REASONING: { primary: 'gpt-5.2-codex',         fallback: ['claude-sonnet-4.6', 'gpt-5.4', 'claude-opus-4.6', 'kimi-k2.5'] },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Keyword lists (condensed English subset from original multilingual set)
// Full multilingual lists preserved for correctness
// ─────────────────────────────────────────────────────────────────────────────

const KEYWORDS = {
  code: [
    'function','class','import','def','select','async','await','const','let','var','return',
    'typescript','javascript','python','rust','sql','regex','stack trace','bug','debug',
    'exception','compile','refactor','unit test','dockerfile','yaml','json schema',
    'proxy','middleware','endpoint','api','```',
    '函数','类','导入','関数','クラス','функция','класс',
  ],
  reasoning: [
    'prove','theorem','derive','step by step','chain of thought','formally','mathematical',
    'proof','logically','counterexample','invariant','tradeoff','root cause','analyze deeply',
    '证明','定理','推导','証明','доказать','докажи','beweisen','demostrar',
  ],
  simple: [
    'what is','define','translate','hello','yes or no','capital of','how old','who is',
    'when was','explain simply',
    '什么是','とは','что такое','was ist',
  ],
  technical: [
    'algorithm','optimize','architecture','distributed','kubernetes','microservice','database',
    'infrastructure','gateway','router','schema','oauth','grpc','latency','throughput',
    'cache','worker','context window','tool calling',
    '算法','架构','アルゴリズム','алгоритм',
  ],
  creative: [
    'story','poem','compose','brainstorm','creative','imagine','write a','tagline','slogan',
    '故事','诗','物語','история','рассказ',
  ],
  imperative: [
    'build','create','implement','design','develop','construct','generate','deploy',
    'configure','set up','fix','patch',
    '构建','構築','построить','создать',
  ],
  constraint: [
    'under','at most','at least','within','no more than','o(','maximum','minimum',
    'limit','budget','must','cannot','without','strict','hard requirement','<1ms',
    '不超过','以下','не более','höchstens',
  ],
  outputFormat: [
    'json','yaml','xml','table','csv','markdown','schema','format as','structured',
    'diff','patch','typescript','bash','curl',
    '表格','テーブル','таблица',
  ],
  reference: [
    'above','below','previous','following','the docs','the api','the code','earlier',
    'attached','this repo','thread','conversation',
    '上面','上記','выше',
  ],
  negation: [
    "don't","do not",'avoid','never','without','except','exclude','no longer',
    'rather than','instead of',
    '不要','しないで','не делай',
  ],
  domain: [
    'quantum','fpga','vlsi','risc-v','asic','photonics','genomics','proteomics',
    'topological','homomorphic','zero-knowledge','lattice-based',
    'openclaw','bankr','anthropic','gemini','qwen','kimi','gpt','mcp','ollama','vllm','llm gateway',
    '量子','квантовый',
  ],
  agentic: [
    'read file','read the file','look at','check the','open the','edit','modify',
    'update the','change the','write to','create file','execute','deploy','install',
    'npm','pip','compile','after that','and also','once done','step 1','step 2',
    'fix','debug','until it works','keep trying','iterate','make sure','verify',
    'confirm','wire up','integrate',
    '读取文件','ファイルを読む','читать файл','открой',
  ],
};

// Dimension weights — must sum to ~1.0
const WEIGHTS = {
  tokenCount:          0.08,
  codePresence:        0.15,
  reasoningMarkers:    0.18,
  technicalTerms:      0.10,
  creativeMarkers:     0.05,
  simpleIndicators:    0.02,
  multiStepPatterns:   0.12,
  questionComplexity:  0.05,
  imperativeVerbs:     0.03,
  constraintCount:     0.04,
  outputFormat:        0.03,
  referenceComplexity: 0.02,
  negationComplexity:  0.01,
  domainSpecificity:   0.02,
  agenticTask:         0.04,
};

const TIER_BOUNDARIES = { simpleMedium: 0.08, mediumComplex: 0.30, complexReasoning: 0.50 };
const CONFIDENCE_STEEPNESS  = 12;
const CONFIDENCE_THRESHOLD  = 0.70;
const MAX_TOKENS_FORCE_COMPLEX = 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// Scoring helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalize(text) {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function countMatches(text, keywords) {
  let n = 0;
  for (const kw of keywords) {
    if (kw && text.includes(kw.toLowerCase())) n++;
  }
  return n;
}

function sigmoid(x, steepness) {
  return 1 / (1 + Math.exp(-steepness * x));
}

function scoreKeyword(text, keywords, name, label, lowThresh, highThresh, noneScore, lowScore, highScore) {
  let matches = 0;
  const found = [];
  for (const kw of keywords) {
    if (text.includes(kw.toLowerCase())) {
      found.push(kw);
      matches++;
      if (matches >= highThresh) break;
    }
  }
  if (matches >= highThresh) return { name, score: highScore, signal: `${label}(${found.slice(0,3).join(',')})` };
  if (matches >= lowThresh)  return { name, score: lowScore,  signal: `${label}(${found.slice(0,3).join(',')})` };
  return { name, score: noneScore, signal: null };
}

function scoreTokenCount(tokens) {
  if (tokens < 50)  return { name: 'tokenCount', score: -1.0, signal: `short(${tokens})` };
  if (tokens > 500) return { name: 'tokenCount', score:  1.0, signal: `long(${tokens})` };
  return { name: 'tokenCount', score: 0, signal: null };
}

function scoreCode(rawPrompt, text) {
  const fences = (rawPrompt.match(/```/g) || []).length;
  const kwHits = countMatches(text, KEYWORDS.code);
  if (fences >= 2)                    return { name: 'codePresence', score: 1.0, signal: 'code-fence' };
  if (fences >= 1 || kwHits >= 3)     return { name: 'codePresence', score: 0.8, signal: 'code-heavy' };
  if (kwHits >= 1)                    return { name: 'codePresence', score: 0.5, signal: 'code' };
  return { name: 'codePresence', score: 0, signal: null };
}

function scoreMultiStep(text) {
  const patterns = [
    /first.*then/i, /step\s*1/i, /step\s*2/i, /\bnext\b/i, /\bfinally\b/i,
    /\bafter that\b/i, /\bonce done\b/i, /\band also\b/i,
    /第一步/, /第二步/, /然后/, /最后/,
    /ステップ1/, /ステップ2/, /その後/,
    /шаг 1/i, /шаг 2/i, /затем/i, /после этого/i,
    /schritt 1/i, /schritt 2/i, /danach/i,
    /paso 1/i, /paso 2/i, /después/i,
  ];
  const hits = patterns.filter(p => p.test(text)).length;
  if (hits >= 3) return { name: 'multiStepPatterns', score: 1.0, signal: 'multi-step-heavy' };
  if (hits >= 1) return { name: 'multiStepPatterns', score: 0.5, signal: 'multi-step' };
  return { name: 'multiStepPatterns', score: 0, signal: null };
}

function scoreQuestionComplexity(prompt) {
  const qmarks = (prompt.match(/\?/g) || []).length;
  const complex = countMatches(prompt.toLowerCase(),
    ['why','how','compare','tradeoff','versus','vs','почему','как','为什么','如何','なぜ','por qué','por que','warum']);
  if (qmarks >= 3 || complex >= 2) return { name: 'questionComplexity', score: 0.5, signal: 'complex-q' };
  if (qmarks >= 1 || complex >= 1) return { name: 'questionComplexity', score: 0.2, signal: 'question' };
  return { name: 'questionComplexity', score: 0, signal: null };
}

function scoreAgentic(text) {
  let n = 0;
  const found = [];
  for (const kw of KEYWORDS.agentic) {
    if (text.includes(kw.toLowerCase())) {
      n++;
      if (found.length < 3) found.push(kw);
    }
  }
  const sig = found.length ? `agentic(${found.join(',')})` : null;
  if (n >= 4) return { dim: { name: 'agenticTask', score: 1.0, signal: sig }, score: 1.0 };
  if (n >= 2) return { dim: { name: 'agenticTask', score: 0.6, signal: sig }, score: 0.6 };
  if (n >= 1) return { dim: { name: 'agenticTask', score: 0.2, signal: sig }, score: 0.2 };
  return { dim: { name: 'agenticTask', score: 0, signal: null }, score: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main classifier — 15 dimensions → tier + confidence
// ─────────────────────────────────────────────────────────────────────────────

function classify(prompt, systemPrompt, estimatedTokens) {
  const userText   = normalize(prompt);
  const sysText    = normalize(systemPrompt || '');
  const combined   = sysText ? `${userText} ${sysText}` : userText;

  const ag = scoreAgentic(userText);

  const dims = [
    scoreTokenCount(estimatedTokens),
    scoreCode(prompt, userText),
    scoreKeyword(combined, KEYWORDS.reasoning,    'reasoningMarkers',   'reasoning',  1, 2, 0, 0.7, 1.0),
    scoreKeyword(combined, KEYWORDS.technical,    'technicalTerms',     'technical',  2, 4, 0, 0.5, 1.0),
    scoreKeyword(combined, KEYWORDS.creative,     'creativeMarkers',    'creative',   1, 2, 0, 0.5, 0.7),
    scoreKeyword(userText,  KEYWORDS.simple,      'simpleIndicators',   'simple',     1, 2, 0,-1.0,-1.0),
    scoreMultiStep(combined),
    scoreQuestionComplexity(prompt),
    scoreKeyword(combined, KEYWORDS.imperative,   'imperativeVerbs',    'imperative', 1, 2, 0, 0.3, 0.5),
    scoreKeyword(combined, KEYWORDS.constraint,   'constraintCount',    'constraint', 1, 3, 0, 0.3, 0.7),
    scoreKeyword(combined, KEYWORDS.outputFormat, 'outputFormat',       'format',     1, 2, 0, 0.4, 0.7),
    scoreKeyword(combined, KEYWORDS.reference,    'referenceComplexity','reference',  1, 2, 0, 0.3, 0.5),
    scoreKeyword(combined, KEYWORDS.negation,     'negationComplexity', 'negation',   2, 3, 0, 0.3, 0.5),
    scoreKeyword(combined, KEYWORDS.domain,       'domainSpecificity',  'domain',     1, 2, 0, 0.5, 0.8),
    ag.dim,
  ];

  const signals = dims.filter(d => d.signal).map(d => d.signal);

  // Weighted score
  let score = 0;
  for (const d of dims) {
    score += d.score * (WEIGHTS[d.name] ?? 0);
  }

  // Reasoning override — if 2+ reasoning keywords in user text → force REASONING
  const reasoningHits = KEYWORDS.reasoning.filter(kw => userText.includes(kw.toLowerCase())).length;
  if (reasoningHits >= 2) {
    const conf = Math.max(sigmoid(Math.max(score, 0.35), CONFIDENCE_STEEPNESS), 0.85);
    return { score, tier: 'REASONING', confidence: conf, signals, agenticScore: ag.score, dims };
  }

  // Tier from boundaries
  let tier, distFromBoundary;
  const { simpleMedium, mediumComplex, complexReasoning } = TIER_BOUNDARIES;
  if      (score < simpleMedium)   { tier = 'SIMPLE';    distFromBoundary = simpleMedium  - score; }
  else if (score < mediumComplex)  { tier = 'MEDIUM';    distFromBoundary = Math.min(score - simpleMedium, mediumComplex - score); }
  else if (score < complexReasoning){ tier = 'COMPLEX';  distFromBoundary = Math.min(score - mediumComplex, complexReasoning - score); }
  else                             { tier = 'REASONING'; distFromBoundary = score - complexReasoning; }

  const confidence = sigmoid(distFromBoundary, CONFIDENCE_STEEPNESS);
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { score, tier: null, confidence, signals, agenticScore: ag.score, dims };
  }

  return { score, tier, confidence, signals, agenticScore: ag.score, dims };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector — picks cheapest eligible model in tier chain
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

function minTier(a, b) {
  return TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];
}

function chooseTierSet(profile, agenticScore) {
  if (profile === 'eco')     return TIERS.eco;
  if (profile === 'premium') return TIERS.premium;
  if (profile === 'auto' && agenticScore >= 0.6) return TIERS.agentic;
  return TIERS.auto;
}

function looksCodeHeavy(prompt, systemPrompt) {
  const text = `${systemPrompt || ''}\n${prompt}`.toLowerCase();
  const signals = ['```','function','class','typescript','javascript','python','rust','sql',
    'debug','bug','stack trace','refactor','unit test','dockerfile','yaml','endpoint','middleware'];
  let n = 0;
  for (const s of signals) { if (text.includes(s)) { n++; if (n >= 2) return true; } }
  return false;
}

function codeBonus(modelId, codeHeavy) {
  if (!codeHeavy) return 0;
  const id = modelId.toLowerCase();
  if (id.includes('codex'))       return -0.35;
  if (id.includes('coder'))       return -0.30;
  if (id.includes('sonnet-4'))    return -0.08;
  if (id.includes('gpt-5.2'))     return -0.04;
  return 0;
}

function estimateCost(model, inputTokens, outputTokens) {
  const ip = model.cost?.input  ?? Infinity;
  const op = model.cost?.output ?? Infinity;
  return (inputTokens / 1_000_000) * ip + (outputTokens / 1_000_000) * op;
}

/**
 * Main entry point.
 *
 * @param {object} args
 * @param {string}  args.prompt
 * @param {string}  [args.systemPrompt]
 * @param {number}  [args.maxOutputTokens=1024]
 * @param {'auto'|'eco'|'premium'} [args.profile='auto']
 * @param {boolean} [args.hasVision=false]
 * @param {boolean} [args.hasTools=false]
 * @param {string}  [args.forceModel]   — skip routing, use this model
 * @returns {RoutingDecision}
 */
function routeRequest({ prompt, systemPrompt, maxOutputTokens = 1024, profile = 'auto', hasVision = false, hasTools = false, forceModel }) {
  // Hard override
  if (forceModel) {
    const m = CATALOG_MAP.get(forceModel);
    return {
      model: forceModel, tier: 'COMPLEX', confidence: 1, method: 'override',
      reasoning: `forced model: ${forceModel}`,
      costEstimate: m ? estimateCost(m, 500, maxOutputTokens) : 0,
      baselineCost: 0, savings: 0,
      chain: [forceModel], ranked: [{ id: forceModel, estimatedCost: 0 }],
      signals: [], agenticScore: 0,
    };
  }

  const inputTokens = Math.ceil(`${systemPrompt || ''} ${prompt}`.length / 4);
  const totalTokens = inputTokens + maxOutputTokens;

  // Force COMPLEX for very long contexts
  let tier, confidence = 0.99, signals = [], agenticScore = 0;
  if (totalTokens > MAX_TOKENS_FORCE_COMPLEX) {
    tier = 'COMPLEX';
  } else {
    const result = classify(prompt, systemPrompt, inputTokens);
    tier          = result.tier ?? 'MEDIUM'; // ambiguous → MEDIUM
    confidence    = result.confidence;
    signals       = result.signals;
    agenticScore  = result.agenticScore;

    // Structured output → minimum MEDIUM
    const isStructured = /json|yaml/i.test(`${systemPrompt || ''} ${prompt}`);
    if (isStructured) tier = minTier(tier, 'MEDIUM');
  }

  const tierSet = chooseTierSet(profile, agenticScore);
  const tierCfg = tierSet[tier];
  let chain = [tierCfg.primary, ...tierCfg.fallback];

  // Filter to models in catalog
  chain = chain.filter(id => CATALOG_MAP.has(id));
  if (!chain.length) chain = ['claude-sonnet-4-20250514']; // emergency fallback

  // Filter by tools
  if (hasTools) {
    const filtered = chain.filter(id => CATALOG_MAP.get(id)?.supportsTools !== false);
    if (filtered.length) chain = filtered;
  }

  // Filter by vision
  if (hasVision) {
    const filtered = chain.filter(id => (CATALOG_MAP.get(id)?.input ?? ['text']).includes('image'));
    if (filtered.length) chain = filtered;
  }

  // Filter by context window
  const ctxFiltered = chain.filter(id => {
    const cw = CATALOG_MAP.get(id)?.contextWindow;
    return cw == null || cw >= totalTokens * 1.1;
  });
  if (ctxFiltered.length) chain = ctxFiltered;

  // Rank by cost (with code affinity bonus)
  const codeHeavy = looksCodeHeavy(prompt, systemPrompt);
  const ranked = chain
    .map(id => {
      const m = CATALOG_MAP.get(id);
      if (!m) return null;
      const raw  = estimateCost(m, inputTokens, maxOutputTokens);
      const adj  = raw + codeBonus(id, codeHeavy);
      return { id, estimatedCost: adj };
    })
    .filter(x => x && Number.isFinite(x.estimatedCost))
    .sort((a, b) => a.estimatedCost - b.estimatedCost);

  if (!ranked.length) {
    // Last resort
    return { model: 'claude-sonnet-4-20250514', tier, confidence, method: 'fallback',
      reasoning: 'all candidates filtered — emergency fallback',
      costEstimate: 0, baselineCost: 0, savings: 0, chain, ranked: [], signals, agenticScore };
  }

  const selected    = ranked[0].id;
  const selectedM   = CATALOG_MAP.get(selected);
  const baselineM   = CATALOG_MAP.get('claude-opus-4.6') ?? CATALOG_MAP.get('claude-opus-4.5') ?? selectedM;
  const costEst     = estimateCost(selectedM, inputTokens, maxOutputTokens);
  const baseCost    = estimateCost(baselineM, inputTokens, maxOutputTokens);
  const savings     = baseCost > 0 ? Math.max(0, (baseCost - costEst) / baseCost) : 0;

  const reasoning = [
    `tier=${tier}`,
    `profile=${profile}`,
    confidence < 0.9 ? `conf=${confidence.toFixed(2)}` : null,
    signals.length ? `signals=${signals.slice(0,4).join(',')}` : null,
    agenticScore >= 0.6 ? `agentic=${agenticScore.toFixed(1)}` : null,
  ].filter(Boolean).join(' | ');

  return {
    model: selected,
    tier,
    confidence,
    method: 'rules',
    reasoning,
    costEstimate: costEst,
    baselineCost: baseCost,
    savings,
    agenticScore,
    chain,
    ranked,
    signals,
  };
}

module.exports = { routeRequest, CATALOG, CATALOG_MAP };
