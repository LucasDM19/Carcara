// src/order.js
// ============================================================
// FASE 2 — Ordens Post-Only GTD
// ============================================================
// Fluxo de uma ordem:
//
//   1. validateOrderParams  — validação local dos parâmetros
//   2. initClient           — autenticação (só carrega credenciais aqui)
//   3. checkPostOnlySafe    — consulta orderbook via axios (já funciona)
//                             e garante que o preço não cruza o spread
//   4. calcShares           — converte USDC → shares
//   5. createOrder          — SDK assina a ordem localmente
//   6. postOrder(GTD)       — envia para a exchange
//
// Post-Only na Polymarket:
//   Não existe um flag "postOnly" explícito no SDK.
//   A garantia é feita em duas camadas:
//     a) checkPostOnlySafe: rejeita ANTES de enviar se o preço
//        cruzaria o spread neste momento
//     b) OrderType.GTD: a exchange cancela automaticamente a ordem
//        se ela não puder ser colocada como maker no book
//
// GTD (Good-Til-Date):
//   A ordem expira automaticamente no timestamp `expiresAt`.
//   Usamos o endDate do mercado selecionado — a ordem some
//   junto com o mercado se não for preenchida.
// ============================================================

const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
const { ethers } = require("ethers");
const { getOrderBook } = require("./market"); // Reutiliza o axios que já funciona
const config = require("./config");
const logger = require("./logger");

let _client = null;

