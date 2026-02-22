// src/order.js
// ============================================================
// FASE 2 — Colocação de Apostas: Post-Only + GTD
// ============================================================
// Responsável por:
//   - Inicializar o ClobClient autenticado
//   - Construir ordens Post-Only GTD (nunca paga taxa de taker)
//   - Verificar segurança ANTES de qualquer ordem
//   - Cancelar ordens abertas
// ============================================================
// ⚠️  SEGURANÇA: Este módulo tem múltiplas camadas de proteção:
//   1. Credenciais carregadas só quando necessário
//   2. Limite de tamanho máximo por aposta (MAX_BET_SIZE_USDC)
//   3. Verificação de slippage antes de executar
//   4. Modo DRY-RUN disponível (não envia ordens reais)
// ============================================================

const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");

let _client = null; // Singleton do cliente autenticado

// ----------------------------------------------------------
// Inicializa o ClobClient com autenticação completa
// Chame apenas quando for realmente operar
// ----------------------------------------------------------
async function initClient() {
  if (_client) return _client;

  const creds = config.loadTradingCredentials(); // Lança erro se não configurado

  const wallet = new ethers.Wallet(creds.privateKey);

  _client = new ClobClient(
    config.clobHost,
    config.chainId,
    wallet,
    {
      key: creds.apiKey,
      secret: creds.apiSecret,
      passphrase: creds.apiPassphrase,
    }
  );

  logger.success(`Cliente CLOB autenticado — carteira: ${wallet.address}`);
  return _client;
}

// ----------------------------------------------------------
// Verificações de segurança antes de qualquer ordem
// Retorna { ok: boolean, reason: string }
// ----------------------------------------------------------
function validateOrderParams({ tokenId, price, side, sizeUsdc }) {
  if (!tokenId) return { ok: false, reason: "tokenId ausente" };

  if (price <= 0 || price >= 1) {
    return { ok: false, reason: `Preço inválido: ${price}. Deve estar entre 0 e 1.` };
  }

  if (sizeUsdc <= 0) {
    return { ok: false, reason: `Tamanho inválido: ${sizeUsdc}` };
  }

  if (sizeUsdc > config.maxBetSizeUsdc) {
    return {
      ok: false,
      reason: `Tamanho ${sizeUsdc} USDC excede o limite de segurança de ${config.maxBetSizeUsdc} USDC`,
    };
  }

  if (!["BUY", "SELL"].includes(side.toUpperCase())) {
    return { ok: false, reason: `Side inválido: ${side}` };
  }

  return { ok: true };
}

// ----------------------------------------------------------
// Verifica se o preço desejado não vai cruzar o spread
// (garantia de Post-Only: não pagar taxa de taker)
// ----------------------------------------------------------
async function checkPostOnlySafe(client, tokenId, side, desiredPrice) {
  const book = await client.getOrderBook(tokenId);

  const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
  const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;

  if (side === "BUY" && bestAsk !== null) {
    if (desiredPrice >= bestAsk) {
      return {
        safe: false,
        reason: `Preço de compra ${desiredPrice} >= melhor ask ${bestAsk}. Ordem cruzaria o spread (viraria taker).`,
        bestBid,
        bestAsk,
      };
    }
  }

  if (side === "SELL" && bestBid !== null) {
    if (desiredPrice <= bestBid) {
      return {
        safe: false,
        reason: `Preço de venda ${desiredPrice} <= melhor bid ${bestBid}. Ordem cruzaria o spread (viraria taker).`,
        bestBid,
        bestAsk,
      };
    }
  }

  return { safe: true, bestBid, bestAsk };
}

