// PM2 ecosystem config — run 24/7 on VPS
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'solana-trader',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
    },
    {
      name: 'solana-trader-sim',
      script: 'src/index.js',
      cwd: __dirname,
      args: '--simulate',
      instances: 1,
      autorestart: false,
      watch: false,
    },
  ],
};
