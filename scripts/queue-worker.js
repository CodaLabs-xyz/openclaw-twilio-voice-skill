#!/usr/bin/env node
/**
 * Queue Worker - Processes pending voice queries asynchronously
 * 
 * Reads queries from pending-queries.jsonl, processes with Groq + tools,
 * and sends results via Telegram.
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

const POLL_INTERVAL = config.queueWorker?.pollInterval || 30000; // 30 seconds default
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Telegram API helper
async function sendTelegram(chatId, message) {
  const botToken = config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
  
  if (!botToken) {
    console.error('Telegram bot token not configured');
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
}

// Process query with Groq (with more time for complex queries)
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
The user asked this during a phone call and you said you'd follow up via Telegram.

Current time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}

Provide a helpful, complete answer. You can be more detailed than voice responses.
Keep it under 200 words. Use simple formatting (no complex markdown).
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

// Read pending queries
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

// Clear pending queries and save to processed
function markProcessed(queries) {
  // Append to processed file
  if (queries.length > 0) {
    const processed = queries.map(q => JSON.stringify({ ...q, processedAt: new Date().toISOString() })).join('\n') + '\n';
    fs.appendFileSync(PROCESSED_PATH, processed);
  }
  
  // Clear pending file
  fs.writeFileSync(QUEUE_PATH, '');
}

// Main processing loop
async function processQueue() {
  const queries = readPendingQueries();
  
  if (queries.length === 0) {
    return;
  }
  
  console.log(`[${new Date().toISOString()}] Processing ${queries.length} pending queries...`);
  
  for (const query of queries) {
    console.log(`  Processing: "${query.message.substring(0, 50)}..."`);
    
    const result = await processQuery(query);
    
    if (result.success) {
      // Format message for Telegram
      const header = query.lang === 'es' 
        ? `📞 *Respuesta a tu pregunta de voz:*\n_"${query.message}"_\n\n`
        : `📞 *Response to your voice query:*\n_"${query.message}"_\n\n`;
      
      const message = header + result.reply;
      
      // Send via Telegram
      const chatId = query.chatId || config.telegram?.defaultChatId;
      if (chatId) {
        const sent = await sendTelegram(chatId, message);
        console.log(`  ${sent ? '✓' : '✗'} Sent to Telegram (${chatId})`);
      } else {
        console.log('  ✗ No chat ID configured');
      }
    } else {
      console.log(`  ✗ Error: ${result.error}`);
    }
  }
  
  // Mark all as processed
  markProcessed(queries);
  console.log(`[${new Date().toISOString()}] Queue processed.`);
}

// Start worker
console.log('Queue Worker starting...');
console.log(`  Config: ${CONFIG_PATH}`);
console.log(`  Queue: ${QUEUE_PATH}`);
console.log(`  Poll interval: ${POLL_INTERVAL}ms`);
console.log(`  Telegram configured: ${!!config.telegram?.botToken}`);
console.log('');

// Initial run
processQueue();

// Poll interval
setInterval(processQueue, POLL_INTERVAL);

console.log('Queue Worker running. Press Ctrl+C to stop.');
