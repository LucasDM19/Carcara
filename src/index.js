// src/index.js
// ============================================================
// PONTO DE ENTRADA DO BOT POLYMARKET
// ============================================================
// Modos disponíveis via --mode=<modo>:
//
//   --mode=market  → Fase 1: Consulta de mercado (padrão)
//   --mode=order   → Fase 2: Coloca aposta Post-Only GTD (requer .env completo)
//   --mode=dry     → Fase 2: Simula aposta sem enviar (DRY-RUN)
//
// Exemplos:
//   npm run market
//   npm run order
//   node src/index.js --mode=dry
// ============================================================

const logger = require("./logger");

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = modeArg ? modeArg.split("=")[1] : "market";

  logger.divider();
  logger.info(`🤖 POLYMARKET BOT iniciando — modo: ${mode.toUpperCase()}`);
  logger.divider();

  switch (mode) {
    // -------------------------------------------------------
    // FASE 1: Consulta de mercado (sem credenciais)
    // -------------------------------------------------------
    case "market": {
      const { runMarketQuery } = require("./market");
      await runMarketQuery();
      break;
    }

    // -------------------------------------------------------
    // FASE 2: Aposta Post-Only GTD (requer .env completo)
    // -------------------------------------------------------
    case "order":
    case "dry": {
      const config = require("./config");
      const { placePostOnlyGtdOrder } = require("./order");

      if (!config.btcConditionId) {
        logger.error(
          "BTC_MARKET_CONDITION_ID não configurado no .env\n" +
          "Execute primeiro: npm run market  →  copie o condition_id do mercado ativo\n" +
          "Depois configure BTC_MARKET_CONDITION_ID no .env"
        );
        process.exit(1);
      }

      // ------------------------------------------------------
      // ⚠️  ATENÇÃO: ajuste estes parâmetros antes de usar!
      // Em produção, estes valores virão da estratégia (Fase 4)
      // ------------------------------------------------------
      const { getMarketByConditionId, getMidpoint } = require("./market");

      logger.info("Buscando mercado configurado...");
      const market = await getMarketByConditionId(config.btcConditionId);
      const yesToken = market.tokens?.find((t) => t.outcome === "Yes");

      if (!yesToken) {
        logger.error("Token YES não encontrado no mercado configurado.");
        process.exit(1);
      }

      logger.info(`Token YES encontrado: ${yesToken.token_id}`);

      // Consulta midpoint para exemplificar uma oferta abaixo do mercado (Post-Only seguro)
      const mid = await getMidpoint(yesToken.token_id);
      logger.info(`Midpoint atual: ${(mid * 100).toFixed(2)}%`);

      // Oferta de compra 2 centavos abaixo do midpoint (Post-Only conservador)
      const bidPrice = Math.max(0.01, parseFloat((mid - 0.02).toFixed(2)));

      const result = await placePostOnlyGtdOrder({
        tokenId: yesToken.token_id,
        price: bidPrice,
        side: "BUY",
        sizeUsdc: config.maxBetSizeUsdc, // Usa limite de segurança configurado
        dryRun: mode === "dry",          // --mode=dry não envia ordem real
      });

      if (result.success) {
        logger.success("Operação concluída!", result);
      } else {
        logger.warn("Operação não executada:", result);
      }

      break;
    }

    default:
      logger.error(`Modo desconhecido: ${mode}`);
      logger.info("Modos disponíveis: market | order | dry");
      process.exit(1);
  }
}

main().catch((err) => {
  logger.error("Erro não tratado no bot", err);
  process.exit(1);
});
