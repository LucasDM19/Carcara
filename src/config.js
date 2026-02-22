// src/config.js
// Carrega e valida todas as variáveis de ambiente.
// Qualquer variável ausente que seja crítica lança um erro ANTES de qualquer ação financeira.

require("dotenv").config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val || val.includes("aqui")) {
    throw new Error(
      `❌ Variável de ambiente obrigatória não configurada: ${name}\n` +
        `   Copie .env.example para .env e preencha os valores reais.`
    );
  }
  return val;
}

function optionalEnv(name, defaultValue) {
  return process.env[name] || defaultValue;
}

// --- Validação em tempo de carregamento ---
// Apenas variáveis seguras para o modo MVP (consulta de mercado)
const config = {
  // Rede
  chainId: parseInt(optionalEnv("CHAIN_ID", "137")),
  clobHost: optionalEnv("CLOB_HOST", "https://clob.polymarket.com"),

  // Mercado alvo
  btcConditionId: optionalEnv("BTC_MARKET_CONDITION_ID", ""),

  // Limites de segurança
  maxBetSizeUsdc: parseFloat(optionalEnv("MAX_BET_SIZE_USDC", "5")),
  maxSlippage: parseFloat(optionalEnv("MAX_SLIPPAGE", "0.01")),

  // Função para carregar credenciais sensíveis (só chama quando for operar)
  loadTradingCredentials() {
    return {
      privateKey: requireEnv("PRIVATE_KEY"),
      apiKey: requireEnv("CLOB_API_KEY"),
      apiSecret: requireEnv("CLOB_API_SECRET"),
      apiPassphrase: requireEnv("CLOB_API_PASSPHRASE"),
    };
  },
};

module.exports = config;
