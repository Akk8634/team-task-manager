# Team Task Manager: Setup Guide

A task manager that runs entirely inside Telegram.

- **Telegram Mini App:** an app-like screen inside Telegram for tasks, checklists, the team dashboard and admin settings
- **Telegram bot:** 4 daily reminders (8 AM, 2 PM, 8 PM, 11 PM), weekly/monthly checkpoints and admin reports, with quick ✅ Done buttons
- **Google Sheet:** stores all the data
- **Google Apps Script:** the backend, which is free and needs no server

## Files

| File | What it is |
|---|---|
| `index.html` | The Mini App screen, hosted on Netlify |
| `netlify.toml` | Netlify settings (no build step) |
| `backend/Code.gs` | The backend: API, bot and scheduled reminders |
| `backend/appsscript.json` | Apps Script project settings (IST timezone, web app access) |

---

## Step 1: Create the Telegram bot (2 min)

1. Open **@BotFather** in Telegram and send `/newbot`.
2. Give it a name (e.g. *Cityflo Tasks*), then a username that ends in `bot` (e.g. `cityflo_tasks_bot`).
3. Copy the **token** BotFather gives you (e.g. `123456789:ABC...`). Keep it private.

## Step 2: Host the Mini App on Netlify (5 min)

The Mini App (`index.html`) must be available at a public HTTPS address. Netlify hosts it for free and redeploys automatically on every push to GitHub.

1. Go to **https://app.netlify.com/signup** and choose **Sign up with GitHub** (use the `Akk8634` account).
2. Click **Add new site → Import an existing project → GitHub**, and allow Netlify to access the **`team-task-manager`** repository.
3. Leave all settings as they are (`netlify.toml` in the repo already sets them) and click **Deploy**.
4. When it finishes, Netlify shows your site URL, e.g. `https://team-task-manager-abc123.netlify.app`.
   - Optional: **Site configuration → Change site name** gives a nicer URL, e.g. `https://cityflo-tasks.netlify.app`.
5. Open the URL in a browser. You should see **"Open in Telegram"**, which means it works. The app itself only runs inside Telegram.

Use this URL as `MINI_APP_URL` in Step 5.

> `index.html` contains no secrets. The backend address is passed to it at runtime by the bot.

## Step 3: Create the Google Sheet and Apps Script project

1. Create a new Google Sheet, e.g. **"Team Task Manager"**.
2. Open **Extensions → Apps Script**.
3. Delete everything in the default `Code.gs` and paste in the contents of **`backend/Code.gs`**.
4. Open ⚙️ **Project Settings** and tick **"Show appsscript.json manifest file in editor"**. Then open `appsscript.json` in the Editor and replace its contents with **`backend/appsscript.json`**.
5. 💾 Save.

## Step 4: Deploy the backend as a web app

1. Click **Deploy → New deployment**, and choose type **Web app** from the ⚙️ icon.
2. Use these settings:
   - **Execute as:** Me
   - **Who has access:** Anyone
3. Click **Deploy**, authorize when asked, and copy the **Web app URL**. It ends with `/exec`.

> **"Anyone" is required**, because Telegram and the Mini App call this URL without a Google login. Every request is still verified: Mini App requests must carry Telegram's signed user data, and bot updates must carry a secret key.
>
> If you don't see **"Anyone"**, your Google Workspace admin has blocked public web apps. Ask them to allow it, or create the Sheet with a personal Gmail account instead.

## Step 5: Fill in CONFIG and run `setup`

1. At the top of `Code.gs`, fill in:
   ```js
   const CONFIG = {
     BOT_TOKEN: '123456789:ABC...',                                // Step 1
     WEB_APP_URL: 'https://script.google.com/macros/s/.../exec',   // Step 4
     MINI_APP_URL: 'https://<your-site>.netlify.app/',             // Step 2
   };
   ```
2. 💾 Save, select the **`setup`** function in the dropdown at the top, and click **Run**.
3. Open **Execution log**. It shows a **6-digit admin code**.

`setup` creates the `Tasks`, `TaskLog` and `Team` sheets, connects the bot, adds the **Open Tasks** menu button and schedules the reminder trigger (checks every 5 minutes).

## Step 6: Become the admin

1. Open your bot in Telegram and tap **Start**.
2. Tap the **Open Tasks** button (bottom-left of the chat).
3. Enter the 6-digit admin code. You are now the Admin.

## Step 7: Add your team

1. Share the bot link (`https://t.me/<bot_username>`) with your team.
2. Each person opens the bot, taps **Start** and then **Open Tasks**. This sends a join request.
3. You get a Telegram message with **✅ Approve / ❌ Reject** buttons. You can also approve people in **Manage → People**.

## Step 8: Create tasks

In the Mini App, go to **Manage → Tasks → ＋ New task**:

