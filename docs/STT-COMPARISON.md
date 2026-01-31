# STT Comparison: Deepgram vs Groq Whisper

## Executive Summary

| Feature | Deepgram Nova-3 | Groq Whisper |
|---------|-----------------|--------------|
| **Streaming** | ✅ Native WebSocket | ❌ Batch only |
| **Latency** | ~150ms TTFT | ~300ms (batch) |
| **Multi-language** | 30+ languages | 100+ languages |
| **Cost/min** | $0.0077-0.0092 | $0.00067-0.00185 |
| **Accuracy (WER)** | 18.3% | 10.3-12% |
| **Free tier** | $200 credit | Yes (25MB limit) |

**Winner for real-time voice:** Deepgram (native streaming)
**Winner for accuracy/cost:** Groq Whisper (better WER, cheaper)

---

## Detailed Comparison

### 1. Latency

**Deepgram Nova-3:**
- Time-to-first-token: ~150ms (US), 250-350ms (global)
- True streaming via WebSocket
- Results arrive as you speak

**Groq Whisper:**
- Batch processing: 216-299x real-time
- 10 min audio → 3.7 seconds processing
- Sub-300ms for short audio clips
- BUT: Must wait for complete audio before processing

**Verdict:** For phone calls, Deepgram's streaming is ideal. User speaks → instant transcription → agent responds. With Groq, you wait for user to finish speaking first.

### 2. Accuracy

**Deepgram Nova-3:**
- WER: 18.3%
- Strong on: noisy environments, far-field audio
- Smart formatting (phone numbers, currencies)

**Groq Whisper Large v3:**
- WER: 10.3%
- Best multilingual accuracy
- Better on accents and dialects
- Trained on 5M hours of audio

**Verdict:** Groq has ~43% lower error rate. For accuracy-critical apps (medical, legal), Whisper wins.

### 3. Pricing

**Deepgram:**
| Model | Price/min |
|-------|-----------|
| Nova-3 Mono | $0.0077 |
| Nova-3 Multi | $0.0092 |
| Nova-2 | $0.0058 |

**Groq:**
| Model | Price/min |
|-------|-----------|
| whisper-large-v3 | $0.00185 |
| whisper-large-v3-turbo | $0.00067 |

**Cost for 1000 minutes:**
- Deepgram Nova-3: $7.70
- Groq Whisper v3: $1.85
- Groq Turbo: $0.67

**Verdict:** Groq is 4-11x cheaper.

### 4. Multi-Language Support

**Deepgram:**
- 30+ languages
- Auto language detection
- Good Spanish, Portuguese, French, German

**Groq Whisper:**
- 100+ languages
- Excellent on low-resource languages
- Best-in-class for Spanish variants
- Can translate non-English → English

**Verdict:** Groq has broader and better language support.

### 5. Integration with Twilio

**Option A: Twilio Built-in STT (Current)**
```
User speaks → Twilio <Gather> → Text → Agent
```
- Uses Google/AWS backend
- Simplest integration
- ~300-500ms latency
- Limited customization

**Option B: Deepgram + Twilio Media Streams**
```
User speaks → Twilio Stream → Deepgram WebSocket → Text → Agent → TTS → Twilio
```
- True bidirectional streaming
- ~150ms latency
- Full control over transcription
- More complex setup
- Example: github.com/deepgram-devs/deepgram-twilio-streaming-python

**Option C: Groq + Recording**
```
User speaks → Twilio <Record> → Audio file → Groq API → Text → Agent
```
- Best accuracy
- Cheapest
- Adds recording step (~500ms overhead)
- Good for voice notes mode

---

## Recommendation for twilio-voice-skill

### Current Architecture
The skill uses Twilio's built-in `<Gather input="speech">` which works fine. Switching to Deepgram/Groq requires significant refactoring.

### Recommended Approach

**For Real-Time Conversation Mode:**
Keep Twilio's built-in STT. It's:
- Already working
- Low latency (~300ms)
- Zero additional cost
- No extra API calls

**For Voice Notes Mode (already using Groq):**
Keep Groq Whisper. It's:
- Already integrated
- Best accuracy
- Cheapest option
- Perfect for async transcription

**Future Enhancement: Hybrid Mode**
If you need lower latency + better accuracy:

1. **Phase 1:** Add Deepgram as optional STT provider
   - Use Twilio Media Streams
   - WebSocket connection to Deepgram
   - Config: `"sttProvider": "deepgram"`

2. **Phase 2:** Language-aware routing
   - Spanish audio → Groq (better accuracy)
   - English audio → Deepgram (lower latency)

### Implementation Priority

| Priority | Task | Effort |
|----------|------|--------|
| Low | Keep current (Twilio STT + Groq for voice notes) | Done ✅ |
| Medium | Add Deepgram option for streaming | 1-2 days |
| Low | Switch to pure Groq | Not recommended for real-time |

---

## Code Examples

### Deepgram WebSocket (streaming)
```javascript
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const connection = deepgram.listen.live({
  model: "nova-3",
  language: "es", // or "en"
  smart_format: true,
});

connection.on(LiveTranscriptionEvents.Transcript, (data) => {
  const transcript = data.channel.alternatives[0].transcript;
  if (data.is_final && transcript) {
    console.log("Final:", transcript);
  }
});

// Send audio chunks from Twilio Media Stream
twilioStream.on('media', (data) => {
  connection.send(Buffer.from(data.payload, 'base64'));
});
```

### Groq Whisper (batch)
```javascript
// Already in the skill for voice notes
const formData = new FormData();
formData.append('file', audioBuffer, 'audio.wav');
formData.append('model', 'whisper-large-v3-turbo');

const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
  body: formData
});
```

---

## TL;DR

| Use Case | Best Choice | Why |
|----------|-------------|-----|
| Real-time phone conversation | Twilio built-in | Already works, no extra cost |
| Voice notes transcription | Groq Whisper | Best accuracy, cheapest |
| Ultra-low latency needs | Deepgram Nova-3 | 150ms streaming |
| Multi-language accuracy | Groq Whisper | Best WER for Spanish |

**For now:** Keep current setup. Twilio STT for conversation, Groq for voice notes.
**Future:** Add Deepgram option if latency becomes critical.
