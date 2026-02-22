// src/index.js
// ============================================================
// PONTO DE ENTRADA DO BOT POLYMARKET
// ============================================================
// Modos disponíveis via --mode=<modo>:
//
//   --mode=market    → Fase 1: Consulta bruta de mercados
//   --mode=select    → Fase 1+: Consulta + seleção inteligente (padrão)
//   --mode=watch     → Fase 1+: Seleção em loop contínuo (atualiza a cada ciclo)
//   --mode=order     → Fase 2: Aposta Post-Only GTD (requer .env completo)
//   --mode=dry       → Fase 2: Simula aposta sem enviar (DRY-RUN)
//
// Exemplos:
//   node src/index.js               → modo select (padrão)
//   node src/index.js --mode=watch  → loop contínuo
//   node src/index.js --mode=order  → aposta real
// ============================================================

const logger = require("./logger");

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = modeArg ? modeArg.split("=")[1] : "select";

  logger.divider();
  logger.info(`🤖 POLYMARKET BOT iniciando — modo: ${mode.toUpperCase()}`);
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
      const { placePostOnlyGtdOrder } = require("./order");
      const { findBtcMarketsViaGamma } = require("./market");
      const { selectBestMarket } = require("./selector");

      logger.info("Buscando e selecionando melhor mercado para apostar...");

      const rawMarkets = await findBtcMarketsViaGamma();
      if (rawMarkets.length === 0) {
        logger.error("Nenhum mercado encontrado. Abortando.");
        process.exit(1);
      }

      const best = await selectBestMarket(rawMarkets);
      if (!best) {
        logger.warn("Nenhum mercado elegível para aposta agora. Tente novamente em instantes.");
        process.exit(0);
      }

      // Aposta no token Up — a estratégia completa virá na Fase 4
      // Por ora: bid 2 centavos abaixo do midpoint (garantia Post-Only)
      const bidPrice = Math.max(0.01, parseFloat((best.midUp - 0.02).toFixed(2)));

      const config = require("./config");
      const result = await placePostOnlyGtdOrder({
        tokenId: best.upToken.token_id,
        price: bidPrice,
        side: "BUY",
        sizeUsdc: config.maxBetSizeUsdc,
        expiresAt: Math.floor(new Date(best.market.end_date).getTime() / 1000),
        dryRun: mode === "dry",
      });

      if (result.success) {
        logger.success("Operação concluída!", result);
      } else {
        logger.warn("Operação não executada:", result);
      }
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
