/**
 * PM2 Ecosystem Configuration
 * 
 * Start all services: pm2 start ecosystem.config.js
 * Stop all: pm2 stop all
 * Restart all: pm2 restart all
 * View logs: pm2 logs
 */

module.exports = {
  apps: [
    {
      name: 'voice-webhook',
      script: './scripts/webhook-server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voice-queue',
      script: './scripts/queue-worker.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production'
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'voice-ngrok',
      script: 'ngrok',
      args: 'http 3001 --domain=zknexus.ngrok.io',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production'
      },
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s'
    }
  ]
};
