# OpenClaw Twilio Voice Skill

> 📞 Voice agent integration for OpenClaw/Clawdbot via Twilio

Enable AI agents to receive and handle phone calls with multi-layer security verification.

## ✨ Features

- 📞 **Receive Incoming Calls** - Twilio webhook integration
- 🔐 **Caller ID Verification** - Allowlist-based access control
- 🔢 **PIN Authentication** - 4-6 digit verification
- 🎤 **Speech-to-Text** - Convert caller speech to text (Whisper/Groq)
- 🔊 **Text-to-Speech** - Agent responses via voice (ElevenLabs/OpenAI)
- 📊 **Call Logging** - Full audit trail
- ⏱️ **Rate Limiting** - Prevent abuse

## 🏗️ Architecture

```mermaid
graph TB
    subgraph External["External"]
        Phone["📱 Phone Call"]
        Twilio["☁️ Twilio"]
    end
    
    subgraph Server["Webhook Server"]
        Webhook["🌐 Webhook Endpoint"]
        Auth["🔐 Auth Layer"]
        PIN["🔢 PIN Verify"]
        Speech["🎤 Speech Handler"]
    end
    
    subgraph Agent["OpenClaw Agent"]
        Gateway["🚪 Gateway"]
        LLM["🧠 Claude/LLM"]
    end
    
    subgraph Voice["Voice Pipeline"]
        STT["📝 STT (Whisper)"]
        TTS["🔊 TTS (ElevenLabs)"]
    end
    
    Phone --> Twilio
    Twilio --> Webhook
    Webhook --> Auth
    Auth -->|Allowed| PIN
    Auth -->|Blocked| Twilio
    PIN -->|Valid| Speech
    PIN -->|Invalid| Twilio
    Speech --> STT
    STT --> Gateway
    Gateway --> LLM
    LLM --> TTS
    TTS --> Twilio
    Twilio --> Phone
    
    style Phone fill:#e1f5fe
    style Twilio fill:#fff3e0
    style Auth fill:#ffebee
    style LLM fill:#e8f5e9
```

## 🔄 Call Flow Sequence

```mermaid
sequenceDiagram
    participant P as 📱 Phone
    participant T as ☁️ Twilio
    participant W as 🌐 Webhook
    participant A as 🤖 Agent
    
    P->>T: Incoming Call
    T->>W: POST /voice/incoming
    
    Note over W: Check Caller ID
    alt Not in Allowlist
        W->>T: "Not authorized" + Hangup
        T->>P: Call Ended
    else In Allowlist
        W->>T: Request PIN (TwiML)
        T->>P: "Enter your PIN"
        P->>T: DTMF: ****
        T->>W: POST /voice/verify-pin
        
        alt Wrong PIN (< 3 attempts)
            W->>T: "Incorrect, try again"
            T->>P: Retry prompt
        else Wrong PIN (3 attempts)
            W->>T: Hangup
            T->>P: Call Ended
        else Correct PIN
            W->>T: "Connected"
            T->>P: Welcome message
            
            loop Conversation
                P->>T: Speech
                T->>W: POST /voice/process-speech
                W->>A: User message
                A->>W: Agent response
                W->>T: TTS response
                T->>P: Audio playback
            end
            
            P->>T: "Goodbye"
            T->>W: Process speech
            W->>T: Farewell + Hangup
            T->>P: Call Ended
        end
    end
```

## 🔐 Security Layers

```mermaid
graph LR
    A["📞 Incoming Call"] --> B{"🔍 Caller ID<br/>in Allowlist?"}
    B -->|No| C["❌ Reject"]
    B -->|Yes| D{"🔢 Valid PIN?"}
    D -->|No| E{"Attempts < 3?"}
    E -->|Yes| D
    E -->|No| C
    D -->|Yes| F{"⏱️ Rate Limit<br/>OK?"}
    F -->|No| C
    F -->|Yes| G["✅ Connected"]
    
    style C fill:#ffcdd2
    style G fill:#c8e6c9
```

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/CodaLabs-xyz/openclaw-twilio-voice-skill
cd openclaw-twilio-voice-skill
npm install
```

### 2. Configure

```bash
cp voice-config.example.json voice-config.json
```

Edit `voice-config.json`:
```json
{
  "allowedNumbers": [
    { "number": "+1234567890", "pin": "1234", "name": "Julio" }
  ],
  "maxAttempts": 3,
  "rateLimitPerHour": 5
}
```

### 3. Set Environment Variables

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="your_auth_token"
export TWILIO_PHONE_NUMBER="+1234567890"
```

### 4. Run Server

```bash
# Development
npm run dev

# Production
npm start
```

### 5. Expose Webhook (Development)

```bash
ngrok http 3001
```

### 6. Configure Twilio

Set your Twilio phone number's webhook URL to:
```
https://your-domain.ngrok.io/voice/incoming
```

## 📁 Project Structure

```
openclaw-twilio-voice-skill/
├── SKILL.md                    # OpenClaw skill documentation
├── README.md                   # This file
├── LICENSE                     # MIT License
├── package.json
├── voice-config.example.json   # Example configuration
├── scripts/
│   └── webhook-server.js       # Main webhook server
└── references/
    ├── twilio-api.md           # Twilio API reference
    └── twiml-patterns.md       # TwiML examples
```

## 💰 Estimated Costs

| Item | Cost |
|------|------|
| Twilio Phone Number | ~$1.15/month |
| Inbound Minutes | ~$0.0085/min |
| Outbound Minutes | ~$0.014/min |
| TTS (ElevenLabs) | ~$0.30/1K chars |
| STT (Groq) | Free tier |

**Estimated total: $5-15/month** for moderate use.

## 🔧 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/voice/incoming` | POST | Twilio webhook for incoming calls |
| `/voice/verify-pin` | POST | PIN verification callback |
| `/voice/process-speech` | POST | Speech processing callback |
| `/health` | GET | Health check |

## 📖 Documentation

- [SKILL.md](SKILL.md) - Complete skill documentation for OpenClaw
- [references/twilio-api.md](references/twilio-api.md) - Twilio API reference
- [references/twiml-patterns.md](references/twiml-patterns.md) - TwiML examples

## 🤝 Contributing

Contributions welcome! Please read the contributing guidelines first.

## 📄 License

[MIT](LICENSE) © PerkOS

---

Built with ❤️ for the [OpenClaw](https://github.com/clawdbot/clawdbot) ecosystem.
