# Twilio Voice Skill for OpenClaw/Clawdbot

Voice agent integration via Twilio. Enables AI agents to receive phone calls with security verification.

## Features

- 📞 Receive incoming calls
- 🔐 Caller ID allowlist verification
- 🔢 PIN authentication
- 🎤 Speech-to-Text integration
- 🔊 Text-to-Speech responses
- 📊 Call logging & rate limiting

## Quick Start

```bash
# Clone
git clone https://github.com/CodaLabs-xyz/twilio-voice-skill
cd twilio-voice-skill

# Configure
cp voice-config.example.json voice-config.json
# Edit voice-config.json with your settings

# Run
node scripts/webhook-server.js

# Expose (for development)
ngrok http 3001
```

## Documentation

See [SKILL.md](SKILL.md) for complete documentation.

## License

MIT