| Field | Options |
|---|---|
| Category | **Daily**, **Weekly**, **Monthly** or **One-time** |
| Weekly: when? | **Any day** (complete any time Mon–Sun, by Sunday night) or **Fixed days** (e.g. every Wednesday) |
| Monthly: when? | **Any time** (complete any time in the month, by the last day) or **Fixed date** (e.g. the 5th) |
| Shift | **Morning** (due by the afternoon time, 2 PM) · **Evening** / **General** (due by end of day) |
| Time | Optional label shown on the task, e.g. a meeting at 11:30 AM. No separate reminder. |
| If applicable | For tasks that only happen sometimes (incidents, breakdowns). Not counted as pending, no reminders. Members mark them Done or N/A. |
| Checklist | Optional sub-items. Each item is **Required** or **Optional** (e.g. a surprise breathalyzer check). The task is done when every required item is ticked; optional items never block it. In the sheet, optional items end with `(optional)`. |
| Assign to | All members, or selected people only |
| Active | Turn off to pause a task without deleting it |

Test the reminders from **Manage → Settings → Send now**.

---

## Deadlines: on time, Late and Missed

| Task | Complete by | After the deadline |
|---|---|---|
| Daily, Morning shift | **2:00 PM** the same day | **Late** until midnight, then **Missed** |
| Daily, Evening / General | **End of day** (midnight) | **Missed** |
| Weekly, any day | **Sunday night** (week = Mon–Sun) | **Missed** |
| Monthly, any time | **Last day of the month** | **Missed** |
| Weekly/Monthly fixed day, One-time | That day (2 PM for Morning shift, midnight otherwise) | **Late** until the next occurrence, then **Missed**. One-time tasks stay Late until done. |

**Marked done by mistake?** Tap **UNDO** in the message at the bottom of the app, tap the task's circle again, or open the task and tap **↩️ Undo: mark as not done**. In the bot, the ✅ button turns into **↩️ Undo** after you press it. A task can be undone until its period closes.

A task finished after its deadline (but before it closes) is shown as **Done late** 🟠. Members see Late items in red at the top of their list, and admins see on-time, late and missed counts for everyone.

## Reminder schedule

Each member gets **at most 4 messages a day**, and only when something is pending.

| Time (default) | Message |
|---|---|
| **8:00 AM** ☀️ | Day plan: Late items, Morning tasks (due by 2 PM), Evening & general tasks, plus weekly/monthly checkpoints |
| **2:00 PM** 🌤️ | Afternoon check: Morning tasks not done are now **Late**, plus Evening & general tasks |
| **8:00 PM** 🌆 | Evening reminder: everything still pending today |
| **11:00 PM** 🌙 | Final reminder: these tasks will be **Missed** at midnight |

Weekly and monthly checkpoints are added to the 8 AM message:

| When | Weekly ("any day" tasks) | Monthly ("any time" tasks) |
|---|---|---|
| Start | Monday: this week's list | 1st: this month's list |
| Middle | Thursday: mid-week check | 15th: mid-month check |
| End | Sunday: last-day warning (also at 8 PM and 11 PM) | Last 3 days: countdown (last day also at 8 PM and 11 PM) |

**Admin reports** come with the 8 AM message: yesterday's on-time / late / missed per member, last week's weekly tasks on Mondays, and last month's monthly tasks on the 1st.

Change the 4 reminder times in **Manage → Settings**. They go out within 5 minutes of the set time.

## Bot commands

- `/today`: today's tasks and their status
- `/pending`: only pending tasks
- `/app`: open the Mini App

## Data in the Google Sheet

- **`Tasks`:** all task settings
- **`TaskLog`:** one row per member, per task, per period: status (Done / N/A / Pending), ticked checklist items, remarks and completion time. This is your history and report.
- **`Team`:** Telegram ID, name, role (Admin / Member) and status (Active / Pending / Rejected)

The bot token and other settings are kept in Apps Script's Script Properties, not in the Sheet.

## Updating the code later

- **Backend (`Code.gs`):** after editing, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same. Run `setup` again if you changed CONFIG.
- **Mini App (`index.html`):** push the new file to GitHub. Netlify redeploys within a minute.

## Troubleshooting

| Problem | Fix |
|---|---|
| Mini App says "Could not connect" | Check that `WEB_APP_URL` ends with `/exec` and the deployment has access **Anyone**. Then run `setup` again. |
| Mini App says "Open in Telegram" | Open it with the bot's **Open Tasks** button, not a browser link. |
| Bot buttons or commands don't respond | Run `setup` again. It re-registers the webhook. |
| No reminders arriving | In Apps Script, open ⏰ **Triggers** and check that `tick` runs every 5 minutes. Running `setup` again recreates it. |
| Lost the admin code | Run `setup` again. A new code is generated while there is no admin. |
| A member can't see a task | Check the task is Active and assigned to them, and that the member has **Gets tasks** turned on (for "All members" tasks). |
