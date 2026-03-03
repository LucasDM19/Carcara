// src/redeem.js — CARCARÁ
// ============================================================
// Auto-Resgate de Posições Vencedoras
// ============================================================
// Quando uma aposta ganha na Polymarket, o USDC não retorna
// automaticamente — é preciso "resgatar" os conditional tokens
// vencedores, que são tokens ERC-1155 no contrato CTF.
//
// Fluxo:
//   1. Busca rounds MATCHED + won=1 + redeemed=0 no banco
//   2. Para cada um, chama redeemPositions() no contrato CTF
//   3. Para carteiras proxy (Magic.Link), chama via execute()
//      do proxy antes de tentar direto pela EOA
//   4. Marca o round como redeemed=1 no banco
//
// Contratos relevantes (Polygon Mainnet):
//   CTF:       0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
//   USDC:      0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
//
// Uso:
//   npm run redeem           → resgata todos os pendentes
//   npm run redeem:watch     → loop a cada 5 minutos
// ============================================================

const { ethers } = require("ethers");
const config  = require("./config");
const logger  = require("./logger");
const { getDb } = require("./db");

// ── Contratos ────────────────────────────────────────────────
const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const CTF_ABI = [
  // Resgata tokens vencedores e devolve USDC
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  // Verifica quantos outcome slots o mercado tem (deve ser 2 para Up/Down)
  "function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256)",
  // Verifica quantos tokens vencedores temos
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
];

// Interface do proxy wallet (Magic.Link / Polymarket proxy)
// O EOA chama execute() no proxy, que por sua vez chama o CTF
const PROXY_ABI = [
  "function execute(address to, uint256 value, bytes calldata data) external payable returns (bytes memory result)",
];

// RPCs Polygon — mesmo fallback do auth.js
const POLYGON_RPCS = [
  "https://rpc.ankr.com/polygon",
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://polygon-rpc.com",
  "https://rpc-mainnet.maticvigil.com",
];

