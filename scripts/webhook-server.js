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

// Queue for async processing
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(__dirname, '..', 'pending-queries.jsonl');

// Queue query for async processing (will be sent via configured channel)
function queueForAsyncProcessing(query) {
  try {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      message: query.message,
      lang: query.lang,
      callerNumber: query.callerNumber,
      callerName: query.callerName,
      chatId: query.chatId || config.telegram?.defaultChatId,
      timestamp: new Date().toISOString()
    };
    
    fs.appendFileSync(QUEUE_PATH, JSON.stringify(entry) + '\n');
    logCall('query_queued', { id: entry.id, message: entry.message.substring(0, 50) });
    return true;
  } catch (error) {
    logCall('queue_error', { error: error.message });
    return false;
  }
}

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

// Escape XML special characters for TwiML
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Clean text for TTS (remove markdown, format for speech)
function cleanForTTS(text) {
  if (!text) return '';
  return text
    // Remove markdown bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Convert bullet points to natural speech
    .replace(/^- /gm, '. ')
    .replace(/^\* /gm, '. ')
    // Remove code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Clean up multiple newlines
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    // Clean up multiple spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Routes
const routes = {
  'POST /voice/incoming': async (req, body) => {
    const { From: callerNumber, CallSid: callSid } = body;
    
    console.log('=== RAW BODY ===', body);
    console.log('=== CALLER ===', callerNumber);
    console.log('=== ALLOWED ===', config.allowedNumbers);
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
      <Gather input="speech" speechTimeout="3" timeout="15" action="/voice/process-speech" method="POST" language="${langCode}">
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
    
    // Clean markdown, escape XML, and truncate long responses
    const safeResponse = escapeXml(cleanForTTS(agentResponse)).substring(0, 1000);
    
    // Check for goodbye intent (EN/ES)
    if (speech?.toLowerCase().match(/goodbye|bye|adiós|adios|chao|hasta luego/)) {
      callState.delete(callSid);
      return twiml(`
        <Say voice="${voice}" language="${langCode}">${safeResponse}</Say>
        <Hangup/>
      `);
    }
    
    return twiml(`
      <Say voice="${voice}" language="${langCode}">${safeResponse}</Say>
      <Gather input="speech" speechTimeout="3" timeout="15" action="/voice/process-speech" method="POST" language="${langCode}">
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

// Direct Groq API for fast voice responses with retry and fallback to queue
async function processWithAgent(userMessage, state) {
  const groqApiKey = process.env.GROQ_API_KEY;
  const FIRST_TIMEOUT_MS = 5000;  // First attempt: 5 seconds
  const SECOND_TIMEOUT_MS = 5000; // Retry: 5 more seconds
  
  if (!groqApiKey) {
    logCall('agent_error', { error: 'GROQ_API_KEY not configured' });
    return state.lang === 'es' 
      ? "El agente no está configurado."
      : "The agent is not configured.";
  }
  
  const systemPrompt = `You are Winston Scott, a calm and professional AI assistant (like the Continental manager from John Wick).
You're on a VOICE CALL with ${state.name}. Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}.

RULES:
- Keep responses under 40 words (this is voice, not text)
- Be conversational and natural
- No markdown, no lists, no bullet points
- Respond ONLY in ${state.lang === 'es' ? 'SPANISH' : 'ENGLISH'}`;

  // Helper function to call Groq with timeout
  async function callGroq(timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 150,
          temperature: 0.7,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ]
        })
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      return { success: true, reply: data.choices?.[0]?.message?.content };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return { success: false, timeout: true };
      }
      return { success: false, error: error.message };
    }
  }
  
  logCall('agent_request', { message: userMessage, name: state.name });
  
  // FIRST ATTEMPT (5 seconds)
  logCall('agent_attempt', { attempt: 1, timeout: FIRST_TIMEOUT_MS });
  let result = await callGroq(FIRST_TIMEOUT_MS);
  
  if (result.success && result.reply) {
    logCall('agent_response', { attempt: 1, response: result.reply.substring(0, 100) });
    return result.reply;
  }
  
  // First attempt timed out - tell user to wait
  if (result.timeout) {
    logCall('agent_first_timeout', { message: userMessage.substring(0, 50) });
    
    // Return "please wait" message - Twilio will speak this
    // But we need to continue processing... This is tricky with TwiML
    // Instead, we'll do retry inline and only queue if both fail
    
    // SECOND ATTEMPT (5 more seconds)
    logCall('agent_attempt', { attempt: 2, timeout: SECOND_TIMEOUT_MS });
    result = await callGroq(SECOND_TIMEOUT_MS);
    
    if (result.success && result.reply) {
      logCall('agent_response', { attempt: 2, response: result.reply.substring(0, 100) });
      // Prepend a brief apology for the wait
      const prefix = state.lang === 'es' ? 'Disculpa la espera. ' : 'Sorry for the wait. ';
      return prefix + result.reply;
    }
    
    // Both attempts failed - queue for async processing
    logCall('agent_queue_fallback', { message: userMessage.substring(0, 50) });
    
    const queued = queueForAsyncProcessing({
      message: userMessage,
      lang: state.lang,
      callerNumber: state.callerNumber,
      callerName: state.name,
      chatId: config.asyncResponse?.telegram?.chatId || config.telegram?.defaultChatId
    });
    
    if (queued) {
      return state.lang === 'es'
        ? "Esa pregunta está tomando más tiempo del esperado. Te envío la respuesta por mensaje de texto en unos minutos."
        : "That question is taking longer than expected. I'll send you the answer via text message in a few minutes.";
    }
  }
  
  // Non-timeout error
  logCall('agent_error', { error: result.error });
  return state.lang === 'es'
    ? "Lo siento, hubo un error. Intenta más tarde."
    : "Sorry, there was an error. Try again later.";
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
