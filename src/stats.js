// src/stats.js — CARCARÁ
// ============================================================
// FASE 4 — Dashboard de métricas no terminal
// ============================================================

const chalk = require("chalk");
const { getStats, getDb } = require("./db");
const logger = require("./logger");

// ============================================================
// Formata número com sinal explícito (+/-)
// ============================================================
function signed(n, decimals = 2) {
  if (n == null) return chalk.gray("—");
  const formatted = Math.abs(n).toFixed(decimals);
  return n >= 0 ? chalk.green(`+${formatted}`) : chalk.red(`-${formatted}`);
}

function pct(num, den) {
  if (!den || den === 0) return chalk.gray("—");
  return `${((num / den) * 100).toFixed(1)}%`;
}

// ============================================================
// Imprime o dashboard completo no terminal
// ============================================================
function printDashboard({ mode = null, strategy = null } = {}) {
  const { summary, recent } = getStats({ mode, strategy });
  const s = summary;

  logger.divider();
  console.log(chalk.bold.yellow("  🦅 CARCARÁ — Dashboard de Métricas"));
  if (mode) console.log(chalk.gray(`  Filtro: modo=${mode}${strategy ? ` estratégia=${strategy}` : ""}`));
  logger.divider();

  // ── Resumo geral ────────────────────────────────────────
  console.log(chalk.bold("\n  APOSTAS REAIS"));
  console.log(`  Total de rounds  : ${chalk.cyan(s.real_rounds ?? s.total_rounds)}`);
  console.log(`  Preenchidas      : ${chalk.green(s.filled)}  (${pct(s.filled, s.real_rounds ?? s.total_rounds)})`);
  console.log(`  Canceladas       : ${chalk.gray(s.cancelled)}  (${pct(s.cancelled, s.real_rounds ?? s.total_rounds)})`);
  console.log(`  Taker fills      : ${s.taker_fills > 0 ? chalk.red(s.taker_fills) : chalk.green("0")}  ← deve ser sempre 0`);
  console.log(`  Erros            : ${s.errors > 0 ? chalk.red(s.errors) : chalk.green("0")}`);
  if (s.sim_rounds > 0) {
    console.log(`  Simulações (SIM) : ${chalk.blue(s.sim_rounds)}  ${chalk.gray("(dry bets — não contam no lucro real)")}`);
  }

  // ── Resultados ───────────────────────────────────────────
  console.log(chalk.bold("\n  RESULTADOS  (apostas resolvidas)"));
  if (s.resolved === 0) {
    console.log(chalk.gray("  Nenhuma aposta resolvida ainda."));
    console.log(chalk.gray("  Execute: npm run resolve -- --id=<round_id> --won=true --payout=<valor>"));
  } else {
    const winRate = s.wins / s.resolved;
    const winColor = winRate >= 0.55 ? chalk.green : winRate >= 0.45 ? chalk.yellow : chalk.red;
    console.log(`  Resolvidas       : ${chalk.cyan(s.resolved)}`);
    console.log(`  Vitórias         : ${chalk.green(s.wins)}  (${winColor(pct(s.wins, s.resolved))})`);
    console.log(`  Derrotas         : ${chalk.red(s.losses)}`);
    console.log(`  Total apostado   : ${chalk.cyan((s.total_wagered || 0).toFixed(2))} USDC`);
    console.log(`  Lucro total      : ${signed(s.total_profit)}  USDC`);
    const roi = s.total_wagered ? (s.total_profit / s.total_wagered) * 100 : 0;
    console.log(`  ROI              : ${signed(roi, 1)}%`);
    if ((s.sim_rounds ?? 0) > 0 && s.sim_profit != null) {
      console.log(`  ${chalk.blue("Lucro simulado   :")} ${signed(s.sim_profit)}  USDC  ${chalk.gray("(se SIMs fossem reais)")}`);
    }
    if (s.sim_rounds > 0 && s.sim_profit != null) {
      console.log(`  ${chalk.blue("Lucro simulado   :")} ${signed(s.sim_profit)}  USDC  ${chalk.gray("(se fossem apostas reais)")}`);
    }
  }

  // ── Últimas apostas ──────────────────────────────────────
  console.log(chalk.bold("\n  ÚLTIMAS 10 APOSTAS"));
  console.log(chalk.gray("  " + "─".repeat(90)));

  const header = [
    "ID".padEnd(4),
    "Data".padEnd(20),
    "Mercado".padEnd(35),
    "Preço".padEnd(6),
    "Fill".padEnd(8),
    "Vol".padEnd(8),
    "Resultado",
  ].join("  ");
  console.log(chalk.gray("  " + header));
  console.log(chalk.gray("  " + "─".repeat(90)));

  (recent || []).slice(0, 10).forEach((r) => {
    const date = r.created_at?.slice(0, 19).replace("T", " ") ?? "—";
    const name = (r.market_name || "").slice(0, 33).padEnd(35);
    const price = (r.price_submitted?.toFixed(2) ?? "—").padEnd(6);

    let fillStr;
    if (r.order_status === "MATCHED") fillStr = chalk.green("PREENCH".padEnd(8));
    else if (r.order_status === "CANCELED") fillStr = chalk.gray("CANCEL".padEnd(8));
    else if (r.order_status === "DRY") fillStr = chalk.blue("DRY".padEnd(8));
    else fillStr = chalk.red((r.order_status || "?").padEnd(8));

    const volColors = { CALM: chalk.green, ALERT: chalk.yellow, STORM: chalk.red };
    const volStr = (volColors[r.vol_level] || chalk.gray)((r.vol_level || "?").padEnd(8));

    let resultStr;
    if (!r.resolved) resultStr = chalk.gray("pendente");
    else if (r.won) resultStr = chalk.green(`✅ +${(r.profit || 0).toFixed(2)} USDC`);
    else resultStr = chalk.red(`❌ ${(r.profit || 0).toFixed(2)} USDC`);

    console.log(`  ${String(r.id).padEnd(4)}  ${date}  ${name}  ${price}  ${fillStr}  ${volStr}  ${resultStr}`);
  });

  console.log(chalk.gray("  " + "─".repeat(90)));
  logger.divider();
}

