/**
 * STT Providers - Unified interface for speech-to-text
 * 
 * Supports:
 * - twilio: Built-in Twilio <Gather> (default, no extra cost)
 * - deepgram: Deepgram Nova-3 via WebSocket (lowest latency)
 * - groq: Groq Whisper via batch API (best accuracy)
 */

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

// Provider configurations
const providers = {
  /**
   * Twilio Built-in STT
   * Uses <Gather input="speech"> - handled in TwiML, not here
   */
  twilio: {
    name: 'Twilio Built-in',
    type: 'twiml', // Handled via TwiML, not streaming
    supportsStreaming: false,
    cost: 'Free (included)',
  },

  /**
   * Deepgram Nova-3 Streaming
   * WebSocket-based, lowest latency (~150ms)
   */
  deepgram: {
    name: 'Deepgram Nova-3',
    type: 'websocket',
    supportsStreaming: true,
    cost: '$0.0077-0.0092/min',
    
    createConnection: (config, options = {}) => {
      const apiKey = config.deepgram?.apiKey || process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        throw new Error('DEEPGRAM_API_KEY not configured');
      }

      const client = createClient(apiKey);
      const connection = client.listen.live({
        model: options.model || 'nova-3',
        language: options.language || 'en-US',
        smart_format: true,
        interim_results: true,
        endpointing: 300, // ms of silence to finalize
        vad_events: true,
      });

      return connection;
    },

    // Convert Twilio mulaw to Deepgram format
    audioConfig: {
      encoding: 'mulaw',
      sampleRate: 8000,
      channels: 1,
    },
  },

  /**
   * Groq Whisper Batch
   * Best accuracy, requires complete audio
   */
  groq: {
    name: 'Groq Whisper',
    type: 'batch',
    supportsStreaming: false,
    cost: '$0.00067-0.00185/min',

    transcribe: async (audioBuffer, config, options = {}) => {
      const apiKey = config.groq?.apiKey || process.env.GROQ_API_KEY;
      if (!apiKey) {
        throw new Error('GROQ_API_KEY not configured');
      }

      const model = options.model || 'whisper-large-v3-turbo';
      const language = options.language || 'en';

      // Create form data
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.wav');
      formData.append('model', model);
      if (language) {
        formData.append('language', language);
      }

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Groq API error: ${error}`);
      }

      const data = await response.json();
      return {
        text: data.text,
        confidence: 1.0, // Groq doesn't return confidence
        language: data.language,
      };
    },
  },
};

/**
 * Get provider by name
 */
function getProvider(name) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown STT provider: ${name}. Valid: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

/**
 * Create a streaming STT session (Deepgram only)
 */
function createStreamingSession(providerName, config, options = {}) {
  const provider = getProvider(providerName);
  
  if (!provider.supportsStreaming) {
    throw new Error(`Provider ${providerName} does not support streaming. Use transcribeBatch instead.`);
  }

  if (providerName === 'deepgram') {
    const connection = provider.createConnection(config, options);
    
    return {
      provider: providerName,
      connection,
      
      // Send audio chunk
      send: (audioChunk) => {
        if (connection.getReadyState() === 1) { // OPEN
          connection.send(audioChunk);
        }
      },

      // Register transcript handler
      onTranscript: (callback) => {
        connection.on(LiveTranscriptionEvents.Transcript, (data) => {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          if (transcript) {
            callback({
              text: transcript,
              isFinal: data.is_final,
              confidence: data.channel?.alternatives?.[0]?.confidence || 0,
              speechFinal: data.speech_final,
            });
          }
        });
      },

      // Register error handler
      onError: (callback) => {
        connection.on(LiveTranscriptionEvents.Error, callback);
      },

      // Close connection
      close: () => {
        connection.finish();
      },
    };
  }

  throw new Error(`Streaming not implemented for ${providerName}`);
}

/**
 * Transcribe audio batch (Groq)
 */
async function transcribeBatch(providerName, audioBuffer, config, options = {}) {
  const provider = getProvider(providerName);

  if (providerName === 'groq') {
    return await provider.transcribe(audioBuffer, config, options);
  }

  throw new Error(`Batch transcription not implemented for ${providerName}`);
}

/**
 * Get language code for provider
 */
function getLanguageCode(providerName, lang) {
  const langMap = {
    deepgram: {
      es: 'es',
      en: 'en-US',
    },
    groq: {
      es: 'es',
      en: 'en',
    },
    twilio: {
      es: 'es-US',
      en: 'en-US',
    },
  };

  return langMap[providerName]?.[lang] || lang;
}

module.exports = {
  providers,
  getProvider,
  createStreamingSession,
  transcribeBatch,
  getLanguageCode,
};
