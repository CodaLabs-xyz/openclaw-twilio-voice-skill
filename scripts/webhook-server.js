#!/usr/bin/env node
/**
 * Twilio Voice Webhook Server
 * 
 * Handles incoming calls with security verification (caller ID + PIN)
 * and connects authorized callers to the AI agent.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Load configuration
const CONFIG_PATH = process.env.VOICE_CONFIG_PATH || './voice-config.json';
let config = {
  allowedNumbers: [],
  maxAttempts: 3,
  rateLimitPerHour: 5,
  ttsProvider: 'elevenlabs',
  sttProvider: 'groq',
  port: process.env.PORT || 3001
};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  }
} catch (e) {
  console.error('Warning: Could not load config file:', e.message);
}

// In-memory state
const callState = new Map(); // callSid -> { attempts, startTime, callerNumber }
const rateLimits = new Map(); // phoneNumber -> { count, resetTime }

// Helpers
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      resolve(Object.fromEntries(params));
    });
    req.on('error', reject);
  });
}

function twiml(content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${content}\n</Response>`;
}

function isAllowed(phoneNumber) {
  return config.allowedNumbers.some(n => n.number === phoneNumber);
}

function getPin(phoneNumber) {
  const entry = config.allowedNumbers.find(n => n.number === phoneNumber);
  return entry?.pin;
}

function getName(phoneNumber) {
  const entry = config.allowedNumbers.find(n => n.number === phoneNumber);
  return entry?.name || 'Guest';
}

function checkRateLimit(phoneNumber) {
  const now = Date.now();
  const limit = rateLimits.get(phoneNumber);
  
  if (!limit || now > limit.resetTime) {
    rateLimits.set(phoneNumber, { count: 1, resetTime: now + 3600000 });
    return true;
  }
  
  if (limit.count >= config.rateLimitPerHour) {
    return false;
  }
  
  limit.count++;
  return true;
}

function logCall(action, data) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, action, ...data }));
}

// Routes
const routes = {
  'POST /voice/incoming': async (req, body) => {
    const { From: callerNumber, CallSid: callSid } = body;
    
    logCall('incoming', { callerNumber, callSid });
    
    // Check rate limit
    if (!checkRateLimit(callerNumber)) {
      logCall('rate_limited', { callerNumber });
      return twiml(`
        <Say voice="alice">Too many calls. Please try again later.</Say>
        <Hangup/>
      `);
    }
    
    // Check allowlist
    if (!isAllowed(callerNumber)) {
      logCall('unauthorized', { callerNumber });
      return twiml(`
        <Say voice="alice">This number is not authorized to access this service.</Say>
        <Hangup/>
      `);
    }
    
    // Initialize call state
    callState.set(callSid, { 
      attempts: 0, 
      startTime: Date.now(), 
      callerNumber,
      name: getName(callerNumber)
    });
    
    // Request PIN
    return twiml(`
      <Gather input="dtmf" numDigits="4" action="/voice/verify-pin" method="POST" timeout="10">
        <Say voice="alice">Welcome. Please enter your 4 digit PIN.</Say>
      </Gather>
      <Say voice="alice">No input received. Goodbye.</Say>
      <Hangup/>
    `);
  },

  'POST /voice/verify-pin': async (req, body) => {
    const { Digits: enteredPin, CallSid: callSid, From: callerNumber } = body;
    const state = callState.get(callSid);
    
    if (!state) {
      return twiml(`<Say voice="alice">Session error. Goodbye.</Say><Hangup/>`);
    }
    
    const correctPin = getPin(callerNumber);
    
    if (enteredPin === correctPin) {
      logCall('authenticated', { callerNumber, name: state.name });
      
      // Connected - start conversation
      return twiml(`
        <Say voice="alice">Welcome ${state.name}. You are now connected. Please speak after the tone.</Say>
        <Gather input="speech" speechTimeout="auto" action="/voice/process-speech" method="POST" language="en-US">
          <Pause length="1"/>
        </Gather>
        <Say voice="alice">I didn't hear anything. Goodbye.</Say>
        <Hangup/>
      `);
    }
    
    // Wrong PIN
    state.attempts++;
    logCall('wrong_pin', { callerNumber, attempts: state.attempts });
    
    if (state.attempts >= config.maxAttempts) {
      callState.delete(callSid);
      logCall('max_attempts', { callerNumber });
      return twiml(`
        <Say voice="alice">Too many failed attempts. Goodbye.</Say>
        <Hangup/>
      `);
    }
    
    return twiml(`
      <Gather input="dtmf" numDigits="4" action="/voice/verify-pin" method="POST" timeout="10">
        <Say voice="alice">Incorrect PIN. You have ${config.maxAttempts - state.attempts} attempts remaining. Please try again.</Say>
      </Gather>
      <Say voice="alice">No input received. Goodbye.</Say>
      <Hangup/>
    `);
  },

  'POST /voice/process-speech': async (req, body) => {
    const { SpeechResult: speech, CallSid: callSid, From: callerNumber } = body;
    const state = callState.get(callSid);
    
    if (!state) {
      return twiml(`<Say voice="alice">Session error. Goodbye.</Say><Hangup/>`);
    }
    
    logCall('speech_input', { callerNumber, speech });
    
    // TODO: Send to agent and get response
    // For now, echo back
    const agentResponse = await processWithAgent(speech, state);
    
    logCall('agent_response', { callerNumber, response: agentResponse });
    
    // Check for goodbye intent
    if (speech?.toLowerCase().includes('goodbye') || speech?.toLowerCase().includes('bye')) {
      callState.delete(callSid);
      return twiml(`
        <Say voice="alice">${agentResponse}</Say>
        <Hangup/>
      `);
    }
    
    return twiml(`
      <Say voice="alice">${agentResponse}</Say>
      <Gather input="speech" speechTimeout="auto" action="/voice/process-speech" method="POST" language="en-US">
        <Pause length="1"/>
      </Gather>
      <Say voice="alice">I didn't hear anything. Goodbye.</Say>
      <Hangup/>
    `);
  },

  'GET /health': async () => {
    return JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() });
  }
};

// Agent integration placeholder
async function processWithAgent(userMessage, state) {
  // TODO: Integrate with Clawdbot/OpenClaw agent
  // This is a placeholder that echoes back
  
  // Example integration:
  // const response = await fetch('http://localhost:18789/api/chat', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ message: userMessage, context: state })
  // });
  // return response.json().reply;
  
  return `You said: ${userMessage}. This is a placeholder response. The agent integration is not yet configured.`;
}

// Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;
  
  try {
    const handler = routes[routeKey];
    
    if (!handler) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    
    const body = req.method === 'POST' ? await parseBody(req) : {};
    const result = await handler(req, body);
    
    const contentType = routeKey.includes('/health') ? 'application/json' : 'text/xml';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(result);
    
  } catch (error) {
    console.error('Error:', error);
    res.writeHead(500);
    res.end(twiml(`<Say voice="alice">An error occurred. Goodbye.</Say><Hangup/>`));
  }
});

server.listen(config.port, () => {
  console.log(`Twilio Voice Webhook Server running on port ${config.port}`);
  console.log(`Allowed numbers: ${config.allowedNumbers.length}`);
  console.log(`Endpoints:`);
  console.log(`  POST /voice/incoming - Webhook for incoming calls`);
  console.log(`  POST /voice/verify-pin - PIN verification`);
  console.log(`  POST /voice/process-speech - Speech processing`);
  console.log(`  GET /health - Health check`);
});
