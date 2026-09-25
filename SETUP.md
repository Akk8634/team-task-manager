# Team Task Manager: Setup Guide

A task manager that runs entirely inside Telegram.

- **Telegram Mini App:** an app-like screen inside Telegram for tasks, checklists, the team dashboard and admin settings
- **Telegram bot:** 4 daily reminders (8 AM, 2 PM, 8 PM, 11 PM), weekly/monthly checkpoints and admin reports, with quick ✅ Done buttons
- **Cloudflare (free plan):** hosts the Mini App, runs the backend (Pages Functions) and stores the data (D1 database)
- **Google Sheet:** a read-only copy for reports and history, updated every 15 minutes. Its script also runs the reminder check every 5 minutes.

## Files

| File | What it is |
|---|---|
| `index.html` | The Mini App screen |
| `functions/api/[[path]].js` | The backend: Mini App API, bot webhook, reminders, Sheet copy |
| `_headers` | Cloudflare Pages cache settings |
| `backend/Code.gs` | The Google Sheet script: moves old data once, runs the reminder check, updates the Sheet copy |
| `backend/appsscript.json` | Apps Script project settings (IST timezone) |

---

## Step 1: Create the Telegram bot (2 min)

1. Open **@BotFather** in Telegram and send `/newbot`.
2. Give it a name (e.g. *Cityflo Tasks*), then a username that ends in `bot` (e.g. `cityflo_tasks_bot`).
3. Copy the **token** BotFather gives you (e.g. `123456789:ABC...`). Keep it private.

## Step 2: Host the app on Cloudflare Pages (5 min)

1. Go to **https://dash.cloudflare.com/sign-up** and create a free account.
2. Open **Workers & Pages → Create → Pages → Connect to Git**, sign in with GitHub (the `Akk8634` account) and pick the **`team-task-manager`** repository.
3. On the build settings screen:
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** `/`
4. Click **Save and Deploy**. Cloudflare shows your site URL, e.g. `https://cityflo-tasks.pages.dev`.

The `functions` folder becomes the backend automatically.

## Step 3: Create the database and the secret key (5 min)

1. In Cloudflare, open **Storage & Databases → D1 SQL Database → Create**. Name it `cityflo-tasks` and click **Create**.
2. Open **Workers & Pages → your Pages project → Settings → Bindings → Add → D1 database**:
   - **Variable name:** `DB` (exactly this)
   - **D1 database:** `cityflo-tasks`
   - Save.
3. In the same project, open **Settings → Variables and Secrets → Add**:
   - **Type:** Secret
   - **Variable name:** `SYNC_KEY`
   - **Value:** a long random password (at least 20 letters and numbers). The Google Sheet script uses it to talk to the backend.
   - Save.
4. Open **Deployments**, and on the latest deployment choose **⋯ → Retry deployment**. Bindings and secrets take effect on the next deployment.

The tables are created automatically in Step 4.

## Step 4: Connect the Google Sheet (5 min)

1. Create a Google Sheet, e.g. **"Team Task Manager"**, and open **Extensions → Apps Script**.
2. Replace everything in `Code.gs` with **`backend/Code.gs`**, and fill in CONFIG:
   ```js
   const CONFIG = {
     APP_URL: 'https://cityflo-tasks.pages.dev', // Step 2
     SYNC_KEY: '...',                            // Step 3
     BOT_TOKEN: '123456789:ABC...',              // Step 1
   };
   ```
3. 💾 Save, select **`setup`** in the dropdown at the top, click **Run** and allow access when asked.
4. Open **Execution log**. It shows a **6-digit admin code** (only when there is no admin yet).

> **Moving from the old Apps Script version?** Use the same Sheet and the same Apps Script project. The first `setup` copies Tasks, Team, TaskLog and TaskLog Archive (and the reminder times and bot token) into the database, then renames the old log tabs to *Old TaskLog* and *Old TaskLog Archive*. It never copies twice, so the live data is never overwritten. The old web app deployment is no longer used and can be archived.

`setup` connects the bot to Cloudflare, adds the **Open Tasks** menu button, schedules the check every 5 minutes and creates the Sheet copy.

## Step 5: Become the admin

1. Open your bot in Telegram and tap **Start**.
2. Tap the **Open Tasks** button (bottom-left of the chat).
3. Enter the 6-digit admin code. You are now the Admin.

## Step 6: Add your team

1. Share the bot link (`https://t.me/<bot_username>`) with your team.
2. Each person opens the bot, taps **Start** and then **Open Tasks**. This sends a join request.
3. You get a Telegram message with **✅ Approve / ❌ Reject** buttons. You can also approve people in **Manage → People**.

## Step 7: Create tasks

In the Mini App, go to **Manage → Tasks → ＋ New task**:

