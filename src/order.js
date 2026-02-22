// src/order.js — CARCARÁ BOT
// ============================================================
// FASE 2 — Ordens Maker-or-Cancel (Post-Only real)
// ============================================================
// Fluxo garantido sem taxa:
//
//   1. validateOrderParams  — validação local dos parâmetros
//   2. calcMakerPrice       — calcula preço que maximiza chance
//                             de entrar como maker no book
//   3. initClient           — autenticação (só carrega credenciais aqui)
//   4. createOrder          — SDK assina a ordem localmente
//   5. postOrder(GTD, true) — 4º parâmetro = maker-or-cancel:
//                             se cruzar com o AMM na hora → cancela
//                             se entrar no book → fica aberta
//   6. Aguarda 3 segundos   — janela para preenchimento maker
//   7. cancelOrder          — cancela qualquer saldo restante
//   8. getOrder             — verifica quanto foi preenchido
//
// Resultado possível:
//   matchedSize > 0 → preenchido como MAKER, sem taxa ✅
//   matchedSize = 0 → não preenchido, cancelado, sem custo ✅
//   NUNCA           → taker fill com taxa ✅
// ============================================================

const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
const { ethers } = require("ethers");
const { getOrderBook } = require("./market");
const config = require("./config");
const logger = require("./logger");

let _client = null;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ============================================================
// Inicializa o ClobClient autenticado (singleton)
// ============================================================
async function initClient() {
  if (_client) return _client;

  const creds = config.loadTradingCredentials();
  const wallet = new ethers.Wallet(creds.privateKey);

  const signatureType = config.proxyWallet ? 1 : 0;
  const funder = config.proxyWallet || undefined;

  _client = new ClobClient(
    config.clobHost,
    config.chainId,
    wallet,
    {
      key: creds.apiKey,
      secret: creds.apiSecret,
      passphrase: creds.apiPassphrase,
    },
    signatureType,
    funder
  );

  logger.success(`Carcará autenticado — carteira: ${wallet.address}`);
  if (funder) logger.info(`   Proxy wallet (funder): ${funder}`);
  return _client;
}

// ============================================================
// Validação local dos parâmetros — roda antes de qualquer rede
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

  // Mínimo de 2 shares (limite da Polymarket)
  if (typeof price === "number" && price > 0 && price < 1 &&
      typeof sizeUsdc === "number" && sizeUsdc > 0) {
    const normalizedSide = String(side).toUpperCase();
    const estimatedShares = normalizedSide === "BUY"
      ? Math.floor((sizeUsdc / price) * 100) / 100
      : Math.floor((sizeUsdc / (1 - price)) * 100) / 100;

    if (estimatedShares < 5) {
      errors.push(
        `Shares estimado (${estimatedShares}) abaixo do mínimo da Polymarket (5 shares). ` +
        `Aumente MAX_BET_SIZE_USDC para pelo menos ${(5 * price).toFixed(2)} USDC.`
      );
    }
  }

  if (errors.length > 0) return { ok: false, reason: errors.join(" | ") };
  return { ok: true };
}

// ============================================================
// Calcula o melhor preço de maker possível
// ============================================================
// Lógica:
//   BUY:  usa best bid do CLOB se existir e for real (> 0.01)
//         senão: midpoint - margem
//   SELL: usa best ask do CLOB se existir e for real (< 0.99)
//         senão: midpoint + margem
//
// Margem padrão de 0.02 para garantir que não cruza com o AMM.
// Nos mercados BTC 5min com CLOB vazio, a ordem entrará no book
// e será preenchida quando (e se) alguém cruzar com ela.
// ============================================================
async function calcMakerPrice(tokenId, side, midpoint, margin = 0.02) {
  const book = await getOrderBook(tokenId);

  const bestBid = book.bids?.[0]?.price != null ? parseFloat(book.bids[0].price) : null;
  const bestAsk = book.asks?.[0]?.price != null ? parseFloat(book.asks[0].price) : null;

  let price;

  if (side === "BUY") {
    if (bestBid !== null && bestBid > 0.01) {
      price = bestBid;
      logger.info(`  Preço maker: best bid do CLOB = ${bestBid}`);
    } else {
      price = parseFloat((midpoint - margin).toFixed(2));
      logger.info(`  Preço maker: midpoint(${midpoint}) - margem(${margin}) = ${price}`);
    }
  } else {
    if (bestAsk !== null && bestAsk < 0.99) {
      price = bestAsk;
      logger.info(`  Preço maker: best ask do CLOB = ${bestAsk}`);
    } else {
      price = parseFloat((midpoint + margin).toFixed(2));
      logger.info(`  Preço maker: midpoint(${midpoint}) + margem(${margin}) = ${price}`);
    }
  }

  return Math.min(Math.max(price, 0.01), 0.99);
}