// ============================================================
// Imprime stats de backtesting por faixa de midpoint
// ============================================================
function printBacktestSummary() {
  const db = getDb();

  logger.divider();
  console.log(chalk.bold.yellow("  🦅 CARCARÁ — Análise por Faixa de Midpoint"));
  logger.divider();

  const ranges = [
    { label: "45–47%", min: 0.45, max: 0.47 },
    { label: "47–49%", min: 0.47, max: 0.49 },
    { label: "49–51%", min: 0.49, max: 0.51 },
    { label: "51–53%", min: 0.51, max: 0.53 },
    { label: "53–55%", min: 0.53, max: 0.55 },
  ];

  console.log(chalk.gray("  Faixa     Rounds  Preench  TaxaFill  Wins  WinRate  Lucro"));
  console.log(chalk.gray("  " + "─".repeat(65)));

  ranges.forEach(({ label, min, max }) => {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN order_status='MATCHED' THEN 1 ELSE 0 END) as filled,
        SUM(CASE WHEN resolved=1 AND won=1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN resolved=1 THEN profit ELSE 0 END) as profit
      FROM rounds
      WHERE mid_up >= ? AND mid_up < ? AND mode != 'dry'
    `).get(min, max);

    const fillRate = row.total ? pct(row.filled, row.total) : "—";
    const winRate = row.resolved ? pct(row.wins, row.resolved) : "—";
    const profit = row.profit != null ? signed(row.profit) : chalk.gray("—");

    console.log(
      `  ${label.padEnd(9)} ${String(row.total).padEnd(7)} ${String(row.filled).padEnd(8)} ` +
      `${fillRate.padEnd(9)} ${String(row.wins).padEnd(5)} ${winRate.padEnd(8)} ${profit}`
    );
  });

  console.log(chalk.gray("  " + "─".repeat(65)));
  logger.divider();
}

// ============================================================
// Breakdown por estratégia
// ============================================================
function printStrategyBreakdown() {
  const db = getDb();

  const strategies = db.prepare(`
    SELECT DISTINCT COALESCE(strategy, 'up-only') as strategy FROM rounds
    WHERE mode IN ('order', 'sim') ORDER BY strategy
  `).all().map(r => r.strategy);

  if (strategies.length === 0) {
    logger.info("Nenhuma aposta registrada ainda.");
    return;
  }

  // ── Apostas reais ─────────────────────────────────────────
  logger.divider();
  console.log(chalk.bold.yellow("  🦅 CARCARÁ — Comparação de Estratégias (REAIS)"));
  logger.divider();
  console.log(chalk.gray("  Estratégia    Rounds  Preench  WinRate  Lucro     ROI"));
  console.log(chalk.gray("  " + "─".repeat(58)));

  for (const strat of strategies) {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN order_status='MATCHED' THEN 1 ELSE 0 END) as filled,
        SUM(CASE WHEN resolved=1 AND won=1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN resolved=1 THEN profit ELSE 0 END) as profit,
        SUM(usdc_submitted) as wagered
      FROM rounds
      WHERE mode = 'order' AND COALESCE(strategy, 'up-only') = ?
    `).get(strat);

    if (!row.total) continue;
    const winRate = row.resolved ? pct(row.wins, row.resolved) : chalk.gray("—");
    const profit = row.profit != null ? signed(row.profit) : chalk.gray("—");
    const roi = row.wagered && row.profit != null
      ? signed((row.profit / row.wagered) * 100, 1) + "%"
      : chalk.gray("—");

    console.log(
      `  ${strat.padEnd(14)} ${String(row.total).padEnd(7)} ${String(row.filled).padEnd(8)} ` +
      `${String(winRate).padEnd(8)} ${String(profit).padEnd(9)} ${roi}`
    );
  }
  console.log(chalk.gray("  " + "─".repeat(58)));

  // ── Simulações ────────────────────────────────────────────
  console.log(chalk.bold.yellow("\n  🦅 CARCARÁ — Comparação de Estratégias (SIMULADO)"));
  console.log(chalk.gray("  " + "─".repeat(70)));
  console.log(chalk.gray("  Estratégia    Rounds  Resolvidos  WinRate   Lucro sim   ROI sim   Pulados"));
  console.log(chalk.gray("  " + "─".repeat(70)));

  for (const strat of strategies) {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN resolved=1 AND won=1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN resolved=1 THEN profit ELSE 0 END) as profit,
        SUM(usdc_submitted) as wagered
      FROM rounds
      WHERE mode = 'sim' AND strategy = ?
    `).get(strat);

    if (!row.total) continue;

    // Rounds pulados pela estratégia (zona neutra) — capturados como 'capture' com strategy tag
    // Por ora estimamos: total registrado vs total de janelas disponíveis não é rastreável,
    // mas podemos mostrar rounds com order_status='DRY' sem resolved ainda
    const skipped = db.prepare(`
      SELECT COUNT(*) as n FROM rounds
      WHERE mode = 'sim' AND strategy = ? AND resolved = 0
        AND datetime(market_end_date) < datetime('now')
    `).get(strat).n;

    const winRate = row.resolved ? pct(row.wins, row.resolved) : chalk.gray("—");
    const profit = row.profit != null ? signed(row.profit) : chalk.gray("—");
    const roi = row.wagered && row.profit != null
      ? signed((row.profit / row.wagered) * 100, 1) + "%"
      : chalk.gray("—");

    console.log(
      `  ${strat.padEnd(14)} ${String(row.total).padEnd(7)} ${String(row.resolved).padEnd(11)} ` +
      `${String(winRate).padEnd(9)} ${String(profit).padEnd(11)} ${String(roi).padEnd(9)} ${skipped > 0 ? chalk.gray(skipped + " pend.") : ""}`
    );
  }
  console.log(chalk.gray("  " + "─".repeat(70)));

  // ── P&L ajustado pelo fill model ─────────────────────────
  console.log(chalk.bold.yellow("\n  🦅 CARCARÁ — P&L Simulado Ajustado (fill probability)"));
  console.log(chalk.gray("  Corrige o P&L simulado pela probabilidade real de fill (~20-25%)"));
  console.log(chalk.gray("  Esta é a estimativa mais fiel ao que aconteceria em apostas reais."));
  console.log(chalk.gray("  " + "─".repeat(75)));
  console.log(chalk.gray("  Estratégia    SimTotal  FillProb  AdjRounds  WinRate   AdjLucro   AdjROI"));
  console.log(chalk.gray("  " + "─".repeat(75)));

  try {
    const { computeAdjustedSimStats } = require("./fill_model");
    for (const strat of strategies) {
      const adj = computeAdjustedSimStats(db, strat);
      if (!adj) continue;
      const wr   = chalk.cyan(`${adj.adjWinRate.toFixed(1)}%`.padEnd(9));
      const prof = signed(adj.adjProfit);
      const roi  = signed(adj.adjRoi, 1) + "%";
      console.log(
        `  ${strat.padEnd(14)} ${String(adj.totalSim).padEnd(9)} ` +
        `${(adj.fillProb * 100).toFixed(0)}%`.padEnd(9) +
        `${String(adj.adjRounds).padEnd(10)} ${wr} ${String(prof).padEnd(10)} ${roi}`
      );
    }
  } catch (e) {
    console.log(chalk.gray(`  Dados insuficientes para ajuste: ${e.message}`));
  }

  console.log(chalk.gray("  " + "─".repeat(75)));
  logger.divider();
}

module.exports = { printDashboard, printBacktestSummary, printStrategyBreakdown };
