// src/strategy.js — CARCARÁ
// ============================================================
// FASE 6 — Sistema de Estratégias
// ============================================================
// Cada estratégia recebe o contexto do mercado selecionado
// e retorna uma decisão de aposta:
//
//   { side: "BUY", outcome: "Up" | "Down", tokenId, rationale }
//
// ou null se a estratégia decidir não apostar nesta janela.
//
// runStrategy() é ASSÍNCRONA — sempre use await.
//
// Estratégias disponíveis:
//   dummy      — cara ou coroa (baseline)
//   up-only    — sempre aposta Up
//   down-only  — sempre aposta Down
//   momentum   — aposta na direção do midpoint deslocado
//   contrarian — aposta contra o midpoint deslocado
//   value      — usa dados históricos do banco para estimar EV
//
// A estratégia value é a única que acessa o banco de dados.
// Todas as outras são funções síncronas puras.
// ============================================================

const logger = require("./logger");

// ============================================================
// DUMMY — escolhe Up ou Down aleatoriamente (50/50)
// ============================================================
function strategyDummy(market) {
  const upWins = Math.random() >= 0.5;
  const outcome = upWins ? "Up" : "Down";
  const tokenId = upWins ? market.upToken?.token_id : market.downToken?.token_id;
  return { side: "BUY", outcome, tokenId, rationale: `Dummy (aleatório): ${outcome}` };
}

// ============================================================
// UP-ONLY — sempre aposta Up
// ============================================================
function strategyUpOnly(market) {
  return {
    side: "BUY", outcome: "Up",
    tokenId: market.upToken?.token_id,
    rationale: "Up-Only: sempre compra Up",
  };
}

// ============================================================
// DOWN-ONLY — sempre aposta Down
// ============================================================
function strategyDownOnly(market) {
  return {
    side: "BUY", outcome: "Down",
    tokenId: market.downToken?.token_id,
    rationale: "Down-Only: sempre compra Down",
  };
}

// ============================================================
// MOMENTUM — aposta na direção que o midpoint já sinaliza
// ============================================================
function strategyMomentum(market, options = {}) {
  const neutralZone = options.neutralZone ?? 0.015;
  const { midUp, upToken, downToken } = market;
  const lo = 0.5 - neutralZone;
  const hi = 0.5 + neutralZone;

  if (midUp >= lo && midUp <= hi) return null;

  if (midUp > hi) {
    return {
      side: "BUY", outcome: "Up", tokenId: upToken?.token_id,
      rationale: `Momentum Up: midUp=${(midUp * 100).toFixed(1)}% > ${(hi * 100).toFixed(1)}%`,
    };
  }
  return {
    side: "BUY", outcome: "Down", tokenId: downToken?.token_id,
    rationale: `Momentum Down: midUp=${(midUp * 100).toFixed(1)}% < ${(lo * 100).toFixed(1)}%`,
  };
}

// ============================================================
// CONTRARIAN — aposta contra a tendência do midpoint
// ============================================================
function strategyContrarian(market, options = {}) {
  const neutralZone = options.neutralZone ?? 0.015;
  const { midUp, upToken, downToken } = market;
  const lo = 0.5 - neutralZone;
  const hi = 0.5 + neutralZone;

  if (midUp >= lo && midUp <= hi) return null;

  if (midUp > hi) {
    return {
      side: "BUY", outcome: "Down", tokenId: downToken?.token_id,
      rationale: `Contrarian Down: midUp=${(midUp * 100).toFixed(1)}% > ${(hi * 100).toFixed(1)}%`,
    };
  }
  return {
    side: "BUY", outcome: "Up", tokenId: upToken?.token_id,
    rationale: `Contrarian Up: midUp=${(midUp * 100).toFixed(1)}% < ${(lo * 100).toFixed(1)}%`,
  };
}

