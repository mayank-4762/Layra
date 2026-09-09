# Telegram Remote Control

Layra can expose its existing `HybridAgent` through a Telegram bot. Telegram is only a remote chat transport; reasoning, planning, tools, memory, Android control and DHS remain inside the same Layra runtime.

## Setup

1. Create a bot with Telegram's official BotFather and copy its bot token.
2. Find your Telegram numeric user ID.
3. In Termux, set:

```sh
export LAYRA_TELEGRAM_BOT_TOKEN='your-bot-token'
export LAYRA_TELEGRAM_ALLOWED_USER_IDS='your-telegram-user-id'
```

The allow-list is optional in code, but strongly recommended so another Telegram user cannot control your Layra instance.

Start Layra with:

```sh
npm start -- --telegram
```

## Commands

- `/start` - connection check
- `/help` - show commands
- `/status` - runtime statistics
- `/stop` - stop Layra execution
- Any other text - send it as a Layra interactive goal/prompt

Long replies are split into Telegram-safe chunks. Telegram polling uses HTTPS and does not require exposing a public HTTP port on your phone or VPS.
