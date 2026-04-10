// src/resolver.js — CARCARÁ
// ============================================================
// FASE 4+ — Auto-resolução de rounds
// ============================================================
// Consulta a Gamma API para detectar o outcome vencedor de
// mercados já encerrados e atualiza o banco automaticamente.
//
// Como funciona:
//   1. Busca todos os rounds com resolved=0 e end_date no passado
//   2. Para cada um, consulta a Gamma API pelo condition_id
//   3. Se o mercado tiver resolvido, extrai o outcome vencedor
//   4. Calcula o payout: shares_matched × 1.00 (se ganhou)
//   5. Grava o resultado no banco via resolveRound()
//
// Uso:
//   npm run resolve:auto         → resolve todos os pendentes
//   npm run resolve:auto -- --watch=60  → loop a cada 60s
// ============================================================

const axios = require("axios");
const { getDb, resolveRound } = require("./db");
const logger = require("./logger");

const GAMMA_HOST = "https://gamma-api.polymarket.com";

// ============================================================
// Busca rounds pendentes de resolução (end_date no passado)
// ============================================================
function getPendingRounds() {
  const db = getDb();
  return db.prepare(`
    SELECT id, condition_id, market_name, market_end_date,
           outcome, shares_matched, usdc_submitted, order_status, token_id
    FROM rounds
    WHERE resolved = 0
      AND order_status IN ('MATCHED', 'DRY')
      AND outcome IS NOT NULL
      AND datetime(market_end_date) < datetime('now')
    ORDER BY market_end_date ASC
  `).all();
}

// ============================================================
// Consulta a Gamma API para descobrir o vencedor do mercado
// Retorna: "Up" | "Down" | null (ainda não resolvido)
// ============================================================
async function fetchMarketOutcome(conditionId, tokenId = null) {
  try {
    // ── Método 1: CLOB API via token_id (mais confiável) ────
    // Se temos o token_id, verificamos o preço atual do token
    // Preço ≈ 0 → token perdeu; Preço ≈ 1 → token ganhou
    if (tokenId) {
      try {
        const clobRes = await axios.get(
          `https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`,
          { timeout: 8_000 }
        );
        const price = parseFloat(clobRes.data?.price ?? clobRes.data?.mid ?? -1);
        logger.info(`  CLOB price para token ${tokenId.slice(0,12)}...: ${price}`);

        if (price >= 0.98) {
          // Token Up ou Down está valendo quase 1 → é o vencedor
          // Precisamos saber qual outcome esse token representa
          // Isso é determinado pelo banco — se outcome='Up' e price≈1 → Up ganhou
          return "TOKEN_WIN"; // sinal especial — caller resolve pelo outcome do round
        }
        if (price <= 0.02) {
          return "TOKEN_LOSE"; // token perdeu
        }
        // Preço intermediário → ainda não resolveu
        logger.info(`  CLOB: preço intermediário (${price}) — mercado ainda não resolveu`);
        return null;
      } catch (clobErr) {
        logger.info(`  CLOB indisponível: ${clobErr.message} — tentando Gamma...`);
      }
    }

    // ── Método 2: Gamma API (múltiplos endpoints) ────────────
    let markets = null;
    const queries = [
      `${GAMMA_HOST}/markets?condition_ids=${conditionId}`,
      `${GAMMA_HOST}/markets?conditionId=${conditionId}`,
    ];

    for (const url of queries) {
      try {
        const res = await axios.get(url, { timeout: 10_000 });
        if (Array.isArray(res.data) && res.data.length > 0) {
          markets = res.data; break;
        }
      } catch { /* tenta próximo */ }
    }

    if (!markets) {
      logger.warn(`  Resolver: nenhum mercado retornado para ${conditionId.slice(0, 12)}...`);
      return null;
    }

    const market = markets[0];
    logger.info(`  API: active=${market.active} closed=${market.closed} resolved=${market.resolved}`);

    const isSettled = market.active === false || market.closed === true || market.resolved === true;

    let prices = [];
    try {
      prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : (market.outcomePrices || []);
    } catch { prices = []; }

    const hasWinner = prices.some(p => parseFloat(p) >= 0.99);

    if (!isSettled && !hasWinner) {
      logger.info(`  ⏳ Mercado ainda ativo — ainda não resolvido.`);
      return null;
    }

    let outcomes = [];
    try {
      outcomes = typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : (market.outcomes || []);
    } catch { outcomes = []; }

    logger.info(`  Outcomes: ${JSON.stringify(outcomes)} | Prices: ${JSON.stringify(prices)}`);

    if (!outcomes.length || outcomes.length !== prices.length) {
      logger.warn(`  Resolver: outcomes/prices inconsistentes`);
      return null;
    }

    const winnerIdx = prices.findIndex(p => parseFloat(p) >= 0.99);
    if (winnerIdx === -1) {
      logger.warn(`  Resolver: nenhum vencedor claro ainda (prices: ${prices})`);
      return null;
    }

    return outcomes[winnerIdx];
  } catch (err) {
    logger.warn(`Resolver: erro ao consultar mercado ${conditionId}: ${err.message}`);
    return null;
  }
}


