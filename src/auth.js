// src/auth.js
// ============================================================
// GERAÇÃO E VERIFICAÇÃO DE CREDENCIAIS POLYMARKET
// ============================================================
// As API keys da Polymarket NÃO são geradas pela UI do site.
// Elas são derivadas criptograficamente da chave privada da
// carteira via assinatura EIP-712.
//
// Este módulo oferece dois fluxos:
//
//  1. deriveApiKey()  — deriva as credenciais deterministicamente
//     da carteira. Sempre gera as mesmas keys para a mesma
//     carteira. Não cria uma nova key, recupera a existente.
//
//  2. createApiKey()  — cria um novo conjunto de credenciais
//     (key/secret/passphrase) na exchange. Use se deriveApiKey
//     retornar 401 (key nunca foi registrada).
//
//  3. checkCredentials() — testa se as credenciais do .env
//     estão corretas fazendo uma chamada autenticada simples.
// ============================================================

const { ClobClient } = require("@polymarket/clob-client");
const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");

// ============================================================
// Inicializa cliente L1 (só wallet, sem API key)
// Usado para criar/derivar as credenciais
// ============================================================
function initL1Client(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  // L1 = sem credentials (4º argumento omitido)
  return new ClobClient(config.clobHost, config.chainId, wallet);
}

// ============================================================
// Inicializa cliente L2 (wallet + API key)
// Usado para verificar credenciais
// ============================================================
function initL2Client(privateKey, apiKey, apiSecret, apiPassphrase) {
  const wallet = new ethers.Wallet(privateKey);
  return new ClobClient(config.clobHost, config.chainId, wallet, {
    key: apiKey,
    secret: apiSecret,
    passphrase: apiPassphrase,
  });
}

// ============================================================
// PASSO 1 — Derive API Key
// ============================================================
// Recupera deterministicamente as credenciais associadas
// a esta carteira. Se a key nunca foi criada, retorna erro.
// Nesse caso, use createApiKey() abaixo.
// ============================================================
async function deriveApiKey() {
  logger.info("🔑 Derivando API key da carteira...");

  const { privateKey } = config.loadTradingCredentials();
  const wallet = new ethers.Wallet(privateKey);

  logger.info(`   Carteira: ${wallet.address}`);

  const client = initL1Client(privateKey);

  try {
    const creds = await client.deriveApiKey();

    logger.success("Credenciais derivadas com sucesso!");
    logger.divider();
    logger.info("Cole estas linhas no seu .env:");
    logger.divider();
    console.log(`CLOB_API_KEY=${creds.key}`);
    console.log(`CLOB_API_SECRET=${creds.secret}`);
    console.log(`CLOB_API_PASSPHRASE=${creds.passphrase}`);
    logger.divider();

    return creds;
  } catch (err) {
    if (err?.response?.status === 404 || err?.message?.includes("not found")) {
      logger.warn("Nenhuma API key encontrada para esta carteira.");
      logger.info("Execute com --mode=auth --action=create para criar uma.");
    } else {
      logger.error("Erro ao derivar API key", err);
    }
    return null;
  }
}

// ============================================================
// PASSO 2 — Create API Key (se deriveApiKey falhar)
// ============================================================
// Cria e registra um novo conjunto de credenciais na exchange.
// Após criar, anote o output e cole no .env.
// ============================================================
async function createApiKey() {
  logger.info("🔑 Criando nova API key na Polymarket...");

  const { privateKey } = config.loadTradingCredentials();
  const wallet = new ethers.Wallet(privateKey);

  logger.info(`   Carteira: ${wallet.address}`);
  logger.warn("   Isso registra uma nova key na exchange.");

  const client = initL1Client(privateKey);

  try {
    const creds = await client.createApiKey();

    logger.success("Nova API key criada com sucesso!");
    logger.divider();
    logger.info("⚠️  Salve imediatamente — o secret não é recuperável depois:");
    logger.divider();
    console.log(`CLOB_API_KEY=${creds.key}`);
    console.log(`CLOB_API_SECRET=${creds.secret}`);
    console.log(`CLOB_API_PASSPHRASE=${creds.passphrase}`);
    logger.divider();
    logger.info("Cole estas linhas no .env e execute: npm run dry");

    return creds;
  } catch (err) {
    logger.error("Erro ao criar API key", err);
    return null;
  }
}

