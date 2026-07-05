# Extemplary
 
A single-file, browser-based practice tool for **NSDA Extemporaneous Speaking** (extemp). Record a round, get an AI judge's ballot, and review your speech with a synced video + transcript player — all client-side, no backend required.
 
**[Live demo →](#deployment)** (set up GitHub Pages — see below)
 
---
 
## What it does
 
- **Record a round** — draws or generates a question, runs a prep timer, then records you on camera for your speech.
- **AI-judged ballot** — transcribes your speech (Groq Whisper), analyzes vocal delivery straight from the audio waveform, and scores you against an 8-category NSDA-style rubric (Llama 3.3 70B via Groq).
- **Vocal Delivery Analysis** — volume, emphasis, tone/pitch variety, pauses, pace (WPM), filler words, and stutters/repetitions, measured directly from your recording.
- **Annotated transcript** — a stenographer-style transcript with color-coded, clickable judge's notes (🟥 big mistake, 🟦 comment, 🟩 brilliant move, 🟨 minor error) and auto-detected section labels (Intro / Body 1–3 / Conclusion).
- **Watch & Read Along** — an embedded video player synced word-for-word with the transcript. Click any word (or any judge's note) to jump the video to that exact moment; the current word highlights live as it plays.
- **Example ballot** — a fully worked sample round (real speech, real ballot) so first-time users can see what a finished round looks like before recording their own, including the same synced playback experience.
- **Session history & export** — round-over-round score tracking, plus export to `.txt`, printable ballot, video download, and shareable round links.
- **Installable PWA** — works offline for timing/recording; add to your phone's home screen.
## Tech
 
Everything lives in a single `.html` file — no build step, no server, no framework.
 
- **Transcription:** Groq's Whisper (`whisper-large-v3`, word-level timestamps)
- **Judging:** Groq's Llama 3.3 70B Versatile
- **Audio analysis:** Web Audio API (client-side FFT/pitch/volume analysis — no server round-trip)
- **Video:** `MediaRecorder` for capture, plain `<video>` for review/playback; the example ballot uses the YouTube IFrame API for its sample speech
- **Storage:** `localStorage` for theme preference only — no accounts, no server-side data storage
## Getting started
 
### Just try it
Open `Extemplary.html` in any modern desktop or mobile browser. That's it.
 
> **Note:** the example ballot's video uses the YouTube IFrame API, which requires the page be served over `http(s)://` — it won't load correctly if you just double-click the file from disk (`file://`). Your own recorded rounds don't have this restriction; that playback is a plain local `<video>` element. See [Deployment](#deployment) below to host it properly.
 
### API keys
The app ships with default Groq API keys for transcription/judging. If you hit rate limits or want to use your own, open **Settings → Override Groq API Key** and paste your own key from [console.groq.com](https://console.groq.com).
 
## Deployment
 
To get a real `https://` URL (recommended, and required for the example ballot's embedded video to work):
 
1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, pick the branch and folder where `Extemplary.html` lives.
4. GitHub will give you a URL like:
```
   https://<your-username>.github.io/<repo-name>/Extemplary.html
```
5. Open that URL — camera recording, AI judging, and the synced example video will all work normally.
Viewing the raw file on `github.com/.../blob/...` or via `raw.githubusercontent.com` is **not** the same as hosting it — use GitHub Pages for a real, working page.
 
## Browser support
 
Requires a modern browser with support for `MediaRecorder`, `getUserMedia`, and the Web Audio API (recent Chrome, Edge, Firefox, or Safari). Camera/microphone access requires either `https://` or `localhost` — browsers block media capture on plain `http://`.
 
## Disclaimer
 
This is an unofficial practice tool and is not affiliated with or endorsed by the NSDA. Audio is sent only to Groq's API for transcription and judging.
 
## License
 
.
