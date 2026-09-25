# Team Task Manager

A team task manager that runs inside Telegram: a **Mini App** for daily, weekly, monthly and one-time tasks and a **bot** for reminders. It runs on Cloudflare's free plan (Pages + Pages Functions + D1 database), with a **Google Sheet** copy for reports and history.

- Daily tasks by shift: Morning tasks are due by 2 PM, Evening and general tasks by end of day
- Weekly (Mon–Sun) and monthly tasks, either "any time in the period" or on fixed days/dates
- On time, **Late** and **Missed** tracking for every member
- 4 daily reminders (8 AM, 2 PM, 8 PM, 11 PM) with quick ✅ Done buttons
- Checklists, remarks, "if applicable" tasks, a team dashboard, admin reports and Sheet reports

| Path | Purpose |
|---|---|
| `index.html` | Telegram Mini App |
| `functions/api/[[path]].js` | Backend on Cloudflare Pages Functions: API, bot webhook, reminders, Sheet copy |
| `_headers` | Cloudflare Pages cache settings |
| `backend/Code.gs` | Google Sheet script: one-time data move, 5-minute reminder check, Sheet copy |
| `backend/appsscript.json` | Apps Script manifest |

See **[SETUP.md](SETUP.md)** for step-by-step setup.