// ============================================================
// VALUE — aposta baseada em Valor Esperado histórico
// ============================================================
// Princípio: EV = win_rate_histórico − preço_pago
//   Se EV > threshold → aposta (condições historicamente lucrativas)
//   Se EV ≤ threshold → não aposta (sem edge suficiente)
//
// Condições analisadas (do mais específico ao mais geral):
//   spread_bucket  — spread apertado (0.01) vs largo (0.02+)
//   vol_level      — CALM | ALERT | STORM
//   time_bucket    — tempo até fechar: very_short/short/medium/long
//   mid_bucket     — |midUp − 0.5|: flat/slight/moderate/strong
//
// A direção (Up/Down) é irrelevante — dados confirmam que
// win_rate independe da direção. Usa random como dummy.
//
// Parâmetros (ajustáveis via options):
//   minSamples  — mínimo de rounds históricos para confiar (padrão: 20)
//   evThreshold — EV mínimo para apostar, ex: 0.02 = 2% (padrão: 0.02)
// ============================================================
async function strategyValue(market, options = {}) {
  const minSamples  = options.minSamples  ?? 20;
  const evThreshold = options.evThreshold ?? 0.02;

  const { getDb } = require("./db");
  const db = getDb();

  // ── Classifica o mercado atual em buckets ─────────────────
  const spreadBucket = market.spread <= 0.01 ? "tight" : "wide";

  const sec = market.secondsToClose ?? 300;
  const timeBucket =
    sec < 120 ? "very_short" :
    sec < 300 ? "short"      :
    sec < 600 ? "medium"     : "long";

  const midDev = Math.abs(market.midUp - 0.5);
  const midBucket =
    midDev < 0.01 ? "flat"     :
    midDev < 0.03 ? "slight"   :
    midDev < 0.06 ? "moderate" : "strong";

  const volLevel = market.volLevel ?? "CALM";

  logger.info(`   Value buckets: spread=${spreadBucket} vol=${volLevel} time=${timeBucket} mid=${midBucket}`);

  // ── Garante tabela de condições sincronizada ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS round_conditions (
      id            INTEGER PRIMARY KEY,
      won           INTEGER,
      price_submitted REAL,
      spread_bucket TEXT,
      vol_level     TEXT,
      time_bucket   TEXT,
      mid_bucket    TEXT
    )
  `);

  db.exec(`
    INSERT OR IGNORE INTO round_conditions
    SELECT
      r.id,
      r.won,
      r.price_submitted,
      CASE WHEN r.spread <= 0.01 THEN 'tight' ELSE 'wide' END,
      r.vol_level,
      CASE
        WHEN r.seconds_to_close < 120  THEN 'very_short'
        WHEN r.seconds_to_close < 300  THEN 'short'
        WHEN r.seconds_to_close < 600  THEN 'medium'
        ELSE 'long'
      END,
      CASE
        WHEN ABS(r.mid_up - 0.5) < 0.01 THEN 'flat'
        WHEN ABS(r.mid_up - 0.5) < 0.03 THEN 'slight'
        WHEN ABS(r.mid_up - 0.5) < 0.06 THEN 'moderate'
        ELSE 'strong'
      END
    FROM rounds r
    WHERE r.resolved = 1
      AND r.mode IN ('sim', 'order')
      AND r.won IS NOT NULL
      AND r.id NOT IN (SELECT id FROM round_conditions)
  `);

  // ── Busca win rate do mais específico para o mais geral ───
  const queries = [
    { label: "spread+vol+time+mid",
      where: `spread_bucket=? AND vol_level=? AND time_bucket=? AND mid_bucket=?`,
      params: [spreadBucket, volLevel, timeBucket, midBucket] },
    { label: "spread+time+mid",
      where: `spread_bucket=? AND time_bucket=? AND mid_bucket=?`,
      params: [spreadBucket, timeBucket, midBucket] },
    { label: "spread+time",
      where: `spread_bucket=? AND time_bucket=?`,
      params: [spreadBucket, timeBucket] },
    { label: "spread",
      where: `spread_bucket=?`,
      params: [spreadBucket] },
    { label: "global",
      where: `1=1`,
      params: [] },
  ];

  let bucket = null;
  let winRate = null;
  let sampleSize = 0;
  let avgPrice = 0.485;

  for (const q of queries) {
    const row = db.prepare(`
      SELECT
        COUNT(*)  as n,
        AVG(CAST(won AS REAL))   as win_rate,
        AVG(price_submitted)     as avg_price
      FROM round_conditions
      WHERE ${q.where}
    `).get(...q.params);

    if (row && row.n >= minSamples) {
      bucket     = q.label;
      winRate    = row.win_rate;
      sampleSize = row.n;
      avgPrice   = row.avg_price ?? avgPrice;
      break;
    }
  }

  // Sem dados suficientes — cai para dummy silenciosamente
  if (winRate === null) {
    logger.info(`   Value: dados insuficientes (<${minSamples} rounds) → dummy`);
    return strategyDummy(market);
  }

  // ── Calcula EV real com preço histórico médio ─────────────
  // EV = win_rate − preço_pago  (numa prediction market binária)
  // Se compro a 0.48 e ganho com 52% de chance: EV = 0.52 − 0.48 = +0.04
  const ev = winRate - avgPrice;

  logger.info(
    `   Value [${bucket}]: n=${sampleSize} | ` +
    `win_rate=${(winRate * 100).toFixed(1)}% | ` +
    `avg_price=${avgPrice.toFixed(3)} | ` +
    `EV=${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(2)}%`
  );

  if (ev < evThreshold) {
    logger.info(
      `   Value: EV ${(ev*100).toFixed(2)}% < threshold ${(evThreshold*100).toFixed(2)}% — pulando janela.`
    );
    return null;
  }

  // Direção aleatória — dados provam que não importa
  const upWins = Math.random() >= 0.5;
  const outcome = upWins ? "Up" : "Down";
  const tokenId = upWins ? market.upToken?.token_id : market.downToken?.token_id;

  return {
    side: "BUY",
    outcome,
    tokenId,
    rationale: `Value [${bucket}]: win=${(winRate*100).toFixed(1)}% EV=+${(ev*100).toFixed(2)}% n=${sampleSize}`,
  };
}

// ============================================================
// Registry de estratégias
// ============================================================
const STRATEGIES = {
  "dummy":      { fn: strategyDummy,      async: false },
  "up-only":    { fn: strategyUpOnly,     async: false },
  "down-only":  { fn: strategyDownOnly,   async: false },
  "momentum":   { fn: strategyMomentum,   async: false },
  "contrarian": { fn: strategyContrarian, async: false },
  "value":      { fn: strategyValue,      async: true  },
};

// ============================================================
// Executa uma estratégia — SEMPRE use await
// ============================================================
async function runStrategy(name, market, options = {}) {
  const entry = STRATEGIES[name];
  if (!entry) {
    const available = Object.keys(STRATEGIES).join(", ");
    throw new Error(`Estratégia desconhecida: "${name}". Disponíveis: ${available}`);
  }

  const decision = entry.async
    ? await entry.fn(market, options)
    : entry.fn(market, options);

  if (!decision) {
    logger.info(
      `🎲 Estratégia [${name}]: sem aposta nesta janela (midUp: ${(market.midUp * 100).toFixed(1)}%)`
    );
    return null;
  }

  logger.info(`🎲 Estratégia [${name}]: ${decision.rationale}`);
  logger.info(`   Apostando em: ${decision.outcome} | Token: ${decision.tokenId?.slice(0, 20)}...`);
  return decision;
}

module.exports = { runStrategy, STRATEGIES };
