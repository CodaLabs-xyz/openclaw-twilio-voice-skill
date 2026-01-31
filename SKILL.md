---
name: twilio-voice
description: Voice agent for phone calls via Twilio. Receive incoming calls, verify caller ID and PIN, then interact via speech. Use when setting up phone-based agent access, voice authentication, or conference call participation.
---

# Twilio Voice Skill

Enable agents to receive and handle phone calls with security verification.

## Features

- Receive incoming calls on a Twilio number
- Verify caller ID against allowlist
- PIN authentication (4-6 digits)
- Speech-to-Text for user input (Whisper)
- Text-to-Speech for agent responses
- Call logging and rate limiting

## Architecture

```
Incoming Call → Twilio → Webhook Server
                              ↓
                    1. Check Caller ID (allowlist)
                    2. Request PIN
                    3. Verify PIN
                    4. Connect to Agent
                              ↓
                    User speaks → STT → Agent → TTS → User hears
```

## Setup

### 1. Twilio Account

Create account at https://twilio.com and get:
- Account SID
- Auth Token
- Phone Number (~$1.15/month)

### 2. Environment Variables

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="your_auth_token"
export TWILIO_PHONE_NUMBER="+1234567890"
```

### 3. Configuration

Create `voice-config.json`:
```json
{
  "allowedNumbers": [
    { "number": "+1234567890", "pin": "1234", "name": "Julio" }
  ],
  "maxAttempts": 3,
  "rateLimitPerHour": 5,
  "ttsProvider": "elevenlabs",
  "sttProvider": "groq"
}
```

### 4. Start Webhook Server

```bash
node scripts/webhook-server.js
```

Expose via ngrok or deploy to VPS:
```bash
ngrok http 3001
```

Configure Twilio webhook URL: `https://your-domain/voice/incoming`

## Session Management

Each call creates a session keyed by caller phone number (Twilio's caller ID):
- **Session key format:** `voice-(+1234567890)` (E.164 format)
- Caller ID available automatically — no lookup required
- Enables per-caller conversation history and context
- Agent receives: phone number, caller name (from config), call duration

## Security Layers

| Layer | Check | Action on Fail |
|-------|-------|----------------|
| 1 | Caller ID in allowlist | "Number not authorized" → Hangup |
| 2 | PIN verification | 3 attempts, then hangup |
| 3 | Rate limiting | Block if >5 calls/hour |
| 4 | All calls logged | Audit trail |

## TwiML Reference

See [references/twiml-patterns.md](references/twiml-patterns.md) for TwiML examples.

## API Reference

See [references/twilio-api.md](references/twilio-api.md) for Twilio API details.

## Scripts

- `scripts/webhook-server.js` - Main webhook server
- `scripts/test-call.js` - Test outbound call
- `scripts/verify-config.js` - Validate configuration

## Costs

| Item | Cost |
|------|------|
| Phone Number | ~$1.15/month |
| Inbound Minutes | ~$0.0085/min |
| Outbound Minutes | ~$0.014/min |
| TTS (ElevenLabs) | ~$0.30/1K chars |
| STT (Groq) | Free tier |

Estimated: **$5-15/month** for moderate use.
