/**
 * @fileoverview Beacon Fee Sync Service
 *
 * Polls Bankr Agent API every 5 minutes to:
 * 1. Fetch wallet balance + token fee data
 * 2. Check unclaimed fees via Bankr prompt API
 * 3. Update agent fee_balance in database
 * 4. Auto-claim fees when threshold reached
 * 5. Broadcast economy updates to SSE clients
 *
 * Required env vars:
 *   BANKR_API_KEY  — Bankr Agent API key (bk_...)
 *   BANKR_LLM_KEY  — Bankr LLM Gateway key (already set)
 *
 * Optional:
 *   FEE_CLAIM_THRESHOLD — Min WETH to trigger auto-claim (default: 0.001)
 *   FEE_SYNC_INTERVAL   — Sync interval in ms (default: 300000 = 5min)
 */

'use strict';

const BANKR_AGENT_API = 'https://api.bankr.bot/agent';
const FEE_CLAIM_THRESHOLD = parseFloat(process.env.FEE_CLAIM_THRESHOLD || '0.001');
const SYNC_INTERVAL      = parseInt(process.env.FEE_SYNC_INTERVAL   || '300000');

/**
 * Submit a prompt to Bankr Agent API and poll until complete.
 * @param {string} apiKey
 * @param {string} prompt
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>} response text
 */
