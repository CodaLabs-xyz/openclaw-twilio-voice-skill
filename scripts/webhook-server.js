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
      <Gather input="dtmf" numDigits="6" action="/voice/verify-pin" method="POST" timeout="10">
        <Say voice="alice">Welcome. Please enter your 6 digit PIN.</Say>
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
      
      // Get menu config (configurable)
      const menu = config.menu || {
        languages: [
          { key: '1', lang: 'es', voice: 'Polly.Lupe', prompt: 'Para español, presione uno.' },
          { key: '2', lang: 'en', voice: 'Polly.Joanna', prompt: 'For English, press two.' }
        ],
        voiceNote: { key: '9', voice: 'Polly.Joanna', prompt: 'To leave a voice note, press nine.' }
      };
      
      // Build menu TwiML
      let menuPrompts = menu.languages.map(l => 
        `<Say voice="${l.voice}" language="${l.lang === 'es' ? 'es-US' : 'en-US'}">${l.prompt}</Say><Pause length="1"/>`
      ).join('\n');
      
      if (menu.voiceNote) {
        menuPrompts += `\n<Say voice="${menu.voiceNote.voice}" language="en-US">${menu.voiceNote.prompt}</Say>`;
      }
      
      return twiml(`
        <Gather input="dtmf" numDigits="1" action="/voice/select-language" method="POST" timeout="10">
          ${menuPrompts}
        </Gather>
        <Say voice="alice">No selection made. Defaulting to English.</Say>
        <Redirect method="POST">/voice/start-conversation?lang=en</Redirect>
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
      <Gather input="dtmf" numDigits="6" action="/voice/verify-pin" method="POST" timeout="10">
        <Say voice="alice">Incorrect PIN. You have ${config.maxAttempts - state.attempts} attempts remaining. Please try again.</Say>
      </Gather>
      <Say voice="alice">No input received. Goodbye.</Say>
      <Hangup/>
    `);
  },

  'POST /voice/select-language': async (req, body) => {
    const { Digits: digit, CallSid: callSid } = body;
    const state = callState.get(callSid);
    
    if (!state) {
      return twiml(`<Say voice="alice">Session error. Goodbye.</Say><Hangup/>`);
    }
    
    const menu = config.menu || { languages: [{ key: '1', lang: 'es' }, { key: '2', lang: 'en' }] };
    const voiceConfig = config.voices || { es: 'Polly.Miguel', en: 'Polly.Matthew' };
    
    // Check for voice note option (9)
    if (digit === (menu.voiceNote?.key || '9')) {
      logCall('voice_note_start', { name: state.name, callSid });
      state.mode = 'voicenote';
      
      const voice = voiceConfig['en'];
      const vnConfig = config.voiceNotes || {};
      const maxLength = vnConfig.maxLengthSeconds || 120;
      
      return twiml(`
        <Say voice="${voice}" language="en-US">Please leave your voice note after the beep. Press any key when finished.</Say>
        <Record action="/voice/save-voicenote" method="POST" maxLength="${maxLength}" playBeep="true" finishOnKey="any"/>
        <Say voice="${voice}" language="en-US">No recording received. Goodbye.</Say>
        <Hangup/>
      `);
    }
    
    // Find selected language from menu config
    const selectedLang = menu.languages.find(l => l.key === digit);
    state.lang = selectedLang?.lang || 'en';
    logCall('language_selected', { lang: state.lang, name: state.name });
    
    const voice = voiceConfig[state.lang];
    const langCode = state.lang === 'es' ? 'es-US' : 'en-US';
    
    const welcomeMsg = state.lang === 'es' 
      ? `Bienvenido ${state.name}. Estás conectado. ¿En qué puedo ayudarte?`
      : `Welcome ${state.name}. You are connected. How can I help you?`;
    
    return twiml(`
      <Say voice="${voice}" language="${langCode}">${welcomeMsg}</Say>
      <Gather input="speech" speechTimeout="auto" timeout="15" action="/voice/process-speech" method="POST" language="${langCode}">
        <Pause length="1"/>
      </Gather>
      <Say voice="${voice}" language="${langCode}">${state.lang === 'es' ? 'No escuché nada. Adiós.' : 'No input received. Goodbye.'}</Say>
      <Hangup/>
    `);
  },

  'POST /voice/save-voicenote': async (req, body) => {
    const { RecordingUrl, RecordingSid, RecordingDuration, CallSid, From: callerNumber } = body;
    const state = callState.get(CallSid);
    
    if (!state) {
      return twiml(`<Say voice="alice">Session error. Goodbye.</Say><Hangup/>`);
    }
    
    const voiceConfig = config.voices || { es: 'Polly.Miguel', en: 'Polly.Matthew' };
    const vnConfig = config.voiceNotes || {};
    const saveDir = vnConfig.saveDir || './voice-notes';
    const voice = voiceConfig['en'];
    
    // Create timestamp-based filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const audioFile = `${timestamp}_${state.name || 'unknown'}.wav`;
    const audioPath = path.join(saveDir, audioFile);
    
    logCall('voice_note_processing', { recordingSid: RecordingSid, name: state.name });
    
    try {
      // Ensure directory exists
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }
      
      // Download audio from Twilio (add .wav extension for format)
      const twilioAuth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
      const audioResponse = await fetch(`${RecordingUrl}.wav`, {
        headers: { 'Authorization': `Basic ${twilioAuth}` }
      });
      
      if (!audioResponse.ok) {
        throw new Error(`Failed to download recording: ${audioResponse.status}`);
      }
      
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      fs.writeFileSync(audioPath, audioBuffer);
      logCall('voice_note_downloaded', { file: audioFile, size: audioBuffer.length });
      
      // Transcribe using Groq Whisper
      let transcription = '';
      const groqApiKey = process.env.GROQ_API_KEY;
      
      if (groqApiKey) {
        const FormData = (await import('node:buffer')).FormData || globalThis.FormData;
        const formData = new FormData();
        formData.append('file', new Blob([audioBuffer]), audioFile);
        formData.append('model', 'whisper-large-v3-turbo');
        
        const transcribeResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqApiKey}` },
          body: formData
        });
        
        if (transcribeResponse.ok) {
          const transcribeData = await transcribeResponse.json();
          transcription = transcribeData.text || '';
          logCall('voice_note_transcribed', { text: transcription.substring(0, 100) + '...' });
        } else {
          logCall('voice_note_transcribe_error', { status: transcribeResponse.status });
        }
      } else {
        logCall('voice_note_no_groq_key', { message: 'GROQ_API_KEY not set, skipping transcription' });
      }
      
      // Save voice note metadata
      const voiceNote = {
        id: RecordingSid,
        callSid: CallSid,
        caller: callerNumber,
        name: state.name,
        audioFile: audioFile,
        transcription: transcription,
        duration: parseInt(RecordingDuration) || 0,
        timestamp: new Date().toISOString(),
        status: transcription ? 'transcribed' : 'pending'
      };
      
      const notesFile = path.join(saveDir, 'notes.jsonl');
      fs.appendFileSync(notesFile, JSON.stringify(voiceNote) + '\n');
      
      // Also save transcription as separate text file for easy access
      if (transcription) {
        const textFile = audioFile.replace('.wav', '.txt');
        fs.writeFileSync(path.join(saveDir, textFile), `[${state.name} - ${voiceNote.timestamp}]\n\n${transcription}\n`);
      }
      
      logCall('voice_note_saved', { id: RecordingSid, audioFile, hasTranscription: !!transcription });
      
      return twiml(`
        <Say voice="${voice}" language="en-US">Your voice note has been saved and transcribed. Thank you. Goodbye.</Say>
        <Hangup/>
      `);
      
    } catch (error) {
      logCall('voice_note_error', { error: error.message });
      
      return twiml(`
        <Say voice="${voice}" language="en-US">Your message was recorded but there was an error saving it. Please try again later. Goodbye.</Say>
        <Hangup/>
      `);
    }
  },

  'POST /voice/process-speech': async (req, body) => {
    const { SpeechResult: speech, CallSid: callSid, From: callerNumber } = body;
    const state = callState.get(callSid);
    
    if (!state) {
      return twiml(`<Say voice="alice">Session error. Goodbye.</Say><Hangup/>`);
    }
    
    const lang = state.lang || 'en';
    const voiceConfig = config.voices || { es: 'Polly.Lupe', en: 'Polly.Joanna' };
    const voice = voiceConfig[lang];
    const langCode = lang === 'es' ? 'es-US' : 'en-US';
    
    logCall('speech_input', { callerNumber, speech, lang });
    
    const agentResponse = await processWithAgent(speech, state);
    
    logCall('agent_response', { callerNumber, response: agentResponse });
    
    // Check for goodbye intent (EN/ES)
    if (speech?.toLowerCase().match(/goodbye|bye|adiós|adios|chao|hasta luego/)) {
      callState.delete(callSid);
      return twiml(`
        <Say voice="${voice}" language="${langCode}">${agentResponse}</Say>
        <Hangup/>
      `);
    }
    
    return twiml(`
      <Say voice="${voice}" language="${langCode}">${agentResponse}</Say>
      <Gather input="speech" speechTimeout="auto" timeout="15" action="/voice/process-speech" method="POST" language="${langCode}">
        <Pause length="1"/>
      </Gather>
      <Say voice="${voice}" language="${langCode}">${lang === 'es' ? 'No escuché nada. Adiós.' : 'No input received. Goodbye.'}</Say>
      <Hangup/>
    `);
  },

  'GET /health': async () => {
    return JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() });
  }
};

// Agent integration via Clawdbot Gateway
async function processWithAgent(userMessage, state) {
  const gatewayUrl = config.agent?.gatewayUrl || 'http://localhost:18789';
  const gatewayToken = config.agent?.gatewayToken;
  
  if (!gatewayToken) {
    logCall('agent_error', { error: 'Gateway token not configured' });
    return "The agent is not configured. Please set up the gateway token.";
  }
  
  try {
    logCall('agent_request', { message: userMessage, name: state.name });
    
    // Use Clawdbot gateway chat completions endpoint
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`
      },
      body: JSON.stringify({
        model: 'groq/llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { 
            role: 'system', 
            content: `You are Winston, a helpful AI assistant. You're receiving a voice call from ${state.name}. 
Keep responses concise and conversational (under 100 words) since this will be read aloud via text-to-speech.
Be friendly, helpful, and natural. Don't use markdown or special formatting.
IMPORTANT: The user selected ${state.lang === 'es' ? 'SPANISH' : 'ENGLISH'}. Always respond in ${state.lang === 'es' ? 'Spanish' : 'English'}.`
          },
          { role: 'user', content: userMessage }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logCall('agent_error', { status: response.status, error: errorText });
      return "I'm having trouble processing that right now. Please try again.";
    }
    
    const data = await response.json();
    logCall('agent_response', { response: data });
    
    // Extract text response (OpenAI format)
    const reply = data.choices?.[0]?.message?.content || "I received your message but couldn't generate a response.";
    
    return reply;
    
  } catch (error) {
    logCall('agent_error', { error: error.message });
    return "I'm sorry, I couldn't connect to the agent. Please try again later.";
  }
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
  console.log(`Voice notes dir: ${config.voiceNotes?.saveDir || './voice-notes'}`);
  console.log(`Endpoints:`);
  console.log(`  POST /voice/incoming - Webhook for incoming calls`);
  console.log(`  POST /voice/verify-pin - PIN verification`);
  console.log(`  POST /voice/select-language - Language/mode selection`);
  console.log(`  POST /voice/process-speech - Speech processing`);
  console.log(`  POST /voice/save-voicenote - Save voice recording`);
  console.log(`  GET /health - Health check`);
});
