// src/logger.js
// Logger simples com timestamps e cores.
// Futuro: pode ser expandido para gravar em arquivo para métricas.

const chalk = require("chalk");

const timestamp = () => new Date().toISOString();

const logger = {
  info: (msg, data) => {
    console.log(chalk.blue(`[${timestamp()}] ℹ️  ${msg}`));
    if (data !== undefined) console.log(chalk.gray(JSON.stringify(data, null, 2)));
  },

  success: (msg, data) => {
    console.log(chalk.green(`[${timestamp()}] ✅ ${msg}`));
    if (data !== undefined) console.log(chalk.gray(JSON.stringify(data, null, 2)));
  },

  warn: (msg, data) => {
    console.log(chalk.yellow(`[${timestamp()}] ⚠️  ${msg}`));
    if (data !== undefined) console.log(chalk.gray(JSON.stringify(data, null, 2)));
  },

  error: (msg, err) => {
    console.log(chalk.red(`[${timestamp()}] ❌ ${msg}`));
    if (err) {
      console.log(chalk.red(err.message || err));
      if (err.response?.data) console.log(chalk.red(JSON.stringify(err.response.data, null, 2)));
    }
  },

  divider: () => console.log(chalk.gray("─".repeat(60))),

  table: (data) => console.table(data),
};

module.exports = logger;
