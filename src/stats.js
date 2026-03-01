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

// ============================================================
// Análise de Adverse Selection
// Cruza win rate REAL com seconds_to_close e price_delta
// para identificar condições onde adverse selection é menor
// ============================================================
function printAdverseSelectionAnalysis() {
  const db = getDb();

  logger.divider();
  console.log(chalk.bold.yellow("  🦅 CARCARÁ — Análise de Adverse Selection (apostas REAIS)"));
  console.log(chalk.gray("  Simulado vs Real por condição — identifica onde o edge real existe"));
  logger.divider();

  const realTotal = db.prepare(`
    SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
    FROM rounds WHERE mode='order' AND order_status='MATCHED' AND resolved=1
  `).get();

  if (!realTotal || realTotal.n < 5) {
    console.log(chalk.gray("  Dados insuficientes — precisamos de ≥5 apostas reais preenchidas e resolvidas."));
    logger.divider();
    return;
  }

  console.log(
    chalk.gray(`  Base: ${realTotal.n} apostas reais preenchidas | `) +
    chalk.cyan(`win rate geral: ${(realTotal.wr * 100).toFixed(1)}%`) +
    chalk.gray(` | Simulado geral: ~52.7%`) +
    chalk.red(` | Gap (adverse selection): ~${(52.7 - realTotal.wr * 100).toFixed(1)}pp`)
  );

  // ── 1. Por tempo até fechar ─────────────────────────────
  console.log(chalk.bold("\n  1. Win Rate Real por Tempo até Fechar"));
  console.log(chalk.gray("  Hipótese: próximo do fechamento há menos tempo para o mercado se mover contra."));
  console.log(chalk.gray("  " + "─".repeat(72)));
  console.log(chalk.gray("  Faixa tempo    Real_n  Real_WR   Sim_n  Sim_WR    Gap      Veredicto"));
  console.log(chalk.gray("  " + "─".repeat(72)));

  const timeBuckets = [
    { label: "< 1 min",    min: 0,    max: 60   },
    { label: "1–2 min",    min: 60,   max: 120  },
    { label: "2–3 min",    min: 120,  max: 180  },
    { label: "3–5 min",    min: 180,  max: 300  },
    { label: "5–10 min",   min: 300,  max: 600  },
    { label: "> 10 min",   min: 600,  max: 99999},
  ];

  for (const b of timeBuckets) {
    const real = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds
      WHERE mode='order' AND order_status='MATCHED' AND resolved=1
        AND seconds_to_close >= ? AND seconds_to_close < ?
    `).get(b.min, b.max);

    const sim = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds
      WHERE mode='sim' AND resolved=1
        AND seconds_to_close >= ? AND seconds_to_close < ?
    `).get(b.min, b.max);

    if (!real.n && !sim.n) continue;

    const realWr  = real.n  ? real.wr  * 100 : null;
    const simWr   = sim.n   ? sim.wr   * 100 : null;
    const gap     = (realWr !== null && simWr !== null) ? realWr - simWr : null;

    const realStr = real.n ? `${real.n.toString().padEnd(6)} ${chalk.cyan((realWr).toFixed(1) + "%")}` : chalk.gray("  —  ".padEnd(14));
    const simStr  = sim.n  ? `${sim.n.toString().padEnd(5)} ${(simWr).toFixed(1) + "%"}` : chalk.gray(" —  ".padEnd(10));
    const gapStr  = gap !== null
      ? (gap >= 0 ? chalk.green(`+${gap.toFixed(1)}pp`) : chalk.red(`${gap.toFixed(1)}pp`))
      : chalk.gray("  —  ");

    // Veredicto: gap ≥ 0 significa adverse selection baixa ou inexistente
    const verdict = gap === null ? "" :
      gap >= 5  ? chalk.green("✅ melhor") :
      gap >= -3 ? chalk.yellow("〰 neutro") :
                  chalk.red("❌ pior");

    console.log(`  ${b.label.padEnd(14)} ${realStr.padEnd(18)} ${simStr.padEnd(13)} ${gapStr.padEnd(12)} ${verdict}`);
  }

  // ── 2. Por desconto em relação ao midpoint ──────────────
  console.log(chalk.bold("\n  2. Win Rate Real por Desconto de Preço (price_delta = midUp - price_submitted)"));
  console.log(chalk.gray("  Hipótese: desconto maior filtra vendedores oportunistas → menos adverse selection."));
  console.log(chalk.gray("  " + "─".repeat(72)));
  console.log(chalk.gray("  Desconto       Real_n  Real_WR   Sim_n  Sim_WR    Gap      Veredicto"));
  console.log(chalk.gray("  " + "─".repeat(72)));

  const priceBuckets = [
    { label: "0.00–0.01",  min: 0.00,  max: 0.01  },
    { label: "0.01–0.02",  min: 0.01,  max: 0.02  },
    { label: "0.02–0.03",  min: 0.02,  max: 0.03  },
    { label: "0.03–0.05",  min: 0.03,  max: 0.05  },
    { label: "0.05–0.08",  min: 0.05,  max: 0.08  },
    { label: "> 0.08",     min: 0.08,  max: 1.0   },
  ];

  for (const b of priceBuckets) {
    const real = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds
      WHERE mode='order' AND order_status='MATCHED' AND resolved=1
        AND (mid_up - price_submitted) >= ? AND (mid_up - price_submitted) < ?
    `).get(b.min, b.max);

    const sim = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds
      WHERE mode='sim' AND resolved=1
        AND (mid_up - price_submitted) >= ? AND (mid_up - price_submitted) < ?
    `).get(b.min, b.max);

    if (!real.n && !sim.n) continue;

    const realWr = real.n ? real.wr * 100 : null;
    const simWr  = sim.n  ? sim.wr  * 100 : null;
    const gap    = (realWr !== null && simWr !== null) ? realWr - simWr : null;

    const realStr = real.n ? `${real.n.toString().padEnd(6)} ${chalk.cyan((realWr).toFixed(1) + "%")}` : chalk.gray("  —  ".padEnd(14));
    const simStr  = sim.n  ? `${sim.n.toString().padEnd(5)} ${(simWr).toFixed(1) + "%"}` : chalk.gray(" —  ".padEnd(10));
    const gapStr  = gap !== null
      ? (gap >= 0 ? chalk.green(`+${gap.toFixed(1)}pp`) : chalk.red(`${gap.toFixed(1)}pp`))
      : chalk.gray("  —  ");

    const verdict = gap === null ? "" :
      gap >= 5  ? chalk.green("✅ melhor") :
      gap >= -3 ? chalk.yellow("〰 neutro") :
                  chalk.red("❌ pior");

    console.log(`  ${b.label.padEnd(14)} ${realStr.padEnd(18)} ${simStr.padEnd(13)} ${gapStr.padEnd(12)} ${verdict}`);
  }

  // ── 3. Por volatilidade ─────────────────────────────────
  console.log(chalk.bold("\n  3. Win Rate Real por Nível de Volatilidade"));
  console.log(chalk.gray("  " + "─".repeat(72)));
  console.log(chalk.gray("  Vol level      Real_n  Real_WR   Sim_n  Sim_WR    Gap      Veredicto"));
  console.log(chalk.gray("  " + "─".repeat(72)));

  const volLevels = ["CALM", "ALERT", "STORM"];
  for (const lvl of volLevels) {
    const real = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds
      WHERE mode='order' AND order_status='MATCHED' AND resolved=1 AND vol_level=?
    `).get(lvl);

    const sim = db.prepare(`
      SELECT COUNT(*) as n, AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
      FROM rounds WHERE mode='sim' AND resolved=1 AND vol_level=?
    `).get(lvl);

    if (!real.n && !sim.n) continue;

    const realWr = real.n ? real.wr * 100 : null;
    const simWr  = sim.n  ? sim.wr  * 100 : null;
    const gap    = (realWr !== null && simWr !== null) ? realWr - simWr : null;

    const realStr = real.n ? `${real.n.toString().padEnd(6)} ${chalk.cyan((realWr).toFixed(1) + "%")}` : chalk.gray("  —  ".padEnd(14));
    const simStr  = sim.n  ? `${sim.n.toString().padEnd(5)} ${(simWr).toFixed(1) + "%"}` : chalk.gray(" —  ".padEnd(10));
    const gapStr  = gap !== null
      ? (gap >= 0 ? chalk.green(`+${gap.toFixed(1)}pp`) : chalk.red(`${gap.toFixed(1)}pp`))
      : chalk.gray("  —  ");
    const verdict = gap === null ? "" :
      gap >= 5  ? chalk.green("✅ melhor") :
      gap >= -3 ? chalk.yellow("〰 neutro") :
                  chalk.red("❌ pior");

    console.log(`  ${lvl.padEnd(14)} ${realStr.padEnd(18)} ${simStr.padEnd(13)} ${gapStr.padEnd(12)} ${verdict}`);
  }

  // ── 4. Resumo: qual condição minimiza adverse selection ─
  console.log(chalk.bold("\n  4. Recomendação para próxima calibração"));
  console.log(chalk.gray("  " + "─".repeat(72)));

  const bestTime = db.prepare(`
    SELECT
      CASE
        WHEN seconds_to_close < 60   THEN '< 1 min'
        WHEN seconds_to_close < 120  THEN '1-2 min'
        WHEN seconds_to_close < 180  THEN '2-3 min'
        WHEN seconds_to_close < 300  THEN '3-5 min'
        WHEN seconds_to_close < 600  THEN '5-10 min'
        ELSE '> 10 min'
      END as bucket,
      COUNT(*) as n,
      AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
    FROM rounds
    WHERE mode='order' AND order_status='MATCHED' AND resolved=1
    GROUP BY bucket HAVING n >= 3
    ORDER BY wr DESC LIMIT 1
  `).get();

  const bestDelta = db.prepare(`
    SELECT
      ROUND((mid_up - price_submitted) * 20) / 20 as delta_bucket,
      COUNT(*) as n,
      AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END) as wr
    FROM rounds
    WHERE mode='order' AND order_status='MATCHED' AND resolved=1
    GROUP BY delta_bucket HAVING n >= 3
    ORDER BY wr DESC LIMIT 1
  `).get();

  if (bestTime) {
    console.log(
      `  Melhor janela temporal : ${chalk.green(bestTime.bucket)} ` +
      `(${bestTime.n} apostas, win rate ${chalk.green((bestTime.wr * 100).toFixed(1) + "%")})`
    );
  }
  if (bestDelta) {
    console.log(
      `  Melhor desconto        : ${chalk.green("~" + (bestDelta.delta_bucket * 100).toFixed(0) + "¢")} abaixo do mid ` +
      `(${bestDelta.n} apostas, win rate ${chalk.green((bestDelta.wr * 100).toFixed(1) + "%")})`
    );

    const currentMargin = 0.005;
    if (bestDelta.delta_bucket > currentMargin + 0.01) {
      console.log(
        chalk.yellow(`
  ⚠️  ORDER_MARGIN atual (${(currentMargin*100).toFixed(1)}¢) está abaixo do ótimo observado.`) +
        chalk.yellow(`
     Considere aumentar para ${(bestDelta.delta_bucket * 100).toFixed(0)}¢ no .env → ORDER_MARGIN=${bestDelta.delta_bucket.toFixed(3)}`)
      );
    }
  }

  logger.divider();
}

module.exports = { printDashboard, printBacktestSummary, printStrategyBreakdown, printAdverseSelectionAnalysis };
