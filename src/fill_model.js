// src/fill_model.js — CARCARÁ
// ============================================================
// FASE 6 — Modelo de Probabilidade de Fill
// ============================================================
// Problema: o modo sim assume fill de 100%, mas na realidade
// ~75-80% das ordens são canceladas sem custo. Isso infla o
// P&L simulado e invalida comparações entre estratégias.
//
// Solução: aprender com os rounds REAIS (mode='order') quais
// condições de orderbook, spread, tempo e volatilidade
// resultam em MATCHED vs CANCELED, e usar esse modelo para:
//
//   1. Corrigir o P&L simulado (sim_adjusted)
//   2. Filtrar janelas com baixa probabilidade de fill
//   3. Melhorar a estratégia value (só aposta se EV * fill_prob > threshold)
//
// Features usadas para prever fill:
//   book_liquidity_near  — tamanho total dos asks no range [price-0.02, price+0.02]
//   book_has_near_ask    — 1 se existe ask real próximo do nosso preço
//   spread               — quanto menor o spread, mais liquid o mercado
//   seconds_to_close     — mais tempo = mais chance de alguém cruzar
//   vol_level            — CALM tem fill mais previsível
//   price_vs_mid         — quão longe do midpoint estamos (nossa margem)
//
// Método: logistic regression simplificada sobre dados históricos.
// Com poucos dados (<30 rounds reais), retorna probabilidade base
// estimada pelo fill rate observado geral.
// ============================================================

const logger = require("./logger");

// ============================================================
// Extrai features de um round + seu orderbook snapshot
// ============================================================
function extractFeatures(round, bookRows) {
  const price = round.price_submitted ?? 0.485;
  const range = 0.03; // considera asks dentro de ±3 centavos do preço

  // Liquidez real nos asks próximos do nosso preço de compra
  const nearAsks = (bookRows || []).filter(
    r => r.side === "asks" && r.price >= price - range && r.price <= price + range
  );
  const liquidityNear = nearAsks.reduce((sum, r) => sum + (r.size || 0), 0);
  const hasNearAsk    = nearAsks.length > 0 ? 1 : 0;

  // Melhor ask disponível
  const allAsks = (bookRows || []).filter(r => r.side === "asks");
  const bestAsk = allAsks.length > 0
    ? Math.min(...allAsks.map(r => r.price))
    : 0.99; // AMM sempre disponível a ~0.50+

  // Distância do nosso preço até o melhor ask (positivo = estamos abaixo do ask)
  const distToBestAsk = bestAsk - price;

  // Normaliza vol_level para número
  const volMap = { CALM: 0, ALERT: 0.5, STORM: 1, UNKNOWN: 0, DISCONNECTED: 0 };
  const volNumeric = volMap[round.vol_level ?? "CALM"] ?? 0;

  // price_vs_mid: quanto nossa oferta está abaixo do midpoint
  // valor positivo = oferecemos desconto (mais atraente para vendedores)
  const priceDelta = (round.mid_up ?? 0.5) - price;

  return {
    liquidity_near:   liquidityNear,
    has_near_ask:     hasNearAsk,
    dist_to_best_ask: distToBestAsk,
    spread:           round.spread ?? 0.01,
    seconds_to_close: Math.min(round.seconds_to_close ?? 300, 600), // cap em 10min
    vol_numeric:      volNumeric,
    price_delta:      priceDelta,
  };
}