// ============================================================
// Inicializa o ClobClient autenticado (singleton)
// Credenciais só são lidas aqui — nunca antes
// ============================================================
async function initClient() {
  if (_client) return _client;

  const creds = config.loadTradingCredentials();

  // Ethers v5: Wallet sem provider (só assina, não precisa de RPC)
  const wallet = new ethers.Wallet(creds.privateKey);

  // ClobClient v4: (host, chainId, signer, creds, signatureType?)
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

// ============================================================
// Validação local dos parâmetros da ordem
// Roda ANTES de qualquer chamada de rede
// ============================================================
function validateOrderParams({ tokenId, price, side, sizeUsdc }) {
  const errors = [];

  if (!tokenId || typeof tokenId !== "string" || tokenId.length < 10)
    errors.push("tokenId ausente ou inválido");

  if (typeof price !== "number" || price <= 0 || price >= 1)
    errors.push(`Preço inválido: ${price} (deve ser > 0 e < 1)`);

  if (typeof sizeUsdc !== "number" || sizeUsdc <= 0)
    errors.push(`Tamanho inválido: ${sizeUsdc}`);

  if (sizeUsdc > config.maxBetSizeUsdc)
    errors.push(
      `Tamanho ${sizeUsdc} USDC excede o limite de segurança (${config.maxBetSizeUsdc} USDC). ` +
      `Ajuste MAX_BET_SIZE_USDC no .env para aumentar.`
    );

  if (!["BUY", "SELL"].includes(String(side).toUpperCase()))
    errors.push(`Side inválido: ${side}`);

  // Verifica mínimo de shares resultante (Polymarket rejeita ordens < 2 shares)
  // Só verifica se price e sizeUsdc são válidos para não gerar NaN
  if (typeof price === "number" && price > 0 && price < 1 &&
      typeof sizeUsdc === "number" && sizeUsdc > 0) {
    const normalizedSide = String(side).toUpperCase();
    const estimatedShares = normalizedSide === "BUY"
      ? Math.floor((sizeUsdc / price) * 100) / 100
      : Math.floor((sizeUsdc / (1 - price)) * 100) / 100;

    if (estimatedShares < 2) {
      errors.push(
        `Shares estimado (${estimatedShares}) abaixo do mínimo da Polymarket (2 shares). ` +
        `Aumente MAX_BET_SIZE_USDC ou escolha um preço mais baixo.`
      );
    }
  }

  if (errors.length > 0)
    return { ok: false, reason: errors.join(" | ") };

  return { ok: true };
}

// ============================================================
// Verifica se o preço da ordem não cruza o spread atual
//
// BUY:  nosso preço deve ser MENOR que o melhor ask
//       (se for igual ou maior → executaria imediatamente → taker)
// SELL: nosso preço deve ser MAIOR que o melhor bid
//
// Usa o getOrderBook() do market.js (axios) que já está validado
// ============================================================
async function checkPostOnlySafe(tokenId, side, desiredPrice) {
  const book = await getOrderBook(tokenId);

  const bestAsk = book.asks?.[0]?.price != null ? parseFloat(book.asks[0].price) : null;
  const bestBid = book.bids?.[0]?.price != null ? parseFloat(book.bids[0].price) : null;

  logger.info(`  Orderbook atual — Best Bid: ${bestBid ?? "N/A"} | Best Ask: ${bestAsk ?? "N/A"}`);

  if (side === "BUY" && bestAsk !== null && desiredPrice >= bestAsk) {
    return {
      safe: false,
      reason:
        `Preço de compra ${desiredPrice} >= best ask ${bestAsk}. ` +
        `A ordem cruzaria o spread e viraria taker. Abortando.`,
      bestBid,
      bestAsk,
    };
  }

  if (side === "SELL" && bestBid !== null && desiredPrice <= bestBid) {
    return {
      safe: false,
      reason:
        `Preço de venda ${desiredPrice} <= best bid ${bestBid}. ` +
        `A ordem cruzaria o spread e viraria taker. Abortando.`,
      bestBid,
      bestAsk,
    };
  }

  return { safe: true, bestBid, bestAsk };
}

// ============================================================
// Converte USDC → shares com truncamento seguro
//
// Na Polymarket, shares têm precisão de 2 casas decimais.
// Truncamos (floor) em vez de arredondar para nunca ultrapassar
// o sizeUsdc máximo configurado.
//
// Fórmula:
//   BUY:  shares = sizeUsdc / price
//         (pagamos `price` por share, queremos `sizeUsdc` no total)
//   SELL: shares = sizeUsdc / (1 - price)
//         (recebemos `1 - price` por share ao vender)
// ============================================================
function calcShares(sizeUsdc, price, side) {
  const raw = side === "BUY"
    ? sizeUsdc / price
    : sizeUsdc / (1 - price);

  // Trunca em 2 casas decimais (nunca arredonda para cima)
  return Math.floor(raw * 100) / 100;
}

// ============================================================
// FUNÇÃO PRINCIPAL: Coloca uma ordem Post-Only GTD
//
// Parâmetros aceitos:
//   tokenId   — ID do token Up ou Down
//   price     — Preço por share (0.01 a 0.99)
//   side      — "BUY" ou "SELL"
//   sizeUsdc  — Valor em USDC a arriscar (≤ MAX_BET_SIZE_USDC)
//   expiresAt — Timestamp Unix (segundos) de expiração da ordem
//               Padrão: endDate do mercado atual
//   dryRun    — true = simula sem enviar (recomendado para testes)
// ============================================================
async function placePostOnlyGtdOrder({
  tokenId,
  price,
  side,
  sizeUsdc,
  expiresAt,
  dryRun = false,
}) {
  logger.divider();
  logger.info(`🎯 Preparando ordem Post-Only GTD  [dryRun: ${dryRun}]`);
  logger.divider();

  // ── CAMADA 1: Validação de parâmetros ──────────────────────
  const validation = validateOrderParams({ tokenId, price, side, sizeUsdc });
  if (!validation.ok) {
    logger.error(`❌ Validação falhou: ${validation.reason}`);
    return { success: false, reason: validation.reason };
  }
  logger.success("Validação de parâmetros OK");

  // ── CAMADA 2: Verificação Post-Only (sem credenciais) ───────
  const normalizedSide = side.toUpperCase();
  const postOnlyCheck = await checkPostOnlySafe(tokenId, normalizedSide, price);

  if (!postOnlyCheck.safe) {
    logger.warn(`⚠️  Post-Only check falhou: ${postOnlyCheck.reason}`);
    return { success: false, reason: postOnlyCheck.reason, spread: postOnlyCheck };
  }
  logger.success(`Post-Only check OK — Best Bid: ${postOnlyCheck.bestBid} | Best Ask: ${postOnlyCheck.bestAsk}`);

  // ── CAMADA 3: Cálculo de shares ────────────────────────────
  const shares = calcShares(sizeUsdc, price, normalizedSide);
  if (shares <= 0) {
    const reason = `Shares calculado é zero ou negativo (${shares}). Verifique price e sizeUsdc.`;
    logger.error(reason);
    return { success: false, reason };
  }

  // Expiração: endDate do mercado, ou +5min como fallback
  const expiry = expiresAt ?? Math.floor(Date.now() / 1000) + 300;

  logger.info("📋 Resumo da ordem:");
  logger.info(`   Token    : ${tokenId.slice(0, 20)}...`);
  logger.info(`   Side     : ${normalizedSide}`);
  logger.info(`   Preço    : ${price} (${(price * 100).toFixed(2)}%)`);
  logger.info(`   Shares   : ${shares}`);
  logger.info(`   Total    : ~${(shares * price).toFixed(2)} USDC`);
  logger.info(`   Expira   : ${new Date(expiry * 1000).toISOString()}`);

  // ── DRY-RUN: Para aqui sem tocar em credenciais ─────────────
  if (dryRun) {
    logger.warn("🧪 DRY-RUN: ordem NÃO enviada. Todas as verificações passaram.");
    return {
      success: true,
      dryRun: true,
      simulatedOrder: { tokenId, side: normalizedSide, price, shares, expiry },
    };
  }

  // ── CAMADA 4: Autenticação e envio ──────────────────────────
  logger.info("🔐 Inicializando cliente autenticado...");
  const client = await initClient();

  logger.info("✍️  Assinando ordem localmente...");
  const order = await client.createOrder({
    tokenID: tokenId,
    price,
    side: normalizedSide === "BUY" ? Side.BUY : Side.SELL,
    size: shares,
    expiration: expiry,
  });

  logger.info("📡 Enviando para a exchange (GTD)...");
  const response = await client.postOrder(order, OrderType.GTD);

  if (response?.success || response?.orderID) {
    logger.success("✅ Ordem enviada com sucesso!", {
      orderId: response.orderID,
      status: response.status,
      errorMsg: response.errorMsg || null,
    });
    return { success: true, orderId: response.orderID, response };
  } else {
    logger.error("❌ Exchange rejeitou a ordem:", response);
    return { success: false, response };
  }
}

// ============================================================
// Cancela uma ordem aberta pelo ID
// ============================================================
async function cancelOrder(orderId) {
  const client = await initClient();
  logger.info(`🗑  Cancelando ordem: ${orderId}`);
  const result = await client.cancelOrder({ orderID: orderId });
  logger.success("Ordem cancelada.", result);
  return result;
}

// ============================================================
// Lista ordens abertas (todas, ou filtradas por market)
// ============================================================
async function getOpenOrders(marketId) {
  const client = await initClient();
  const params = marketId ? { market: marketId } : {};
  const orders = await client.getOpenOrders(params);
  logger.info(`Ordens abertas: ${orders?.length ?? 0}`);
  return orders;
}

module.exports = {
  placePostOnlyGtdOrder,
  cancelOrder,
  getOpenOrders,
  initClient,
};
