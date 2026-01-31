/**
 * Twilio Media Stream Handler
 * 
 * Handles WebSocket connections from Twilio Media Streams
 * and routes audio to configured STT provider (Deepgram/Groq).
 * 
 * Architecture:
 *   Phone → Twilio → WebSocket → This Handler → STT Provider → Agent
 */

const WebSocket = require('ws');
const { createStreamingSession, transcribeBatch, getLanguageCode } = require('./stt-providers');

/**
 * Create a Media Stream WebSocket server
 */
function createMediaStreamServer(config, options = {}) {
  const port = options.port || 3002;
  const wss = new WebSocket.Server({ port });

  console.log(`Media Stream WebSocket server running on port ${port}`);

  // Active sessions by streamSid
  const sessions = new Map();

  wss.on('connection', (ws, req) => {
    console.log('New Media Stream connection');
    
    let streamSid = null;
    let callSid = null;
    let sttSession = null;
    let audioBuffer = []; // For batch mode (Groq)

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'connected':
            console.log('Media Stream connected:', data);
            break;

          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            
            const sessionData = sessions.get(callSid) || {};
            const lang = sessionData.lang || 'en';
            const provider = config.sttProvider || 'deepgram';

            console.log(`Stream started: ${streamSid}, provider: ${provider}, lang: ${lang}`);

            // Initialize STT session based on provider
            if (provider === 'deepgram') {
              sttSession = createStreamingSession('deepgram', config, {
                language: getLanguageCode('deepgram', lang),
              });

              sttSession.onTranscript((result) => {
                if (result.isFinal && result.text) {
                  console.log(`[Deepgram] Final: ${result.text}`);
                  
                  // Send transcript back to session handler
                  if (sessionData.onTranscript) {
                    sessionData.onTranscript(result.text, result);
                  }
                }
              });

              sttSession.onError((error) => {
                console.error('[Deepgram] Error:', error);
              });
            }
            // For Groq, we collect audio and transcribe at the end
            break;

          case 'media':
            // Decode base64 audio payload (mulaw 8kHz)
            const audioChunk = Buffer.from(data.media.payload, 'base64');

            if (config.sttProvider === 'deepgram' && sttSession) {
              // Stream to Deepgram
              sttSession.send(audioChunk);
            } else if (config.sttProvider === 'groq') {
              // Buffer for batch transcription
              audioBuffer.push(audioChunk);
            }
            break;

          case 'stop':
            console.log(`Stream stopped: ${streamSid}`);

            // If using Groq, transcribe the buffered audio
            if (config.sttProvider === 'groq' && audioBuffer.length > 0) {
              try {
                const fullAudio = Buffer.concat(audioBuffer);
                const wavAudio = mulawToWav(fullAudio);
                
                const sessionData = sessions.get(callSid) || {};
                const lang = sessionData.lang || 'en';

                const result = await transcribeBatch('groq', wavAudio, config, {
                  language: getLanguageCode('groq', lang),
                });

                console.log(`[Groq] Transcribed: ${result.text}`);

                if (sessionData.onTranscript) {
                  sessionData.onTranscript(result.text, result);
                }
              } catch (error) {
                console.error('[Groq] Transcription error:', error);
              }
            }

            // Cleanup
            if (sttSession) {
              sttSession.close();
            }
            audioBuffer = [];
            sessions.delete(callSid);
            break;

          default:
            console.log('Unknown event:', data.event);
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    ws.on('close', () => {
      console.log('Media Stream connection closed');
      if (sttSession) {
        sttSession.close();
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  return {
    wss,
    sessions,

    // Register a call session for transcript callbacks
    registerSession: (callSid, sessionData) => {
      sessions.set(callSid, sessionData);
    },

    // Get session data
    getSession: (callSid) => {
      return sessions.get(callSid);
    },

    // Close server
    close: () => {
      wss.close();
    },
  };
}

/**
 * Convert mulaw 8kHz to WAV format
 * Required for Groq Whisper API
 */
function mulawToWav(mulawBuffer) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;

  // Decode mulaw to PCM
  const pcmSamples = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcmSamples[i] = mulawDecode(mulawBuffer[i]);
  }

  // Create WAV header
  const pcmBuffer = Buffer.from(pcmSamples.buffer);
  const wavHeader = createWavHeader(pcmBuffer.length, sampleRate, numChannels, bitsPerSample);

  return Buffer.concat([wavHeader, pcmBuffer]);
}

/**
 * Decode single mulaw byte to PCM sample
 */
function mulawDecode(mulaw) {
  const BIAS = 0x84;
  const CLIP = 32635;

  mulaw = ~mulaw;
  const sign = (mulaw & 0x80);
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;

  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  if (sign !== 0) {
    sample = -sample;
  }

  return Math.max(-CLIP, Math.min(CLIP, sample));
}

/**
 * Create WAV file header
 */
function createWavHeader(dataSize, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const header = Buffer.alloc(44);

  // RIFF chunk
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk size
  header.writeUInt16LE(1, 20);  // Audio format (PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Generate TwiML for Media Stream
 */
function generateStreamTwiML(options = {}) {
  const wsUrl = options.wsUrl || 'wss://your-server.com/media-stream';
  const track = options.track || 'inbound_track'; // or 'both_tracks'

  return `
    <Connect>
      <Stream url="${wsUrl}" track="${track}">
        <Parameter name="callSid" value="{{CallSid}}" />
      </Stream>
    </Connect>
  `;
}

module.exports = {
  createMediaStreamServer,
  generateStreamTwiML,
  mulawToWav,
};
