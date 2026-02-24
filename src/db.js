// src/db.js — CARCARÁ
// ============================================================
// FASE 4 — Camada de persistência SQLite
// ============================================================
// Tabelas:
//
//   rounds        — cada execução do bot (aposta ou captura)
//   orderbook_snapshots — estado do orderbook no momento da ordem
//   volatility_snapshots — estado de volatilidade no momento
//   results       — resultado final de cada round (após resolução)
//
// Design:
//   - Toda aposta real e toda captura gera um round
//   - O round captura o contexto completo no momento da decisão
//   - O resultado é preenchido posteriormente via --mode=resolve
//   - Isso permite backtesting: simular estratégias sobre rounds passados
// ============================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const logger = require("./logger");

const DB_PATH = path.join(__dirname, "..", "data", "carcara.db");

let _db = null;

function getDb() {
  if (_db) return _db;

  // Cria o diretório data/ se não existir
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");   // melhor performance em leitura concorrente
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
  logger.success(`📦 Banco de dados: ${DB_PATH}`);
  return _db;
}

// ============================================================
// Schema
// ============================================================
function initSchema(db) {
  db.exec(`
    -- Cada execução do Carcará (aposta real, dry-run ou captura pura)
    CREATE TABLE IF NOT EXISTS rounds (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),

      -- Identificação do modo
      mode              TEXT NOT NULL,  -- 'order' | 'dry' | 'capture'
      strategy          TEXT,           -- nome da estratégia (Fase 6)

      -- Mercado selecionado
      condition_id      TEXT NOT NULL,
      market_name       TEXT NOT NULL,
      market_end_date   TEXT NOT NULL,
      seconds_to_close  INTEGER,
      market_score      REAL,

      -- Estado do midpoint no momento da seleção
      mid_up            REAL,
      mid_down          REAL,
      spread            REAL,

      -- Parâmetros da ordem
      side              TEXT,           -- 'BUY' | 'SELL'
      token_id          TEXT,
      outcome           TEXT,           -- 'Up' | 'Down'
      price_submitted   REAL,
      shares_submitted  REAL,
      usdc_submitted    REAL,
      wait_ms           INTEGER,
      margin_used       REAL,

      -- Resultado do envio
      order_id          TEXT,
      order_status      TEXT,           -- 'MATCHED' | 'CANCELED' | 'LIVE' | 'ERROR' | 'DRY'
      shares_matched    REAL DEFAULT 0,
      taker_fill        INTEGER DEFAULT 0,  -- 0 = maker, 1 = taker
      cancelled_immediately INTEGER DEFAULT 0,

      -- Volatilidade no momento
      vol_level         TEXT,           -- 'CALM' | 'ALERT' | 'STORM' | 'UNKNOWN'
      vol_speed         REAL,
      vol_stddev        REAL,
      vol_amplitude     REAL,
      btc_price         REAL,

      -- Resultado final (preenchido pelo --mode=resolve)
      resolved          INTEGER DEFAULT 0,
      won               INTEGER,        -- 1 = ganhou, 0 = perdeu, NULL = não resolvido
      payout            REAL,           -- USDC recebido
      profit            REAL            -- payout - usdc_submitted
    );

    -- Snapshot completo do orderbook no momento da ordem
    -- Permite simular slippage e fill probability em backtests
    CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id    INTEGER REFERENCES rounds(id),
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_id    TEXT NOT NULL,
      side        TEXT NOT NULL,  -- 'bids' | 'asks'
      price       REAL NOT NULL,
      size        REAL NOT NULL,
      level       INTEGER NOT NULL  -- 0 = melhor, 1 = segundo, etc.
    );

    -- Snapshot de volatilidade a cada N segundos (captura contínua)
    -- Base para análise de correlação volatilidade × resultado
    CREATE TABLE IF NOT EXISTS volatility_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      btc_price   REAL,
      vol_level   TEXT,
      vol_speed   REAL,
      vol_stddev  REAL,
      vol_amplitude REAL
    );

    -- Índices para queries de backtesting
    CREATE INDEX IF NOT EXISTS idx_rounds_mode ON rounds(mode);
    CREATE INDEX IF NOT EXISTS idx_rounds_created ON rounds(created_at);
    CREATE INDEX IF NOT EXISTS idx_rounds_condition ON rounds(condition_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_resolved ON rounds(resolved);
    CREATE INDEX IF NOT EXISTS idx_ob_round ON orderbook_snapshots(round_id);
    CREATE INDEX IF NOT EXISTS idx_vol_captured ON volatility_snapshots(captured_at);
  `);
}

// ============================================================
// Inserção de um round completo
// ============================================================
function insertRound(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO rounds (
      mode, strategy, condition_id, market_name, market_end_date,
      seconds_to_close, market_score, mid_up, mid_down, spread,
      side, token_id, outcome, price_submitted, shares_submitted,
      usdc_submitted, wait_ms, margin_used,
      order_id, order_status, shares_matched, taker_fill, cancelled_immediately,
      vol_level, vol_speed, vol_stddev, vol_amplitude, btc_price
    ) VALUES (
      @mode, @strategy, @condition_id, @market_name, @market_end_date,
      @seconds_to_close, @market_score, @mid_up, @mid_down, @spread,
      @side, @token_id, @outcome, @price_submitted, @shares_submitted,
      @usdc_submitted, @wait_ms, @margin_used,
      @order_id, @order_status, @shares_matched, @taker_fill, @cancelled_immediately,
      @vol_level, @vol_speed, @vol_stddev, @vol_amplitude, @btc_price
    )
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid;
}

