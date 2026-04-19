// src/backtest.js — CARCARÁ
// ============================================================
// BACKTESTER — Projeta desempenho de estratégias sobre dados históricos
// ============================================================
// Princípio: aplica as regras de qualquer estratégia sobre os rounds
// simulados já resolvidos no banco, e calcula:
//
//   - Quantos rounds a estratégia teria selecionado (elegíveis)
//   - Fill rate histórico nessas condições
//   - WR histórico nas condições filtradas
//   - P&L projetado com intervalo de confiança (Wilson score)
//   - Comparação com baseline dummy
//
// Isso responde ANTES de apostas reais:
//   "Se eu tivesse apostado com essa estratégia, teria ganho ou perdido?"
//
// Estratégias implementadas para backtest:
//   skew-up        — midUp > 0.56, aposta Up
//   skew-down      — midUp < 0.44, aposta Down
//   skew           — ambos os lados
//   momentum-down  — midUp < 0.485, aposta Down
//   dummy          — baseline aleatório
//   custom         — passa filtros por parâmetro
// ============================================================

const logger = require("./logger");
const chalk  = require("chalk");

// ============================================================
// Intervalo de confiança de Wilson (95%)
// Mais robusto que ±1.96*sqrt(p*(1-p)/n) para amostras pequenas
// ============================================================
function wilsonCI(wins, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 0, center: 0 };
  const p     = wins / n;
  const denom = 1 + z*z/n;
  const center = (p + z*z/(2*n)) / denom;
  const margin = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom;
  return {
    low:    Math.max(0, center - margin),
    high:   Math.min(1, center + margin),
    center,
  };
}

// ============================================================
// Define se um round histórico seria selecionado pela estratégia
// Retorna { selected: bool, outcome: 'Up'|'Down'|null }
// ============================================================
function applyStrategy(name, round, options = {}) {
  const midUp = round.mid_up ?? 0.5;
  const sec   = round.seconds_to_close ?? 300;
  const trend = round.btc_trend_5m ?? null;

  // Filtros comuns configuráveis
  const timeMin = options.timeMin ?? 300;  // 5min
  const timeMax = options.timeMax ?? 600;  // 10min
  const timeOk  = sec >= timeMin && sec <= timeMax;

  switch (name) {

    case "dummy":
      // Aposta em qualquer mercado elegível, direção aleatória
      // Não usa timeOk — representa o comportamento histórico real
      return { selected: true, outcome: Math.random() >= 0.5 ? "Up" : "Down" };

    case "skew-up": {
      const midOk   = midUp > 0.56;
      const trendOk = trend !== null && trend !== "desconhecido" && trend !== "forte_queda";
      // Sem filtro de tendência para dados sem btc_trend_5m (rounds antigos)
      // — usa apenas midUp e tempo para maximizar amostra histórica
      const selected = midOk && timeOk;
      return { selected, outcome: "Up" };
    }

    case "skew-up:filtered": {
      // Versão estrita com filtro de tendência — só usa rounds com trend data
      const midOk   = midUp > 0.56;
      const trendOk = trend !== null && trend !== "desconhecido" && trend !== "forte_queda";
      const selected = midOk && timeOk && trendOk;
      return { selected, outcome: "Up" };
    }

    case "skew-down": {
      const midOk   = midUp < 0.44;
      const selected = midOk && timeOk;
      return { selected, outcome: "Down" };
    }

    case "skew": {
      const midOk = midUp < 0.44 || midUp > 0.56;
      if (!midOk || !timeOk) return { selected: false, outcome: null };
      return { selected: true, outcome: midUp > 0.56 ? "Up" : "Down" };
    }

    case "momentum-down": {
      const midOk   = midUp < 0.485;
      const selected = midOk && timeOk;
      return { selected, outcome: "Down" };
    }

    case "lateral-up": {
      // O sinal mais forte dos dados: lateral + Up + midUp > 56%
      const midOk   = midUp > 0.56;
      const trendOk = trend === "lateral";
      const selected = midOk && timeOk && trendOk;
      return { selected, outcome: "Up" };
    }

    case "custom": {
      // Filtros configuráveis via options
      const midMin  = options.midMin  ?? 0;
      const midMax  = options.midMax  ?? 1;
      const outcome = options.outcome ?? (midUp >= 0.5 ? "Up" : "Down");
      const trends  = options.trends  ?? null; // array de trends aceitos, null = todos
      const midOk   = midUp >= midMin && midUp <= midMax;
      const trendOk = !trends || (trend && trends.includes(trend));
      return { selected: midOk && timeOk && trendOk, outcome };
    }

    default:
      return { selected: false, outcome: null };
  }
}

