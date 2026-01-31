/**
 * PM2 Ecosystem Configuration
 * 
 * Start all services: pm2 start ecosystem.config.js
 * Stop all: pm2 stop all
 * Restart all: pm2 restart all
 * View logs: pm2 logs
 * 
 * Configuration is read from voice-config.json
 */

const fs = require('fs');
const path = require('path');

// Load config for ngrok domain
let config = {};
const configPath = path.join(__dirname, 'voice-config.json');
try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  console.error('Warning: Could not load voice-config.json');
}

// Get ngrok domain from config or environment
const ngrokDomain = config.ngrok?.domain || process.env.NGROK_DOMAIN || '';
const ngrokArgs = ngrokDomain 
  ? `http 3001 --domain=${ngrokDomain}`
  : 'http 3001';

module.exports = {
  apps: [
    {
      name: 'voice-webhook',
      script: './scripts/webhook-server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: config.port || 3001
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
      args: ngrokArgs,
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
