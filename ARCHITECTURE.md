# Twilio Voice Skill - Architecture v2.0

## Design Principles

1. **Speed First** - Voice calls need instant responses (< 3 seconds)
2. **Explicit Async** - Research/tools are always queued, never inline
3. **Security Layers** - Defense in depth (caller ID + PIN + optional voice)
4. **Customizable** - Every security feature is configurable
5. **Predictable** - User always knows what to expect
6. **Professional** - Production-ready, no amateur errors

---

## Security Architecture

### Layer 1: Caller ID (Required)
```json
{
  "security": {
    "callerIdCheck": true,
    "allowedNumbers": ["+1234567890"]
  }
}
```

### Layer 2: PIN Authentication (Required)
```json
{
  "security": {
    "pin": {
      "enabled": true,
      "length": 6,           // 4-8 digits, default 6
      "maxAttempts": 3,
      "lockoutMinutes": 30
    }
  }
}
```

### Layer 3: Voice Verification (Optional, Future)
```json
{
  "security": {
    "voiceVerification": {
      "enabled": false,
      "provider": "azure|aws|google",
      "enrollmentRequired": true,
      "confidenceThreshold": 0.85
    }
  }
}
```

### Layer 4: Rate Limiting (Required)
```json
{
  "security": {
    "rateLimit": {
      "callsPerHour": 10,
      "callsPerDay": 50
    }
  }
}
```

### Layer 5: Audit Logging (Required)
- All calls logged with timestamp, caller, duration
- All authentication attempts logged
- Stored in `logs/calls.jsonl`

---

## Call Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         INCOMING CALL                           │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Caller ID Check     │
                    │   (allowlist)         │
                    └───────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
               ✅ Allowed              ❌ Blocked
                    │                       │
                    ▼                       ▼
            ┌───────────────┐         "Not authorized"
            │  Rate Limit   │              │
            │    Check      │              ▼
            └───────────────┘           HANGUP
                    │
            ┌───────┴───────┐
            │               │
            ▼               ▼
       ✅ OK           ❌ Exceeded
            │               │
            ▼               ▼
    ┌───────────────┐  "Too many calls"
    │  PIN Entry    │       │
    │  (N digits)   │       ▼
    └───────────────┘    HANGUP
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
 ✅ Valid      ❌ Invalid (attempt < max)
    │               │
    │               ▼
    │          "Incorrect. Try again"
    │               │
    │               ▼
    │          [Loop to PIN Entry]
    │
    │          ❌ Invalid (attempt >= max)
    │               │
    │               ▼
    │          "Too many attempts"
    │               │
    │               ▼
    │            HANGUP + LOCKOUT
    │
    ▼
┌───────────────────┐
│  Voice Verify     │ (Optional - Future)
│  (if enabled)     │
└───────────────────┘
            │
            ▼
┌───────────────────┐
│  Language Select  │
│  1=ES  2=EN       │
└───────────────────┘
            │
            ▼
┌───────────────────────────────────────────────────────────────┐
│                      CONVERSATION LOOP                         │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│   ┌─────────────┐                                             │
│   │   Listen    │◄──────────────────────────────────┐         │
│   └─────────────┘                                   │         │
│          │                                          │         │
│          ▼                                          │         │
│   ┌─────────────────────┐                           │         │
│   │  Intent Detection   │                           │         │
│   └─────────────────────┘                           │         │
│          │                                          │         │
│   ┌──────┼──────┬──────────────┐                    │         │
│   │      │      │              │                    │         │
│   ▼      ▼      ▼              ▼                    │         │
│ CHAT   TASK   VOICE_NOTE    GOODBYE                 │         │
│   │      │      │              │                    │         │
│   ▼      ▼      ▼              ▼                    │         │
│ Groq   Queue  Record       "Goodbye"               │         │
│ Fast   Async  + Save          │                    │         │
│   │      │      │              ▼                    │         │
│   ▼      ▼      ▼           HANGUP                 │         │
│ Response Response Response                          │         │
│   │      │      │                                   │         │
│   └──────┴──────┴───────────────────────────────────┘         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Intent Detection

### CHAT (Default)
Any message that doesn't match other intents.
- Process with Groq direct (fast, no tools)
- Response in 2-3 seconds
- Winston answers with general knowledge

### TASK (Explicit async)
User explicitly requests research/action:
- "investiga..." / "investigate..."
- "busca..." / "search..."
- "averigua..." / "find out..."
- "crea una tarea..." / "create a task..."
- "cuando puedas..." / "when you can..."
- "envíame por telegram..." / "send me via telegram..."

