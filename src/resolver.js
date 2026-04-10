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
async function fetchMarketOutcome(conditionId) {
  try {
    // Tenta múltiplos formatos de query e endpoints
    let markets = null;
    const queries = [
      `${GAMMA_HOST}/markets?condition_ids=${conditionId}`,
      `${GAMMA_HOST}/markets?conditionId=${conditionId}`,
      `${GAMMA_HOST}/events?condition_ids=${conditionId}`,
    ];

    for (const url of queries) {
      try {
        const res = await axios.get(url, { timeout: 10_000 });
        const data = res.data;
        // Pode retornar array de markets ou array de events com markets dentro
        if (Array.isArray(data) && data.length > 0) {
          // Events têm markets aninhados
          if (data[0].markets) {
            const nested = data.flatMap(e => e.markets || [])
              .filter(m => m.conditionId === conditionId || m.condition_id === conditionId);
            if (nested.length > 0) { markets = nested; break; }
          } else {
            markets = data; break;
          }
        }
      } catch { /* tenta próximo */ }
    }

    // Fallback: Data API da Polymarket
    if (!markets) {
      try {
        const res = await axios.get(
          `https://data-api.polymarket.com/positions?market=${conditionId}`,
          { timeout: 10_000 }
        );
        if (Array.isArray(res.data) && res.data.length > 0) {
          // Data API retorna posições — se outcome_price = 1, esse outcome ganhou
          const settled = res.data.find(p => parseFloat(p.curPrice || p.outcomePrice || 0) >= 0.99);
          if (settled) {
            logger.info(`  Resolver via Data API: vencedor = ${settled.outcome || settled.title}`);
            return settled.outcome || settled.title;
          }
        }
      } catch { /* Data API indisponível */ }
    }

    if (!markets) {
      logger.warn(`  Resolver: nenhum mercado retornado para ${conditionId.slice(0, 12)}...`);
      return null;
    }

    const market = markets[0];

    // Debug: mostra estado do mercado
    logger.info(`  API: active=${market.active} closed=${market.closed} resolved=${market.resolved}`);

    // A Gamma pode usar active=false, closed=true, ou resolved=true para indicar encerramento
    // Fallback: se end_date passou há mais de 2 horas e API ainda diz ativo,
    // tenta ler outcomePrices diretamente — se um deles for 1.0, o mercado resolveu
    const isSettled = market.active === false || market.closed === true || market.resolved === true;
    if (!isSettled) {
      // Verifica se outcomePrices já tem um vencedor claro mesmo com flags incorretas
      let prices = [];
      try {
        prices = typeof market.outcomePrices === "string"
          ? JSON.parse(market.outcomePrices)
          : (market.outcomePrices || []);
      } catch { prices = []; }

      const hasWinner = prices.some(p => parseFloat(p) >= 0.99);
      if (!hasWinner) {
        logger.info(`  ⏳ Mercado ainda ativo — ainda não resolvido.`);
        return null;
      }
      logger.info(`  ℹ️  API flags inconsistentes mas outcomePrices indica resolução — prosseguindo.`);
    }

    // Extrai outcomes e preços finais
    let outcomes, prices;
    try {
      outcomes = typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : (market.outcomes || []);
      prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : (market.outcomePrices || []);
    } catch {
      logger.warn(`  Resolver: erro ao parsear outcomes/prices`);
      return null;
    }

    logger.info(`  Outcomes: ${JSON.stringify(outcomes)} | Prices: ${JSON.stringify(prices)}`);

    if (!outcomes.length || outcomes.length !== prices.length) {
      logger.warn(`  Resolver: outcomes/prices inconsistentes`);
      return null;
    }

    // O vencedor tem preço final próximo de 1.0
    const winnerIdx = prices.findIndex(p => parseFloat(p) >= 0.99);
    if (winnerIdx === -1) {
      logger.warn(`  Resolver: nenhum vencedor claro ainda (prices: ${prices})`);
      return null;
    }

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