// ============================================================
// Treina modelo sobre rounds reais com orderbook capturado
// Retorna coeficientes de uma regressão logística simplificada
// (gradiente manual, sem dependência de lib de ML)
// ============================================================
function trainFillModel(db) {
  // Busca rounds reais com orderbook capturado
  const rounds = db.prepare(`
    SELECT r.id, r.price_submitted, r.spread, r.seconds_to_close,
           r.vol_level, r.mid_up, r.order_status
    FROM rounds r
    WHERE r.mode = 'order'
      AND r.order_status IN ('MATCHED', 'CANCELED')
      AND r.price_submitted IS NOT NULL
      AND EXISTS (SELECT 1 FROM orderbook_snapshots o WHERE o.round_id = r.id)
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all();

  if (rounds.length < 5) {
    return { type: "base_rate", fillRate: null, n: rounds.length };
  }

  // Calcula fill rate base (sem features)
  const filled = rounds.filter(r => r.order_status === "MATCHED").length;
  const baseRate = filled / rounds.length;

  if (rounds.length < 15) {
    // Poucos dados — só usa a taxa base
    logger.info(`   FillModel: poucos dados (${rounds.length} rounds reais) → taxa base ${(baseRate * 100).toFixed(1)}%`);
    return { type: "base_rate", fillRate: baseRate, n: rounds.length };
  }

  // Monta dataset com features
  const dataset = [];
  for (const round of rounds) {
    const bookRows = db.prepare(`
      SELECT side, price, size FROM orderbook_snapshots WHERE round_id = ?
    `).all(round.id);

    const features = extractFeatures(round, bookRows);
    const label = round.order_status === "MATCHED" ? 1 : 0;
    dataset.push({ features, label });
  }

  // Regressão logística via gradiente descendente
  // Features: [liquidity_near, has_near_ask, dist_to_best_ask,
  //            spread, seconds_to_close_norm, vol_numeric, price_delta, bias]
  const featureKeys = [
    "liquidity_near", "has_near_ask", "dist_to_best_ask",
    "spread", "seconds_to_close", "vol_numeric", "price_delta",
  ];

  // Normalização simples (min-max por feature)
  const stats = {};
  for (const key of featureKeys) {
    const vals = dataset.map(d => d.features[key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    stats[key] = { min, max, range: max - min || 1 };
  }

  const normalize = (features) => {
    return featureKeys.map(k => (features[k] - stats[k].min) / stats[k].range);
  };

  // Inicializa pesos
  let weights = new Array(featureKeys.length + 1).fill(0); // +1 para bias
  const lr = 0.1;
  const epochs = 200;

  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));

  for (let e = 0; e < epochs; e++) {
    const grads = new Array(weights.length).fill(0);
    for (const { features, label } of dataset) {
      const x = [...normalize(features), 1]; // adiciona bias
      const z = x.reduce((sum, xi, i) => sum + xi * weights[i], 0);
      const pred = sigmoid(z);
      const err = pred - label;
      for (let i = 0; i < weights.length; i++) {
        grads[i] += err * x[i];
      }
    }
    for (let i = 0; i < weights.length; i++) {
      weights[i] -= (lr / dataset.length) * grads[i];
    }
  }

  return {
    type: "logistic",
    weights,
    featureKeys,
    stats,
    fillRate: baseRate,
    n: rounds.length,
  };
}

// ============================================================
// Prediz probabilidade de fill dado o contexto atual
// ============================================================
function predictFillProbability(model, round, bookRows) {
  if (!model || model.type === "base_rate") {
    return model?.fillRate ?? 0.20; // fallback: taxa base observada
  }

  const features = extractFeatures(round, bookRows);
  const { weights, featureKeys, stats } = model;

  const normalize = (f) =>
    featureKeys.map(k => (f[k] - stats[k].min) / stats[k].range);

  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));

  const x = [...normalize(features), 1];
  const z = x.reduce((sum, xi, i) => sum + xi * (weights[i] ?? 0), 0);
  return sigmoid(z);
}

// ============================================================
// API principal — singleton do modelo treinado
// ============================================================
let _model = null;
let _modelTrainedAt = null;
const MODEL_TTL_MS = 10 * 60 * 1000; // retreina a cada 10 minutos

function getFillModel(db) {
  const now = Date.now();
  if (!_model || !_modelTrainedAt || now - _modelTrainedAt > MODEL_TTL_MS) {
    _model = trainFillModel(db);
    _modelTrainedAt = now;

    if (_model.type === "logistic") {
      logger.info(
        `   🧠 FillModel treinado: ${_model.n} rounds reais | ` +
        `base_rate=${(_model.fillRate * 100).toFixed(1)}% | logistic`
      );
    }
  }
  return _model;
}

// ============================================================
// Ajusta o P&L simulado de um conjunto de rounds
// Retorna stats corrigidas pela fill probability histórica
// ============================================================
function computeAdjustedSimStats(db, strategyName) {
  const model = getFillModel(db);
  const fillProb = model.fillRate ?? 0.20;

  const rows = db.prepare(`
    SELECT id, won, profit, usdc_submitted
    FROM rounds
    WHERE mode = 'sim'
      AND strategy = ?
      AND resolved = 1
  `).all(strategyName);

  if (!rows.length) return null;

  // P&L ajustado: cada round tem probabilidade fillProb de ter sido real
  // wins ajustado = wins × fillProb
  // losses = (rounds − wins) × fillProb
  // custo de oportunidade: rounds que não preencheram = 0 (sem custo)
  const wins     = rows.filter(r => r.won).length;
  const total    = rows.length;
  const adjWins  = wins * fillProb;
  const adjRounds = total * fillProb;
  const adjProfit = rows.reduce((sum, r) => {
    if (r.won) return sum + (r.profit ?? 0) * fillProb;
    // perdas só acontecem quando a ordem preenche
    return sum + (r.profit ?? 0) * fillProb;
  }, 0);

  const adjWagered = rows.reduce((s, r) => s + (r.usdc_submitted ?? 0), 0) * fillProb;
  const adjRoi = adjWagered > 0 ? (adjProfit / adjWagered) * 100 : 0;

  return {
    strategy: strategyName,
    totalSim: total,
    fillProb,
    adjRounds: Math.round(adjRounds),
    adjWins: Math.round(adjWins),
    adjWinRate: adjRounds > 0 ? (adjWins / adjRounds) * 100 : 0,
    adjProfit,
    adjRoi,
    rawWinRate: total > 0 ? (wins / total) * 100 : 0,
    rawProfit: rows.reduce((s, r) => s + (r.profit ?? 0), 0),
  };
}

module.exports = {
  getFillModel,
  predictFillProbability,
  extractFeatures,
  computeAdjustedSimStats,
};