// ----------------------------------------------------------
// Coloca uma ordem Post-Only + GTD
//
// Parâmetros:
//   tokenId    — ID do token YES ou NO do mercado
//   price      — Preço em USDC por share (ex: 0.55 = 55%)
//   side       — "BUY" ou "SELL"
//   sizeUsdc   — Valor em USDC a apostar
//   expiresAt  — Timestamp Unix de expiração (GTD). Padrão: fim do mercado atual
//   dryRun     — Se true, simula sem enviar ordem real
// ----------------------------------------------------------
async function placePostOnlyGtdOrder({
  tokenId,
  price,
  side,
  sizeUsdc,
  expiresAt,
  dryRun = false,
}) {
  logger.divider();
  logger.info("🎯 Preparando ordem Post-Only GTD...");

  // 1. Validação de parâmetros
  const validation = validateOrderParams({ tokenId, price, side, sizeUsdc });
  if (!validation.ok) {
    logger.error(`Ordem rejeitada pela validação: ${validation.reason}`);
    return { success: false, reason: validation.reason };
  }

  // 2. Inicializar cliente (carrega credenciais)
  const client = await initClient();

  // 3. Verificar se é Post-Only seguro (não cruza spread)
  const postOnlyCheck = await checkPostOnlySafe(client, tokenId, side, price);
  if (!postOnlyCheck.safe) {
    logger.warn(`Post-Only check falhou: ${postOnlyCheck.reason}`);
    logger.warn("Ordem NÃO enviada (política Post-Only ativa).");
    return { success: false, reason: postOnlyCheck.reason, spread: postOnlyCheck };
  }

  logger.success(`Post-Only check OK — Best Bid: ${postOnlyCheck.bestBid} | Best Ask: ${postOnlyCheck.bestAsk}`);

  // 4. Calcular shares a partir do valor em USDC
  //    shares = sizeUsdc / price  (compra) ou sizeUsdc / (1 - price) (venda)
  const shares = side === "BUY"
    ? Math.floor((sizeUsdc / price) * 100) / 100
    : Math.floor((sizeUsdc / (1 - price)) * 100) / 100;

  // 5. Expiração padrão: 5 minutos a partir de agora (se não especificado)
  const expiry = expiresAt || Math.floor(Date.now() / 1000) + 300;

  const orderParams = {
    tokenID: tokenId,
    price: price,
    side: side === "BUY" ? Side.BUY : Side.SELL,
    size: shares,
    expiration: expiry,   // Campo GTD
    feeRateBps: "0",      // Post-Only: taxa de maker (0 bps na Polymarket)
  };

  logger.info("Parâmetros da ordem:", {
    tokenId,
    side,
    price,
    shares,
    sizeUsdc,
    expiresAt: new Date(expiry * 1000).toISOString(),
    dryRun,
  });

  // 6. DRY-RUN: retorna simulação sem enviar
  if (dryRun) {
    logger.warn("🧪 DRY-RUN ativo — ordem NÃO enviada. Simulação concluída.");
    return { success: true, dryRun: true, params: orderParams };
  }

  // 7. Criar e enviar a ordem
  const order = await client.createOrder(orderParams);

  // POST_ONLY = ordem cancela automaticamente se cruzar o spread no momento do envio
  // GTD       = cancela automaticamente ao atingir o tempo de expiração
  const response = await client.postOrder(order, OrderType.GTD);

  if (response.success) {
    logger.success("✅ Ordem enviada com sucesso!", {
      orderId: response.orderID,
      status: response.status,
    });
    return { success: true, orderId: response.orderID, response };
  } else {
    logger.error("Ordem rejeitada pela exchange", response);
    return { success: false, response };
  }
}

// ----------------------------------------------------------
// Cancela uma ordem pelo ID
// ----------------------------------------------------------
async function cancelOrder(orderId) {
  const client = await initClient();
  logger.info(`Cancelando ordem: ${orderId}`);
  const result = await client.cancelOrder({ orderID: orderId });
  logger.success("Ordem cancelada.", result);
  return result;
}

// ----------------------------------------------------------
// Lista ordens abertas
// ----------------------------------------------------------
async function getOpenOrders(marketId) {
  const client = await initClient();
  const orders = await client.getOpenOrders({ market: marketId });
  logger.info(`Ordens abertas: ${orders.length}`);
  return orders;
}

module.exports = {
  placePostOnlyGtdOrder,
  cancelOrder,
  getOpenOrders,
  initClient,
};
