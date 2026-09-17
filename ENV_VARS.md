# Required environment variables

Copy into `.env` on the deploy host (congvc-c00). Never commit `.env`.

```
TELEGRAM_BOT_TOKEN=
ACTUAL_SERVER_URL=http://127.0.0.1:5006
ACTUAL_SYNC_ID=
ACTUAL_PASSWORD=
ACTUAL_DATA_DIR=/data/actual-cache
ALLOWED_TELEGRAM_USER_IDS=
SYNC_INTERVAL_MS=300000
```

- `ALLOWED_TELEGRAM_USER_IDS` — comma-separated numeric Telegram user IDs. Empty or unset denies everyone (deny-by-default).
- `ACTUAL_PASSWORD` — empty until the operator sets it locally on the deploy host.
