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
// Registry de estratégias disponíveis
// ============================================================
const STRATEGIES = {
  "dummy":     strategyDummy,
  "up-only":   strategyUpOnly,
  "down-only": strategyDownOnly,
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
  logger.info(`🎲 Estratégia [${name}]: ${decision.rationale}`);
  logger.info(`   Apostando em: ${decision.outcome} | Token: ${decision.tokenId?.slice(0, 20)}...`);
  return decision;
}

module.exports = { runStrategy, STRATEGIES };
