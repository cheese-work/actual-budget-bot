# Required environment variables

## Release version

CD generates one ICT build stamp on X99 and bakes it into the image as `RELEASE_BUILD`.
The `bot_started` JSON log exposes `version` from `package.json`, `build` (`YYYYMMDD-hhmm`), and `displayVersion` (`<version>-<build>`).
The display string is not used for version comparisons. The image tag adds the source SHA: `<version>-<build>-<sha7>`.
Local and PR builds do not generate a stamp; `build` is empty and `displayVersion` is the plain package version.
`RELEASE_BUILD` is image metadata, not an operator setting; do not put it in the deploy host's `.env`.

The release job calls `.github/release-tools/release-stamp.sh`, an exact snapshot of `cheese-work/multica-dotfiles/scripts/release-stamp.sh` at `5dafb3d959466df589353a8de1da0def15102a62` (CHE-1308).
The snapshot avoids a cross-repository token for the private tooling repository. Its SHA-256 is checked in `src/version.test.ts`; update the snapshot and checksum together when the shared script changes.

## Operator settings

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
JEV_ENABLED=false
TYPESAFE_API_KEY=
JEV_MIN_CONFIDENCE=0.85
JEV_TIMEOUT_MS=1500
```

- `ALLOWED_TELEGRAM_USER_IDS` — comma-separated numeric Telegram user IDs. Empty or unset denies everyone (deny-by-default).
- `ACTUAL_PASSWORD` — the Actual **server** password. Empty until the operator sets it locally on the deploy host.
- `ACTUAL_FILE_PASSWORD` — the **budget file** encryption password, required only when the budget is end-to-end encrypted. This is a different secret from `ACTUAL_PASSWORD`; leaving it empty against an encrypted file fails startup with `File <name> is encrypted. Please provide a password.`
- `ANTHROPIC_API_KEY` — direct vendor key. Only used as a **fallback** when `ANTHROPIC_AUTH_TOKEN` is unset — see below.
- `ANTHROPIC_MODEL` — text-fallback model (messages the deterministic parser can't handle). Defaults to a small model; that path is a single low-stakes structured-extraction call per ambiguous message.
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — route the text-fallback and image/vision lanes through **OmniRoute**, an Anthropic-API-compatible proxy, instead of hitting the vendor API directly. When `ANTHROPIC_BASE_URL` is set, requests go to that URL; `ANTHROPIC_AUTH_TOKEN` is preferred over `ANTHROPIC_API_KEY` for the `x-api-key` header whenever both are present. Leave both unset to fall back to a direct `ANTHROPIC_API_KEY` call against the vendor API. Either an auth token or an API key must be present for the text-fallback and image lanes to work at all; with neither set, those paths degrade to "please rephrase" / "couldn't read that image" instead of calling out.
- `ANTHROPIC_VISION_MODEL` — model used for photo/image-document transaction extraction (`src/visionExtract.ts`). Defaults to the same small model as the text fallback; a single structured-extraction call per image.
- `JEV_ENABLED` — turns on the Jev ("System One" from TypeSafe AI) intent pre-gate (`src/intentRouter.ts`, `src/jev.ts`) for inbound text messages. Must be the literal string `true` — `1`/`TRUE`/`yes`/`on` all evaluate to off, silently (no warning, no error). Defaults to `false` (off); when off, routing is exactly today's regex-and-ordering behavior. **Privacy note:** when enabled, Jev receives the message text and the account/category name lists — same data *kinds* as the Anthropic fallback (`src/llmFallback.ts`), but on a strictly larger *set of messages*: the fallback only ever sees text the deterministic parser (`src/parse.ts`) already failed on, while the intent pre-gate runs on any message matching its hint pattern *before* that deterministic parse is attempted — including messages the deterministic parser would have handled locally today and never sent anywhere (e.g. `spent 45k on coffee`). That data goes to a different vendor (TypeSafe AI) and is a new privacy surface. Enabled-but-unreachable is also distinguishable from disabled at the side-effect level even though routing outcomes are identical: two extra Actual reads per hint-matching message, `intent_router_context_fetch_failed` warnings, up to `JEV_TIMEOUT_MS` of added latency, and an outbound TLS connection to `api.typesafe.ai` carrying the message text before any answer is discarded.
- `TYPESAFE_API_KEY` — bearer token for `https://api.typesafe.ai/v1/systemone`. Required for `JEV_ENABLED=true` to actually call out; with it unset, the router silently behaves as if Jev were disabled (degrades, never throws).
- `JEV_MIN_CONFIDENCE` — confidence floor (0–1) below which a Jev answer is discarded and treated the same as "Jev unreachable." Defaults to `0.85`. Jev's confidence is population-calibrated, not a per-answer correctness guarantee — this threshold is set high because a wrong `log_transaction` verdict here means silently writing a transaction the user never asked to log, while a wrong `spending_query` verdict only costs a legitimate log getting deflected to the report path (user retries; no data damage).
- `JEV_TIMEOUT_MS` — hard timeout for the Jev HTTP call. Defaults to `1500`ms (Jev's own compute is ~70–500ms; the rest is network margin). A timeout resolves to null, same as any other Jev failure.