// ============================================================
// PASSO 3 — Verificar credenciais atuais do .env
// ============================================================
async function checkCredentials() {
  logger.info("🔍 Verificando credenciais do .env...");

  let creds;
  try {
    creds = config.loadTradingCredentials();
  } catch (err) {
    logger.error("Credenciais não configuradas no .env", err);
    return false;
  }

  const wallet = new ethers.Wallet(creds.privateKey);
  logger.info(`   Carteira     : ${wallet.address}`);
  logger.info(`   CLOB_API_KEY : ${creds.apiKey}`);

  const client = initL2Client(
    creds.privateKey,
    creds.apiKey,
    creds.apiSecret,
    creds.apiPassphrase
  );

  try {
    // Chamada autenticada leve: lista as API keys desta carteira
    // É o endpoint mais simples que requer autenticação L2 completa
    const apiKeys = await client.getApiKeys();
    logger.success("Credenciais válidas!");
    logger.info(`   API keys registradas: ${apiKeys?.length ?? JSON.stringify(apiKeys)}`);
    return true;
  } catch (err) {
    const status = err?.response?.status || err?.status;
    if (status === 401) {
      logger.error("Credenciais inválidas (401). Tente:");
      logger.info("   node src/index.js --mode=auth --action=derive");
      logger.info("   node src/index.js --mode=auth --action=create");
    } else {
      logger.error("Erro ao verificar credenciais", err);
    }
    return false;
  }
}

// ============================================================
// Runner principal do modo auth
// ============================================================
// ============================================================
// Diagnóstico de saldo e allowance
// ============================================================
// O contrato CTF Exchange da Polymarket precisa de aprovação
// explícita para gastar USDC da sua carteira (ERC-20 allowance).
// Este comando verifica e aprova se necessário.
// ============================================================
async function checkAndApprove() {
  logger.info("💰 Verificando saldo e allowance na Polygon...");

  const { privateKey } = config.loadTradingCredentials();
  const wallet = new ethers.Wallet(privateKey);
  logger.info(`   Carteira: ${wallet.address}`);

  // Endereços na Polygon Mainnet
  const USDC_ADDRESS       = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e (bridged)
  const CTF_EXCHANGE       = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Polymarket CTF Exchange
  const NEG_RISK_EXCHANGE  = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // Neg Risk Exchange
  const NEG_RISK_ADAPTER   = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"; // Neg Risk Adapter

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
  ];

  // Tenta múltiplos RPCs públicos da Polygon em ordem
  const POLYGON_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.llamarpc.com",
    "https://polygon-rpc.com",
    "https://rpc-mainnet.maticvigil.com",
  ];

  let provider = null;
  for (const rpc of POLYGON_RPCS) {
    try {
      logger.info(`   Testando RPC: ${rpc}`);
      const p = new ethers.providers.JsonRpcProvider(rpc);
      await Promise.race([
        p.getNetwork(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))
      ]);
      provider = p;
      logger.success(`   RPC OK: ${rpc}`);
      break;
    } catch {
      logger.warn(`   RPC falhou, tentando próximo...`);
    }
  }

  if (!provider) {
    logger.error("Nenhum RPC Polygon disponível. Verifique sua conexão e tente novamente.");
    return;
  }

  const walletWithProvider = wallet.connect(provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, walletWithProvider);

  try {
    const decimals = await usdc.decimals();
    const balance = await usdc.balanceOf(wallet.address);
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, decimals)).toFixed(2);

    logger.info(`   Saldo USDC    : ${balanceFormatted} USDC`);

    if (parseFloat(balanceFormatted) < 1) {
      logger.error("Saldo USDC insuficiente. Deposite USDC na rede Polygon para continuar.");
      logger.info("   Endereço da carteira: " + wallet.address);
      return;
    }

    // Verifica allowance para os contratos que a Polymarket usa
    const contracts = [
      { name: "CTF Exchange",      address: CTF_EXCHANGE },
      { name: "Neg Risk Exchange", address: NEG_RISK_EXCHANGE },
      { name: "Neg Risk Adapter",  address: NEG_RISK_ADAPTER },
    ];

    const MAX_UINT = ethers.constants.MaxUint256;
    const MIN_ALLOWANCE = ethers.utils.parseUnits("1000", decimals); // 1000 USDC mínimo

    for (const c of contracts) {
      const allowance = await usdc.allowance(wallet.address, c.address);
      const allowanceFormatted = parseFloat(ethers.utils.formatUnits(allowance, decimals)).toFixed(2);
      const isOk = allowance.gte(MIN_ALLOWANCE);

      logger.info(`   Allowance ${c.name}: ${allowanceFormatted} USDC ${isOk ? "✅" : "❌"}`);

      if (!isOk) {
        logger.warn(`   Aprovando allowance máxima para ${c.name}...`);
        const tx = await usdc.approve(c.address, MAX_UINT);
        logger.info(`   Tx enviada: ${tx.hash}`);
        await tx.wait();
        logger.success(`   Allowance aprovada para ${c.name}!`);
      }
    }

    logger.divider();
    logger.success("Saldo e allowances OK! Pode executar: npm run order");
  } catch (err) {
    logger.error("Erro ao verificar saldo/allowance", err);
  }
}

async function runAuth(action = "check") {
  logger.divider();
  logger.info(`🔐 MODO AUTH — ação: ${action}`);
  logger.divider();

  switch (action) {
    case "derive":  return await deriveApiKey();
    case "create":  return await createApiKey();
    case "approve": return await checkAndApprove();
    case "check":
    default:        return await checkCredentials();
  }
}

module.exports = { runAuth, deriveApiKey, createApiKey, checkCredentials, checkAndApprove };
