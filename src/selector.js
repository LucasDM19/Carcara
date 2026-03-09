// src/selector.js — CARCARÁ
// ============================================================
// SELETOR DE MERCADO INTELIGENTE
// ============================================================
// Dado um conjunto de mercados BTC ativos, seleciona o mais
// adequado para apostar segundo os seguintes critérios:
//
//  1. ELEGIBILIDADE (filtros obrigatórios — descarta mercado):
//     - endDate deve estar no futuro
//     - Tempo restante mínimo (MIN_SECONDS_TO_CLOSE) para dar
//       tempo de a ordem ser executada antes do encerramento
//     - Midpoint do token Up entre MID_MIN e MID_MAX
//       (mercado ainda indeciso — não está resolvido)
//
//  2. SCORE (critérios de desempate — quanto maior melhor):
//     - Midpoint próximo de 50% → mercado mais equilibrado
//     - Spread pequeno → menor custo implícito
//     - Tempo restante moderado → nem muito cedo, nem muito tarde
//     - Liquidez (tamanho do best bid + best ask)
//
//  O mercado com maior score final é retornado como selecionado.
// ============================================================

const { getMidpoint, getSpread, getOrderBook, normalizeMarket } = require("./market");
const logger = require("./logger");

// --- Parâmetros configuráveis ---
const CONFIG = {
  // Tempo mínimo restante para considerar o mercado (segundos)
  // Abaixo disso, provavelmente não dá tempo de executar a ordem
  MIN_SECONDS_TO_CLOSE: 60,

  // Tempo máximo restante — mercados muito longe no futuro têm
  // menos liquidez imediata. 15 minutos é um bom teto.
  MAX_SECONDS_TO_CLOSE: 15 * 60,

  // Faixa de midpoint aceitável para o token Up (0 a 1)
  // Fora deste range → mercado já está muito inclinado
  MID_MIN: 0.20,
  MID_MAX: 0.80,

  // Spread máximo tolerado (acima disso, liquidez ruim)
  MAX_SPREAD: 0.10,
};

// ============================================================
// Analisa um único mercado e retorna seus dados de qualidade
// Retorna null se o mercado for inelegível
// ============================================================
async function analyzeMarket(rawMarket) {
  const market = normalizeMarket(rawMarket);

  // Precisa ter pelo menos 2 tokens (Up e Down)
  if (!market.tokens || market.tokens.length < 2) return null;

  const now = Date.now();
  const endDate = new Date(market.end_date);
  const secondsToClose = (endDate - now) / 1000;

  // --- Filtros de elegibilidade ---
  if (secondsToClose < CONFIG.MIN_SECONDS_TO_CLOSE) {
    logger.info(`  ⏭  "${market.question}" — muito perto de fechar (${Math.round(secondsToClose)}s)`);
    return null;
  }

  if (secondsToClose > CONFIG.MAX_SECONDS_TO_CLOSE) {
    logger.info(`  ⏭  "${market.question}" — muito distante (${Math.round(secondsToClose / 60)}min)`);
    return null;
  }

  // Busca dados do token Up (índice 0)
  const upToken = market.tokens[0];
  const downToken = market.tokens[1];

  if (!upToken?.token_id || !downToken?.token_id) return null;

  let midUp, spreadData, bookUp;
  try {
    [midUp, spreadData, bookUp] = await Promise.all([
      getMidpoint(upToken.token_id),
      getSpread(upToken.token_id),
      getOrderBook(upToken.token_id),
    ]);
  } catch (err) {
    logger.warn(`  ⚠️  Erro ao consultar dados de "${market.question}": ${err.message}`);
    return null;
  }

  const spread = parseFloat(spreadData.spread) || 1;
  const midDown = 1 - midUp;

  // Filtro: mercado já inclinado demais
  if (midUp < CONFIG.MID_MIN || midUp > CONFIG.MID_MAX) {
    logger.info(
      `  ⏭  "${market.question}" — midpoint inclinado (Up: ${(midUp * 100).toFixed(1)}%)`
    );
    return null;
  }

  // Filtro: spread alto demais (liquidez ruim)
  if (spread > CONFIG.MAX_SPREAD) {
    logger.info(`  ⏭  "${market.question}" — spread alto (${spread})`);
    return null;
  }

  // --- Cálculo de score ---

  // 1. Proximidade de 50% (0 = perfeito equilíbrio, 1 = desequilíbrio máximo)
  const balanceScore = 1 - Math.abs(midUp - 0.5) * 2;  // 0 a 1

  // 2. Spread baixo é bom (invertido)
  const spreadScore = 1 - spread / CONFIG.MAX_SPREAD;   // 0 a 1

  // 3. Tempo restante: preferimos entre 7 e 12 minutos
  //    Dados de adverse selection mostram que fills em 5–10min têm +16pp de win rate.
  //    Como o fill ocorre ~2min após a seleção, selecionamos com 2min de antecedência.
  const TIME_IDEAL_MIN = 7 * 60;   // 420s
  const TIME_IDEAL_MAX = 12 * 60;  // 720s
  let timeScore;
  if (secondsToClose >= TIME_IDEAL_MIN && secondsToClose <= TIME_IDEAL_MAX) {
    timeScore = 1.0; // platô ótimo
  } else if (secondsToClose < TIME_IDEAL_MIN) {
    timeScore = secondsToClose / TIME_IDEAL_MIN; // sobe linearmente até 300s
  } else {
    timeScore = Math.max(0, 1 - (secondsToClose - TIME_IDEAL_MAX) / (CONFIG.MAX_SECONDS_TO_CLOSE - TIME_IDEAL_MAX));
  }

  // 4. Liquidez: tamanho do melhor bid + melhor ask
  const bestBidSize = parseFloat(bookUp.bids?.[0]?.size || 0);
  const bestAskSize = parseFloat(bookUp.asks?.[0]?.size || 0);
  const totalLiquidity = bestBidSize + bestAskSize;
  const liquidityScore = Math.min(totalLiquidity / 20000, 1); // normalizado em 20k USDC

  // Score final ponderado
  const score =
    balanceScore  * 0.40 +   // 40% — equilíbrio do mercado
    spreadScore   * 0.30 +   // 30% — qualidade da liquidez
    timeScore     * 0.20 +   // 20% — janela de tempo ideal
    liquidityScore * 0.10;   // 10% — tamanho do livro

  return {
    market,
    upToken,
    downToken,
    midUp,
    midDown,
    spread,
    secondsToClose,
    bestBidSize,
    bestAskSize,
    score,
    scores: { balanceScore, spreadScore, timeScore, liquidityScore },
  };
}

