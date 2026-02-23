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
           outcome, shares_matched, usdc_submitted, order_status
    FROM rounds
    WHERE resolved = 0
      AND order_status IN ('MATCHED', 'CAPTURE')
      AND market_end_date < datetime('now')
    ORDER BY market_end_date ASC
  `).all();
}

// ============================================================
// Consulta a Gamma API para descobrir o vencedor do mercado
// Retorna: "Up" | "Down" | null (ainda não resolvido)
// ============================================================
async function fetchMarketOutcome(conditionId) {
  try {
    const url = `${GAMMA_HOST}/markets?condition_ids=${conditionId}`;
    const res = await axios.get(url, { timeout: 10_000 });
    const markets = res.data;

    if (!Array.isArray(markets) || markets.length === 0) return null;

    const market = markets[0];

    // Mercado ainda aberto ou sem resolução
    if (!market.closed && !market.resolved) return null;

    // A Gamma retorna os outcomes e os preços finais (0 ou 1)
    // O vencedor tem outcomePrices próximo de "1"
    let outcomes, prices;
    try {
      outcomes = typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes;
      prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
    } catch {
      return null;
    }

    if (!outcomes || !prices || outcomes.length !== prices.length) return null;

    // Encontra o outcome com preço final = 1 (vencedor)
    const winnerIdx = prices.findIndex(p => parseFloat(p) >= 0.99);
    if (winnerIdx === -1) return null;

    return outcomes[winnerIdx]; // "Up" ou "Down"
  } catch (err) {
    logger.warn(`Resolver: erro ao consultar mercado ${conditionId}: ${err.message}`);
    return null;
  }
}

// ============================================================
// Resolve um round com base no outcome vencedor
// ============================================================
function resolveRoundWithOutcome(round, winnerOutcome) {
  const won = round.outcome === winnerOutcome;
  // Payout: se ganhou, cada share vira 1 USDC
  const payout = won ? (round.shares_matched || 0) * 1.0 : 0;

  resolveRound(round.id, { won, payout });

  const profit = won
    ? payout - (round.usdc_submitted || 0)
    : -(round.usdc_submitted || 0);

  const icon = won ? "✅" : "❌";
  logger.info(
    `${icon} Round #${round.id} — ${round.market_name?.slice(-25)} — ` +
    `Apostou: ${round.outcome} | Venceu: ${winnerOutcome} | ` +
    `Profit: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USDC`
  );

  return { won, payout, profit };
}

// ============================================================
// Roda a resolução automática em todos os pendentes
// ============================================================
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

    const winner = await fetchMarketOutcome(round.condition_id);

    if (!winner) {
      logger.warn(`  ⏳ Mercado ainda não resolvido pela Gamma API — tentando depois.`);
      skipped++;
      continue;
    }

    logger.info(`  Vencedor  : ${winner}`);
    resolveRoundWithOutcome(round, winner);
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