Flow:
1. Detect task intent
2. Extract task description
3. Confirm: "I'll [task]. Press 1 to confirm, 2 to cancel"
4. If confirmed: Queue task
5. Response: "Saved. You'll receive the result via message."

### VOICE_NOTE
- "dejar mensaje" / "leave message"
- "grabar nota" / "record note"
- Press 9 in menu

### GOODBYE
- "adiós" / "goodbye" / "bye" / "chao" / "hasta luego"

---

## Configuration Schema

```json
{
  "server": {
    "port": 3001
  },
  
  "security": {
    "callerIdCheck": true,
    "allowedNumbers": [
      {
        "number": "+1234567890",
        "name": "User Name",
        "pin": "123456"
      }
    ],
    "pin": {
      "length": 6,
      "maxAttempts": 3,
      "lockoutMinutes": 30
    },
    "voiceVerification": {
      "enabled": false
    },
    "rateLimit": {
      "callsPerHour": 10,
      "callsPerDay": 50
    }
  },
  
  "voice": {
    "tts": {
      "es": "Polly.Andres-Neural",
      "en": "Polly.Matthew-Neural"
    },
    "stt": {
      "provider": "twilio",
      "language": "auto"
    }
  },
  
  "conversation": {
    "provider": "groq",
    "model": "llama-3.3-70b-versatile",
    "maxTokens": 150,
    "systemPrompt": "custom prompt or null for default"
  },
  
  "asyncTasks": {
    "enabled": true,
    "responseChannel": "gateway",
    "gateway": {
      "url": "http://localhost:18789",
      "token": "xxx"
    },
    "telegram": {
      "botToken": "xxx",
      "chatId": "xxx"
    }
  },
  
  "voiceNotes": {
    "enabled": true,
    "saveDir": "./voice-notes",
    "maxLengthSeconds": 120,
    "transcribe": true
  },
  
  "ngrok": {
    "domain": "your-domain.ngrok.io"
  },
  
  "logging": {
    "level": "info",
    "dir": "./logs"
  }
}
```

---

## File Structure

```
twilio-voice-skill/
├── ARCHITECTURE.md          # This document
├── README.md                # User documentation
├── SKILL.md                 # Clawdbot skill manifest
├── package.json
├── ecosystem.config.js      # PM2 configuration
│
├── config/
│   ├── default.json         # Default configuration
│   └── schema.json          # JSON Schema for validation
│
├── src/
│   ├── server.js            # Main webhook server
│   ├── worker.js            # Queue worker
│   │
│   ├── routes/
│   │   ├── incoming.js      # POST /voice/incoming
│   │   ├── verify-pin.js    # POST /voice/verify-pin
│   │   ├── language.js      # POST /voice/select-language
│   │   ├── speech.js        # POST /voice/process-speech
│   │   ├── confirm-task.js  # POST /voice/confirm-task
│   │   └── voicenote.js     # POST /voice/save-voicenote
│   │
│   ├── services/
│   │   ├── auth.js          # Authentication logic
│   │   ├── intent.js        # Intent detection
│   │   ├── conversation.js  # Groq conversation
│   │   ├── queue.js         # Task queue management
│   │   └── tts.js           # Text-to-speech helpers
│   │
│   └── utils/
│       ├── twiml.js         # TwiML builders
│       ├── logger.js        # Logging utilities
│       └── config.js        # Config loader
│
├── voice-notes/             # Recorded messages
├── logs/                    # Call logs
└── queue/                   # Pending tasks
    ├── pending.jsonl
    └── processed.jsonl
```

---

## Response Times

| Action | Target | Max |
|--------|--------|-----|
| PIN validation | < 100ms | 500ms |
| Language selection | < 100ms | 500ms |
| Chat response (Groq) | < 3s | 5s |
| Task confirmation | < 100ms | 500ms |
| Voice note save | < 2s | 5s |

---

## Error Handling

### Graceful Degradation
1. If Groq fails → "Sorry, I'm having trouble. Try again."
2. If queue fails → Log error, apologize, continue conversation
3. If Twilio webhook timeout → Return minimal TwiML

### Never Crash
- All routes wrapped in try/catch
- Errors logged, not thrown
- Always return valid TwiML

---

## Future Enhancements

1. **Voice Verification** - Speaker recognition for additional security
2. **Whisper STT** - Better transcription (record + transcribe)
3. **Conversation History** - Remember context across turns
4. **Multi-language** - Portuguese, French, etc.
5. **Outbound Calls** - Agent-initiated calls for urgent notifications

---

## Version History

- v1.0 - Initial implementation
- v2.0 - Architecture rewrite (this document)