async function bankrPrompt(apiKey, prompt, timeoutMs = 30000) {
  const submitRes = await fetch(`${BANKR_AGENT_API}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ prompt }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.json().catch(() => ({}));
    throw new Error(`Bankr prompt submit failed: ${submitRes.status} ${JSON.stringify(err)}`);
  }

  const { jobId } = await submitRes.json();
  if (!jobId) throw new Error('No jobId returned from Bankr prompt');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));

    const statusRes = await fetch(`${BANKR_AGENT_API}/job/${jobId}`, {
      headers: { 'X-API-Key': apiKey },
    });

    if (!statusRes.ok) continue;
    const job = await statusRes.json();

    if (job.status === 'completed') return job.response || '';
    if (job.status === 'failed')    throw new Error(`Bankr job failed: ${job.error}`);
  }

  throw new Error('Bankr prompt timed out');
}

/**
 * Fetch wallet balances from Bankr Agent API.
 * Returns ETH balance and token list on Base.
 */
async function fetchWalletBalance(apiKey) {
  const res = await fetch(`${BANKR_AGENT_API}/balances?chains=base`, {
    headers: { 'X-API-Key': apiKey },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Bankr balances failed: ${res.status} ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const base = data.balances?.base ?? {};

  return {
    evmAddress:    data.evmAddress,
    ethBalance:    parseFloat(base.nativeBalance || '0'),
    ethUsd:        parseFloat(base.nativeUsd     || '0'),
    totalUsd:      parseFloat(base.total         || '0'),
    tokenBalances: base.tokenBalances || [],
  };
}

/**
 * Parse fee amount from Bankr prompt response.
 * Handles various response formats.
 */
function parseFeeAmount(text) {
  if (!text) return 0;

  // Match patterns like "0.0234 WETH", "$12.50", "0.001 ETH"
  const patterns = [
    /(\d+\.?\d*)\s*WETH/i,
    /(\d+\.?\d*)\s*ETH/i,
    /\$(\d+\.?\d*)/,
    /(\d+\.?\d*)\s*USD/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseFloat(match[1]);
  }

  // Try to find any decimal number
  const nums = text.match(/\d+\.\d+/);
  if (nums) return parseFloat(nums[0]);

  return 0;
}

/**
 * Main fee sync function — called on interval.
 * @param {object} opts
 * @param {object} opts.dbAdapter  — database adapter
 * @param {Function} opts.broadcast — SSE broadcast function
 * @param {object} opts.logger      — fastify logger
 */
async function syncFees({ dbAdapter, broadcast, logger }) {
  const BANKR_API_KEY = process.env.BANKR_API_KEY || '';
  const param = (i) => dbAdapter.isSQLite() ? '?' : `$${i}`;

  if (!BANKR_API_KEY) {
    logger.warn('[FeeSync] BANKR_API_KEY not set — skipping fee sync');
    return;
  }

  logger.info('[FeeSync] Starting fee sync cycle...');

  try {
    // Step 1: Fetch wallet balance
    const wallet = await fetchWalletBalance(BANKR_API_KEY);
    logger.info(`[FeeSync] Wallet: ${wallet.evmAddress} | ETH: ${wallet.ethBalance} | Total: $${wallet.totalUsd}`);

    // Step 2: Check unclaimed fees via prompt
    let unclaimedFees = 0;
    let claimedNow = false;

    try {
      const feeResponse = await bankrPrompt(
        BANKR_API_KEY,
        'check my fees for BEACON token on base, show the unclaimed WETH amount'
      );
      logger.info(`[FeeSync] Fee check response: ${feeResponse.slice(0, 200)}`);
      unclaimedFees = parseFeeAmount(feeResponse);
      logger.info(`[FeeSync] Unclaimed fees: ${unclaimedFees} WETH`);
    } catch (err) {
      logger.warn(`[FeeSync] Fee check failed: ${err.message}`);
    }

    // Step 3: Auto-claim if above threshold
    if (unclaimedFees >= FEE_CLAIM_THRESHOLD) {
      logger.info(`[FeeSync] Fees (${unclaimedFees}) >= threshold (${FEE_CLAIM_THRESHOLD}) — claiming...`);
      try {
        const claimResponse = await bankrPrompt(
          BANKR_API_KEY,
          'claim my fees for BEACON token on base',
          60000 // 60s timeout for on-chain tx
        );
        logger.info(`[FeeSync] Claim response: ${claimResponse.slice(0, 200)}`);
        claimedNow = true;

        // Refetch balance after claim
        const updated = await fetchWalletBalance(BANKR_API_KEY).catch(() => wallet);
        wallet.ethBalance = updated.ethBalance;
        wallet.totalUsd   = updated.totalUsd;
      } catch (err) {
        logger.warn(`[FeeSync] Auto-claim failed: ${err.message}`);
      }
    }

    // Step 4: Update all agents that have wallet_address set
    const { rows: agents } = await dbAdapter.query(
      'SELECT id, name, wallet_address, token_address FROM agents WHERE wallet_address IS NOT NULL'
    );

    for (const agent of agents) {
      // Find agent's token balance in wallet
      const tokenBalance = wallet.tokenBalances.find(tb => {
        const addr = tb.token?.baseToken?.address?.toLowerCase();
        return addr && agent.token_address && addr === agent.token_address.toLowerCase();
      });

      const tokenUsd = tokenBalance?.token?.balanceUSD ?? 0;

      // fee_balance = ETH balance + token holdings (proxy for accumulated fees)
      const newFeeBalance = parseFloat((wallet.ethBalance + tokenUsd / 2000).toFixed(6));

      await dbAdapter.query(
        `UPDATE agents SET fee_balance = ${param(1)} WHERE id = ${param(2)}`,
        [newFeeBalance, agent.id]
      );

      logger.info(`[FeeSync] Agent ${agent.name} fee_balance updated: ${newFeeBalance}`);
    }

    // Step 5: Broadcast economy update to all SSE clients
    const { rows: economy } = await dbAdapter.query(
      'SELECT id, name, token_symbol, fee_balance, llm_calls FROM agents'
    );

    broadcast('economy-updated', {
      agents: economy,
      wallet: {
        address:    wallet.evmAddress,
        ethBalance: wallet.ethBalance,
        totalUsd:   wallet.totalUsd,
        unclaimedFees,
        claimedNow,
        syncedAt:   new Date().toISOString(),
      },
    });

    logger.info(`[FeeSync] Sync complete. Unclaimed: ${unclaimedFees} WETH, Claimed: ${claimedNow}`);

  } catch (err) {
    logger.error(`[FeeSync] Sync error: ${err.message}`);
  }
}

/**
 * Start the fee sync service.
 * Call this after server starts.
 *
 * @param {object} opts
 * @param {object} opts.dbAdapter
 * @param {Function} opts.broadcast
 * @param {object} opts.logger
 * @returns {object} { stop() }
 */
function startFeeSync({ dbAdapter, broadcast, logger }) {
  const BANKR_API_KEY = process.env.BANKR_API_KEY || '';

  if (!BANKR_API_KEY) {
    logger.warn('[FeeSync] BANKR_API_KEY not set — fee sync disabled');
    return { stop: () => {} };
  }

  logger.info(`[FeeSync] Starting fee sync (interval: ${SYNC_INTERVAL}ms, claim threshold: ${FEE_CLAIM_THRESHOLD} WETH)`);

  // Run immediately on start
  syncFees({ dbAdapter, broadcast, logger });

  // Then on interval
  const timer = setInterval(() => {
    syncFees({ dbAdapter, broadcast, logger });
  }, SYNC_INTERVAL);

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = { startFeeSync, syncFees, fetchWalletBalance, bankrPrompt };
