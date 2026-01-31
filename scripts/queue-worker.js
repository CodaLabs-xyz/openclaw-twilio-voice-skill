#!/usr/bin/env node
/**
 * Queue Worker - Processes pending voice queries asynchronously
 * 
 * Reads queries from pending-queries.jsonl, processes with Groq,
 * and sends results via configured channel (Gateway, Telegram, SMS, Webhook).
 * 
 * Supports multiple response methods:
 * - gateway: Uses Clawdbot Gateway (routes to user's configured channel)
 * - telegram: Direct Telegram Bot API
 * - sms: Twilio SMS
 * - webhook: POST to custom URL
 */

const fs = require('fs');
const path = require('path');

// Load configuration
const CONFIG_PATH = process.env.VOICE_CONFIG_PATH || path.join(__dirname, '..', 'voice-config.json');
const QUEUE_PATH = process.env.QUEUE_PATH || path.join(__dirname, '..', 'pending-queries.jsonl');
const PROCESSED_PATH = process.env.PROCESSED_PATH || path.join(__dirname, '..', 'processed-queries.jsonl');

let config = {};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
} catch (e) {
  console.error('Warning: Could not load config file:', e.message);
}

const POLL_INTERVAL = config.queueWorker?.pollInterval || 30000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ============================================
// Response Senders (multi-channel support)
// ============================================

const senders = {
  /**
   * Send via Clawdbot Gateway - routes to user's configured channel
   * (Telegram, WhatsApp, Discord, Signal, etc.)
   */
  async gateway(message, query) {
    const gatewayUrl = config.asyncResponse?.gateway?.url || config.agent?.gatewayUrl || 'http://localhost:18789';
    const gatewayToken = config.asyncResponse?.gateway?.token || config.agent?.gatewayToken;
    
    if (!gatewayToken) {
      console.error('Gateway token not configured');
      return false;
    }
    
    try {
      // Use Gateway's message endpoint to send to the user's channel
      const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`
        },
        body: JSON.stringify({
          model: 'groq/llama-3.3-70b-versatile',
          max_tokens: 50,
          messages: [
            {
              role: 'system',
              content: 'You are a message relay. Simply output the following message exactly as provided, do not add anything.'
            },
            {
              role: 'user',
              content: `Send this message to the user:\n\n${message}`
            }
          ]
        })
      });
      
      return response.ok;
    } catch (error) {
      console.error('Gateway send error:', error.message);
      return false;
    }
  },

  /**
   * Send via Telegram Bot API
   */
  async telegram(message, query) {
    const botToken = config.asyncResponse?.telegram?.botToken || config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = query.chatId || config.asyncResponse?.telegram?.chatId || config.telegram?.defaultChatId;
    
    if (!botToken) {
      console.error('Telegram bot token not configured');
      return false;
    }
    
    if (!chatId) {
      console.error('Telegram chat ID not configured');
      return false;
    }
    
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        })
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('Telegram API error:', error);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Telegram send error:', error.message);
      return false;
    }
  },

  /**
   * Send via Twilio SMS
   */
  async sms(message, query) {
    const accountSid = config.twilio?.accountSid;
    const authToken = config.twilio?.authToken;
    const fromNumber = config.twilio?.phoneNumber;
    const toNumber = query.callerNumber || config.asyncResponse?.sms?.to;
    
    if (!accountSid || !authToken || !fromNumber || !toNumber) {
      console.error('SMS not fully configured (need Twilio credentials and phone numbers)');
      return false;
    }
    
    try {
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        body: new URLSearchParams({
          To: toNumber,
          From: fromNumber,
          Body: message.replace(/[*_`]/g, '') // Remove markdown for SMS
        })
      });
      
      return response.ok;
    } catch (error) {
      console.error('SMS send error:', error.message);
      return false;
    }
  },

  /**
   * Send via custom webhook (POST)
   */
  async webhook(message, query) {
    const webhookUrl = config.asyncResponse?.webhook?.url;
    const headers = config.asyncResponse?.webhook?.headers || {};
    
    if (!webhookUrl) {
      console.error('Webhook URL not configured');
      return false;
    }
    
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({
          type: 'voice_query_response',
          query: query.message,
          response: message,
          caller: query.callerNumber,
          callerName: query.callerName,
          lang: query.lang,
          timestamp: new Date().toISOString()
        })
      });
      
      return response.ok;
    } catch (error) {
      console.error('Webhook send error:', error.message);
      return false;
    }
  }
};

/**
 * Send response via configured method
 */
async function sendResponse(message, query) {
  const method = config.asyncResponse?.method || 'telegram';
  const sender = senders[method];
  
  if (!sender) {
    console.error(`Unknown response method: ${method}`);
    return false;
  }
  
  console.log(`  Sending via ${method}...`);
  return await sender(message, query);
}

// ============================================
// Query Processing
// ============================================

async function processQuery(query) {
  if (!GROQ_API_KEY) {
    return { success: false, error: 'GROQ_API_KEY not configured' };
  }
  
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: `You are Winston Scott, a professional AI assistant. 
You're responding to a voice query that was deferred for async processing.
The user asked this during a phone call and you said you'd follow up.

Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}

Provide a helpful, complete answer. Keep it under 200 words.
Use simple formatting suitable for text messages.
Respond in ${query.lang === 'es' ? 'SPANISH' : 'ENGLISH'}.`
          },
          { role: 'user', content: query.message }
        ]
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }
    
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;
    
    return { success: true, reply };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================
// Queue Management
// ============================================

function readPendingQueries() {
  if (!fs.existsSync(QUEUE_PATH)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(QUEUE_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    return lines.map(line => JSON.parse(line));
  } catch (error) {
    console.error('Error reading queue:', error.message);
    return [];
  }
}

function markProcessed(queries) {
  if (queries.length > 0) {
    const processed = queries.map(q => JSON.stringify({ ...q, processedAt: new Date().toISOString() })).join('\n') + '\n';
    fs.appendFileSync(PROCESSED_PATH, processed);
  }
  fs.writeFileSync(QUEUE_PATH, '');
}

function logStatus(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================
// Main Loop
// ============================================

async function processQueue() {
  const queries = readPendingQueries();
  
  if (queries.length === 0) {
    return;
  }
  
  logStatus(`Processing ${queries.length} pending queries...`);
  
  for (const query of queries) {
    console.log(`  Query: "${query.message.substring(0, 50)}..."`);
    
    const result = await processQuery(query);
    
    if (result.success) {
      const header = query.lang === 'es' 
        ? `📞 *Respuesta a tu pregunta de voz:*\n_"${query.message}"_\n\n`
        : `📞 *Response to your voice query:*\n_"${query.message}"_\n\n`;
      
      const message = header + result.reply;
      const sent = await sendResponse(message, query);
      console.log(`  ${sent ? '✓ Sent' : '✗ Failed'}`);
    } else {
      console.log(`  ✗ Error: ${result.error}`);
    }
  }
  
  markProcessed(queries);
  logStatus('Queue processed.');
}

// ============================================
// Startup
// ============================================

console.log('╔════════════════════════════════════════╗');
console.log('║   Voice Query Queue Worker             ║');
console.log('╚════════════════════════════════════════╝');
console.log('');
console.log(`Config: ${CONFIG_PATH}`);
console.log(`Queue:  ${QUEUE_PATH}`);
console.log(`Poll:   ${POLL_INTERVAL}ms`);
console.log(`Method: ${config.asyncResponse?.method || 'telegram'}`);
console.log('');

// Initial run
processQueue();

// Poll interval
setInterval(processQueue, POLL_INTERVAL);

console.log('Worker running. Press Ctrl+C to stop.');
