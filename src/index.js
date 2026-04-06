// src/index.js — CARCARÁ
// ============================================================
// PONTO DE ENTRADA DO CARCARÁ
// ============================================================
// Modos disponíveis via --mode=<modo>:
//
//   --mode=market      → Fase 1: Consulta bruta de mercados
//   --mode=select      → Fase 1+: Consulta + seleção inteligente (padrão)
//   --mode=watch       → Fase 1+: Seleção em loop contínuo
//   --mode=volatility  → Fase 3: Monitor de volatilidade standalone
//   --mode=order       → Fase 2: Aposta Maker-or-Cancel (requer .env completo)
//   --mode=dry         → Fase 2: Simula aposta sem enviar (DRY-RUN)
//   --mode=capture     → Fase 4: Captura dados de mercado sem apostar
//   --mode=stats       → Fase 4: Dashboard de métricas no terminal
//   --mode=stats --backtest → Fase 4: Análise por faixa de midpoint
//   --mode=sim               → Fase 4+: Simulação contínua em loop (dry bets)
//   --mode=resolve           → Fase 4: Auto-resolve + auto-redeem de ganhos
//   --mode=redeem            → Fase 6: Resgata posições vencedoras na blockchain
//   --mode=resolve:manual    → Fase 4: Resolve manualmente (fallback)
//   --mode=auth              → Utilitário: gerencia credenciais da API
//
// Estratégias (--strategy=<nome>):
//   dummy     → cara ou coroa — baseline de comparação
//   up-only   → sempre aposta Up (padrão)
//   down-only → sempre aposta Down
//
// Exemplos:
//   npm run sim                               → simulação contínua (dummy, aguarda fechar)
//   npm run sim -- --strategy=dummy --interval=30 → a cada 30s
//   npm run order                              → aposta Up (padrão)
//   npm run order -- --strategy=dummy          → aposta aleatório
//   npm run capture                            → coleta dados sem apostar
//   npm run stats                              → dashboard de métricas
//   npm run resolve                            → auto-resolve todos os pendentes
//   npm run resolve -- --watch=60              → resolve em loop a cada 60s
// ============================================================

