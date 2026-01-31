# TwiML Patterns

## Reject Unauthorized Caller

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This number is not authorized to access this service.</Say>
  <Hangup/>
</Response>
```

## Request PIN

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="4" action="/voice/verify-pin" method="POST" timeout="10">
    <Say voice="alice">Please enter your 4 digit PIN.</Say>
  </Gather>
  <Say voice="alice">No input received. Goodbye.</Say>
  <Hangup/>
</Response>
```

## PIN Incorrect (Retry)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="4" action="/voice/verify-pin" method="POST" timeout="10">
    <Say voice="alice">Incorrect PIN. Please try again.</Say>
  </Gather>
  <Say voice="alice">Too many failed attempts. Goodbye.</Say>
  <Hangup/>
</Response>
```

## Connected - Speech Input

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Welcome. You are now connected. Please speak after the tone.</Say>
  <Gather input="speech" speechTimeout="auto" action="/voice/process-speech" method="POST">
    <Play>https://example.com/beep.mp3</Play>
  </Gather>
</Response>
```

## Agent Response

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://example.com/tts-response.mp3</Play>
  <Gather input="speech" speechTimeout="auto" action="/voice/process-speech" method="POST">
    <Say voice="alice">Is there anything else?</Say>
  </Gather>
</Response>
```

## End Call

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling. Goodbye.</Say>
  <Hangup/>
</Response>
```

## Conference Join

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference>AgentRoom</Conference>
  </Dial>
</Response>
```