// ============================================================
// Seleciona o melhor mercado entre todos os ativos disponíveis
// ============================================================
async function selectBestMarket(rawMarkets) {
  logger.info(`\n🔍 Analisando ${rawMarkets.length} mercado(s) candidato(s)...`);
  logger.divider();

  const analyses = [];

  for (const raw of rawMarkets) {
    const result = await analyzeMarket(raw);
    if (result) analyses.push(result);
  }

  if (analyses.length === 0) {
    logger.warn("Nenhum mercado passou pelos critérios de elegibilidade.");
    return null;
  }

  // Ordena por score decrescente
  analyses.sort((a, b) => b.score - a.score);

  logger.info("\n📋 Mercados elegíveis (ordenados por score):");
  logger.divider();

  for (const a of analyses) {
    const min = Math.floor(a.secondsToClose / 60);
    const sec = Math.round(a.secondsToClose % 60);
    const timeStr = `${min}m${sec.toString().padStart(2, "0")}s`;

    logger.info(
      `  Score: ${(a.score * 100).toFixed(1).padStart(5)}%  |  ` +
      `Up: ${(a.midUp * 100).toFixed(1).padStart(5)}%  |  ` +
      `Spread: ${a.spread.toFixed(3)}  |  ` +
      `Fecha em: ${timeStr}  |  ` +
      `"${a.market.question}"`
    );
    logger.info(
      `           ↳ balance:${(a.scores.balanceScore*100).toFixed(0)}%  ` +
      `spread:${(a.scores.spreadScore*100).toFixed(0)}%  ` +
      `time:${(a.scores.timeScore*100).toFixed(0)}%  ` +
      `liquidity:${(a.scores.liquidityScore*100).toFixed(0)}%`
    );
  }

  const best = analyses[0];

  logger.divider();
  logger.success(`✨ Mercado selecionado: "${best.market.question}"`);
  logger.info(`   Condition ID : ${best.market.condition_id}`);
  logger.info(`   Token Up     : ${best.upToken.token_id}`);
  logger.info(`   Token Down   : ${best.downToken.token_id}`);
  logger.info(`   Midpoint     : Up ${(best.midUp * 100).toFixed(2)}%  |  Down ${(best.midDown * 100).toFixed(2)}%`);
  logger.info(`   Spread       : ${best.spread}`);
  logger.info(`   Fecha em     : ${Math.round(best.secondsToClose)}s`);
  logger.info(`   Score final  : ${(best.score * 100).toFixed(1)}%`);

  return best;
}

module.exports = {
  selectBestMarket,
  analyzeMarket,
  CONFIG,
};
