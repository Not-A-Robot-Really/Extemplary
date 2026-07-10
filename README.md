# Extemplary

A single-file, browser-based practice tool for **NSDA Extemporaneous Speaking** (extemp). Record a round, get an AI judge's ballot, review your speech with a synced video + transcript player, and build a saved history of every round you've practiced — all from one HTML file, with accounts and cloud storage powered by Supabase.

**[Live demo →](#deployment)** (set up GitHub Pages — see below)

---

## What it does

- **Record a round** — draws or generates a question, runs a prep timer, then records you on camera for your speech.
- **AI-judged ballot** — transcribes your speech (Groq Whisper), analyzes vocal delivery straight from the audio waveform, and scores you against an 8-category NSDA-style rubric (Llama 3.3 70B via Groq).
- **Vocal Delivery Analysis** — volume, emphasis, tone/pitch variety, pauses, pace (WPM), filler words, and stutters/repetitions, measured directly from your recording.
- **Annotated transcript** — a stenographer-style transcript with color-coded, clickable judge's notes (🟥 big mistake, 🟦 comment, 🟩 brilliant move, 🟨 minor error) and auto-detected section labels (Intro / Body 1–3 / Conclusion).
- **Watch & Read Along** — an embedded video player synced word-for-word with the transcript. Click any word (or any judge's note) to jump the video to that exact moment; the current word highlights live as it plays.
- **Example ballot** — a fully worked sample round (real speech, real ballot) so first-time users can see what a finished round looks like before recording their own, including the same synced playback experience.
- **Accounts & sign-in** — sign up with an email and password to save your progress. Sessions persist automatically: close the tab, come back later, and you're still signed in. Sign out any time from the account menu.
- **Cloud-saved ballot history** — every completed round (video, transcript, full written feedback, and category scores) is saved to your account and available from any device you sign in on, via a **My History** view.
- **Trends across your ballots** — the History view aggregates your average score in each rubric category across every round you've recorded, surfacing your overall strengths and weaknesses at a glance, not just per-round feedback.
- **Session score tracking & export** — round-over-round score tracking within a session, plus export to `.txt`, printable ballot, video download, and shareable round links.
- **Installable PWA** — works offline for timing/recording; add to your phone's home screen.

## Tech

Everything lives in a single `.html` file — no build step, no custom backend, no framework. A Supabase project provides authentication and cloud storage.

- **Transcription:** Groq's Whisper (`whisper-large-v3`, word-level timestamps)
- **Judging:** Groq's Llama 3.3 70B Versatile
- **Audio analysis:** Web Audio API (client-side FFT/pitch/volume analysis — no server round-trip)
- **Video:** `MediaRecorder` for capture, plain `<video>` for review/playback; the example ballot uses the YouTube IFrame API for its sample speech
- **Accounts:** [Supabase Auth](https://supabase.com/docs/guides/auth) (email + password), loaded client-side via `supabase-js`
- **Cloud storage:** a Supabase Postgres table (`ballots`) for scores/transcripts/feedback, and a private Supabase Storage bucket (`ballot-videos`) for recorded videos — both locked down with Row Level Security so each account can only ever access its own data
- **Local storage:** `localStorage` is still used for lightweight preferences (theme, timer settings); everything account-related (ballots, video, session) lives in Supabase, not the browser

## Getting started

### Just try it
Open `Extemplary.html` in any modern desktop or mobile browser. That's it — no install, no npm, no server to run.

> **Note:** the example ballot's video uses the YouTube IFrame API, which requires the page be served over `http(s)://` — it won't load correctly if you just double-click the file from disk (`file://`). Your own recorded rounds don't have this restriction; that playback is a plain local `<video>` element. Signing up, logging in, and cloud history also require `https://` (or `localhost`) for the same reason browsers require it for camera access. See [Deployment](#deployment) below to host it properly.

### Creating an account
The first time you open the app you'll land on a **Log In / Sign Up** screen.

1. Switch to the **Sign Up** tab, enter an email and a password (6+ characters), and submit.
2. Depending on the project's auth settings, you may need to check your email and click a confirmation link before your first log in (see [Supabase setup](#supabase-setup) below).
3. Once signed in, you'll stay signed in automatically — even after closing the tab or restarting your browser — until you tap **Sign out** in the account menu (top right).

Every round you finish while signed in is saved automatically. Tap the clock icon in the header at any time to open **My History**: expand any past round to rewatch the video, re-read the transcript, or reread the full judge's feedback, or scroll up to see your average score by category across all your rounds and your standout overall strengths and weaknesses.

### API keys
The app ships with default Groq API keys for transcription/judging. If you hit rate limits or want to use your own, open **Settings → Override Groq API Key** and paste your own key from [console.groq.com](https://console.groq.com).

## Supabase setup

Accounts and cloud history run on a Supabase project. The app already has a project's URL and public (`anon`) key wired in, but that project needs one piece of one-time setup before sign-ups, history, and video storage will work.

1. Open the corresponding project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor → New query**, paste in the contents of `setup.sql` (included in this repo), and run it. This creates:
   - A `ballots` table (question, scores, feedback, transcript, video path) with Row Level Security, so each signed-in user can only read, insert, or delete their own rows.
   - A private `ballot-videos` Storage bucket with matching policies, so videos are only reachable by their owner via short-lived signed URLs.
3. Under **Authentication → Providers → Email**, confirm email sign-in is enabled, and decide whether to require **email confirmation** before first login (on by default — recommended for a publicly hosted app; can be turned off for faster testing).
4. Under **Authentication → URL Configuration**, set **Site URL** (and add to **Redirect URLs**) to your deployed GitHub Pages URL, so confirmation emails link back to the right place.

If you fork this project and want your *own* Supabase backend rather than the one it ships with, create a new Supabase project, run `setup.sql` there, and swap in your project's URL and anon key where `SUPABASE_URL` / `SUPABASE_ANON_KEY` are defined near the top of the `<script>` in `Extemplary.html`. The anon key is meant to be public — it's Row Level Security, not key secrecy, that protects user data.

## Deployment

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

Requires a modern browser with support for `MediaRecorder`, `getUserMedia`, and the Web Audio API (recent Chrome, Edge, Firefox, or Safari). Camera/microphone access, as well as account sign-in and cloud history, require either `https://` or `localhost` — browsers block media capture on plain `http://`, and Supabase Auth sessions behave unreliably there too.

## Privacy & data

- Audio is sent only to Groq's API for transcription and judging.
- Account email/password and ballot history (scores, transcripts, feedback, and recorded video) are stored in Supabase, associated only with your account, and protected by Row Level Security — no other user can read or modify your data through the app.
- Recorded video is stored in a **private** Storage bucket; it is only ever served back to your browser via short-lived signed links generated while you're signed in, not via public URLs.

## Disclaimer

This is an unofficial practice tool and is not affiliated with or endorsed by the NSDA.

## License

MIT — see below.

```
MIT License

Copyright (c) 2026 Extemplary contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> **Note on API keys:** this repo, as shipped, includes working default Groq and Supabase keys so it runs out of the box. The MIT license covers the *code* — it does not give you rights to those specific keys or the quota/data behind them. If you fork or redeploy this publicly, please swap in your **own** Groq API key (`console.groq.com`) and your **own** Supabase project (URL + anon key, with `setup.sql` run against it) rather than reusing the ones baked into this copy. Reusing someone else's keys in a public deployment can exhaust their quota or expose their Supabase project to traffic they didn't intend, and is not something the license permits just because the code is open.
