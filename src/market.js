// src/market.js
// ============================================================
// FASE 1 — MVP: Consulta de mercado (somente leitura)
// ============================================================
// O mercado BTC 5min da Polymarket se chama:
//   "Bitcoin Up or Down - February 22, 1:30PM-1:35PM ET"
// Não contém "5min", "higher", etc. — padrão descoberto via debug.
//
// A Gamma API retorna mercados passados como "active=true",
// então filtramos também por endDate > agora.
// ============================================================

const axios = require("axios");
const config = require("./config");
const logger = require("./logger");

const clobApi = axios.create({
  baseURL: config.clobHost,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

const gammaApi = axios.create({
  baseURL: "https://gamma-api.polymarket.com",
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

// ============================================================
// Filtro — baseado no nome real descoberto via debug:
//   "Bitcoin Up or Down - February 22, 1:30PM-1:35PM ET"
// ============================================================
function filterBtcMarkets(markets) {
  const now = new Date();

  return markets.filter((m) => {
    const q = (m.question || m.title || m.description || "").toLowerCase();

    // Descarta mercados já encerrados (endDate no passado)
    const endDate = m.endDate || m.end_date || m.endDateIso;
    if (endDate && new Date(endDate) < now) return false;

    const isActive = m.active !== false && m.closed !== true && m.archived !== true;
    if (!isActive) return false;

    const isBtc = q.includes("bitcoin") || q.includes("btc") || q.includes("₿");

    // Padrão real: "bitcoin up or down"
    // Mantém os outros padrões como fallback
    const is5min =
      q.includes("up or down") ||          // ← padrão real descoberto
      q.includes("5 min") ||
      q.includes("5min") ||
      q.includes("5-min") ||
      q.includes("5 minute") ||
      q.includes("five minute") ||
      (q.includes("5") && q.includes("minute"));

    return isBtc && is5min;
  });
}

// ============================================================
// ESTRATÉGIA 1: Gamma API — ordenada por endDate ascendente
// com filtro de endDate > agora aplicado no lado cliente
// ============================================================
async function findBtcMarketsViaGamma() {
  logger.info("[Gamma API] Buscando mercados Bitcoin Up or Down ativos...");

  const now = new Date();
  // Passa a data atual como filtro mínimo (Gamma pode suportar endDate_min)
  const endDateMin = now.toISOString();

  let found = [];
  let offset = 0;
  const limit = 100;
  const MAX_ROUNDS = 8; // Até 800 mercados

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const response = await gammaApi.get("/markets", {
        params: {
          active: true,
          closed: false,
          archived: false,
          order: "endDate",
          ascending: true,
          end_date_min: endDateMin, // Filtra no servidor se suportado
          limit,
          offset,
        },
      });

      const markets = Array.isArray(response.data)
        ? response.data
        : response.data?.markets || response.data?.data || [];

      if (markets.length === 0) {
        logger.info(`[Gamma] Rodada ${round + 1}: sem mais resultados.`);
        break;
      }

      // Aplica filtro de data no cliente (garante mesmo que o servidor ignore)
      const futureMarkets = markets.filter((m) => {
        const end = m.endDate || m.end_date;
        return end && new Date(end) > now;
      });

      logger.info(`[Gamma] Rodada ${round + 1} (offset ${offset}): ${markets.length} total, ${futureMarkets.length} com endDate futuro. Top 5:`);
      futureMarkets.slice(0, 5).forEach((m) => {
        const title = m.question || m.title || "(sem título)";
        const end = m.endDate || m.end_date || "?";
        logger.info(`  → [${end}] "${title}"`);
      });

      const filtered = filterBtcMarkets(futureMarkets);

      if (filtered.length > 0) {
        logger.success(`[Gamma] ${filtered.length} mercado(s) BTC ativos encontrados!`);
        found = found.concat(filtered);
        break;
      }

      // Se não achou mercados futuros nesta rodada, não tem mais para ver
      if (futureMarkets.length === 0) {
        logger.warn(`[Gamma] Sem mais mercados futuros — encerrando busca.`);
        break;
      }

      offset += limit;
    } catch (err) {
      logger.warn(`[Gamma] Rodada ${round + 1} falhou: ${err.message}`);
      break;
    }
  }

  const seen = new Set();
  return found.filter((m) => {
    const id = m.conditionId || m.condition_id || m.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ============================================================
// ESTRATÉGIA 2: CLOB API — lê as últimas páginas (mais recentes)
// ============================================================
async function findBtcMarketsViaCLOB() {
  logger.info("[CLOB API] Mapeando páginas para encontrar mercados recentes...");

  let cursors = [null];
  let cursor = null;
  const SCOUT_PAGES = 80;

  for (let i = 0; i < SCOUT_PAGES; i++) {
    try {
      const params = { limit: 1 };
      if (cursor) params.next_cursor = cursor;
      const res = await clobApi.get("/markets", { params });
      const next = res.data?.next_cursor;
      if (!next || next === "LTE=") break;
      cursor = next;
      cursors.push(cursor);
    } catch {
      break;
    }
  }

  logger.info(`[CLOB] ${cursors.length} páginas mapeadas. Lendo as últimas 20...`);

  const lastCursors = cursors.slice(-20);
  let found = [];

  for (let i = lastCursors.length - 1; i >= 0; i--) {
    const pageCursor = lastCursors[i];
    logger.info(`[CLOB] Lendo página ${lastCursors.length - i}/${lastCursors.length}...`);

    try {
      const params = { limit: 1000 };
      if (pageCursor) params.next_cursor = pageCursor;
      const res = await clobApi.get("/markets", { params });
      const batch = res.data?.data || [];

      logger.info(`  ${batch.length} mercados. Amostra:`);
      batch.slice(0, 3).forEach((m) =>
        logger.info(`  → "${m.question}" | active:${m.active} | closed:${m.closed}`)
      );

      const filtered = filterBtcMarkets(batch);
      found = found.concat(filtered);
      if (found.length > 0) break;
    } catch (err) {
      logger.warn(`[CLOB] Erro: ${err.message}`);
    }
  }

  return found;
}

// ============================================================
// Normaliza campos entre Gamma API e CLOB API
// ============================================================
function normalizeMarket(m) {
  // Constrói lista de tokens a partir dos diferentes formatos possíveis:
  //
  // CLOB API:  m.tokens = [{ outcome: "Yes", token_id: "0x..." }, ...]
  // Gamma API: m.clobTokenIds = ["0x...", "0x..."]
  //            m.outcomes = "Yes\nNo" (string separada por \n) OU array
  //            m.outcomePrices = "0.5\n0.5"
  let tokens = [];

  if (Array.isArray(m.tokens) && m.tokens.length > 0) {
    // Formato CLOB: ja vem pronto
    tokens = m.tokens;
  } else if (m.clobTokenIds) {
    // Formato Gamma: clobTokenIds e outcomes chegam como string JSON '["a","b"]'
    const parseField = (field) => {
      if (Array.isArray(field)) return field;
      const s = String(field).trim();
      if (s.startsWith("[")) {
        try { return JSON.parse(s); } catch (e) {}
      }
      return s.split("\n").filter(Boolean);
    };

    const ids = parseField(m.clobTokenIds);
    const outcomeLabels = m.outcomes ? parseField(m.outcomes) : ["Up", "Down"];

    tokens = ids.map((id, i) => ({
      outcome: outcomeLabels[i] || ("Outcome " + (i + 1)),
      token_id: String(id),
    }));
  }

  return {
    question: m.question || m.title || "(sem título)",
    condition_id: m.conditionId || m.condition_id || "",
    active: m.active !== false,
    closed: m.closed === true,
    end_date: m.endDate || m.end_date || null,
    tokens,
    _raw: m,
  };
}

// ============================================================
// CLOB: orderbook, midpoint, spread, mercado por ID
// ============================================================
async function getOrderBook(tokenId) {
  const response = await clobApi.get("/book", { params: { token_id: tokenId } });
  return response.data;
}

async function getMidpoint(tokenId) {
  const response = await clobApi.get("/midpoint", { params: { token_id: tokenId } });
  return parseFloat(response.data.mid);
}

async function getSpread(tokenId) {
  const response = await clobApi.get("/spread", { params: { token_id: tokenId } });
  return response.data;
}

async function getMarketByConditionId(conditionId) {
  const response = await clobApi.get(`/markets/${conditionId}`);
  return response.data;
}

// ============================================================
// Exibe resumo do mercado com orderbook
// ============================================================
async function displayMarketSummary(rawMarket) {
  const market = normalizeMarket(rawMarket);

  logger.divider();
  logger.info(`📊 MERCADO  : ${market.question}`);
  logger.info(`   Condition ID : ${market.condition_id}`);
  logger.info(`   Encerra em   : ${market.end_date || "?"}`);
  logger.info(`   Status       : ${market.active && !market.closed ? "🟢 ATIVO" : "🔴 FECHADO"}`);

  if (!market.tokens || market.tokens.length === 0) {
    logger.warn("Nenhum token encontrado. Configure BTC_MARKET_CONDITION_ID manualmente.");
    return;
  }

  for (const token of market.tokens) {
    if (!token.token_id) {
      logger.warn(`  Token ${token.outcome}: token_id ausente — pulando orderbook.`);
      continue;
    }

    logger.divider();
    logger.info(`  Token : ${token.outcome}  (${token.token_id})`);

    try {
      const [book, mid, spread] = await Promise.all([
        getOrderBook(token.token_id),
        getMidpoint(token.token_id),
        getSpread(token.token_id),
      ]);

      const topBids = (book.bids || []).slice(0, 3);
      const topAsks = (book.asks || []).slice(0, 3);

      logger.info(`  Midpoint : ${(mid * 100).toFixed(2)}%`);
      logger.info(`  Spread   : ${spread.spread}`);

      logger.info("  Top Asks (melhor preço de venda):");
      if (topAsks.length === 0) console.log("       (sem asks)");
      topAsks.forEach((a) => console.log(`       Preço: ${a.price}  |  Tamanho: ${a.size}`));

      logger.info("  Top Bids (melhor preço de compra):");
      if (topBids.length === 0) console.log("       (sem bids)");
      topBids.forEach((b) => console.log(`       Preço: ${b.price}  |  Tamanho: ${b.size}`));
    } catch (err) {
      logger.error(`  Erro ao consultar orderbook de ${token.outcome}`, err);
    }
  }
}

// ============================================================
// Função principal da Fase 1
// ============================================================
async function runMarketQuery() {
  logger.divider();
  logger.info("🤖 POLYMARKET BOT — FASE 1: Consulta de Mercado");
  logger.info(`   CLOB Host : ${config.clobHost}`);
  logger.info(`   Chain ID  : ${config.chainId}`);
  logger.divider();

  try {
    let markets = [];

    if (config.btcConditionId) {
      logger.info(`Usando condition_id do .env: ${config.btcConditionId}`);
      const market = await getMarketByConditionId(config.btcConditionId);
      markets = [market];
    } else {
      markets = await findBtcMarketsViaGamma();

      if (markets.length === 0) {
        logger.warn("Gamma não encontrou. Tentando CLOB...");
        markets = await findBtcMarketsViaCLOB();
      }
    }

    if (markets.length === 0) {
      logger.warn("Nenhum mercado BTC ativo encontrado pelas APIs automáticas.");
      logger.divider();
      logger.info("💡 Solução manual:");
      logger.info("   1. Acesse https://polymarket.com e abra o mercado 'Bitcoin Up or Down'");
      logger.info('   2. DevTools (F12) → Network → filtre por "markets"');
      logger.info("   3. Copie o condition_id da requisição /markets/<id>");
      logger.info("   4. Cole em BTC_MARKET_CONDITION_ID no .env");
      logger.info("   5. Execute: npm run market");
      return;
    }

    logger.success(`${markets.length} mercado(s) encontrado(s)!`);

    for (const market of markets.slice(0, 3)) {
      await displayMarketSummary(market);
    }

    logger.divider();
    logger.success("Consulta concluída.");
    logger.info("💡 Configure BTC_MARKET_CONDITION_ID no .env com o condition_id acima.");
  } catch (err) {
    logger.error("Falha ao consultar mercado", err);
    process.exit(1);
  }
}

module.exports = {
  runMarketQuery,
  findBtcMarketsViaGamma,
  findBtcMarketsViaCLOB,
  getOrderBook,
  getMidpoint,
  getSpread,
  getMarketByConditionId,
  normalizeMarket,
};
