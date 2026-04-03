// analyze.js — Análise direta do banco, sem dependências do bot
// Rode com: node analyze.js
const Database = require("better-sqlite3");
const path = require("path");
const DB_PATH = path.join(__dirname, "data", "carcara.db");
const db = new Database(DB_PATH);

console.log("\n=== CARCARÁ — ANÁLISE DIRETA DO BANCO ===\n");

// 1. Win rate real por estratégia com EV correto
console.log("1. Win rate e EV real por estratégia:");
db.prepare(`
  SELECT COALESCE(strategy,'dummy') as strategy,
    COUNT(*) as n,
    ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
    ROUND(AVG(price_submitted),3) as avg_price,
    ROUND(SUM(profit),2) as profit,
    ROUND(SUM(usdc_submitted),2) as wagered
  FROM rounds
  WHERE mode='order' AND order_status='MATCHED' AND resolved=1
  GROUP BY strategy ORDER BY n DESC
`).all().forEach(r => {
  const ev  = ((r.wr/100) - r.avg_price) * 100;
  const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
  console.log(`  ${r.strategy.padEnd(12)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
});

// 2. Dummy em condições ótimas vs não ótimas
console.log("\n2. Dummy: condições ótimas (5-10min + delta 0.01-0.02) vs demais:");
db.prepare(`
  SELECT
    CASE WHEN seconds_to_close BETWEEN 300 AND 600
         AND (mid_up - price_submitted) BETWEEN 0.01 AND 0.02
    THEN 'otimo' ELSE 'outros' END as cond,
    COUNT(*) as n,
    ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
    ROUND(AVG(price_submitted),3) as avg_price,
    ROUND(SUM(profit),2) as profit,
    ROUND(SUM(usdc_submitted),2) as wagered
  FROM rounds
  WHERE mode='order' AND order_status='MATCHED' AND resolved=1
    AND COALESCE(strategy,'dummy') = 'dummy'
  GROUP BY cond
`).all().forEach(r => {
  const ev  = ((r.wr/100) - r.avg_price) * 100;
  const roi = r.wagered ? (r.profit/r.wagered*100).toFixed(1) : "—";
  console.log(`  ${r.cond.padEnd(8)} n=${String(r.n).padEnd(4)} wr=${r.wr}%  avg_price=${r.avg_price}  EV=${ev.toFixed(2)}%  profit=${r.profit}  ROI=${roi}%`);
});

// 3. Fill rate e win rate por janela de tempo
console.log("\n3. Fill rate e win rate por tempo até fechar:");
db.prepare(`
  SELECT
    CASE WHEN seconds_to_close < 300  THEN '< 5min'
         WHEN seconds_to_close < 600  THEN '5-10min'
         WHEN seconds_to_close < 900  THEN '10-15min'
         ELSE '> 15min' END as bucket,
    COUNT(*) as tentativas,
    SUM(CASE WHEN order_status='MATCHED' THEN 1 ELSE 0 END) as fills,
    ROUND(AVG(CASE WHEN order_status='MATCHED' AND resolved=1
      THEN CAST(won AS FLOAT) END)*100,1) as wr
  FROM rounds WHERE mode='order'
  GROUP BY bucket ORDER BY
    CASE bucket WHEN '< 5min' THEN 1 WHEN '5-10min' THEN 2
    WHEN '10-15min' THEN 3 ELSE 4 END
`).all().forEach(r => {
  const fr = r.tentativas ? (r.fills/r.tentativas*100).toFixed(1) : 0;
  console.log(`  ${r.bucket.padEnd(10)} tentativas=${String(r.tentativas).padEnd(5)} fills=${String(r.fills).padEnd(4)} fill_rate=${fr}%  wr=${r.wr ?? "—"}%`);
});

// 4. Distribuição de price_delta nos fills reais
console.log("\n4. Win rate por price_delta real (min 3 amostras):");
db.prepare(`
  SELECT ROUND((mid_up - price_submitted)*100)/100 as delta,
    COUNT(*) as n,
    ROUND(AVG(CASE WHEN won=1 THEN 1.0 ELSE 0.0 END)*100,1) as wr,
    ROUND(AVG(price_submitted),3) as avg_price,
    ROUND(SUM(profit),2) as profit
  FROM rounds
  WHERE mode='order' AND order_status='MATCHED' AND resolved=1
  GROUP BY delta HAVING n >= 3 ORDER BY delta
`).all().forEach(r =>
  console.log(`  delta=${r.delta}  n=${r.n}  wr=${r.wr}%  avg_price=${r.avg_price}  profit=${r.profit}`)
);

console.log("\n=== FIM ===\n");