async function autoResolve() {
  const pending = getPendingRounds();

  if (pending.length === 0) {
    logger.info("✨ Nenhum round pendente de resolução.");
    return { resolved: 0, skipped: 0 };
  }

  logger.info(`🔍 ${pending.length} round(s) pendente(s) de resolução...`);
  logger.divider();

  let resolved = 0;
  let skipped = 0;

  for (const round of pending) {
    logger.info(`Verificando Round #${round.id}: ${round.market_name?.slice(0, 50)}`);
    logger.info(`  End date  : ${round.market_end_date}`);
    logger.info(`  Apostou   : ${round.outcome} | ${round.shares_matched} shares`);

    const winner = await fetchMarketOutcome(round.condition_id, round.token_id);

    if (!winner) {
      logger.warn(`  ⏳ Mercado ainda não resolvido pela Gamma API — tentando depois.`);
      skipped++;
      continue;
    }

    // Handle TOKEN_WIN/TOKEN_LOSE from CLOB API
    let wonBool;
    if (winner === "TOKEN_WIN") {
      wonBool = true;
      logger.info(`  CLOB confirmou: ${round.outcome} GANHOU`);
    } else if (winner === "TOKEN_LOSE") {
      wonBool = false;
      logger.info(`  CLOB confirmou: ${round.outcome} PERDEU`);
    } else {
      wonBool = winner === round.outcome;
      logger.info(`  Vencedor  : ${winner}`);
    }

    const payout = wonBool ? round.shares_matched * 1.0 : 0;
    const label  = wonBool
      ? `✅ Round #${round.id} — ${round.market_name?.slice(0,30)} — Apostou: ${round.outcome} | Venceu: ${winner !== "TOKEN_WIN" && winner !== "TOKEN_LOSE" ? winner : round.outcome} | Profit: +${(payout - (round.usdc_submitted ?? 0)).toFixed(2)} USDC`
      : `❌ Round #${round.id} — ${round.market_name?.slice(0,30)} — Apostou: ${round.outcome} | Profit: -${(round.usdc_submitted ?? 0).toFixed(2)} USDC`;
    logger.info(label);
    resolveRound(round.id, { won: wonBool, payout });
    resolved++;

    // Pequena pausa entre chamadas à API
    await new Promise(r => setTimeout(r, 500));
  }

  logger.divider();
  logger.info(`Resolução concluída: ${resolved} resolvidos, ${skipped} aguardando.`);
  return { resolved, skipped };
}

// ============================================================
// Modo watch: roda em loop a cada N segundos
// ============================================================
async function watchAndResolve(intervalSeconds = 60) {
  logger.info(`🦅 CARCARÁ Auto-Resolver — verificando a cada ${intervalSeconds}s`);
  logger.info("   Ctrl+C para parar.");

  const run = async () => {
    logger.divider();
    logger.info(`[${new Date().toISOString()}] Verificando rounds pendentes...`);
    await autoResolve();
  };

  await run();
  const timer = setInterval(run, intervalSeconds * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    logger.info("⏹  Auto-resolver parado.");
    process.exit(0);
  });
}

module.exports = { autoResolve, watchAndResolve, fetchMarketOutcome };