// ============================================================
// Conecta ao provider Polygon com fallback
// ============================================================
async function getProvider() {
  for (const rpc of POLYGON_RPCS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpc);
      await Promise.race([
        p.getNetwork(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return p;
    } catch { /* tenta próximo */ }
  }
  throw new Error("Nenhum RPC Polygon disponível.");
}

// ============================================================
// Adiciona coluna redeemed ao banco se ainda não existir
// ============================================================
function ensureRedeemedColumn() {
  const db = getDb();
  try {
    db.exec("ALTER TABLE rounds ADD COLUMN redeemed INTEGER DEFAULT 0");
    logger.info("   Coluna 'redeemed' adicionada ao banco.");
  } catch {
    // Já existe — normal
  }
}

// ============================================================
// Busca rounds ganhos ainda não resgatados
// ============================================================
function getPendingRedeems() {
  const db = getDb();
  return db.prepare(`
    SELECT id, condition_id, outcome, shares_matched,
           market_name, order_id, token_id
    FROM rounds
    WHERE mode    = 'order'
      AND order_status = 'MATCHED'
      AND won     = 1
      AND resolved = 1
      AND (redeemed IS NULL OR redeemed = 0)
    ORDER BY created_at ASC
  `).all();
}

// ============================================================
// Converte condition_id para bytes32
// ============================================================
function toBytes32(conditionId) {
  // Remove "0x" se presente, pad para 32 bytes
  const hex = conditionId.replace(/^0x/, "").padStart(64, "0");
  return "0x" + hex;
}

// ============================================================
// Determina o indexSet para o outcome vencedor
// Em mercados Up/Down binários:
//   Up   → indexSet = 1 (posição 0 → bit 0 → 2^0 = 1)
//   Down → indexSet = 2 (posição 1 → bit 1 → 2^1 = 2)
//
// ATENÇÃO: se a ordem dos outcomes no contrato for diferente,
// os indexSets precisam ser invertidos. O log vai mostrar o
// slot count — se redeemPositions retornar 0 USDC, tente [2]
// para Up e [1] para Down.
// ============================================================
function getIndexSet(outcome) {
  return outcome === "Up" ? [1] : [2];
}

// ============================================================
// Tenta resgatar via proxy wallet (Magic.Link)
// O EOA chama execute() no proxy, que chama o CTF
// ============================================================
async function redeemViaProxy(wallet, proxyAddress, conditionBytes32, indexSets) {
  const provider = await getProvider();
  const signer   = wallet.connect(provider);

  const ctfIface = new ethers.utils.Interface(CTF_ABI);
  const calldata = ctfIface.encodeFunctionData("redeemPositions", [
    USDC_ADDRESS,
    ethers.constants.HashZero,  // parentCollectionId = 0x000...
    conditionBytes32,
    indexSets,
  ]);

  const proxy = new ethers.Contract(proxyAddress, PROXY_ABI, signer);
  const tx = await proxy.execute(CTF_ADDRESS, 0, calldata, {
    gasLimit: 300_000,
    maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"),  // Polygon mínimo ~25 Gwei
    maxFeePerGas:         ethers.utils.parseUnits("60", "gwei"),  // teto confortável
  });

  logger.info(`   Tx enviada (via proxy): ${tx.hash}`);
  logger.info(`   Aguardando confirmação (timeout 60s)...`);
  const receipt = await Promise.race([
    tx.wait(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout aguardando confirmação")), 60_000))
  ]);
  return receipt;
}

// ============================================================
// Tenta resgatar direto pelo EOA (sem proxy)
// ============================================================
async function redeemDirect(wallet, conditionBytes32, indexSets) {
  const provider = await getProvider();
  const signer   = wallet.connect(provider);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
  const tx  = await ctf.redeemPositions(
    USDC_ADDRESS,
    ethers.constants.HashZero,
    conditionBytes32,
    indexSets,
    {
      gasLimit: 300_000,
      maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"),
      maxFeePerGas:         ethers.utils.parseUnits("60", "gwei"),
    }
  );

  logger.info(`   Tx enviada (direto): ${tx.hash}`);
  logger.info(`   Aguardando confirmação (timeout 60s)...`);
  const receipt = await Promise.race([
    tx.wait(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout aguardando confirmação")), 60_000))
  ]);
  return receipt;
}

// ============================================================
// Resgata um round individual
// ============================================================
async function redeemRound(round, wallet, proxyAddress) {
  const conditionBytes32 = toBytes32(round.condition_id);
  const indexSets        = getIndexSet(round.outcome);

  logger.info(`\n💰 Resgatando Round #${round.id}`);
  logger.info(`   Mercado  : ${round.market_name?.slice(0, 50)}`);
  logger.info(`   Apostou  : ${round.outcome} | ${round.shares_matched} shares`);
  logger.info(`   indexSets: [${indexSets}]`);

  // Tenta proxy primeiro se configurado
  if (proxyAddress) {
    try {
      logger.info(`   Tentando via proxy (${proxyAddress})...`);
      const receipt = await redeemViaProxy(wallet, proxyAddress, conditionBytes32, indexSets);
      if (receipt.status === 1) {
        logger.success(`   ✅ Resgatado via proxy! Gas: ${receipt.gasUsed}`);
        return { success: true, method: "proxy", txHash: receipt.transactionHash };
      }
    } catch (err) {
      logger.warn(`   Proxy falhou: ${err.message} — tentando direto...`);
    }
  }

  // Fallback: direto pelo EOA
  try {
    const receipt = await redeemDirect(wallet, conditionBytes32, indexSets);
    if (receipt.status === 1) {
      logger.success(`   ✅ Resgatado direto! Gas: ${receipt.gasUsed}`);
      return { success: true, method: "direct", txHash: receipt.transactionHash };
    }
    return { success: false, reason: "Tx revertida" };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ============================================================
// Cancela transação travada enviando tx vazia com mesmo nonce
// e gas price maior (replace-by-fee)
// ============================================================
async function cancelStuckTx(txHash) {
  logger.info(`🔧 Tentando cancelar tx travada: ${txHash}`);

  const { privateKey } = config.loadTradingCredentials();
  const wallet  = new ethers.Wallet(privateKey);
  const provider = await getProvider();
  const signer  = wallet.connect(provider);

  // Busca a tx original para pegar o nonce
  const origTx = await provider.getTransaction(txHash);
  if (!origTx) {
    logger.error("Transação não encontrada no provider. Tente outro RPC.");
    return false;
  }

  const nonce    = origTx.nonce;
  const oldGas   = origTx.maxFeePerGas || origTx.gasPrice;
  // Novo gas = 150% do original, mínimo 100 Gwei para garantir replace
  const newGas   = ethers.BigNumber.from(oldGas || 0)
    .mul(150).div(100)
    .gt(ethers.utils.parseUnits("100", "gwei"))
    ? ethers.BigNumber.from(oldGas).mul(150).div(100)
    : ethers.utils.parseUnits("100", "gwei");

  logger.info(`   Nonce original : ${nonce}`);
  logger.info(`   Gas original   : ${ethers.utils.formatUnits(oldGas || 0, "gwei")} Gwei`);
  logger.info(`   Novo gas price : ${ethers.utils.formatUnits(newGas, "gwei")} Gwei`);
  logger.info(`   Enviando tx vazia para cancelar...`);

  try {
    const cancelTx = await signer.sendTransaction({
      to:       wallet.address,   // self-transfer — só cancela a tx
      value:    0,
      nonce,
      gasLimit: 21_000,
      maxPriorityFeePerGas: newGas,
      maxFeePerGas:         newGas,
    });

    logger.info(`   Tx de cancel enviada: ${cancelTx.hash}`);
    logger.info(`   Aguardando confirmação...`);

    const receipt = await Promise.race([
      cancelTx.wait(),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 60_000)),
    ]);

    if (receipt.status === 1) {
      logger.success(`   ✅ Tx original cancelada! Nonce ${nonce} liberado.`);
      logger.info(`   Agora rode npm run redeem novamente.`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`   Falha ao cancelar: ${err.message}`);
    return false;
  }
}

// ============================================================
// Executa resgate de todos os rounds pendentes
// ============================================================
async function autoRedeem() {
  ensureRedeemedColumn();

  const pending = getPendingRedeems();
  if (!pending.length) {
    logger.info("✨ Nenhum resgate pendente.");
    return { redeemed: 0, failed: 0 };
  }

  logger.info(`💰 ${pending.length} round(s) com resgate pendente.`);
  logger.divider();

  const { privateKey } = config.loadTradingCredentials();
  const wallet = new ethers.Wallet(privateKey);
  const proxyAddress = config.proxyWallet || null;

  const db = getDb();
  let redeemed = 0;
  let failed = 0;

  for (const round of pending) {
    const result = await redeemRound(round, wallet, proxyAddress);

    if (result.success) {
      db.prepare(`
        UPDATE rounds SET redeemed = 1 WHERE id = ?
      `).run(round.id);
      redeemed++;
    } else {
      logger.error(`   ❌ Round #${round.id} falhou: ${result.reason}`);
      failed++;
    }

    // Pausa entre transações para não saturar o RPC
    await new Promise(r => setTimeout(r, 2_000));
  }

  logger.divider();
  logger.info(`Resgates concluídos: ${redeemed} OK, ${failed} falhou.`);
  return { redeemed, failed };
}

// ============================================================
// Modo watch: roda em loop a cada N segundos
// ============================================================
async function watchAndRedeem(intervalSeconds = 300) {
  logger.info(`🦅 CARCARÁ Auto-Redeem — verificando a cada ${intervalSeconds}s`);
  logger.info("   Ctrl+C para parar.");

  const run = async () => {
    logger.divider();
    logger.info(`[${new Date().toISOString()}] Verificando resgates pendentes...`);
    await autoRedeem();
  };

  await run();
  const timer = setInterval(run, intervalSeconds * 1000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    logger.info("⏹  Auto-redeem parado.");
    process.exit(0);
  });
}

module.exports = { autoRedeem, watchAndRedeem, cancelStuckTx };
