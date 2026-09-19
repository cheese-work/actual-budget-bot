# Required environment variables

Copy into `.env` on the deploy host (congvc-c00). Never commit `.env`.

```
TELEGRAM_BOT_TOKEN=
ACTUAL_SERVER_URL=http://127.0.0.1:5006
ACTUAL_SYNC_ID=
ACTUAL_PASSWORD=
ACTUAL_FILE_PASSWORD=
ACTUAL_DATA_DIR=/data/actual-cache
ALLOWED_TELEGRAM_USER_IDS=
SYNC_INTERVAL_MS=300000
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_BASE_URL=
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_VISION_MODEL=claude-haiku-4-5-20251001
```

- `ALLOWED_TELEGRAM_USER_IDS` — comma-separated numeric Telegram user IDs. Empty or unset denies everyone (deny-by-default).
- `ACTUAL_PASSWORD` — the Actual **server** password. Empty until the operator sets it locally on the deploy host.
- `ACTUAL_FILE_PASSWORD` — the **budget file** encryption password, required only when the budget is end-to-end encrypted. This is a different secret from `ACTUAL_PASSWORD`; leaving it empty against an encrypted file fails startup with `File <name> is encrypted. Please provide a password.`
- `ANTHROPIC_API_KEY` — direct vendor key. Only used as a **fallback** when `ANTHROPIC_AUTH_TOKEN` is unset — see below.
- `ANTHROPIC_MODEL` — text-fallback model (messages the deterministic parser can't handle). Defaults to a small model; that path is a single low-stakes structured-extraction call per ambiguous message.
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — route the text-fallback and image/vision lanes through **OmniRoute**, an Anthropic-API-compatible proxy, instead of hitting the vendor API directly. When `ANTHROPIC_BASE_URL` is set, requests go to that URL; `ANTHROPIC_AUTH_TOKEN` is preferred over `ANTHROPIC_API_KEY` for the `x-api-key` header whenever both are present. Leave both unset to fall back to a direct `ANTHROPIC_API_KEY` call against the vendor API. Either an auth token or an API key must be present for the text-fallback and image lanes to work at all; with neither set, those paths degrade to "please rephrase" / "couldn't read that image" instead of calling out.
- `ANTHROPIC_VISION_MODEL` — model used for photo/image-document transaction extraction (`src/visionExtract.ts`). Defaults to the same small model as the text fallback; a single structured-extraction call per image.