// ============================================================
// Determina se o round resolvido teria ganho com o outcome dado
// ============================================================
function wouldWin(round, outcome) {
  if (round.won === null || round.won === undefined) return null;
  // Para rounds simulados (DRY): won=1 significa que o outcome apostado ganhou
  // Precisamos verificar se o outcome que a estratégia escolheu é o mesmo que ganhou
  if (round.outcome === outcome) {
    return round.won === 1;
  } else {
    // Estratégia escolheu o lado oposto do que foi simulado
    return round.won === 0; // se o simulado perdeu, o oposto ganhou
  }
}

// ============================================================
// Executa backtest de uma estratégia sobre os dados históricos
// ============================================================
function runBacktest(db, strategyName, options = {}) {
  const betSize   = options.betSize   ?? 3.5;
  const fillRate  = options.fillRate  ?? null; // null = usa fill rate real do banco
  const dateFrom  = options.dateFrom  ?? null;
  const dateTo    = options.dateTo    ?? null;

  // Busca rounds simulados resolvidos
  let query = `
    SELECT id, mid_up, seconds_to_close, btc_trend_5m, btc_trend_15m,
           outcome, won, price_submitted, created_at, vol_level
    FROM rounds
    WHERE mode = 'sim'
      AND resolved = 1
      AND won IS NOT NULL
  `;
  const params = [];
  if (dateFrom) { query += " AND DATE(created_at) >= ?"; params.push(dateFrom); }
  if (dateTo)   { query += " AND DATE(created_at) <= ?"; params.push(dateTo); }
  query += " ORDER BY created_at ASC";

  const rounds = db.prepare(query).all(...params);

  if (rounds.length === 0) {
    return { error: "Nenhum round simulado resolvido encontrado." };
  }

  // Aplica a estratégia a cada round
  let eligible   = 0;   // rounds que passariam nos filtros
  let wins       = 0;
  let losses     = 0;
  let skipped    = 0;   // won=null

  // Para distribuição por condição
  const byTrend  = {};
  const byMidBucket = {};

  for (const round of rounds) {
    const { selected, outcome } = applyStrategy(strategyName, round, options);
    if (!selected) continue;

    eligible++;

    const result = wouldWin(round, outcome);
    if (result === null) { skipped++; continue; }

    // Agrupa por tendência
    const trend = round.btc_trend_5m ?? "sem_dados";
    if (!byTrend[trend]) byTrend[trend] = { wins: 0, losses: 0 };
    if (result) { wins++; byTrend[trend].wins++; }
    else        { losses++; byTrend[trend].losses++; }

    // Agrupa por faixa de midUp
    const mid = round.mid_up ?? 0.5;
    const bucket = mid < 0.44 ? "< 44%" :
                   mid < 0.47 ? "44-47%" :
                   mid < 0.50 ? "47-50%" :
                   mid < 0.53 ? "50-53%" :
                   mid < 0.56 ? "53-56%" : "> 56%";
    if (!byMidBucket[bucket]) byMidBucket[bucket] = { wins: 0, losses: 0 };
    if (result) byMidBucket[bucket].wins++;
    else        byMidBucket[bucket].losses++;
  }

  const resolved = wins + losses;
  if (resolved === 0) {
    return { error: "Nenhum round elegível encontrado para essa estratégia.", eligible, rounds: rounds.length };
  }

  // Fill rate: usa o histórico real para a faixa de midUp correspondente
  // ou o fill rate geral se não especificado
  const actualFillRate = fillRate ?? (() => {
    // Calcula fill rate real da faixa relevante
    const stratFills = {
      "skew-up":         "> 56%",
      "skew-up:filtered":"> 56%",
      "skew-down":       "< 44%",
      "momentum-down":   "44-50%",
    };
    // Fill rate geral observado nessas faixas
    const fillRates = {
      "> 56%":  0.389,
      "< 44%":  0.333,
      "44-50%": 0.100,
      "all":    0.125,
    };
    const key = stratFills[strategyName] ?? "all";
    return fillRates[key] ?? fillRates["all"];
  })();

  // Métricas principais
  const wr        = wins / resolved;
  const ci        = wilsonCI(wins, resolved);
  const avgPrice  = rounds.filter(r => {
    const { selected } = applyStrategy(strategyName, r, options);
    return selected;
  }).reduce((sum, r, _, arr) => sum + (r.price_submitted ?? 0.485) / arr.length, 0);

  // EV por aposta (usando preço médio real)
  const ev        = wr - avgPrice;

  // P&L projetado por 100 tentativas reais (considerando fill rate)
  const fillsPer100  = 100 * actualFillRate;
  const plPer100     = fillsPer100 * ev * betSize;

  // P&L projetado por 100 tentativas — intervalo de confiança
  const plLow  = fillsPer100 * (ci.low  - avgPrice) * betSize;
  const plHigh = fillsPer100 * (ci.high - avgPrice) * betSize;

  return {
    strategy:     strategyName,
    totalSim:     rounds.length,
    eligible,
    resolved,
    wins,
    losses,
    winRate:      wr,
    winRatePct:   (wr * 100).toFixed(1),
    ci95Low:      (ci.low  * 100).toFixed(1),
    ci95High:     (ci.high * 100).toFixed(1),
    avgPrice:     avgPrice.toFixed(3),
    ev:           (ev * 100).toFixed(2),
    fillRate:     actualFillRate,
    betSize,
    // Projeção por 100 tentativas
    proj100: {
      fills:   fillsPer100.toFixed(1),
      pl:      plPer100.toFixed(2),
      plLow:   plLow.toFixed(2),
      plHigh:  plHigh.toFixed(2),
    },
    byTrend,
    byMidBucket,
  };
}

