# **Extemplary**

---

A **free** browser extention for practicing **NSDA Extemporaneous Speaking**. Record a round, recieve tailored comments &feedback, review your speech transcript, and automatically save a history of every round you've practiced.

**[Live demo →](#deployment)**

![Image22](Images/speechbackgr.png)

---

## What is Extemp? 🗣️

Extemporaneous Speaking refers to a speech event where you deliver a **7 minute** memorized speech (no notes!) on a topic that you will be given **30 minutes** to research. The aim of Extemporaneous Speaking is to deliver the strongest, most well crafted  speech with precise evidence and flawless reasoning, testing both your presentational and analytical writing skills.

---

## Features 🧩
---
**How the Extention works (summed up in 1 flowchart!)**
Sign up → Generate questions → Write a speech → Record your speech → Receive feedback → Set goals → Practice more → Track your improvement/progress → Correct bad habits & general weaknesses

- **Record a round** | Generate 3 realistic practice questions, run a prep timer, then record on your webcam for your speech.

- **AI-judged ballot** | Transcribes your speech, analyzes vocal delivery straight from the extracted audio, and scores you on a custom made **8-category NSDA extemp rubric** using the model: Llama 3.3 70B on Groq.

- **Vocal Delivery Analysis** | Each speech will be measured for volume, emphasis, tone/pitch variety, pauses, pace (WPM), filler words, and stutters/repetitions.

- **Annotated transcript** | An automated transcript with personalized comments (🟥 = big mistake, 🟦 = comment, 🟩 = brilliant move, 🟨 = minor error).

- **Watch & Read Along** | An embedded video player synced word-for-word with the transcript. Click any word (or any judge's note) to jump the video to that **exact** moment; the current word highlights live as it plays.

- **Citation checker** | Before you use a stat or quote, paste the claim, the date, and the source in the citation checker and Extemplary will search the web to verify it. The result could either be **TRUE**, **FALSE**, or **UNVERIFIED**, with a 2-3 sentence explanation and a link to the source of the claim/evidence. If you are not sure of the exact data, you can swap any unknown digit for `?` (ex. `06/??/2025`) for a range of possible dates. You can also use the citation checker to check the citations from other people's speech.

- **Example ballot** | An example sample round (with speech and ballot) so first-time users can see what a finished round looks like before recording their own, including the same synced playback experience.

- **Accounts & sign-in** | Sign up with an email and password to save your progress. Sessions persist automatically: close the tab, come back later, and you're still signed in. Sign out any time from the account menu.

- **Cloud-saved ballot history** | Every completed round (video, transcript, full written feedback, and category scores) is saved and automatically stored onto your account and available from any device you sign in on, via the **My History** page.

- **Coach's Overall Notes** | Comprehensive feedback of your Extemp journey that finds patterns across your *entire* practice history, naming your biggest recurring strength, your biggest recurring area to improve, and one concrete next step. It's designed to update automatically at designated milestone rounds or whenever you record a particularly brillian round.

- **Trends across your ballots** | The "History view" combines & stores your average score in each rubric category across every round you've recorded, with per-category bars plus your top overall strengths and weaknesses.

- **Score line graphs** | Line graphs of your overall score, sorted by individual rubric category and type of practice, plotted round-by-round across all of your speeches. This not only helps with tracking your progress in a specific area across months of hard work, but also serves as a representation of your speeches as a whole. 

- **Streak & Calendar** | A tracked practice streak: When you record a ballot, set a goal, or complete one keeps the streak alive. Your current streak lives in a flame counter fixed to the top of the app, and the full **Streak Calendar** view lays out a month-by-month history of active days, and your current & best streak.

- **tournament & event tracker** | Located in the calendar tab, you can add an upcoming tournament's date and name on the calendar. It will also show up in list below the calendar.

- **Goals** | Set some attainable goals to achieve in the future! Either hit a streak length, beat an overall score threshold, beat a threshold in one specific rubric category, complete a number of practice rounds, or live video ballots this month. Each goal tracks its own live progress. My History also contains *Suggested Goals* that are auto-generated from your own weakest rubric categories, current average score, and current streak, so there's always a sensible next target waiting for you.

- **Session score tracking & export** | Precise score tracking within a session **and** over many rounds, plus export to `.txt`, printable ballot, video download, and shareable round links.

- **Extemp Rubric** | A comprehensive rubric that includes all aspects of an extemp speech for grading speeches.

- **Installable PWA** | Works offline for timing/recording; add to your phone's home screen.

- **Tutorial** | The first time you create an account, a walkthrough gides you through every part of the app, allowing the user to try every feature the site offers. During the tutorial, the Coach's Notes, Trends, and Goals sections show a placeholder skeleton preview instead of a blank page.

Note: Extemplary requires camera and microphone access for recording speeches (duh).

## Free trial before signing up! 🆓
---
The sign-in screen is also a landing page. Scroll down past the log in info to see a glimpes of what the app can actually do. Interact with the several features which you can try live, no account required!

- **1️⃣ Real practice questions** | pick between **domestic, economic, and international** topics and get three relevant extemp questions on the spot (one free try per browser).

- **2️⃣ Current event briefings** | generate current event/news briefing the same way the in-app Tournament Briefing feature does (one free try per browser).

- **3️⃣ A working prep timer** | the actual 30-minute countdown, fully functional, unlimited use.

- **Watch & Read Along preview** | a real annotated transcript excerpt with clickable judge's-note highlights, plus the example round's video in its own player.

- **4️⃣ AI-judged ballot preview** | one full, real category (with score, What Worked, Critical Flaws, and What You Could Have Done) pulled from an actual ballot.

- **5️⃣ Citation checker** | verify one real claim against its source, the exact same way the in-app Citation Checker does (one free try per browser).

- 6️⃣ **Example Ballot** | Contains a **complete** example round with an example transcript, video, feedback, comments, rubric, and score.

Note: the Streak Calendar and Goals system are account features and aren't part of the free-try preview, since both are built on your ongoing ballot history.

## Software ⚙️
---
Supabase: provides authentication and cloud storage

- **Transcription:** Groq's Whisper (`whisper-large-v3`)
- **Judging:** Groq's Llama 3.3 70B 
- **Question drafting, briefings & citation checking:** Google's Gemini with live Google Search
- **Audio analysis:** Web Audio API (client-side FFT/pitch/volume analysis)
- **Video:** `MediaRecorder` for capture and`<video>` for review/playback. The example ballot utilizes the YouTube IFrame API for its sample speech.
- **Accounts:** [Supabase Auth](https://supabase.com/docs/guides/auth) (requires email + password), loaded client-side via `supabase-js`
- **Cloud storage:** Supabase table (`ballots`) for scores, transcripts, and feedback. Table (`user_overall_feedback`) was created/used for the "Coach's Overall Notes" comments. Table (`calendar_events`) was created/used for tournament/event dates on the Calendar. The table (`user_goals`) was used for storing goals and their targets. Last, a private Supabase Storage bucket (`ballot-videos`) was created for storing recorded videos with Row Level Security so that each account can only ever access its own data
- **Streak calculation:** Computed entirely on the clientside from `ballots` and `user_goals` rows. A day counts as "active" if you recorded a ballot, set a goal, or currently have a goal complete that day.
- **Local storage:** (localStorage`) used for minor preferences (theme, timer settings) and for whether a browser has already tried its one free landing-page demo (questions, briefings, citation checker). Everything privacy & account related (ex. ballots, video, session, streak/calendar events, goals) is in Supabase.

## Getting started 📖
---
### Try it!
Open `Extemplary.html` in any modern desktop or mobile browser, no installs needed.

> **Note:** The example ballot's video uses YouTube IFrame API, which requires the page be served over. `http(s)://` It won't load correctly if you open the file from disk (`file://`). Cloud history also require `https://` (or `localhost`) for the reason browsers require it for camera access. See [Deployment](#deployment) below to host it properly!

### Creating an account 👤
---
You'll land on the sign in screen (landing page) the first time you open the app.

1. Locate the **Sign Up** tab, enter an email and a password (requires 6+ characters), and submit.
2. Depending on the project's auth settings, you may need to check your email and click a confirmation link before your first log in (see [Supabase setup](#supabase-setup) below).
3. Once signed in, you'll stay signed in automatically, even after closing the tab or restarting your browser, until you tap **Sign out** in the top right of the account menu. You will also see a quick tutorial on how the extention works that will guide you through all the features of Extemplary.

Every round completed while signed in is saved **automatically**. Click on any past round in the "My Ballot History" page to rewatch the video, re-read the transcript, or reread the full judge's feedback, read your Coach's Overall Notes, view your progress graphs, general strengths/weaknesses and view & add **Goals** (with auto-suggested ones based on your own weak spots).

### API keys 🔑
---
The app utilizes default Groq and Gemini API keys for transcription, judging, and question/briefing/citation generation. **As of now, the API keys now cannot be replaced by your own**.

## Supabase setup 💾
---
Accounts and cloud history run on a Supabase project.

If you fork this project and want your *own* Supabase backend rather than the one it comes with:
**Create a new Supabase project**, run `setup.sql` there, and swap in your project's URL and anon key in `SUPABASE_URL` / `SUPABASE_ANON_KEY` near the top of `<script>` in `Extemplary.html`. The anon key is meant to be public, Row Level Security. It is *not* meant to be key secrecy.

### Email delivery 🌐
---
Supabase's built-in email sender only allows two emails/hour. Providers like Resend, Brevo, or SendGrid all have free tiers, but all require a valid domain. Therefore, there is **currently no built in email verification system for sign ups**. However, we are trying to resolve the issue soon.

## Deployment 📦
---
To get a real `https://` URL (required for camera access, sign in page, and the example ballot's embedded video to work):

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, pick the branch and folder where `Extemplary.html` lives.
4. GitHub will give you a URL like:
```
   https://<your-username>.github.io/<repo-name>/Extemplary.html
```
5. Open that URL: camera recording, AI judging, account sign up/log in, and the synced example video will all work normally.

Viewing the raw file on `github.com/.../blob/...` or VIA `raw.githubusercontent.com` is **not** the same as hosting it.

My reccomendation is to just use GitHub Pages for a working page.

## Browser support
---
Requires a modern browser with support for `MediaRecorder`, `getUserMedia`, and the Web Audio API (recent Chrome, Edge, Firefox, or Safari). Camera/microphone access as well as account sign-in and cloud history require either `https://` or `localhost`.

## Privacy & data 🛡️
---
- Audio is sent *only* to Groq's API for transcription and judging; question drafting, briefing generation, and citation checking are sent only to Google's Gemini API.
- Account email/password and ballot history (scores, transcripts, feedback, and recorded video) are stored in Supabase, associated only with your account, and protected by Row Level Security. In other words, no other user can read or modify your data through the app.
- Your Streak Calendar data (tournament/event entries) and Goals data (goal type, target, progress source) are likewise stored in Supabase, tied to your account, and protected by Row Level Security.
- Recorded video is stored in **private** storage buckets; it is only ever served back to your browser via short-lived signed links generated while you're signed in, not via public URLs.
- The landing page's "free try" demos (practice questions, current event briefings, citation checker) run before sign-in and are not saved anywhere only a "used" sign is stored locally so the free sample isn't repeatable.

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