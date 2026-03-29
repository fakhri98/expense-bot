# Expense Bot

Simple WhatsApp expense tracker using Twilio + Google Sheets.

## Commands

- `kategori jumlah keterangan` (example: `makan 45000 nasi padang`)
- `/summary` for monthly summary
- `/today` for today's expenses
- `/week` for this week's expenses
- `/help` for usage help

## Environment Variables

Create `.env` with:

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
SPREADSHEET_ID=...
GOOGLE_CREDENTIALS_JSON='{"type":"service_account",...}'
MONTHLY_BUDGET=3000000
```

`MONTHLY_BUDGET` is optional (default: `3000000`).

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Twilio sends no reply | Webhook URL wrong or server down | Check deployment logs and verify URL ends with `/webhook` |
| `403` from Google Sheets | Service account not shared on sheet | Share the sheet with service account email as Editor |
| JSON parse error | Credentials env var has line breaks | Make sure `GOOGLE_CREDENTIALS_JSON` is minified in one line |
| Amount shows as `NaN` | Wrong input format | Use `kategori jumlah keterangan` (example: `makan 45000`) |
| Bot replies but sheet stays empty | Wrong Spreadsheet ID | Re-copy the ID from Google Sheets URL |
| Ngrok URL expired | Free ngrok URL rotated | Run `ngrok http 3000` again and update webhook URL |

## Project Structure

```text
expense-bot/
|-- index.js
|-- package.json
|-- .env
|-- .gitignore
|-- README.md
```