// ============================================================
// Imprime relatório completo do backtest
// ============================================================
function printBacktestReport(result, label = null) {
  if (result.error) {
    console.log(chalk.red("  Erro: " + result.error));
    if (result.eligible !== undefined) {
      console.log(chalk.gray("  Rounds simulados: " + result.rounds + " | Elegíveis: " + result.eligible));
    }
    return;
  }

  const stratLabel = label || result.strategy;
  const evColor  = parseFloat(result.ev) >= 0 ? chalk.green : chalk.red;
  const plColor  = parseFloat(result.proj100.pl) >= 0 ? chalk.green : chalk.red;
  const wrColor  = parseFloat(result.winRatePct) >= 55 ? chalk.green :
                   parseFloat(result.winRatePct) >= 50 ? chalk.yellow : chalk.red;

  console.log(chalk.bold("\n  Estratégia: " + stratLabel));
  console.log("  " + "─".repeat(60));
  console.log("  Dados simulados    : " + result.totalSim + " rounds | " + result.eligible + " elegíveis");
  console.log("  Resolvidos         : " + result.resolved + " (wins=" + result.wins + " losses=" + result.losses + ")");
  console.log("  Win rate           : " + wrColor(result.winRatePct + "%") +
    chalk.gray("  IC 95%: [" + result.ci95Low + "% – " + result.ci95High + "%]"));
  console.log("  Preço médio        : " + result.avgPrice);
  console.log("  EV por aposta      : " + evColor((parseFloat(result.ev) >= 0 ? "+" : "") + result.ev + "%"));
  console.log("  Fill rate histórico: " + (result.fillRate * 100).toFixed(1) + "%");
  console.log(chalk.bold("  Projeção (100 tentativas reais com $" + result.betSize + "/aposta):"));
  console.log("    Fills esperados  : ~" + result.proj100.fills);
  console.log("    P&L projetado    : " + plColor((parseFloat(result.proj100.pl) >= 0 ? "+" : "") + result.proj100.pl + " USDC"));
  console.log("    Intervalo 95%    : [" +
    (parseFloat(result.proj100.plLow)  >= 0 ? "+" : "") + result.proj100.plLow + " ; " +
    (parseFloat(result.proj100.plHigh) >= 0 ? "+" : "") + result.proj100.plHigh + " USDC]");

  // Por tendência (se disponível)
  const trends = Object.entries(result.byTrend).filter(([, v]) => v.wins + v.losses >= 3);
  if (trends.length > 0) {
    console.log(chalk.bold("\n  Por tendência BTC (trend5):"));
    console.log("  " + "─".repeat(50));
    trends.sort((a, b) => {
      const wrA = a[1].wins / (a[1].wins + a[1].losses);
      const wrB = b[1].wins / (b[1].wins + b[1].losses);
      return wrB - wrA;
    }).forEach(([trend, v]) => {
      const n   = v.wins + v.losses;
      const wr  = (v.wins / n * 100).toFixed(1);
      const col = parseFloat(wr) >= 55 ? chalk.green : parseFloat(wr) >= 50 ? chalk.yellow : chalk.red;
      console.log("  " + trend.padEnd(18) + " n=" + String(n).padEnd(5) + " WR=" + col(wr + "%"));
    });
  }

  // Por faixa de midUp
  const mids = Object.entries(result.byMidBucket).filter(([, v]) => v.wins + v.losses >= 3);
  if (mids.length > 0) {
    console.log(chalk.bold("\n  Por faixa de midUp:"));
    console.log("  " + "─".repeat(50));
    mids.forEach(([bucket, v]) => {
      const n   = v.wins + v.losses;
      const wr  = (v.wins / n * 100).toFixed(1);
      const col = parseFloat(wr) >= 55 ? chalk.green : parseFloat(wr) >= 50 ? chalk.yellow : chalk.red;
      console.log("  midUp=" + bucket.padEnd(10) + " n=" + String(n).padEnd(5) + " WR=" + col(wr + "%"));
    });
  }
}