| Field | Options |
|---|---|
| Category | **Daily**, **Weekly**, **Monthly** or **One-time** |
| Weekly: when? | **Any day** (complete any time in the week, by the last working day) or **Fixed days** (e.g. every Wednesday) |
| Monthly: when? | **Any time** (complete any time in the month, by the last day) or **Fixed date** (e.g. the 5th) |
| Shift | **Morning** (due by the afternoon time, 2 PM) · **Evening** / **General** (due by end of day) |
| Time | Optional label shown on the task, e.g. a meeting at 11:30 AM. No separate reminder. |
| If applicable | For tasks that only happen sometimes (incidents, breakdowns). Not counted as pending, no reminders. Members mark them Done or N/A. |
| Checklist | Optional sub-items. Each item is **Required** or **Optional** (e.g. a surprise breathalyzer check). The task is done when every required item is ticked; optional items never block it. In the sheet, optional items end with `(optional)`. |
| Assign to | All members, or selected people only |
| Active | Turn off to pause a task without deleting it |

Test the reminders from **Manage → Settings → Send now**. The same section has **📢 Message to team**, to send your own message to everyone or to selected people through the bot.

---

## Deadlines: on time, Late and Missed

| Task | Complete by | After the deadline |
|---|---|---|
| Daily, Morning shift | **2:00 PM** the same day | **Late** until midnight, then **Missed** |
| Daily, Evening / General | **End of day** (midnight) | **Missed** |
| Weekly, any day | **Last working day of the week** (Friday for Mon–Fri) | **Late** over the weekend, **Missed** from Monday |
| Monthly, any time | **Last working day of the month** | **Late** until the month ends, then **Missed** |
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
| **11:00 PM** 🌙 | Final reminder: after midnight these tasks count as late or missed |

Weekly and monthly checkpoints are added to the 8 AM message:

| When | Weekly ("any day" tasks) | Monthly ("any time" tasks) |
|---|---|---|
| Start | First working day of the week: this week's list | First working day of the month: this month's list |
| Middle | Thursday: mid-week check | 15th: mid-month check |
| End | Last working day: "due today" (also at 8 PM and 11 PM) | Last 3 working days: countdown (last day also at 8 PM and 11 PM) |

**Admin reports** come with the 8 AM message: the previous working day's on-time / late / missed per member (on Monday, Friday's report), last week's weekly tasks on the first working day of the week, and last month's monthly tasks on the first working day of the month.

**Working days** (default Mon–Fri) are set in **Manage → Settings**. Days off get no daily tasks, no reminders and no Missed. Tasks with a fixed day or date keep that day even if it is a day off.

Change the 4 reminder times in **Manage → Settings**. They go out within 5 minutes of the set time.

## Bot commands

- `/today`: today's tasks and their status
- `/pending`: only pending tasks
- `/app`: open the Mini App

## Data and reports in the Google Sheet

The app keeps its data in the Cloudflare database. The Sheet is a **copy** that updates every 15 minutes (or right away from the menu **Task Manager → Update this Sheet now**). Changes typed into these tabs are overwritten; manage tasks and people in the app.

| Tab | What it shows |
|---|---|
| **Tasks** | All task settings |
| **Team** | Telegram ID, name, role (Admin / Member), status and "Gets tasks" |
| **History** | Every status change: one row per member, per task, per period, with status, ticked checklist items, remarks and time. Kept forever. |
| **Daily Report** | One row per member per day: tasks due, done on time, done late, not done, on-time %. Added after each day ends. |
| **Weekly & Monthly Report** | "Any day" weekly tasks per week and "any time" monthly tasks per month, per member |
| **Monthly Summary** | Totals per member per month (daily + weekly + monthly), newest month first |

Use filters on these tabs, or **File → Download** for Excel/CSV. The app's Team tab shows the last 60 days.

## Updating the code later

- **App and backend (`index.html`, `functions/`):** push to GitHub. Cloudflare Pages redeploys within a minute or two.
- **Google Sheet script (`Code.gs`):** paste the new version and save. No deployment is needed.

## Free plan limits

| | Free limit | This team (25 people, 50 tasks) |
|---|---|---|
| Requests | 100,000 a day | a few thousand a day |
| Database | 5 GB, 5 million row reads a day | a few MB, well under the read limit |
| Deploys | 500 a month | a few a week |
| Messages per reminder | about 40 at once; the rest go with the next check (≤ 5 min later) | 25 |

## Troubleshooting

| Problem | Fix |
|---|---|
| App says "The app is being upgraded" | `setup` has not finished yet. Run it again and check the log. |
| App says "Open in Telegram" | Open it with the bot's **Open Tasks** button, not a browser link. |
| `setup` says "Wrong or missing SYNC_KEY" | The key in CONFIG must match the Cloudflare secret, and the deployment must have been redeployed after adding it (Step 3.4). |
| "The database is not connected yet" | Add the D1 binding named `DB` (Step 3.2) and redeploy. |
| Bot buttons or commands don't respond | Run `setup` again. It re-registers the webhook. |
| No reminders arriving | In Apps Script, open ⏰ **Triggers** and check that `tick` runs every 5 minutes. Running `setup` again recreates it. |
| Lost the admin code | Run `setup` again. A new code is shown while there is no admin. |
| A member can't see a task | Check the task is Active and assigned to them, and that the member has **Gets tasks** turned on (for "All members" tasks). |