const logger = require("./logger");
const config = require("./config");

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = modeArg ? modeArg.split("=")[1] : "select";

  logger.divider();
  logger.info(`🦅 CARCARÁ iniciando — modo: ${mode.toUpperCase()}`);
  logger.divider();

  switch (mode) {

    // -------------------------------------------------------
    // MARKET: Consulta bruta (sem seleção)
    // -------------------------------------------------------
    case "market": {
      const { runMarketQuery } = require("./market");
      await runMarketQuery();
      break;
    }

    // -------------------------------------------------------
    // SELECT: Consulta + seleção inteligente (uma vez)
    // -------------------------------------------------------
    case "select":
    default: {
      await runSelectMode();
      break;
    }

    // -------------------------------------------------------
    // WATCH: Loop contínuo — re-seleciona a cada novo ciclo
    // -------------------------------------------------------
    case "watch": {
      logger.info("👁  Modo WATCH ativo — atualizando a cada 30 segundos. Ctrl+C para parar.");
      logger.divider();

      const runOnce = async () => {
        try {
          await runSelectMode();
        } catch (err) {
          logger.error("Erro no ciclo de watch", err);
        }
      };

      await runOnce();
      setInterval(runOnce, 30_000);
      break;
    }

    // -------------------------------------------------------
    // SIM: Simulação contínua — dry bets em loop
    // Acumula métricas sem gastar dinheiro real.
    // Uso: npm run sim
    //      npm run sim -- --strategy=dummy --interval=30
    // -------------------------------------------------------
    case "sim": {
      const { findBtcMarketsViaGamma, getOrderBook } = require("./market");
      const { selectBestMarket } = require("./selector");
      const { calcMakerPrice } = require("./order");
      const { runStrategy } = require("./strategy");
      const { insertRound, insertOrderbookSnapshot } = require("./db");
      const { autoResolve } = require("./resolver");
      const {
        startVolatilityMonitor, waitForData, stopVolatilityMonitor, getVolatilityState, formatVolatilityState,
      } = require("./volatility");

      const strategyName = args.find(a => a.startsWith("--strategy="))?.split("=")[1] ?? "dummy";
      // Intervalo mínimo entre iterações em segundos (padrão: aguarda o mercado fechar)
      const intervalSec = parseInt(args.find(a => a.startsWith("--interval="))?.split("=")[1] ?? "0");

      logger.info(`🎮 SIM — Simulação contínua`);
      logger.info(`   Estratégia : ${strategyName}`);
      logger.info(`   Intervalo  : ${intervalSec > 0 ? intervalSec + "s fixo" : "aguarda mercado fechar"}`);
      logger.info(`   Ctrl+C para parar.`);
      logger.divider();

      // Inicia monitor de volatilidade uma vez — fica ativo o loop todo
      startVolatilityMonitor();
      try { await waitForData(15_000); } catch { /* ok */ }

      let iteration = 0;
      let lastConditionId = null;
      let lastEndDate = null;

      const runIteration = async () => {
        iteration++;
        logger.divider();
        logger.info(`[SIM #${iteration}] ${new Date().toISOString()}`);

        try {
          const volState = getVolatilityState();
          logger.info(`   ${formatVolatilityState(volState)}`);

          const rawMarkets = await findBtcMarketsViaGamma();
          if (!rawMarkets.length) {
            logger.warn("   Nenhum mercado encontrado — aguardando...");
            return;
          }

          const best = await selectBestMarket(rawMarkets);
          if (!best) {
            logger.warn("   Nenhum mercado elegível — aguardando...");
            return;
          }

          // Evita registrar o mesmo mercado duas vezes seguidas
          const condId = best.market.condition_id || best.market.id;
          if (condId === lastConditionId) {
            logger.info(`   Mesmo mercado da iteração anterior — aguardando fechar.`);
            return;
          }

          // Injeta estado de volatilidade no contexto do mercado para a estratégia value
          best.volLevel = volState.level;

          const decision = await runStrategy(strategyName, best);

          // Estratégia pode recusar apostar (ex: momentum em zona neutra)
          if (!decision) {
            logger.info(`   ⏭  Estratégia [${strategyName}] recusou apostar nesta janela — zona neutra.`);
            lastConditionId = condId; // marca para não tentar de novo no mesmo mercado
            return;
          }

          const book = await getOrderBook(decision.tokenId);
          const midpoint = decision.outcome === "Up" ? best.midUp : best.midDown;
          const bidPrice = await calcMakerPrice(decision.tokenId, "BUY", midpoint, config.orderMargin);
          const simulatedShares = Math.floor((config.maxBetSizeUsdc / bidPrice) * 100) / 100;

          const roundId = insertRound({
            mode: "sim",
            strategy: strategyName,
            condition_id: condId,
            market_name: best.market.question || best.market.title,
            market_end_date: best.market.end_date,
            seconds_to_close: best.secondsToClose,
            market_score: best.score,
            mid_up: best.midUp,
            mid_down: best.midDown,
            spread: best.spread,
            side: "BUY",
            token_id: decision.tokenId,
            outcome: decision.outcome,
            price_submitted: bidPrice,
            shares_submitted: simulatedShares,
            usdc_submitted: config.maxBetSizeUsdc,
            wait_ms: config.orderWaitMs,
            margin_used: config.orderMargin,
            order_id: null,
            order_status: "DRY",
            shares_matched: simulatedShares,
            taker_fill: 0,
            cancelled_immediately: 0,
            vol_level: volState.level,
            vol_speed: volState.speed,
            vol_stddev: volState.stddev,
            vol_amplitude: volState.amplitude,
            btc_price: volState.price,
          });

          insertOrderbookSnapshot(roundId, decision.tokenId, book);

          // ── Fase 6: Estima probabilidade de fill ─────────
          try {
            const { getFillModel, predictFillProbability, extractFeatures } = require("./fill_model");
            const { getDb } = require("./db");
            const fillModel = getFillModel(getDb());
            const bookRows = (book.bids || []).map(b => ({ side: "bids", ...b }))
              .concat((book.asks || []).map(a => ({ side: "asks", ...a })));
            const roundCtx = {
              price_submitted: bidPrice,
              spread: best.spread,
              seconds_to_close: best.secondsToClose,
              vol_level: volState.level,
              mid_up: best.midUp,
            };
            const fillProb = predictFillProbability(fillModel, roundCtx, bookRows);
            logger.info(`   📊 Fill probability estimada: ${(fillProb * 100).toFixed(1)}%`);
          } catch { /* modelo ainda sem dados suficientes */ }
          // ─────────────────────────────────────────────────

          logger.success(`   ✅ Sim #${roundId} registrado — ${decision.outcome} @ ${bidPrice} | ${simulatedShares} shares | Fecha em ${best.secondsToClose}s`);

          lastConditionId = condId;
          lastEndDate = new Date(best.market.end_date);

          // Tenta resolver rounds antigos pendentes
          const { resolved } = await autoResolve();
          if (resolved > 0) logger.success(`   🎯 ${resolved} round(s) resolvidos automaticamente.`);

        } catch (err) {
          logger.error(`   Erro na iteração: ${err.message}`);
        }
      };

      // Função que calcula quando rodar a próxima iteração
      const scheduleNext = async () => {
        await runIteration();

        let waitMs;
        if (intervalSec > 0) {
          waitMs = intervalSec * 1000;
        } else if (lastEndDate) {
          // Aguarda o mercado atual fechar + 5s de margem
          const msUntilClose = lastEndDate.getTime() - Date.now() + 5_000;
          waitMs = Math.max(msUntilClose, 10_000);
          logger.info(`   ⏳ Próxima iteração em ${Math.round(waitMs / 1000)}s (mercado fecha às ${lastEndDate.toISOString()})`);
        } else {
          waitMs = 30_000; // fallback
        }

        setTimeout(scheduleNext, waitMs);
      };

      process.on("SIGINT", () => {
        stopVolatilityMonitor();
        logger.info(`
⏹  SIM encerrado após ${iteration} iteração(ões).`);
        logger.info(`   Execute npm run stats para ver os resultados.`);
        process.exit(0);
      });

      // Inicia
      scheduleNext();
      // Mantém o processo vivo
      await new Promise(() => {});
      break;
    }

    // -------------------------------------------------------
    // ANALYZE: Análise direta do banco — EV real por estratégia
    // -------------------------------------------------------
    case "analyze": {
      const { getDb } = require("./db");
      const db = getDb();

      console.log("\n=== CARCARÁ — ANÁLISE DIRETA DO BANCO ===\n");

      // 1. Win rate e EV real por estratégia
      console.log("1. Win rate e EV real por estratégia:");
      db.prepare(`
        SELECT COALESCE(strategy,'dummy') as strategy,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(price_submitted),3) as avg_price,
          ROUND(SUM(profit),2) as profit,
          ROUND(SUM(usdc_submitted),2) as wagered
        FROM rounds
        WHERE mode='order' AND order_status='MATCHED' AND resolved=1
        GROUP BY strategy ORDER BY n DESC
      `).all().forEach(r => {
        const ev  = ((r.wr/100) - r.avg_price) * 100;
        const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
        console.log(`  ${r.strategy.padEnd(12)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
      });

      // 2. Dummy em condições ótimas vs demais
      console.log("\n2. Dummy: condições ótimas (5-10min + delta 0.01-0.02) vs demais:");
      db.prepare(`
        SELECT
          CASE WHEN seconds_to_close BETWEEN 300 AND 600
               AND (mid_up - price_submitted) BETWEEN 0.01 AND 0.02
          THEN 'otimo' ELSE 'outros' END as cond,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(price_submitted),3) as avg_price,
          ROUND(SUM(profit),2) as profit,
          ROUND(SUM(usdc_submitted),2) as wagered
        FROM rounds
        WHERE mode='order' AND order_status='MATCHED' AND resolved=1
          AND COALESCE(strategy,'dummy') = 'dummy'
        GROUP BY cond
      `).all().forEach(r => {
        const ev  = ((r.wr/100) - r.avg_price) * 100;
        const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
        console.log(`  ${r.cond.padEnd(8)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
      });

      // 3. Fill rate e win rate por janela de tempo
      console.log("\n3. Fill rate e win rate por tempo até fechar:");
      db.prepare(`
        SELECT
          CASE WHEN seconds_to_close < 300  THEN '< 5min'
               WHEN seconds_to_close < 600  THEN '5-10min'
               WHEN seconds_to_close < 900  THEN '10-15min'
               ELSE '> 15min' END as bucket,
          COUNT(*) as tentativas,
          SUM(CASE WHEN order_status='MATCHED' THEN 1 ELSE 0 END) as fills,
          ROUND(AVG(CASE WHEN order_status='MATCHED' AND resolved=1
            THEN CAST(won AS FLOAT) END)*100,1) as wr
        FROM rounds WHERE mode='order'
        GROUP BY bucket ORDER BY
          CASE bucket WHEN '< 5min' THEN 1 WHEN '5-10min' THEN 2
          WHEN '10-15min' THEN 3 ELSE 4 END
      `).all().forEach(r => {
        const fr = r.tentativas ? (r.fills/r.tentativas*100).toFixed(1) : 0;
        console.log(`  ${r.bucket.padEnd(10)} tentativas=${String(r.tentativas).padEnd(5)} fills=${String(r.fills).padEnd(4)} fill_rate=${fr}%  wr=${r.wr ?? "—"}%`);
      });

      // 4. Win rate por price_delta
      console.log("\n4. Win rate por price_delta real (min 3 amostras):");
      db.prepare(`
        SELECT ROUND((mid_up - price_submitted)*100)/100 as delta,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(price_submitted),3) as avg_price,
          ROUND(SUM(profit),2) as profit
        FROM rounds
        WHERE mode='order' AND order_status='MATCHED' AND resolved=1
        GROUP BY delta HAVING n >= 3 ORDER BY delta
      `).all().forEach(r =>
        console.log(`  delta=${r.delta}  n=${r.n}  wr=${r.wr}%  avg_price=${r.avg_price}  profit=${r.profit}`)
      );

      // 5. Momentum por direção (Up vs Down)
      console.log("\n5. Momentum por direção apostada:");
      db.prepare(`
        SELECT
          outcome,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(price_submitted),3) as avg_price,
          ROUND(SUM(profit),2) as profit,
          ROUND(SUM(usdc_submitted),2) as wagered,
          ROUND(AVG(mid_up)*100,1) as avg_mid_up
        FROM rounds
        WHERE mode='order' AND order_status='MATCHED' AND resolved=1
          AND strategy='momentum'
        GROUP BY outcome
      `).all().forEach(r => {
        const ev  = ((r.wr/100) - r.avg_price) * 100;
        const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
        console.log(`  ${r.outcome.padEnd(6)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  avg_mid_up=${r.avg_mid_up}%  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
      });

      // 6. Momentum Down em condições ótimas de tempo
      console.log("\n6. Momentum Down por janela de tempo:");
      db.prepare(`
        SELECT
          CASE WHEN seconds_to_close < 300  THEN '< 5min'
               WHEN seconds_to_close < 600  THEN '5-10min'
               ELSE '> 10min' END as bucket,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(price_submitted),3) as avg_price,
          ROUND(SUM(profit),2) as profit,
          ROUND(SUM(usdc_submitted),2) as wagered
        FROM rounds
        WHERE mode='order' AND order_status='MATCHED' AND resolved=1
          AND strategy='momentum' AND outcome='Down'
        GROUP BY bucket
        ORDER BY CASE bucket WHEN '< 5min' THEN 1 WHEN '5-10min' THEN 2 ELSE 3 END
      `).all().forEach(r => {
        const ev  = ((r.wr/100) - r.avg_price) * 100;
        const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
        console.log(`  ${r.bucket.padEnd(10)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
      });

      // 7. Simulado: win rate por faixa de midUp
      console.log("\n7. Simulado: win rate por faixa de midUp (Up vs Down):");
      db.prepare(`
        SELECT
          CASE
            WHEN mid_up < 0.44 THEN '< 44%'
            WHEN mid_up < 0.47 THEN '44-47%'
            WHEN mid_up < 0.50 THEN '47-50%'
            WHEN mid_up < 0.53 THEN '50-53%'
            WHEN mid_up < 0.56 THEN '53-56%'
            ELSE '> 56%'
          END as bucket,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(CASE WHEN outcome='Down' AND won=1 THEN 1.0 WHEN outcome='Down' THEN 0.0 END)*100,1) as wr_down,
          ROUND(AVG(CASE WHEN outcome='Up'   AND won=1 THEN 1.0 WHEN outcome='Up'   THEN 0.0 END)*100,1) as wr_up
        FROM rounds WHERE mode='sim' AND resolved=1
        GROUP BY bucket ORDER BY MIN(mid_up)
      `).all().forEach(function(r) {
        console.log("  midUp=" + r.bucket.padEnd(8) + " n=" + String(r.n).padEnd(5) +
          " wr=" + r.wr + "%  wr_down=" + (r.wr_down ?? "—") + "%  wr_up=" + (r.wr_up ?? "—") + "%");
      });

      // 8. Simulado: win rate por liquidez no orderbook
      console.log("\n8. Simulado: win rate por liquidez no orderbook (top ask size):");
      db.prepare(`
        SELECT
          CASE
            WHEN obs.size IS NULL OR obs.size = 0 THEN 'sem ask'
            WHEN obs.size < 100   THEN '< 100'
            WHEN obs.size < 500   THEN '100-500'
            WHEN obs.size < 2000  THEN '500-2k'
            ELSE '> 2k'
          END as liq_bucket,
          COUNT(*) as n,
          ROUND(AVG(CASE WHEN r.won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
          ROUND(AVG(r.price_submitted),3) as avg_price
        FROM rounds r
        LEFT JOIN (
          SELECT round_id, size FROM orderbook_snapshots
          WHERE side='asks' AND level=0
        ) obs ON obs.round_id = r.id
        WHERE r.mode='sim' AND r.resolved=1
        GROUP BY liq_bucket
        ORDER BY CASE liq_bucket WHEN 'sem ask' THEN 0 WHEN '< 100' THEN 1
          WHEN '100-500' THEN 2 WHEN '500-2k' THEN 3 ELSE 4 END
      `).all().forEach(function(r) {
        console.log("  ask_size=" + r.liq_bucket.padEnd(10) + " n=" + String(r.n).padEnd(5) +
          " wr=" + r.wr + "%  avg_price=" + r.avg_price);
      });

      // 9. Fills reais vs simulado por faixa de midUp
      console.log("\n9. Fills reais vs simulado — win rate por faixa de midUp:");
      console.log("  bucket       real_n  real_wr   sim_n   sim_wr    gap");
      var buckets = [
        ["< 44%",  0,    0.44],
        ["44-47%", 0.44, 0.47],
        ["47-50%", 0.47, 0.50],
        ["50-53%", 0.50, 0.53],
        ["53-56%", 0.53, 0.56],
        ["> 56%",  0.56, 1.0 ],
      ];
      buckets.forEach(function(b) {
        var label = b[0], lo = b[1], hi = b[2];
        var real = db.prepare("SELECT COUNT(*) as n, ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr FROM rounds WHERE mode='order' AND order_status='MATCHED' AND resolved=1 AND mid_up >= ? AND mid_up < ?").get(lo, hi);
        var sim  = db.prepare("SELECT COUNT(*) as n, ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr FROM rounds WHERE mode='sim' AND resolved=1 AND mid_up >= ? AND mid_up < ?").get(lo, hi);
        var gap  = (real.n >= 3 && sim.n > 0) ? ((real.wr - sim.wr >= 0 ? "+" : "") + (real.wr - sim.wr).toFixed(1) + "pp") : "—";
        console.log("  " + label.padEnd(12) + String(real.n).padEnd(7) + (real.n>=3 ? real.wr+"%" : "—").padEnd(9) +
          String(sim.n).padEnd(7) + (sim.wr ?? "—") + "%   " + gap);
      });

      // 10. Fill rate real por faixa de midUp
      console.log("\n10. Fill rate real por faixa de midUp:");
      buckets.forEach(function(b) {
        var label = b[0], lo = b[1], hi = b[2];
        var r = db.prepare("SELECT COUNT(*) as tentativas, SUM(CASE WHEN order_status='MATCHED' THEN 1 ELSE 0 END) as fills FROM rounds WHERE mode='order' AND mid_up >= ? AND mid_up < ?").get(lo, hi);
        var fr = r.tentativas ? (r.fills/r.tentativas*100).toFixed(1) : "0";
        console.log("  " + label.padEnd(12) + "tentativas=" + String(r.tentativas).padEnd(5) + " fills=" + r.fills + "  fill_rate=" + fr + "%");
      });

      console.log("\n=== FIM ===\n");
      break;
    }

    // -------------------------------------------------------
    // REDEEM: Resgate automático de posições vencedoras
    // -------------------------------------------------------
    case "redeem": {
      const { autoRedeem, watchAndRedeem, cancelStuckTx } = require("./redeem");
      const cancelHash = args.find(a => a.startsWith("--cancel="))?.split("=")[1];
      if (cancelHash) {
        await cancelStuckTx(cancelHash);
        break;
      }
      const watchArg = args.find(a => a.startsWith("--watch="))?.split("=")[1];
      if (watchArg) {
        await watchAndRedeem(parseInt(watchArg));
      } else {
        await autoRedeem();
      }
      break;
    }

    // -------------------------------------------------------
    // VOLATILITY: Monitor standalone de volatilidade
    // -------------------------------------------------------
    case "volatility": {
      const { startVolatilityMonitor, getVolatilityState, formatVolatilityState } = require("./volatility");
      const chalk = require("chalk");

      logger.info("🦅 CARCARÁ — Monitor de Volatilidade");
      logger.info("   Atualizando a cada 5s. Ctrl+C para parar.");
      logger.divider();

      startVolatilityMonitor();

      setInterval(() => {
        const state = getVolatilityState();
        const line = formatVolatilityState(state);
        if (state.level === "STORM") console.log(chalk.red(`[${new Date().toISOString()}] ${line}`));
        else if (state.level === "ALERT") console.log(chalk.yellow(`[${new Date().toISOString()}] ${line}`));
        else console.log(chalk.green(`[${new Date().toISOString()}] ${line}`));
      }, 5_000);

      process.on("SIGINT", () => {
        const { stopVolatilityMonitor } = require("./volatility");
        stopVolatilityMonitor();
        process.exit(0);
      });
      break;
    }

    // -------------------------------------------------------
    // AUTH: Gerenciamento de credenciais
    // -------------------------------------------------------
    case "auth": {
      const { runAuth } = require("./auth");
      const actionArg = args.find((a) => a.startsWith("--action="));
      const action = actionArg ? actionArg.split("=")[1] : "check";
      await runAuth(action);
      break;
    }

    // -------------------------------------------------------
    // ORDER / DRY: Aposta Post-Only GTD (Fase 2)
    // -------------------------------------------------------
    case "order":
    case "dry": {
      // ── Imports do bloco order/dry ────────────────────────
      const { placePostOnlyGtdOrder: _place, calcMakerPrice: _calcPrice } = require("./order");
      const { findBtcMarketsViaGamma: _findMarkets, getOrderBook: _getBook } = require("./market");
      const { selectBestMarket: _selectBest } = require("./selector");
      const { insertRound, insertOrderbookSnapshot } = require("./db");
      const {
        startVolatilityMonitor, waitForData, stopVolatilityMonitor,
        getVolatilityState, formatVolatilityState,
      } = require("./volatility");

      // ── Fase 3: Verificação de volatilidade ──────────────
      if (mode !== "dry") {
        logger.info("📡 Verificando volatilidade do BTC...");
        startVolatilityMonitor();
        try {
          await waitForData(20_000);
        } catch {
          logger.warn("Timeout aguardando dados de volatilidade — continuando sem verificação.");
        }

        const volCheck = getVolatilityState();
        logger.info(`   ${formatVolatilityState(volCheck)}`);

        if (volCheck.level === "STORM") {
          logger.warn("🔴 STORM detectado — Carcará aguardando calmaria. Aposta cancelada.");
          stopVolatilityMonitor();
          process.exit(0);
        }

        if (volCheck.level === "ALERT") {
          logger.warn("🟡 ALERT — volatilidade elevada. Carcará opera com cautela.");
        }
      }
      // ─────────────────────────────────────────────────────

      logger.info("Buscando e selecionando melhor mercado para apostar...");

      const rawMarkets = await _findMarkets();
      if (rawMarkets.length === 0) {
        logger.error("Nenhum mercado encontrado. Abortando.");
        process.exit(1);
      }

      const best = await _selectBest(rawMarkets);
      if (!best) {
        logger.warn("Nenhum mercado elegível para aposta agora. Tente novamente em instantes.");
        process.exit(0);
      }

      // ── Estratégia: decide Up ou Down ────────────────────
      const { runStrategy } = require("./strategy");
      const strategyName = args.find(a => a.startsWith("--strategy="))?.split("=")[1] ?? "up-only";
      // Injeta estado de volatilidade no contexto do mercado para a estratégia value
      const _volForStrategy = getVolatilityState();
      best.volLevel = _volForStrategy.level;

      const decision = await runStrategy(strategyName, best);

      // Estratégia pode recusar apostar (ex: momentum em zona neutra)
      if (!decision) {
        logger.warn(`⏭  Estratégia [${strategyName}] recusou apostar nesta janela — zona neutra.`);
        stopVolatilityMonitor();
        process.exit(0);
      }

      // ── Quality Gate (só para mode=order) ────────────────
      // Só prossegue se as duas condições ótimas forem satisfeitas simultaneamente:
      //   1. price_delta (midUp − preço) entre 0.01 e 0.02
      //   2. seconds_to_close entre 300s (5min) e 600s (10min)
      // Dados de adverse selection mostram que fora dessas condições
      // o win rate real cai abaixo do simulado de forma consistente.
      if (mode === "order") {
        const sec = best.secondsToClose;
        const timeOk = sec >= 300 && sec <= 600;

        // Para momentum-down: só aposta quando midUp < 0.485 (mercado favorece Down)
        // Para outras estratégias: verifica price_delta
        let condOk = true;
        let condDesc = "";

        if (strategyName === "momentum-down") {
          const midOk = best.midUp < 0.485;
          condOk = midOk && timeOk;
          condDesc = `midUp=${(best.midUp*100).toFixed(1)}% ${midOk ? "✅ (<48.5%)" : "❌ (≥48.5%)"} | seconds=${Math.round(sec)}s ${timeOk ? "✅ (5–10min)" : "❌ (fora)"}`;
        } else if (strategyName === "skew") {
          const midOk = best.midUp < 0.44 || best.midUp > 0.56;
          condOk = midOk && timeOk;
          condDesc = `midUp=${(best.midUp*100).toFixed(1)}% ${midOk ? "✅ (<44% ou >56%)" : "❌ (zona neutra 44-56%)"} | seconds=${Math.round(sec)}s ${timeOk ? "✅ (5–10min)" : "❌ (fora)"}`;
        } else if (strategyName === "skew-up") {
          const midOk = best.midUp > 0.56;
          condOk = midOk && timeOk;
          condDesc = `midUp=${(best.midUp*100).toFixed(1)}% ${midOk ? "✅ (>56%)" : "❌ (≤56%)"} | seconds=${Math.round(sec)}s ${timeOk ? "✅ (5–10min)" : "❌ (fora)"}`;
        } else {
          const midpoint   = decision.outcome === "Up" ? best.midUp : best.midDown;
          const priceDelta = midpoint - (midpoint - config.orderMargin);
          const deltaOk    = priceDelta >= 0.01 && priceDelta <= 0.02;
          condOk   = deltaOk && timeOk;
          condDesc = `price_delta=${priceDelta.toFixed(3)} ${deltaOk ? "✅" : "❌"} | seconds=${Math.round(sec)}s ${timeOk ? "✅ (5–10min)" : "❌ (fora)"}`;
        }

        logger.info(`🔒 Quality Gate: ${condDesc}`);

        if (!condOk) {
          logger.warn(`⏭  Quality Gate: condições não ótimas — apostando mesmo assim (use --strict para bloquear).`);
          if (args.includes("--strict")) {
            logger.warn(`   Modo --strict: cancelando aposta.`);
            stopVolatilityMonitor();
            process.exit(0);
          }
        } else {
          logger.success(`✅ Quality Gate passou — condições ótimas confirmadas.`);
        }
      }
      // ─────────────────────────────────────────────────────

      // Captura orderbook antes de decidir o preço
      const book = await _getBook(decision.tokenId);

      const bidPrice = await _calcPrice(decision.tokenId, "BUY", decision.outcome === "Up" ? best.midUp : best.midDown, config.orderMargin);

      const result = await _place({
        tokenId: decision.tokenId,
        price: bidPrice,
        side: "BUY",
        sizeUsdc: config.maxBetSizeUsdc,
        expiresAt: Math.floor(new Date(best.market.end_date).getTime() / 1000),
        waitMs: config.orderWaitMs,
        dryRun: mode === "dry",
      });

      // ── Fase 4: Registra o round no banco ────────────────
      const volState = getVolatilityState();
      const roundId = insertRound({
        mode,
        condition_id: best.market.condition_id || best.market.id,
        market_name: best.market.question || best.market.title,
        market_end_date: best.market.end_date,
        seconds_to_close: best.secondsToClose,
        market_score: best.score,
        mid_up: best.midUp,
        mid_down: best.midDown,
        spread: best.spread,
        side: "BUY",
        token_id: decision.tokenId,
        outcome: decision.outcome,
        strategy: strategyName,
        price_submitted: bidPrice,
        shares_submitted: result.totalSize ?? result.simulatedOrder?.shares ?? 0,
        usdc_submitted: config.maxBetSizeUsdc,
        wait_ms: config.orderWaitMs,
        margin_used: config.orderMargin,
        order_id: result.orderId ?? null,
        order_status: mode === "dry" ? "DRY"
          : result.cancelledImmediately ? "CANCELED"
          : result.filled ? "MATCHED"
          : result.success ? "CANCELED"
          : "ERROR",
        // Para DRY: simula shares como se a ordem tivesse preenchido totalmente
        shares_matched: mode === "dry"
          ? (result.totalSize ?? Math.floor((config.maxBetSizeUsdc / bidPrice) * 100) / 100)
          : (result.matchedSize ?? 0),
        taker_fill: result.takerFill ? 1 : 0,
        cancelled_immediately: result.cancelledImmediately ? 1 : 0,
        vol_level: volState.level ?? "UNKNOWN",
        vol_speed: volState.speed ?? null,
        vol_stddev: volState.stddev ?? null,
        vol_amplitude: volState.amplitude ?? null,
        btc_price: volState.price ?? null,
      });

      // Salva o orderbook capturado
      insertOrderbookSnapshot(roundId, best.upToken.token_id, book);
      logger.info(`📦 Round #${roundId} registrado no banco.`);
      // ─────────────────────────────────────────────────────

      if (result.success) {
        logger.success("Operação concluída!", result);
      } else {
        logger.warn("Operação não executada:", result);
      }

      stopVolatilityMonitor();
      process.exit(0);
    }

    // -------------------------------------------------------
    // CAPTURE: Captura dados de mercado sem apostar
    // Gera histórico para backtesting
    // -------------------------------------------------------
    case "capture": {
      const { findBtcMarketsViaGamma } = require("./market");
      const { selectBestMarket } = require("./selector");
      const { getOrderBook } = require("./market");
      const { insertRound, insertOrderbookSnapshot } = require("./db");
      const { startVolatilityMonitor, waitForData, getVolatilityState, stopVolatilityMonitor } = require("./volatility");

      logger.info("📸 CAPTURE — Coletando dados sem apostar...");
      startVolatilityMonitor();
      try { await waitForData(15_000); } catch { /* ok */ }

      const rawMarkets = await findBtcMarketsViaGamma();
      if (!rawMarkets.length) { logger.error("Nenhum mercado."); process.exit(1); }

      const best = await selectBestMarket(rawMarkets);
      if (!best) { logger.warn("Nenhum mercado elegível."); process.exit(0); }

      const book = await getOrderBook(best.upToken.token_id);
      const volState = getVolatilityState();

      const roundId = insertRound({
        mode: "capture",
        strategy: null,
        condition_id: best.market.condition_id || best.market.id,
        market_name: best.market.question || best.market.title,
        market_end_date: best.market.end_date,
        seconds_to_close: best.secondsToClose,
        market_score: best.score,
        mid_up: best.midUp,
        mid_down: best.midDown,
        spread: best.spread,
        side: null, token_id: best.upToken.token_id, outcome: "Up",
        price_submitted: null, shares_submitted: null,
        usdc_submitted: null, wait_ms: null, margin_used: null,
        order_id: null, order_status: "CAPTURE",
        shares_matched: 0, taker_fill: 0, cancelled_immediately: 0,
        vol_level: volState.level, vol_speed: volState.speed,
        vol_stddev: volState.stddev, vol_amplitude: volState.amplitude,
        btc_price: volState.price,
      });

      insertOrderbookSnapshot(roundId, best.upToken.token_id, book);
      stopVolatilityMonitor();

      logger.success(`📸 Snapshot #${roundId} capturado.`);
      logger.info(`   Mercado  : ${best.market.question || best.market.title}`);
      logger.info(`   Mid Up   : ${best.midUp}`);
      logger.info(`   Spread   : ${best.spread}`);
      logger.info(`   Vol      : ${volState.level} — BTC $${volState.price?.toLocaleString()}`);
      break;
    }

    // -------------------------------------------------------
    // STATS: Dashboard de métricas
    // -------------------------------------------------------
    case "stats": {
      const { printDashboard, printBacktestSummary, printStrategyBreakdown } = require("./stats");
      const modeFilter = args.find(a => a.startsWith("--filter="))?.split("=")[1] ?? null;
      const backtest = args.includes("--backtest");
      const strategies = args.includes("--strategies");
      printDashboard({ mode: modeFilter });
      if (backtest)   printBacktestSummary();
      if (strategies) printStrategyBreakdown();
      if (args.includes("--adverse")) {
        const { printAdverseSelectionAnalysis } = require("./stats");
        printAdverseSelectionAnalysis();
      }
      if (args.includes("--recent")) {
        const { printRecentROI } = require("./stats");
        const daysArg  = args.find(a => a.startsWith("--days="))?.split("=")[1];
        const sinceArg = args.find(a => a.startsWith("--since="))?.split("=")[1];
        printRecentROI(daysArg ? parseInt(daysArg) : null, sinceArg ?? null);
      }
      break;
    }

    // -------------------------------------------------------
    // RESOLVE: Auto-resolução via Gamma API
    // -------------------------------------------------------
    case "resolve": {
      const { autoResolve, watchAndResolve } = require("./resolver");
      const watchArg = args.find(a => a.startsWith("--watch="))?.split("=")[1];

      if (watchArg) {
        await watchAndResolve(parseInt(watchArg));
      } else {
        const resolveResult = await autoResolve();
        // Após resolver, tenta resgatar automaticamente os ganhos
        if (resolveResult?.resolved > 0) {
          logger.info("💰 Tentando resgatar posições vencedoras recém-resolvidas...");
          const { autoRedeem } = require("./redeem");
          await autoRedeem();
        }
      }
      break;
    }

    // -------------------------------------------------------
    // RESOLVE:MANUAL — Registra resultado manualmente
    // Fallback para quando a Gamma API não resolver automaticamente
    // -------------------------------------------------------
    case "resolve:manual": {
      const { resolveRound } = require("./db");
      const idArg = args.find(a => a.startsWith("--id="))?.split("=")[1];
      const wonArg = args.find(a => a.startsWith("--won="))?.split("=")[1];
      const payoutArg = args.find(a => a.startsWith("--payout="))?.split("=")[1];

      if (!idArg || wonArg == null) {
        logger.error("Uso: npm run resolve:manual -- --id=<N> --won=true --payout=<valor>");
        process.exit(1);
      }

      resolveRound(parseInt(idArg), {
        won: wonArg === "true" || wonArg === "1",
        payout: parseFloat(payoutArg ?? "0"),
      });
      logger.success(`Round #${idArg} resolvido manualmente. won=${wonArg} payout=${payoutArg}`);
      break;
    }
  }
}

// -------------------------------------------------------
// Helper: busca mercados + roda seleção inteligente
// -------------------------------------------------------
async function runSelectMode() {
  const { findBtcMarketsViaGamma, findBtcMarketsViaCLOB } = require("./market");
  const { selectBestMarket } = require("./selector");

  logger.info("🔎 Buscando mercados BTC ativos...");

  let markets = await findBtcMarketsViaGamma();
  if (markets.length === 0) {
    logger.warn("Gamma API sem resultados. Tentando CLOB...");
    markets = await findBtcMarketsViaCLOB();
  }

  if (markets.length === 0) {
    logger.warn("Nenhum mercado encontrado. Verifique a conexão ou tente novamente.");
    return;
  }

  logger.success(`${markets.length} mercado(s) candidato(s) encontrado(s).`);

  const best = await selectBestMarket(markets);

  if (!best) {
    logger.divider();
    logger.warn("Nenhum mercado passou pelos critérios de elegibilidade agora.");
    logger.info("Possíveis razões:");
    logger.info("  • Todos os mercados já estão muito inclinados (midpoint fora de 20%–80%)");
    logger.info("  • Todos estão muito perto de fechar (< 60s) ou muito distantes (> 15min)");
    logger.info("  • Spread muito alto em todos os mercados");
    logger.info("Tente novamente em alguns instantes ou ajuste os parâmetros em selector.js");
  }
}

main().catch((err) => {
  logger.error("Erro não tratado no bot", err);
  process.exit(1);
});