// ============================================================
// Converte USDC → shares com truncamento (nunca arredonda p/ cima)
// ============================================================
function calcShares(sizeUsdc, price, side) {
  const raw = side === "BUY"
    ? sizeUsdc / price
    : sizeUsdc / (1 - price);
  return Math.floor(raw * 100) / 100;
}

// ============================================================
// FUNÇÃO PRINCIPAL — Ordem Maker-or-Cancel
// ============================================================
// Garante que NUNCA paga taxa de taker:
//   - Se cruzar com AMM na hora → cancela automaticamente
//   - Se ficar no book → aguarda 3s, cancela restante
//   - Só cobra taxa se for preenchida como MAKER (0 bps)
// ============================================================
async function placePostOnlyGtdOrder({
  tokenId,
  price,
  side,
  sizeUsdc,
  expiresAt,
  waitMs = 3000,   // tempo de espera antes de cancelar restante
  dryRun = false,
}) {
  logger.divider();
  logger.info(`🦅 CARCARÁ — Ordem Maker-or-Cancel  [dryRun: ${dryRun}]`);
  logger.divider();

  // ── Validação ────────────────────────────────────────────
  const validation = validateOrderParams({ tokenId, price, side, sizeUsdc });
  if (!validation.ok) {
    logger.error(`Validação falhou: ${validation.reason}`);
    return { success: false, reason: validation.reason };
  }
  logger.success("Parâmetros validados.");

  const normalizedSide = side.toUpperCase();
  const shares = calcShares(sizeUsdc, price, normalizedSide);
  const expiry = expiresAt ?? Math.floor(Date.now() / 1000) + 300;

  logger.info("📋 Ordem:");
  logger.info(`   Side   : ${normalizedSide}`);
  logger.info(`   Preço  : ${price} (${(price * 100).toFixed(2)}%)`);
  logger.info(`   Shares : ${shares}`);
  logger.info(`   Total  : ~${(shares * price).toFixed(2)} USDC`);
  logger.info(`   Expira : ${new Date(expiry * 1000).toISOString()}`);

  // ── DRY-RUN ──────────────────────────────────────────────
  if (dryRun) {
    logger.warn("🧪 DRY-RUN: ordem NÃO enviada.");
    return {
      success: true,
      dryRun: true,
      simulatedOrder: { tokenId, side: normalizedSide, price, shares, expiry },
    };
  }

  // ── Autenticação ─────────────────────────────────────────
  const client = await initClient();

  // ── Assina a ordem ───────────────────────────────────────
  logger.info("✍️  Assinando...");
  const order = await client.createOrder({
    tokenID: tokenId,
    price,
    side: normalizedSide === "BUY" ? Side.BUY : Side.SELL,
    size: shares,
    feeRateBps: 1000,       // exigido pelo SDK para assinar
    expiration: expiry,
  });

  // ── Envia: Maker-or-Cancel ────────────────────────────────
  // postOrder(order, orderType, immediateOrCancel, makerOrCancel)
  //   immediateOrCancel = false → não cancela se não for preenchida toda
  //   makerOrCancel     = true  → CANCELA se cruzar com AMM (vira taker)
  logger.info("📡 Enviando (Maker-or-Cancel)...");
  let response;
  try {
    response = await client.postOrder(order, OrderType.GTD, false, true);
  } catch (err) {
    const errMsg = err?.response?.data?.error || err?.message || String(err);

    // Maker-or-cancel: cruzaria com AMM → SDK pode lançar como erro
    if (errMsg.toLowerCase().includes("cancel") || errMsg.toLowerCase().includes("match")) {
      logger.warn("⚡ Ordem cancelada na hora (cruzaria com AMM). Sem taxa. ✅");
      return { success: true, filled: false, takerFill: false, cancelledImmediately: true };
    }

    // Erro real da exchange (ex: size inválido) — não tenta cancelar
    logger.error(`Exchange rejeitou: ${errMsg}`);
    return { success: false, reason: errMsg };
  }

  // Verifica se a resposta é um erro disfarçado de objeto
  if (!response?.orderID && (response?.status >= 400 || response?.error)) {
    const errMsg = response?.error || response?.data?.error || JSON.stringify(response);
    logger.error(`Exchange rejeitou: ${errMsg}`);
    return { success: false, reason: errMsg };
  }

  const orderId = response.orderID;
  logger.info(`   Order ID: ${orderId}`);
  logger.info(`   Status  : ${response.status}`);

  // Se já foi cancelada imediatamente (maker-or-cancel)
  if (response.status === "canceled" || response.status === "cancelled") {
    logger.warn("⚡ Maker-or-cancel: ordem cancelada (cruzaria com AMM). Sem taxa. ✅");
    return { success: true, filled: false, takerFill: false, cancelledImmediately: true };
  }

  // ── Aguarda preenchimento no book ─────────────────────────
  logger.info(`⏳ Aguardando ${waitMs / 1000}s para preenchimento maker...`);
  await sleep(waitMs);

  // ── Cancela o restante ────────────────────────────────────
  try {
    await client.cancelOrder({ orderID: orderId });
    logger.info("🗑  Restante cancelado.");
  } catch {
    // Pode já ter sido totalmente preenchida — normal
  }

  // ── Verifica quanto foi preenchido ────────────────────────
  let orderStatus;
  try {
    orderStatus = await client.getOrder(orderId);
  } catch (err) {
    logger.warn("Não foi possível consultar status final da ordem.", err);
    return { success: true, orderId, filled: null };
  }

  const matchedSize = parseFloat(orderStatus.size_matched || orderStatus.sizeMatched || "0");
  const totalSize = parseFloat(orderStatus.size || orderStatus.original_size || shares);
  const filledPct = totalSize > 0 ? ((matchedSize / totalSize) * 100).toFixed(1) : "0";

  logger.divider();

  if (matchedSize > 0) {
    const valueFilled = (matchedSize * price).toFixed(2);
    logger.success(`✅ Preenchido como MAKER: ${matchedSize}/${totalSize} shares (${filledPct}%) = ~${valueFilled} USDC`);
    logger.success("   Sem taxa de taker. 🦅");
  } else {
    logger.info("📭 Não preenchida. Cancelada sem custo.");
  }

  return {
    success: true,
    orderId,
    filled: matchedSize > 0,
    takerFill: false,       // garantido pelo maker-or-cancel
    matchedSize,
    totalSize,
    filledPct: parseFloat(filledPct),
    orderStatus,
  };
}

// ============================================================
// Cancela uma ordem aberta pelo ID
// ============================================================
async function cancelOrder(orderId) {
  const client = await initClient();
  logger.info(`🗑  Cancelando: ${orderId}`);
  const result = await client.cancelOrder({ orderID: orderId });
  logger.success("Ordem cancelada.", result);
  return result;
}

// ============================================================
// Lista ordens abertas
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
  calcMakerPrice,
  cancelOrder,
  getOpenOrders,
  initClient,
};
