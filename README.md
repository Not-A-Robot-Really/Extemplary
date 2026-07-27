# **Extemplary**

---

A **free** browser extention for practicing **NSDA Extemporaneous Speaking**. Record a round, receive an AI judge's ballot, recieve feedback & review your speech transcript, and automatically record a saved history of every round you've practiced. Account creation and cloud storage are powered by Supabase.

**[Live demo →](#deployment)** (setting up GitHub Pages — see below)

![Image22](speechbackgr.png)

---

## What is Extemp? 🗣️

Extemporaneous Speaking refers to a speech event where you deliver a **7 minute** memorized speech (no notes!) on a topic that you will be given **30 minutes** to research. The aim of Extemporaneous Speaking is to deliver the strongest, most well crafted  speech with evidence and flawless reasoning, testing both your presentational and analytical writing skills.

---

## Features 🧩
---
Sign up → Generate questions → Write a speech → Record your speech → Receive feedback → Set goals → Practice more → Track your improvement/progress → Correct bad habits & general weaknesses

- **Record a round** — Generate 3 realistic practice questions, run a prep timer, then record on camera for your speech.

- **AI-judged ballot** — Transcribes your speech, analyzes vocal delivery straight from the audio waveform, and scores you using a custom made **8-category NSDA extemp rubric** (using the model: Llama 3.3 70B on Groq).

- **Vocal Delivery Analysis** — Volume, emphasis, tone/pitch variety, pauses, pace (WPM), filler words, and stutters/repetitions, measured directly from your recording.

- **Annotated transcript** — An automated transcript with color coded, personalized comments (🟥: big mistake, 🟦: comment, 🟩: brilliant move, 🟨: minor error) and auto marked paragraph labels (Intro / Body 1–3 / Conclusion).

- **Watch & Read Along** — An embedded video player synced word-for-word with the transcript. Click any word (or any judge's note) to jump the video to that **exact** moment; the current word highlights live as it plays.

- **Citation checker** — Before you use a stat or quote in-round, paste the claim, the date it happened, and the source it's attributed to, and Gemini searches the web live to verify it. Marks the claim **TRUE**, **FALSE**, or **UNVERIFIED**, with a 2-3 sentence explanation and a link to the real source it found. Not sure of the exact date? Swap any unknown digit for `?` (e.g. `06/??/2025`) and it'll treat that as an approximate range instead of a literal date. You can also use the citation checker to check the citations from other people's speech.

- **Example ballot** — An example sample round (with speech and ballot) so first-time users can see what a finished round looks like before recording their own, including the same synced playback experience.

- **Accounts & sign-in** — Sign up with an email and password to save your progress. Sessions persist automatically: close the tab, come back later, and you're still signed in. Sign out any time from the account menu.

- **Cloud-saved ballot history** — Every completed round (video, transcript, full written feedback, and category scores) is saved and automatically stored onto your account and available from any device you sign in on, via the **My History** page.

- **Coach's Overall Notes** — A short comment sitting at the top of My History that synthesizes patterns across your *entire* practice history, naming your biggest recurring strength, your biggest recurring area to improve, and one concrete next step. It's regenerated automatically at milestone round counts (1, 2, 3, 5, 7, 10, then every 5 rounds after that) or whenever you post a clear breakthrough round, so it stays current without burning an AI call on every single visit.

- **Trends across your ballots** — The History view aggregates your average score in each rubric category across every round you've recorded, with per-category bars plus your top overall strengths and weaknesses, letting you see the whole picture — not just per-round feedback.

- **Score trend line graphs** — Sparkline charts for your overall score and for each individual rubric category, plotted round-by-round across your whole history, so you can see exactly where you're improving (or backsliding) at a glance.

- **Streak & Calendar** — A tracked practice streak: any day you record a ballot, set a goal, or complete one keeps the streak alive. Your current streak lives in a flame counter fixed to the top of the app, and the full **Streak Calendar** view lays out a month-by-month history of active days, your current and best-ever streak, and milestone markers at 3, 7, 14, 30, and 365 days. The same calendar doubles as a lightweight **tournament & event tracker** — add an upcoming competition's date and name and it'll show up in a running, sorted list of what's next (with past events tucked away behind a toggle).

- **Goals system** — Set concrete goals for yourself right from the Streak Calendar or My History: hit a streak length, beat an overall score threshold, beat a threshold in one specific rubric category, complete a number of practice rounds or live video ballots this month, or simply show up to a tournament on your calendar. Each goal tracks its own live progress bar computed straight from your ballot history. My History also surfaces **Suggested Goals** — no extra AI call needed — auto-generated from your own weakest rubric categories, current average score, and current streak, so there's always a sensible next target waiting for you.

- **Session score tracking & export** — Precise score tracking within a session **and** over many rounds, plus export to `.txt`, printable ballot, video download, and shareable round links.

- **Installable PWA** — Works offline for timing/recording; add to your phone's home screen.

Note: Extemplary requires camera and microphone access for recording speeches (duh).

## Free trial before signing up! 🆓
---
The sign-in screen is also a landing page. Scroll down past the log in info to see a glimpes of what the app can actually do, with several features you can try live, no account required!:

- **1️⃣ Real practice questions** — pick between **domestic, economic, and international** topics and get three relevant extemp questions on the spot (one free try per browser).

- **2️⃣ Current event briefings** — generate current event/news briefing the same way the in-app Tournament Briefing feature does (one free try per browser).

- **3️⃣ A working prep timer** — the actual 30-minute countdown, fully functional, unlimited use.

- **Watch & Read Along preview** — a real annotated transcript excerpt with clickable judge's-note highlights, plus the example round's video in its own player.

- **4️⃣ AI-judged ballot preview** — one full, real category (with score, What Worked, Critical Flaws, and What You Could Have Done) pulled from an actual ballot.

- **5️⃣ Citation checker** — verify one real claim against its source, the exact same way the in-app Citation Checker does (one free try per browser).

- 6️⃣ **Example Ballot** — Contains a **complete** example round, with example transcript, video, feedback, comments, rubric, and score. This preview is fully  from the rest of the app. You can look around without ever being signed into anything.

Note: the Streak Calendar and Goals system are account features and aren't part of the free-try preview, since both are built on your ongoing ballot history.

## Software ⚙️
---
Supabase provides authentication and cloud storage.

- **Transcription:** Groq's Whisper (`whisper-large-v3`, word-level timestamps)
- **Judging:** Groq's Llama 3.3 70B (Versatile) 
- **Question drafting, briefings & citation checking:** Google's Gemini with live Google Search grounding, used both in the signed-in app and for the landing page's live free-try demos
- **Audio analysis:** Web Audio API (client-side FFT/pitch/volume analysis — no server round-trip)
- **Video:** `MediaRecorder` for capture, plain `<video>` for review/playback; the example ballot uses the YouTube IFrame API for its sample speech
- **Accounts:** [Supabase Auth](https://supabase.com/docs/guides/auth) (email + password), loaded client-side via `supabase-js`
- **Cloud storage:** a Supabase Postgres table (`ballots`) for scores/transcripts/feedback, a table (`user_overall_feedback`) for the cached Coach's Overall Notes comment, a table (`calendar_events`) for tournament/event dates behind the Streak Calendar, a table (`user_goals`) for saved goals and their targets, and a private Supabase Storage bucket (`ballot-videos`) for recorded videos — all locked down with Row Level Security so each account can only ever access its own data
- **Streak calculation:** computed entirely client-side from your existing `ballots` and `user_goals` rows — no separate streak table needed. A day counts as "active" if you recorded a ballot, set a goal, or currently have a goal complete that day.
- **Local storage:** `localStorage` is used for lightweight preferences (theme, timer settings) and for remembering whether a browser has already used its one free landing-page demo try (questions, briefings, citation checker); everything account-related (ballots, video, session, streak/calendar events, goals) lives in Supabase, not the browser

## Getting started 📖
---
### Just try it
Open `Extemplary.html` in any modern (up to date) desktop or mobile browser. No installs needed, no npm, no server to run.

> **Note:** the example ballot's video uses the YouTube IFrame API, which requires the page be served over `http(s)://` — it won't load correctly if you just double-click the file from disk (`file://`). Your own recorded rounds don't have this restriction; that playback is a plain local `<video>` element. Signing up, logging in, and cloud history also require `https://` (or `localhost`) for the same reason browsers require it for camera access. See [Deployment](#deployment) below to host it properly.

### Creating an account 👤
---
You'll land on the sign in screen (landing page) the first time you open the app.

1. Locate the **Sign Up** tab, enter an email and a password (requires 6+ characters), and submit.
2. Depending on the project's auth settings, you may need to check your email and click a confirmation link before your first log in (see [Supabase setup](#supabase-setup) below).
3. Once signed in, you'll stay signed in automatically — even after closing the tab or restarting your browser — until you tap **Sign out** in the account menu (top right).

Every round completed while signed in is saved **automatically**. Tap the clock icon in the header at any time to open **My History**: expand any past round to rewatch the video, re-read the transcript, or reread the full judge's feedback, read your Coach's Overall Notes, scroll through your score trend line graphs and category strengths/weaknesses across all your rounds, review or add **Goals** (including auto-suggested ones based on your own weak spots), and jump straight to the Streak Calendar from there.

Tap the flame icon in the header to open the **Streak Calendar**: see your current and best-ever streak, a full monthly view of active days, upcoming tournaments/events you've added, and your active goals with live progress bars, all in one place.

Tap the magnifying-glass icon in the header any time to open the **Citation Checker** and verify a claim before you use it in a speech.

### API keys 🔑
---
The app utilizes default Groq and Gemini API keys for transcription, judging, and question/briefing/citation generation. If you hit rate limits or want to use your own, open **Settings → Override Groq API Key** and paste your own key from [console.groq.com](https://console.groq.com).

## Supabase setup 💾
---
Accounts and cloud history run on a Supabase project. The app already has a project's URL and public (`anon`) key wired in, but that project needs one piece of one-time setup before sign-ups, history, and video storage will work.

1. Open the corresponding project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor → New query**, paste in the contents of `setup.sql` (included in this repo), and run it. This creates:
   - A `ballots` table (question, scores, feedback, transcript, video path) with Row Level Security, so each signed-in user can only read, insert, or delete their own rows.
   - A `user_overall_feedback` table for the cached Coach's Overall Notes comment, also protected by Row Level Security.
   - A `calendar_events` table (event date, title, notes) powering the Streak Calendar's tournament/event tracker, protected by Row Level Security.
   - A `user_goals` table (goal type, params, target date, status) powering the Goals system, protected by Row Level Security.
   - A private `ballot-videos` Storage bucket with matching policies, so videos are only reachable by their owner via short-lived signed URLs.
3. Under **Authentication → Providers → Email**, confirm email sign-in is enabled, and decide whether to require **email confirmation** before first login (on by default — recommended for a publicly hosted app; can be turned off for faster testing, and either way needs a working SMTP sender — see below).
4. Under **Authentication → URL Configuration**, set **Site URL** (and add to **Redirect URLs**) to your deployed GitHub Pages URL, so confirmation emails link back to the right place.

If you fork this project and want your *own* Supabase backend rather than the one it ships with, create a new Supabase project, run `setup.sql` there, and swap in your project's URL and anon key where `SUPABASE_URL` / `SUPABASE_ANON_KEY` are defined near the top of the `<script>` in `Extemplary.html`. The anon key is meant to be public — it's Row Level Security, not key secrecy, that protects user data.

### Email delivery 🌐
---
Supabase's built-in email sender is rate-limited to about 2 emails/hour, which doesn't cut it logistically for signups. Providers like Resend, Brevo, or SendGrid all have workable free tiers, though most require verifying either a valid sender domain or a single sender address before they'll deliver to real recipients. Therefore, there is **currently no built in email verification system** for sign ups. However, we are trying to resolve the issue soon.

## Deployment 📦
---
To get a real `https://` URL (required for camera access, sign-in, and the example ballot's embedded video to work):

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, pick the branch and folder where `Extemplary.html` lives.
4. GitHub will give you a URL like:
```
   https://<your-username>.github.io/<repo-name>/Extemplary.html
```
5. Open that URL — camera recording, AI judging, account sign-up/log-in, and the synced example video will all work normally.

Viewing the raw file on `github.com/.../blob/...` or via `raw.githubusercontent.com` is **not** the same as hosting it — use GitHub Pages for a real, working page.

## Browser support 
---
Requires a modern browser with support for `MediaRecorder`, `getUserMedia`, and the Web Audio API (recent Chrome, Edge, Firefox, or Safari). Camera/microphone access, as well as account sign-in and cloud history, require either `https://` or `localhost` — browsers block media capture on plain `http://`, and Supabase Auth sessions behave unreliably there too.

## Privacy & data 🛡️
---
- Audio is sent only to Groq's API for transcription and judging; question drafting, briefing generation, and citation checking are sent only to Google's Gemini API.
- Account email/password and ballot history (scores, transcripts, feedback, and recorded video) are stored in Supabase, associated only with your account, and protected by Row Level Security — no other user can read or modify your data through the app.
- Your Streak Calendar data (tournament/event entries) and Goals data (goal type, target, progress source) are likewise stored in Supabase, tied to your account, and protected by Row Level Security.
- Recorded video is stored in **private** storage buckets; it is only ever served back to your browser via short-lived signed links generated while you're signed in, not via public URLs.
- The landing page's free-try demos (practice questions, current event briefings, citation checker) run before sign-in and are not saved anywhere — only a "used" flag is kept locally in your browser so the free try isn't repeatable.

## Disclaimer ⚠️
---
This is an unofficial practice tool and is not affiliated with or endorsed by the NSDA.

## License
---
MIT License

Copyright (c) 2026 Extemplary contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**API keys:** this repo includes working default Groq, Gemini, and Supabase keys so it runs out of the box. The MIT license does not give rights to those specific keys or the data behind them. If you fork or redeploy this publicly, please swap in your **own** Groq API key, your **own** Gemini API key, and your **own** Supabase project rather than reusing the current ones.