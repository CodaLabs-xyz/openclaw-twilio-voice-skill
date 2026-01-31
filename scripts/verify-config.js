#!/usr/bin/env node
/**
 * Configuration Verifier
 * 
 * Validates voice-config.json and environment variables
 * before starting the server.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.VOICE_CONFIG_PATH || path.join(__dirname, '..', 'voice-config.json');

console.log('╔════════════════════════════════════════╗');
console.log('║   Voice Skill Config Verifier          ║');
console.log('╚════════════════════════════════════════╝\n');

const checks = [];
let hasErrors = false;

function check(name, condition, errorMsg) {
  if (condition) {
    checks.push({ name, status: '✅', msg: 'OK' });
  } else {
    checks.push({ name, status: '❌', msg: errorMsg });
    hasErrors = true;
  }
}

function warn(name, condition, warnMsg) {
  if (condition) {
    checks.push({ name, status: '✅', msg: 'OK' });
  } else {
    checks.push({ name, status: '⚠️', msg: warnMsg });
  }
}

// 1. Config file exists
check('Config file', fs.existsSync(CONFIG_PATH), `Not found: ${CONFIG_PATH}`);

let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    check('Config valid JSON', true, '');
  } catch (e) {
    check('Config valid JSON', false, e.message);
  }
}

// 2. Required config fields
check('allowedNumbers[]', config.allowedNumbers?.length > 0, 'No allowed numbers configured');
check('Port configured', config.port || process.env.PORT, 'Using default port 3001');

// 3. Twilio credentials
const twilioSid = config.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
const twilioToken = config.twilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
check('Twilio Account SID', twilioSid && !twilioSid.includes('xxx'), 'Set TWILIO_ACCOUNT_SID or config.twilio.accountSid');
check('Twilio Auth Token', twilioToken && twilioToken !== 'your_auth_token', 'Set TWILIO_AUTH_TOKEN or config.twilio.authToken');

// 4. API Keys (env vars)
warn('GROQ_API_KEY', !!process.env.GROQ_API_KEY, 'Not set - transcription disabled');

// 5. Gateway config (for agent integration)
const gatewayToken = config.agent?.gatewayToken || process.env.GATEWAY_TOKEN;
warn('Gateway Token', gatewayToken && gatewayToken !== 'your_gateway_token', 'Not configured - using direct Groq');

// 6. Multi-language config
check('Languages configured', config.menu?.languages?.length > 0, 'No language menu configured');
check('Voices configured', config.voices && Object.keys(config.voices).length > 0, 'No voices configured');

// 7. Allowed numbers validation
if (config.allowedNumbers?.length > 0) {
  const validNumbers = config.allowedNumbers.every(n => 
    n.number?.startsWith('+') && n.pin?.length >= 4
  );
  check('Numbers format (E.164 + PIN)', validNumbers, 'Numbers should be E.164 format (+1...) with 4+ digit PIN');
}

// Print results
console.log('Checks:\n');
for (const c of checks) {
  console.log(`  ${c.status} ${c.name}: ${c.msg}`);
}

console.log('\n' + '─'.repeat(44));

if (hasErrors) {
  console.log('\n❌ Configuration has errors. Fix them before starting.\n');
  process.exit(1);
} else {
  console.log('\n✅ Configuration looks good!\n');
  process.exit(0);
}
