# Carcara
Oportunista, inteligente e carniceiro. Símbolo de resistência e adaptação nos sertões e cidades. 

# 🤖 Polymarket Bot — BTC 5min

Bot de apostas automatizado para o mercado de preço do Bitcoin (5 minutos) na Polymarket.

---

## 🗺️ Roadmap

| Fase | Status | Descrição |
|------|--------|-----------|
| **1 — MVP** | ✅ Pronto | Consulta de mercado (sem dinheiro) |
| **2 — Ordens** | ✅ Pronto | Apostas Post-Only GTD |
| **3 — Volatilidade** | 🔜 Próxima | Detector de volatilidade extrema do BTC |
| **4 — Métricas** | 🔜 Próxima | Dashboard em tempo real do desempenho |
| **5 — Estratégia** | 🔜 Próxima | Estratégia completa de apostas |

---

## ⚡ Setup Rápido

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite .env com suas credenciais
```

### 3. Executar Fase 1 — Consulta de Mercado
```bash
npm run market
# ou:
node src/index.js --mode=market
```

---

## 🔑 Credenciais Necessárias

### Para a Fase 1 (consulta):
Nenhuma credencial necessária.

### Para a Fase 2 (apostas):

**1. Carteira Polygon**
- Crie uma carteira Ethereum/Polygon dedicada para o bot
- Mantenha poucos fundos nela (apenas o necessário)
- Copie a chave privada para `PRIVATE_KEY` no `.env`

**2. API Keys da Polymarket**
- Acesse: https://polymarket.com → Perfil → API Keys
- Gere uma nova API Key
- Copie `key`, `secret` e `passphrase` para o `.env`

**3. Condition ID do Mercado BTC 5min**
- Execute `npm run market` para ver mercados ativos
- Copie o `condition_id` do mercado desejado
- Cole em `BTC_MARKET_CONDITION_ID` no `.env`

---

## 🚀 Modos de Execução

```bash
# Fase 1: Consultar mercados BTC 5min ativos
npm run market

# Fase 2: Simular aposta (DRY-RUN — sem enviar ordem real)
node src/index.js --mode=dry

# Fase 2: Fazer aposta real Post-Only GTD
npm run order
```

---

## 🛡️ Segurança

- **Post-Only**: ordens só executam como maker — nunca paga taxa de taker
- **GTD**: ordens expiram automaticamente (padrão: 5 minutos)
- **Limite máximo**: configure `MAX_BET_SIZE_USDC` para limitar apostas
- **Slippage check**: verificação antes de enviar qualquer ordem
- **DRY-RUN**: sempre teste com `--mode=dry` antes do real
- **`.env` no `.gitignore`**: credenciais nunca vão para o git

---

## 📁 Estrutura do Projeto

```
polymarket-bot/
├── src/
│   ├── index.js    ← Ponto de entrada e roteamento de modos
│   ├── market.js   ← Fase 1: Consulta de mercado (somente leitura)
│   ├── order.js    ← Fase 2: Ordens Post-Only GTD
│   ├── config.js   ← Configurações e validação de .env
│   └── logger.js   ← Logger com timestamps e cores
├── .env.example    ← Template de configuração (sem valores reais)
├── .env            ← Suas credenciais (nunca commite este arquivo!)
├── .gitignore
└── package.json
```

---

## 🔜 Fase 3 — Detector de Volatilidade (planejado)

```
src/volatility.js   ← Monitora preço BTC via Binance/Coingecko WebSocket
                       Pausa o bot se ATR ou desvio padrão exceder limiar
```

## 🔜 Fase 4 — Métricas em Tempo Real (planejado)

```
src/metrics.js      ← Grava histórico de apostas em JSON/SQLite
src/dashboard.js    ← Servidor HTTP com dashboard simples (Express + SSE)
```
