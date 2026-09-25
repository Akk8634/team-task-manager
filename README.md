# Team Task Manager

A team task manager that runs inside Telegram: a **Mini App** for daily, weekly, monthly and one-time tasks, a **bot** for reminders, and a **Google Sheet** as the database (backend on Google Apps Script).

- Daily tasks by shift: Morning tasks are due by 2 PM, Evening and general tasks by end of day
- Weekly (Mon–Sun) and monthly tasks, either "any time in the period" or on fixed days/dates
- On time, **Late** and **Missed** tracking for every member
- 4 daily reminders (8 AM, 2 PM, 8 PM, 11 PM) with quick ✅ Done buttons
- Checklists, remarks, "if applicable" tasks, a team dashboard and admin reports

| Path | Purpose |
|---|---|
| `index.html` | Telegram Mini App (hosted on Cloudflare Pages) |
| `_headers` | Cloudflare Pages cache settings |
| `backend/Code.gs` | Google Apps Script backend: API, bot webhook, scheduled reminders |
| `backend/appsscript.json` | Apps Script manifest |

See **[SETUP.md](SETUP.md)** for step-by-step setup.
