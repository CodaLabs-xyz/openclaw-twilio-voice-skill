# Twilio API Reference

## Authentication

```bash
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="your_auth_token"
```

## Webhook Parameters (Incoming Call)

When Twilio calls your webhook, it sends these parameters:

| Parameter | Description |
|-----------|-------------|
| CallSid | Unique identifier for the call |
| AccountSid | Your Twilio account ID |
| From | Caller's phone number (E.164 format) |
| To | Your Twilio number |
| CallStatus | Status: queued, ringing, in-progress, completed, failed |
| Direction | "inbound" or "outbound-api" |
| CallerName | Caller ID name (if available) |

## Gather Parameters

```xml
<Gather 
  input="speech dtmf"      <!-- Input type: speech, dtmf, or both -->
  numDigits="4"            <!-- For DTMF: number of digits to collect -->
  timeout="5"              <!-- Seconds to wait for input -->
  speechTimeout="auto"     <!-- For speech: auto-detect end of speech -->
  action="/next-step"      <!-- URL to call with results -->
  method="POST"            <!-- HTTP method -->
  language="en-US"         <!-- Speech recognition language -->
>
```

## Speech Result Parameters

After speech input, Twilio sends:

| Parameter | Description |
|-----------|-------------|
| SpeechResult | Transcribed text |
| Confidence | Recognition confidence (0-1) |
| CallSid | Call identifier |

## DTMF Result Parameters

After keypad input:

| Parameter | Description |
|-----------|-------------|
| Digits | Keys pressed |
| CallSid | Call identifier |

## Outbound Call (Node.js)

```javascript
const twilio = require('twilio');
const client = twilio(accountSid, authToken);

const call = await client.calls.create({
  url: 'https://your-domain/voice/outbound-script',
  to: '+1234567890',
  from: '+0987654321'
});
console.log(call.sid);
```

## Conference Calls

Join a caller to a conference:
```xml
<Response>
  <Dial>
    <Conference 
      startConferenceOnEnter="true"
      endConferenceOnExit="false"
      waitUrl="http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
    >
      MyConference
    </Conference>
  </Dial>
</Response>
```

## Recording

Record a call or message:
```xml
<Response>
  <Record 
    maxLength="60"
    action="/handle-recording"
    transcribe="true"
    transcribeCallback="/handle-transcription"
  />
</Response>
```

## Useful Links

- [TwiML Reference](https://www.twilio.com/docs/voice/twiml)
- [Voice Quickstart](https://www.twilio.com/docs/voice/quickstart)
- [Pricing](https://www.twilio.com/voice/pricing)
