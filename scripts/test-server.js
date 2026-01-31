#!/usr/bin/env node
/**
 * Basic Server Tests
 * 
 * Tests the webhook server endpoints without needing Twilio.
 * Run: node scripts/test-server.js
 */

const http = require('http');

const PORT = process.env.TEST_PORT || 3099;
const BASE_URL = `http://localhost:${PORT}`;

// Test results
const results = [];
let serverProcess;

function log(msg) {
  console.log(`  ${msg}`);
}

async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    log(`✅ ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    log(`❌ ${name}: ${error.message}`);
  }
}

async function runTests() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   Voice Skill Server Tests             ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Start server in background
  const { spawn } = require('child_process');
  const path = require('path');
  
  console.log(`Starting test server on port ${PORT}...`);
  
  serverProcess = spawn('node', [path.join(__dirname, 'webhook-server.js')], {
    env: { ...process.env, PORT: String(PORT), VOICE_CONFIG_PATH: path.join(__dirname, '..', 'voice-config.example.json') },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Capture server output for debugging
  let serverOutput = '';
  serverProcess.stdout.on('data', (data) => { serverOutput += data.toString(); });
  serverProcess.stderr.on('data', (data) => { serverOutput += data.toString(); });
  
  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  // Wait for server to start
  await new Promise(r => setTimeout(r, 2000));
  
  // Verify server is running
  try {
    const healthCheck = await request('GET', '/health');
    if (healthCheck.status !== 200) {
      console.error('Server failed to start properly');
      serverProcess.kill();
      process.exit(1);
    }
  } catch (e) {
    console.error('Server not responding:', e.message);
    serverProcess.kill();
    process.exit(1);
  }

  console.log('\nRunning tests:\n');

  // Test 1: Health endpoint
  await test('GET /health returns 200', async () => {
    const res = await request('GET', '/health');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const data = JSON.parse(res.body);
    if (!data.status || data.status !== 'ok') throw new Error('Missing status: ok');
  });

  // Test 2: Incoming call from unauthorized number
  await test('POST /voice/incoming rejects unauthorized', async () => {
    const res = await request('POST', '/voice/incoming', 'From=%2B19999999999&CallSid=test123');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('not authorized')) throw new Error('Expected unauthorized message');
    if (!res.body.includes('Hangup')) throw new Error('Expected Hangup');
  });

  // Test 3: Incoming call from authorized number (example config has +1234567890)
  await test('POST /voice/incoming accepts authorized number', async () => {
    const res = await request('POST', '/voice/incoming', 'From=%2B1234567890&CallSid=test456');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('Gather')) throw new Error('Expected Gather for PIN');
    if (!res.body.includes('PIN')) throw new Error('Expected PIN prompt');
  });

  // Test 4: Wrong PIN
  await test('POST /voice/verify-pin rejects wrong PIN', async () => {
    // First, initiate a call to set up state
    await request('POST', '/voice/incoming', 'From=%2B1234567890&CallSid=test789');
    
    const res = await request('POST', '/voice/verify-pin', 'Digits=000000&CallSid=test789&From=%2B1234567890');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('Incorrect')) throw new Error('Expected incorrect PIN message');
  });

  // Test 5: Correct PIN leads to language menu
  await test('POST /voice/verify-pin accepts correct PIN', async () => {
    await request('POST', '/voice/incoming', 'From=%2B1234567890&CallSid=testABC');
    
    const res = await request('POST', '/voice/verify-pin', 'Digits=123456&CallSid=testABC&From=%2B1234567890');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('español') || !res.body.includes('English')) {
      throw new Error('Expected language menu');
    }
  });

  // Test 6: Language selection
  await test('POST /voice/select-language selects Spanish', async () => {
    await request('POST', '/voice/incoming', 'From=%2B1234567890&CallSid=testDEF');
    await request('POST', '/voice/verify-pin', 'Digits=123456&CallSid=testDEF&From=%2B1234567890');
    
    const res = await request('POST', '/voice/select-language', 'Digits=1&CallSid=testDEF');
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    if (!res.body.includes('Bienvenido')) throw new Error('Expected Spanish welcome');
  });

  // Test 7: 404 for unknown route
  await test('GET /unknown returns 404', async () => {
    const res = await request('GET', '/unknown');
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  // Test 8: TwiML format
  await test('Responses are valid TwiML', async () => {
    const res = await request('POST', '/voice/incoming', 'From=%2B1234567890&CallSid=testXML');
    if (!res.body.includes('<?xml')) throw new Error('Missing XML declaration');
    if (!res.body.includes('<Response>')) throw new Error('Missing Response tag');
  });

  // Cleanup
  serverProcess.kill();

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('\n' + '─'.repeat(44));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