// ============================================================
// Snapshot do orderbook (top N níveis de bid e ask)
// ============================================================
function insertOrderbookSnapshot(roundId, tokenId, book, levels = 5) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO orderbook_snapshots (round_id, token_id, side, price, size, level)
    VALUES (@round_id, @token_id, @side, @price, @size, @level)
  `);

  const insert = db.transaction((bids, asks) => {
    (bids || []).slice(0, levels).forEach((entry, i) => {
      stmt.run({
        round_id: roundId, token_id: tokenId,
        side: "bids", price: parseFloat(entry.price),
        size: parseFloat(entry.size), level: i,
      });
    });
    (asks || []).slice(0, levels).forEach((entry, i) => {
      stmt.run({
        round_id: roundId, token_id: tokenId,
        side: "asks", price: parseFloat(entry.price),
        size: parseFloat(entry.size), level: i,
      });
    });
  });

  insert(book.bids, book.asks);
}

// ============================================================
// Snapshot de volatilidade (gravação periódica)
// ============================================================
function insertVolatilitySnapshot(state) {
  const db = getDb();
  db.prepare(`
    INSERT INTO volatility_snapshots (btc_price, vol_level, vol_speed, vol_stddev, vol_amplitude)
    VALUES (@btc_price, @vol_level, @vol_speed, @vol_stddev, @vol_amplitude)
  `).run({
    btc_price: state.price,
    vol_level: state.level,
    vol_speed: state.speed,
    vol_stddev: state.stddev,
    vol_amplitude: state.amplitude,
  });
}

// ============================================================
// Atualiza resultado de um round após resolução do mercado
// ============================================================
function resolveRound(roundId, { won, payout }) {
  const db = getDb();
  const profit = won
    ? payout - (db.prepare("SELECT usdc_submitted FROM rounds WHERE id = ?").get(roundId)?.usdc_submitted ?? 0)
    : -(db.prepare("SELECT usdc_submitted FROM rounds WHERE id = ?").get(roundId)?.usdc_submitted ?? 0);

  db.prepare(`
    UPDATE rounds SET resolved = 1, won = @won, payout = @payout, profit = @profit
    WHERE id = @id
  `).run({ won: won ? 1 : 0, payout, profit, id: roundId });
}

// ============================================================
// Queries de métricas para o dashboard
// ============================================================
function getStats({ mode = null, strategy = null, limit = null } = {}) {
  const db = getDb();

  const where = [];
  if (mode) where.push(`mode = '${mode}'`);
  if (strategy) where.push(`strategy = '${strategy}'`);
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitClause = limit ? `LIMIT ${limit}` : "";

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_rounds,
      SUM(CASE WHEN mode IN ('order','dry') THEN 1 ELSE 0 END) as real_rounds,
      SUM(CASE WHEN mode = 'sim' THEN 1 ELSE 0 END) as sim_rounds,
      SUM(CASE WHEN order_status = 'MATCHED' THEN 1 ELSE 0 END) as filled,
      SUM(CASE WHEN order_status = 'CANCELED' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN order_status = 'ERROR' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN taker_fill = 1 THEN 1 ELSE 0 END) as taker_fills,
      SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN resolved = 1 AND won = 1 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN resolved = 1 AND won = 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN resolved = 1 AND mode != 'sim' THEN profit ELSE 0 END) as total_profit,
      SUM(CASE WHEN mode != 'sim' THEN usdc_submitted ELSE 0 END) as total_wagered,
      SUM(CASE WHEN resolved = 1 AND mode = 'sim' THEN profit ELSE 0 END) as sim_profit,
      AVG(CASE WHEN order_status = 'MATCHED' THEN shares_matched / shares_submitted ELSE NULL END) as avg_fill_rate
    FROM rounds ${whereClause}
  `).get();

  const recent = db.prepare(`
    SELECT id, created_at, mode, market_name, side, price_submitted,
           shares_matched, order_status, vol_level, mid_up, resolved, won, profit
    FROM rounds ${whereClause}
    ORDER BY created_at DESC
    ${limitClause || "LIMIT 20"}
  `).all();

  return { summary, recent };
}

function getRoundsForBacktest({ minMidUp = 0, maxMidUp = 1, volLevel = null } = {}) {
  const db = getDb();
  const where = [`mode != 'dry'`, `mid_up >= ${minMidUp}`, `mid_up <= ${maxMidUp}`];
  if (volLevel) where.push(`vol_level = '${volLevel}'`);

  return db.prepare(`
    SELECT r.*, 
      (SELECT json_group_array(json_object('side','bids','price',price,'size',size,'level',level))
       FROM orderbook_snapshots WHERE round_id = r.id AND side = 'bids') as bids_json,
      (SELECT json_group_array(json_object('side','asks','price',price,'size',size,'level',level))
       FROM orderbook_snapshots WHERE round_id = r.id AND side = 'asks') as asks_json
    FROM rounds r
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
  `).all();
}

module.exports = {
  getDb,
  insertRound,
  insertOrderbookSnapshot,
  insertVolatilitySnapshot,
  resolveRound,
  getStats,
  getRoundsForBacktest,
};