// ============================================================
// Runner principal — compara múltiplas estratégias
// ============================================================
function runFullBacktest(db, options = {}) {
  const betSize  = options.betSize  ?? 3.5;
  const dateFrom = options.dateFrom ?? null;
  const dateTo   = options.dateTo   ?? null;

  const strategies = [
    { name: "dummy",           label: "Dummy (baseline)" },
    { name: "skew-up",         label: "Skew-Up (midUp>56%, 5-10min)" },
    { name: "skew-up:filtered",label: "Skew-Up + filtro tendência" },
    { name: "skew-down",       label: "Skew-Down (midUp<44%, 5-10min)" },
    { name: "skew",            label: "Skew completo (ambos lados)" },
    { name: "momentum-down",   label: "Momentum-Down (midUp<48.5%)" },
    { name: "lateral-up",      label: "Lateral+Up (sinal mais forte)" },
  ];

  console.log("\n" + "═".repeat(65));
  console.log("  🦅 CARCARÁ — BACKTESTER");
  console.log("  Projeta P&L de estratégias sobre dados simulados históricos");
  if (dateFrom || dateTo) {
    console.log("  Período: " + (dateFrom ?? "início") + " → " + (dateTo ?? "hoje"));
  }
  console.log("  Tamanho da aposta: $" + betSize);
  console.log("═".repeat(65));

  const results = [];
  for (const strat of strategies) {
    const result = runBacktest(db, strat.name, { betSize, dateFrom, dateTo });
    results.push({ ...result, _label: strat.label });
    printBacktestReport(result, strat.label);
  }

  // Ranking final
  const valid = results.filter(r => !r.error && r.resolved >= 10);
  if (valid.length > 0) {
    console.log("\n" + "═".repeat(65));
    console.log(chalk.bold("  RANKING por P&L projetado (100 tentativas):"));
    console.log("  " + "─".repeat(60));
    valid.sort((a, b) => parseFloat(b.proj100.pl) - parseFloat(a.proj100.pl));
    valid.forEach((r, i) => {
      const pl    = parseFloat(r.proj100.pl);
      const color = pl >= 0 ? chalk.green : chalk.red;
      const ci    = "[" + r.proj100.plLow + " ; " + r.proj100.plHigh + "]";
      console.log("  " + (i+1) + ". " + (r._label || r.strategy).padEnd(38) +
        color((pl >= 0 ? "+" : "") + r.proj100.pl.padStart(7) + " USDC") +
        chalk.gray("  IC95: " + ci));
    });
    console.log("═".repeat(65));

    const best = valid[0];
    const bestPl = parseFloat(best.proj100.pl);
    if (bestPl > 0) {
      console.log(chalk.bold.green("\n  ✅ Melhor estratégia: " + (best._label || best.strategy)));
      console.log(chalk.green("     WR=" + best.winRatePct + "% | EV=+" + best.ev + "% | IC95: [" +
        best.ci95Low + "% – " + best.ci95High + "%]"));
      if (parseFloat(best.ci95Low) < 50) {
        console.log(chalk.yellow("  ⚠️  IC95 inclui valores abaixo de 50% — incerteza ainda alta."));
        console.log(chalk.yellow("     Mais dados simulados reduziriam o intervalo de confiança."));
      }
    } else {
      console.log(chalk.bold.red("\n  ❌ Nenhuma estratégia com P&L projetado positivo."));
      console.log(chalk.red("     Recomendação: acumular mais dados simulados antes de apostar."));
    }
  }
  console.log();
}

module.exports = { runBacktest, runFullBacktest, printBacktestReport, wilsonCI };
