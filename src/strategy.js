// src/strategy.js — CARCARÁ
// ============================================================
// FASE 5 (base) — Sistema de Estratégias
// ============================================================
// Cada estratégia recebe o contexto do mercado selecionado
// e retorna uma decisão de aposta:
//
//   { side: "BUY", outcome: "Up" | "Down", rationale: string }
//
// ou null se a estratégia decidir não apostar nesta janela.
//
// Estratégias disponíveis:
//   dummy    — cara ou coroa (baseline para comparação)
//   up-only  — sempre aposta Up (comportamento original)
//
// Qualquer estratégia futura deve superar a dummy em win rate
// e/ou ROI para justificar sua existência.
// ============================================================

const logger = require("./logger");

// ============================================================
// DUMMY — escolhe Up ou Down aleatoriamente (50/50)
// Serve como baseline: qualquer estratégia real deve superar.
// ============================================================
function strategyDummy(market) {
  const upWins = Math.random() >= 0.5;
  const outcome = upWins ? "Up" : "Down";
  const tokenId = upWins ? market.upToken?.token_id : market.downToken?.token_id;

  return {
    side: "BUY",
    outcome,
    tokenId,
    rationale: `Dummy (aleatório): ${outcome}`,
  };
}

// ============================================================
// UP-ONLY — sempre aposta que o BTC vai subir
// Comportamento original do Carcará.
// ============================================================
function strategyUpOnly(market) {
  return {
    side: "BUY",
    outcome: "Up",
    tokenId: market.upToken?.token_id,
    rationale: "Up-Only: sempre compra Up",
  };
}

// ============================================================
// DOWN-ONLY — sempre aposta que o BTC vai cair
// Útil para comparar com Up-Only em períodos bearish.
// ============================================================
function strategyDownOnly(market) {
  return {
    side: "BUY",
    outcome: "Down",
    tokenId: market.downToken?.token_id,
    rationale: "Down-Only: sempre compra Down",
  };
}

// ============================================================
// MOMENTUM — aposta na direção que o mercado já sinalizou
// ============================================================
// Lógica: se o midpoint está acima de 50%, o mercado coletivo
// já está apostando Up — acompanha essa tendência.
// Se está abaixo de 50%, acompanha Down.
//
// Não aposta em mercados muito equilibrados (zona neutra),
// onde o sinal é fraco e os dados mostram resultado negativo.
//
// Parâmetros:
//   NEUTRAL_ZONE: faixa ao redor de 50% considerada sem sinal
//   Ex: 0.015 → ignora mercados entre 48.5% e 51.5%
// ============================================================
function strategyMomentum(market, options = {}) {
  const neutralZone = options.neutralZone ?? 0.015; // ±1.5% ao redor de 50%
  const { midUp, midDown, upToken, downToken } = market;

  const lowerBound = 0.5 - neutralZone; // ex: 0.485
  const upperBound = 0.5 + neutralZone; // ex: 0.515

  // Zona neutra — sinal fraco, não apostar
  if (midUp >= lowerBound && midUp <= upperBound) {
    return null; // sinaliza para o caller não apostar
  }

  // Mercado favorece Up — acompanha
  if (midUp > upperBound) {
    return {
      side: "BUY",
      outcome: "Up",
      tokenId: upToken?.token_id,
      rationale: `Momentum Up: midUp=${(midUp * 100).toFixed(1)}% > ${(upperBound * 100).toFixed(1)}%`,
    };
  }

  // Mercado favorece Down — acompanha
  return {
    side: "BUY",
    outcome: "Down",
    tokenId: downToken?.token_id,
    rationale: `Momentum Down: midUp=${(midUp * 100).toFixed(1)}% < ${(lowerBound * 100).toFixed(1)}%`,
  };
}

// ============================================================
// CONTRARIAN — aposta contra a tendência do mercado
// ============================================================
// Hipótese alternativa: mercados levemente deslocados tendem
// a reverter para 50%. Útil para comparar com momentum.
// ============================================================
function strategyContrarian(market, options = {}) {
  const neutralZone = options.neutralZone ?? 0.015;
  const { midUp, midDown, upToken, downToken } = market;

  const lowerBound = 0.5 - neutralZone;
  const upperBound = 0.5 + neutralZone;

  if (midUp >= lowerBound && midUp <= upperBound) {
    return null; // zona neutra — sem sinal
  }

  // Mercado favorece Up — aposta contra (Down)
  if (midUp > upperBound) {
    return {
      side: "BUY",
      outcome: "Down",
      tokenId: downToken?.token_id,
      rationale: `Contrarian Down: midUp=${(midUp * 100).toFixed(1)}% > ${(upperBound * 100).toFixed(1)}%`,
    };
  }

  // Mercado favorece Down — aposta contra (Up)
  return {
    side: "BUY",
    outcome: "Up",
    tokenId: upToken?.token_id,
    rationale: `Contrarian Up: midUp=${(midUp * 100).toFixed(1)}% < ${(lowerBound * 100).toFixed(1)}%`,
  };
}

// ============================================================
// Registry de estratégias disponíveis
// ============================================================
const STRATEGIES = {
  "dummy":      strategyDummy,
  "up-only":    strategyUpOnly,
  "down-only":  strategyDownOnly,
  "momentum":   strategyMomentum,
  "contrarian": strategyContrarian,
};

// ============================================================
// Executa uma estratégia pelo nome
// ============================================================
function runStrategy(name, market) {
  const fn = STRATEGIES[name];
  if (!fn) {
    const available = Object.keys(STRATEGIES).join(", ");
    throw new Error(`Estratégia desconhecida: "${name}". Disponíveis: ${available}`);
  }

  const decision = fn(market);

  if (!decision) {
    logger.info(`🎲 Estratégia [${name}]: zona neutra — sem aposta (midUp: ${(market.midUp * 100).toFixed(1)}%)`);
    return null;
  }

  logger.info(`🎲 Estratégia [${name}]: ${decision.rationale}`);
  logger.info(`   Apostando em: ${decision.outcome} | Token: ${decision.tokenId?.slice(0, 20)}...`);
  return decision;
}

module.exports = { runStrategy, STRATEGIES };
