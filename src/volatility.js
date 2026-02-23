// src/volatility.js — CARCARÁ
// ============================================================
// FASE 3 — Detector de Volatilidade do BTC
// ============================================================
// Conecta via WebSocket à Binance e monitora o preço do BTC
// em tempo real. Calcula três métricas de volatilidade:
//
//   1. VELOCIDADE  — variação % por minuto (rolling 60s)
//      Detecta movimentos bruscos e rápidos.
//      Ex: BTC caiu 0.5% no último minuto → alta velocidade
//
//   2. DESVIO PADRÃO — std dev dos últimos N ticks (rolling)
//      Detecta oscilação intensa mesmo sem tendência clara.
//      Ex: BTC subindo e caindo alternadamente → alto desvio
//
//   3. AMPLITUDE    — (max - min) / min dos últimos 5 minutos
//      Detecta o range total de variação recente.
//      Ex: BTC oscilou 1% nos últimos 5min → alta amplitude
//
// O estado resultante é um dos três:
//   🟢 CALM     — mercado estável, Carcará pode operar
//   🟡 ALERT    — volatilidade elevada, operar com cautela
//   🔴 STORM    — volatilidade extrema, Carcará fica inativo
//
// Integração:
//   import { getVolatilityState, startVolatilityMonitor } from './volatility'
//   await startVolatilityMonitor()           // inicia WS em background
//   const state = getVolatilityState()       // consulta estado atual
//   if (state.level !== 'STORM') { ... }    // decide se aposta
// ============================================================

const WebSocket = require("ws");
const logger = require("./logger");

// --- Configuração de limiares ---
const CONFIG = {
  // Janela de ticks para cálculos (cada tick = ~1s na Binance)
  TICK_WINDOW: 300,          // 5 minutos de histórico

  // Velocidade: variação % em 60s
  SPEED_ALERT: 0.20,         // 0.20% em 60s → ALERT
  SPEED_STORM: 0.50,         // 0.50% em 60s → STORM

  // Desvio padrão (em % do preço)
  STDDEV_ALERT: 0.08,        // 0.08% → ALERT
  STDDEV_STORM: 0.20,        // 0.20% → STORM

  // Amplitude: range (max-min)/min nos últimos 5min
  AMPLITUDE_ALERT: 0.30,     // 0.30% → ALERT
  AMPLITUDE_STORM: 0.80,     // 0.80% → STORM

  // Reconexão automática em caso de queda do WS
  RECONNECT_DELAY_MS: 3000,

  // Tempo máximo sem tick antes de marcar como DESCONECTADO
  STALE_THRESHOLD_MS: 15000,
};

// --- Estado interno ---
let ticks = [];              // { price, timestamp }[]
let currentState = {
  level: "UNKNOWN",          // UNKNOWN | CALM | ALERT | STORM | DISCONNECTED
  price: null,
  speed: null,
  stddev: null,
  amplitude: null,
  reason: "Aguardando dados...",
  updatedAt: null,
};
let ws = null;
let staleTimer = null;
let isRunning = false;

// ============================================================
// Cálculos de volatilidade
// ============================================================

function calcSpeed(ticks, windowMs = 60_000) {
  if (ticks.length < 2) return null;
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = ticks.filter((t) => t.timestamp >= cutoff);
  if (recent.length < 2) return null;

  const oldest = recent[0].price;
  const newest = recent[recent.length - 1].price;
  return Math.abs((newest - oldest) / oldest) * 100; // %
}

function calcStdDev(ticks) {
  if (ticks.length < 5) return null;
  const prices = ticks.map((t) => t.price);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  return (Math.sqrt(variance) / mean) * 100; // % do preço
}

function calcAmplitude(ticks) {
  if (ticks.length < 2) return null;
  const prices = ticks.map((t) => t.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  return ((max - min) / min) * 100; // %
}

function classifyLevel(speed, stddev, amplitude) {
  // STORM: qualquer métrica acima do limiar crítico
  if (
    (speed !== null && speed >= CONFIG.SPEED_STORM) ||
    (stddev !== null && stddev >= CONFIG.STDDEV_STORM) ||
    (amplitude !== null && amplitude >= CONFIG.AMPLITUDE_STORM)
  ) {
    const reasons = [];
    if (speed >= CONFIG.SPEED_STORM)     reasons.push(`velocidade ${speed.toFixed(3)}%/min`);
    if (stddev >= CONFIG.STDDEV_STORM)   reasons.push(`desvio ${stddev.toFixed(3)}%`);
    if (amplitude >= CONFIG.AMPLITUDE_STORM) reasons.push(`amplitude ${amplitude.toFixed(3)}%`);
    return { level: "STORM", reason: `Tempestade: ${reasons.join(", ")}` };
  }

  // ALERT: qualquer métrica acima do limiar de atenção
  if (
    (speed !== null && speed >= CONFIG.SPEED_ALERT) ||
    (stddev !== null && stddev >= CONFIG.STDDEV_ALERT) ||
    (amplitude !== null && amplitude >= CONFIG.AMPLITUDE_ALERT)
  ) {
    const reasons = [];
    if (speed >= CONFIG.SPEED_ALERT)     reasons.push(`velocidade ${speed.toFixed(3)}%/min`);
    if (stddev >= CONFIG.STDDEV_ALERT)   reasons.push(`desvio ${stddev.toFixed(3)}%`);
    if (amplitude >= CONFIG.AMPLITUDE_ALERT) reasons.push(`amplitude ${amplitude.toFixed(3)}%`);
    return { level: "ALERT", reason: `Atenção: ${reasons.join(", ")}` };
  }

  return { level: "CALM", reason: "Mercado estável" };
}

function updateState(price) {
  const now = Date.now();

  // Adiciona tick e mantém janela de TICK_WINDOW ticks
  ticks.push({ price, timestamp: now });
  if (ticks.length > CONFIG.TICK_WINDOW) {
    ticks = ticks.slice(-CONFIG.TICK_WINDOW);
  }

  const speed = calcSpeed(ticks);
  const stddev = calcStdDev(ticks);
  const amplitude = calcAmplitude(ticks);
  const { level, reason } = classifyLevel(speed, stddev, amplitude);

  currentState = { level, price, speed, stddev, amplitude, reason, updatedAt: now };

  // Reset do timer de staleness
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    currentState = {
      ...currentState,
      level: "DISCONNECTED",
      reason: "Sem dados da Binance há mais de 15 segundos",
    };
    logger.warn("🔌 Carcará — Monitor de volatilidade: sem dados (DISCONNECTED)");
  }, CONFIG.STALE_THRESHOLD_MS);
}

// ============================================================
// WebSocket — Binance BTC/USDT ticker em tempo real
// ============================================================
function connect() {
  const url = "wss://stream.binance.com:9443/ws/btcusdt@trade";
  logger.info(`🔌 Carcará Volatilidade — conectando: ${url}`);

  ws = new WebSocket(url);

  ws.on("open", () => {
    logger.success("📡 Carcará Volatilidade — WebSocket Binance conectado.");
    ticks = []; // limpa histórico ao reconectar
  });

  ws.on("message", (data) => {
    try {
      const trade = JSON.parse(data);
      const price = parseFloat(trade.p); // trade price
      if (price > 0) updateState(price);
    } catch {
      // ignora mensagens malformadas
    }
  });

  ws.on("close", () => {
    if (!isRunning) return; // parada intencional — não reconecta
    logger.warn("🔌 Carcará Volatilidade — WebSocket desconectado. Reconectando...");
    currentState = { ...currentState, level: "DISCONNECTED", reason: "WebSocket desconectado" };
    setTimeout(connect, CONFIG.RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    logger.warn(`Carcará Volatilidade — erro WS: ${err.message}`);
    // O evento "close" será emitido logo após, que cuida da reconexão
  });
}

// ============================================================
// API pública do módulo
// ============================================================

// Inicia o monitor em background — não bloqueia
function startVolatilityMonitor() {
  if (isRunning) return;
  isRunning = true;
  connect();
  logger.info("🦅 Monitor de volatilidade do Carcará iniciado.");
}

// Para o monitor
function stopVolatilityMonitor() {
  isRunning = false;
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
  logger.info("⏹  Monitor de volatilidade parado.");
}

// Retorna o estado atual — uso síncrono, sem await
function getVolatilityState() {
  return { ...currentState };
}

// Aguarda até ter dados suficientes (útil no startup)
function waitForData(timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (currentState.level !== "UNKNOWN") {
        clearInterval(check);
        resolve(currentState);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error("Timeout aguardando dados de volatilidade da Binance"));
      }
    }, 500);
  });
}

// Formata o estado para exibição no log
function formatVolatilityState(state) {
  const icons = { CALM: "🟢", ALERT: "🟡", STORM: "🔴", DISCONNECTED: "🔌", UNKNOWN: "⬜" };
  const icon = icons[state.level] || "❓";

  const parts = [
    `${icon} ${state.level}`,
    state.price ? `BTC $${state.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "",
    state.speed != null ? `vel: ${state.speed.toFixed(3)}%/min` : "",
    state.stddev != null ? `σ: ${state.stddev.toFixed(3)}%` : "",
    state.amplitude != null ? `amp: ${state.amplitude.toFixed(3)}%` : "",
  ].filter(Boolean);

  return `${parts.join("  |  ")}  →  ${state.reason}`;
}

// ============================================================
// Modo standalone: node src/volatility.js
// Útil para calibrar os limiares antes de integrar
// ============================================================
if (require.main === module) {
  const chalk = require("chalk");

  logger.info("🦅 CARCARÁ — Monitor de Volatilidade (standalone)");
  logger.info("   Pressione Ctrl+C para parar.");
  logger.divider();

  startVolatilityMonitor();

  // Imprime estado a cada 5 segundos
  setInterval(() => {
    const state = getVolatilityState();
    const line = formatVolatilityState(state);

    if (state.level === "STORM") {
      console.log(chalk.red(`[${new Date().toISOString()}] ${line}`));
    } else if (state.level === "ALERT") {
      console.log(chalk.yellow(`[${new Date().toISOString()}] ${line}`));
    } else {
      console.log(chalk.green(`[${new Date().toISOString()}] ${line}`));
    }
  }, 5_000);

  process.on("SIGINT", () => {
    stopVolatilityMonitor();
    process.exit(0);
  });
}

module.exports = {
  startVolatilityMonitor,
  stopVolatilityMonitor,
  getVolatilityState,
  waitForData,
  formatVolatilityState,
  CONFIG,
};
