const DATA = window.APP_DATA;
(function(){

  // ===== SUPABASE CONFIG =====
  // Fill these in with YOUR project's values (Project Settings → API).
  // SUPABASE_ANON_KEY is the public "anon" key, it's designed to be
  // exposed in client-side code (Supabase docs make this explicit) and is
  // NOT the same thing as a service_role key or a Groq/Gemini API key. The
  // real Groq/Gemini keys now live only as server-side secrets on the edge
  // functions below and never ship in this file.
  const SUPABASE_URL = 'https://iiehhmelfotwkdqxplug.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpZWhobWVsZm90d2tkcXhwbHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDYxMzEsImV4cCI6MjA5ODkyMjEzMX0.8QzN1LJmr70Sidxp2RsOq-z3S_NX5lN9QWTr45CSaHo';
  const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

  // ===== AUTH + SAVED PROGRESS =====
  // Real accounts via Supabase Auth (email + password). Session tokens are
  // persisted by supabase-js itself (localStorage), which is what makes
  // "stay signed in across tabs/reopens" work with zero extra code.
  // Ballot history (video/transcript/feedback) lives in the cloud: a
  // Postgres table ("ballots") plus a Storage bucket ("ballot-videos") in
  // this same Supabase project, both protected by Row Level Security so
  // each signed-in user can only ever read/write their own rows and files.
  // One-time setup required in the Supabase SQL editor, see setup.sql.
  const supabaseClient = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  // Exposed so tutorial.js can reuse this exact client instance instead of
  // creating a second one. Two live GoTrueClient instances in the same tab
  // can deadlock on the session-refresh lock, which is what was hanging the
  // tutorial's "Next" button on the speaker-name step.
  window.ExtemplarySupabase = supabaseClient;
  const VIDEO_BUCKET = 'ballot-videos';

  // ===== EDGE FUNCTION AUTH =====
  // The edge functions require verify_jwt now, so the plain anon key is no
  // longer enough to call them — the request needs a real Supabase-issued
  // user JWT. Signed-in users already have one from their session. Anyone
  // else (e.g. mid-signup, or a session that hasn't hydrated yet) gets a
  // lightweight anonymous-auth session instead, so nothing here has to wait
  // on or force a real signup.
  let anonSignInPromise = null;
  async function getAuthToken(){
    if(!supabaseClient) return SUPABASE_ANON_KEY;
    const { data } = await supabaseClient.auth.getSession();
    if(data?.session?.access_token) return data.session.access_token;
    if(!anonSignInPromise) anonSignInPromise = supabaseClient.auth.signInAnonymously();
    const { data: anonData, error } = await anonSignInPromise;
    anonSignInPromise = null;
    if(error || !anonData?.session?.access_token){
      throw new Error('auth_failed:could not establish a session for this request.');
    }
    return anonData.session.access_token;
  }

  // ===== USAGE LIMIT WIDGET =====
  // Bottom-left floating button + panel showing today's AI usage per
  // category, as progress bars. Reads directly from the `api_usage` table
  // (RLS lets a user select only their own rows); the edge functions are
  // the ones that actually enforce the caps server-side via
  // increment_api_usage() — these numbers here are just for display.
  // Keep this list in sync with DAILY_LIMITS in the three edge functions.
  const RATE_CATEGORIES = [
    { key: 'ballot_feedback',   label: 'Ballot Feedback',              limit: 100 },
    { key: 'citation_checker',  label: 'Citation Checker',             limit: 40 },
    { key: 'question_generator',label: 'Practice Question Generator',  limit: 40 },
    { key: 'current_events',    label: 'Current Events Summary',       limit: 15 }
  ];
  // Ballot Feedback is judged by whichever model the picker has selected
  // (see JUDGE_MODELS / judgeModelValue further down), and those models
  // don't cost the same to run. Rather than every judging call draining
  // the daily cap by a flat 1 unit, pricier models drain it faster and
  // cheaper ones drain it slower — weighted roughly (inversely) against
  // each model's Cost score on the "LLM Model Rankings" panel: a low
  // cost score (expensive) burns more units per call, a high cost score
  // (cheap) burns fewer. Keep the keys in sync with JUDGE_MODELS below.
  const BALLOT_FEEDBACK_MODEL_WEIGHTS = {
    llama:      1,  // GPT-OSS 120B — cost score 97 (cheapest per-token on
                    // Groq). This is the correct weight for the single-call
                    // path (Intro/Body Drill, Body Drill, Rough Draft).
                    // Regular Practice does NOT use this value at all —
                    // runGptOssSplitJudging below passes its own explicit
                    // weightOverride per call (see doFetch), since that
                    // path fires 9 real HTTP calls (8 category passes + 1
                    // synthesis pass) and needs the daily-cap charge
                    // spread across them by hand rather than multiplied by
                    // this single flat number 9 times.
    deepseekv4pro: 1, // DeepSeek V4 Pro — cost score 97
    qwen38:     1,  // Qwen3.8 2.4T A95B — cost score 88
    gemini37flash: 1, // Gemini 3.7 Flash — cost score 93
    glm52:      1,  // GLM 5.2        — cost score 91
    sonnet5:    2,  // Claude Sonnet 5— cost score 82
    kimik3:     3,  // Kimi K3        — cost score 74
    opus5:      5   // Claude Opus 5  — cost score 57
  };
  const BALLOT_FEEDBACK_USAGE_KEY = 'extemplary_bf_weighted_usage';
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  // When a 429 response body fails to parse (res.json() throws — a
  // network blip, or a stream cut short right at a day-boundary isolate
  // rotation), info.currentCount/info.usageLimit end up undefined, which
  // rendered as a literal "?/?" in the rate-limit toast — technically
  // correct but useless to the person reading it. Fall back to a real
  // number instead: the category's known daily limit, plus (for
  // ballot_feedback specifically) the locally tracked weighted usage
  // count, which is our best guess at the real server-side count even
  // without a parseable response.
  function rateLimitFallback(category){
    const cat = RATE_CATEGORIES.find(c => c.key === category);
    const limit = cat ? cat.limit : null;
    const count = category === 'ballot_feedback' ? getWeightedBallotFeedbackUnits() : null;
    return { count, limit };
  }
  // A 429 from one of our own edge functions means the daily quota was
  // genuinely hit, and always comes back as {error:'rate_limited',
  // currentCount, usageLimit}. But Supabase also enforces its own
  // platform-level rate limit (a per-project/per-function requests-per-
  // second cap, separate from the app's quota system) — e.g. when the
  // Opus 5 / Kimi / DeepSeek judging loop fires several hackclub-chat
  // calls in quick succession across continuation rounds. THAT 429's
  // body doesn't match our app's shape, so treating every 429 as a real
  // quota block used to surface a locally-tracked fallback number
  // (whatever this browser had guessed so far, e.g. "11") mislabeled as
  // if it were the real daily count — even though the actual server
  // count (checkable directly in the DB) was correctly much higher, and
  // a genuine quota block literally cannot fire below the limit since
  // the counter only ever increases. Callers should use isRealQuotaBlock
  // to decide whether to show "you've hit your daily limit" at all, vs.
  // treating it as a transient error worth retrying.
  async function readRateLimitInfo(res, fallbackCategory){
    const info = await res.json().catch(()=> ({}));
    const isRealQuotaBlock = !!(info && info.error === 'rate_limited');
    const fallback = rateLimitFallback(info.category || fallbackCategory);
    return { info, isRealQuotaBlock, fallback };
  }
  function getWeightedBallotFeedbackUnits(){
    try{
      const raw = JSON.parse(localStorage.getItem(BALLOT_FEEDBACK_USAGE_KEY) || 'null');
      return (raw && raw.date === todayISO()) ? (raw.units || 0) : 0;
    }catch(e){ return 0; }
  }
  function addWeightedBallotFeedbackUnits(modelKey){
    try{
      const weight = BALLOT_FEEDBACK_MODEL_WEIGHTS[modelKey] || 1;
      const units = getWeightedBallotFeedbackUnits() + weight;
      localStorage.setItem(BALLOT_FEEDBACK_USAGE_KEY, JSON.stringify({ date: todayISO(), units }));
    }catch(e){}
  }
  const RATE_LIMIT_ROBOT_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="4" y="8" width="16" height="12" rx="2"></rect>' +
    '<line x1="12" y1="8" x2="12" y2="4"></line>' +
    '<circle cx="12" cy="4" r="1.3" fill="#ffffff"></circle>' +
    '<line x1="2" y1="14" x2="4" y2="14"></line>' +
    '<line x1="20" y1="14" x2="22" y2="14"></line>' +
    '<line x1="9" y1="13" x2="9" y2="15"></line>' +
    '<line x1="15" y1="13" x2="15" y2="15"></line>' +
    '</svg>';
  const RateLimitUI = (function(){
    let built = false, panelEl, btnEl, barsEl, styleInjected = false;
    function injectStyles(){
      if(styleInjected) return;
      styleInjected = true;
      const style = document.createElement('style');
      style.textContent = `
        .ai-usage-btn{
          position:fixed;right:16px;bottom:16px;z-index:99999;
          width:36px;height:36px;box-sizing:border-box;padding:6px;border-radius:5px;
          display:flex;align-items:center;justify-content:center;
          background:var(--charcoal);border:1px solid var(--charcoal);color:var(--on-accent);
          cursor:pointer;box-shadow:none;transition:color .15s, background .15s;
        }
        .ai-usage-btn:hover{color:var(--crimson-bright);}
        .ai-usage-panel{
          position:fixed;right:16px;bottom:56px;z-index:99999;
          width:290px;max-width:calc(100vw - 32px);
          background:var(--parchment);border:1px solid var(--charcoal);border-radius:5px;
          box-shadow:none;overflow:hidden;
          visibility:hidden;opacity:0;transform:translateX(24px);
          transition:opacity .22s cubic-bezier(0.2,0.8,0.3,1), transform .22s cubic-bezier(0.2,0.8,0.3,1), visibility .22s;
          pointer-events:none;
        }
        .ai-usage-panel.open{
          visibility:visible;opacity:1;transform:translateX(0);pointer-events:auto;
        }
        .ai-usage-panel .sp-head{
          background:var(--charcoal);padding:13px 16px;
          font-family:var(--font-display);font-size:15px;letter-spacing:0.3px;
          color:var(--on-accent);border-bottom:3px double var(--crimson);
        }
        .ai-usage-panel .sp-body{padding:14px 16px 12px;}
        .ai-usage-row{margin-bottom:11px;}
        .ai-usage-row:last-child{margin-bottom:0;}
        .ai-usage-label-row{
          display:flex;justify-content:space-between;align-items:baseline;
          font-family:var(--font-body);font-size:12.5px;color:var(--charcoal);margin-bottom:5px;
        }
        .ai-usage-count{
          font-family:var(--font-mono);font-size:10px;letter-spacing:0.5px;color:var(--slate);
        }
        .ai-usage-track{height:7px;box-sizing:border-box;border-radius:4px;background:#ffffff;border:1px solid var(--rule);overflow:hidden;}
        .ai-usage-fill{height:100%;transition:width 0.3s ease;}
        .ai-usage-note{
          font-family:var(--font-body);font-size:11px;color:var(--slate);
          margin-top:10px;padding-top:10px;border-top:1px solid var(--rule);
        }
        .copy-confirm-toast{
          position:fixed;right:20px;bottom:20px;z-index:2147483100;
          background:var(--crimson);color:var(--on-accent);border:1px solid var(--crimson-deep);
          font-family:var(--font-body);font-size:13px;font-weight:600;
          padding:10px 16px;border-radius:6px;
          opacity:0;transform:translateY(8px);
          transition:opacity .2s ease, transform .2s ease;
          pointer-events:none;
        }
        .copy-confirm-toast.show{opacity:1;transform:translateY(0);}
      `;
      document.head.appendChild(style);
    }
    function build(){
      if(built) return;
      built = true;
      injectStyles();
      btnEl = document.createElement('button');
      btnEl.type = 'button';
      btnEl.className = 'ai-usage-btn';
      btnEl.setAttribute('aria-label', "AI Token Usage");
      btnEl.title = "AI Token Usage";
      btnEl.innerHTML = RATE_LIMIT_ROBOT_ICON_SVG;
      panelEl = document.createElement('div');
      panelEl.className = 'ai-usage-panel';
      const head = document.createElement('div');
      head.className = 'sp-head';
      head.textContent = "AI Token Usage";
      panelEl.appendChild(head);
      const body = document.createElement('div');
      body.className = 'sp-body';
      barsEl = document.createElement('div');
      body.appendChild(barsEl);
      const note = document.createElement('div');
      note.className = 'ai-usage-note';
      note.textContent = 'Resets daily at midnight UTC.';
      body.appendChild(note);
      panelEl.appendChild(body);
      document.body.appendChild(btnEl);
      document.body.appendChild(panelEl);
      btnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panelEl.classList.contains('open');
        panelEl.classList.toggle('open', willOpen);
        if(willOpen) refresh();
      });
      document.addEventListener('click', (e) => {
        if(panelEl.classList.contains('open') && !panelEl.contains(e.target) && e.target !== btnEl){
          panelEl.classList.remove('open');
        }
      });
      render({});
    }
    function render(counts){
      barsEl.innerHTML = '';
      RATE_CATEGORIES.forEach(cat => {
        const count = cat.key === 'ballot_feedback'
          ? Math.max(counts[cat.key] || 0, getWeightedBallotFeedbackUnits())
          : (counts[cat.key] || 0);
        const pct = Math.min(100, Math.round((count / cat.limit) * 100));
        const row = document.createElement('div');
        row.className = 'ai-usage-row';
        const labelRow = document.createElement('div');
        labelRow.className = 'ai-usage-label-row';
        labelRow.innerHTML = `<span>${cat.label}</span><span class="ai-usage-count">${count}/${cat.limit}</span>`;
        const track = document.createElement('div');
        track.className = 'ai-usage-track';
        const fill = document.createElement('div');
        fill.className = 'ai-usage-fill';
        const color = pct >= 100 ? 'var(--score-red)' : pct >= 75 ? 'var(--score-yellow)' : 'var(--score-green)';
        fill.style.cssText = `width:${pct}%;background:${color};`;
        track.appendChild(fill);
        row.appendChild(labelRow);
        row.appendChild(track);
        barsEl.appendChild(row);
      });
    }
    async function refresh(){
      build();
      try{
        if(!supabaseClient) return;
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const userId = sessionData?.session?.user?.id;
        if(!userId){ render({}); return; }
        const today = new Date().toISOString().slice(0,10);
        const { data, error } = await supabaseClient
          .from('api_usage')
          .select('category,count')
          .eq('usage_date', today);
        if(error){ console.warn('usage fetch failed', error); return; }
        const counts = {};
        (data||[]).forEach(row => { counts[row.category] = row.count; });
        render(counts);
      }catch(e){ console.warn('usage refresh failed', e); }
    }
    function addBallotFeedbackUsage(modelKey){
      addWeightedBallotFeedbackUnits(modelKey);
      refresh();
    }
    return { build, refresh, addBallotFeedbackUsage };
  })();
  window.RateLimitUI = RateLimitUI;
  RateLimitUI.build();
  RateLimitUI.refresh();

  let currentUser = null; // { id, email }

  async function loadHistory(){
    if(!currentUser || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('ballots')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('ts', { ascending: false });
    if(error){ console.warn('Could not load ballot history', error); return []; }
    return (data || []).map(row => ({
      id: row.id, round: row.round, ts: new Date(row.ts).getTime(),
      question: row.question || '', total: row.total, rank: row.rank,
      categories: row.categories || [], feedback: row.feedback || '',
      transcript: row.transcript || '', hasVideo: !!row.video_path,
      videoPath: row.video_path || null,
      annotations: row.annotations || null,
      deliveryMetrics: row.delivery_metrics || null,
      // Older rows saved before this distinction existed didn't record a
      // source, so treat them as live-camera video ballots (the original,
      // still-default recording method) rather than dropping them from
      // "video ballots" goal counts.
      recordSource: (row.delivery_metrics && row.delivery_metrics.recordSource) || 'camera',
      isIntroDrill: !!(row.delivery_metrics && row.delivery_metrics.isIntroDrill),
      isBodyDrill: !!(row.delivery_metrics && row.delivery_metrics.isBodyDrill),
      isRoughDraft: !!(row.delivery_metrics && row.delivery_metrics.isRoughDraft),
      // Tucked into delivery_metrics (see recordBallotToHistory) rather than
      // a new column, same pattern as recordSource/isIntroDrill above.
      factCheck: (row.delivery_metrics && row.delivery_metrics.factCheck) || null
    }));
  }

  // Records one completed round (called from renderResults once feedback
  // has been parsed) so it shows up later in "My History".
  async function recordBallotToHistory(parsed, feedback, transcript, question, round, videoBlob, annotations, deliveryMetrics, recordSource, isIntroDrill, isBodyDrill, factCheck, isRoughDraft){
    if(!currentUser || !supabaseClient) return;
    const id = (crypto.randomUUID && crypto.randomUUID()) || ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2,8));
    let videoPath = null;
    if(videoBlob){
      videoPath = currentUser.id + '/' + id + '.webm';
      const { error: upErr } = await supabaseClient.storage
        .from(VIDEO_BUCKET)
        .upload(videoPath, videoBlob, { contentType: videoBlob.type || 'video/webm', upsert: true });
      if(upErr){ console.warn('Could not upload video', upErr); videoPath = null; }
    }
    // Tuck how the video was captured ('camera' = recorded live, 'capture' =
    // tab/YouTube capture, 'upload' = a pre-existing file) into the existing
    // delivery_metrics JSON blob, so the "Video ballots this month" goal can
    // count only rounds that were actually recorded live, distinct from the
    // "Practice rounds this month" goal, which counts every completed round.
    // Also tuck in whether this round was an Intro Drill (introduction-only,
    // trimmed rubric) or a Body Drill (single-body-paragraph-only, trimmed
    // rubric) so History can label it distinctly without a schema change.
    // factCheck (the independent, non-scored evidence fact-check pass) is
    // tucked in here the same way, rather than adding a new `ballots`
    // column — keeps this feature deployable without a schema migration.
    const deliveryMetricsWithSource = Object.assign({}, deliveryMetrics || {}, { recordSource: recordSource || 'camera', isIntroDrill: !!isIntroDrill, isBodyDrill: !!isBodyDrill, isRoughDraft: !!isRoughDraft, factCheck: factCheck || null });
    // Save everything the live results view can show, including the
    // color-coded annotated-transcript data (sections + comments) and the
    // measured vocal delivery metrics, so "My History" can reconstruct the
    // full formatted ballot later, not just a plain-text dump.
    const { error } = await supabaseClient.from('ballots').insert({
      id, user_id: currentUser.id, round, ts: new Date().toISOString(),
      question: question || '', total: parsed.total, rank: parsed.rank,
      categories: parsed.categories.map(c => ({name:c.name, score:c.score, max:c.max})),
      feedback: feedback || '', transcript: transcript || '', video_path: videoPath,
      annotations: annotations || null, delivery_metrics: deliveryMetricsWithSource
    });
    if(error) console.warn('Could not save ballot to cloud history', error);
  }

  async function getVideoUrl(videoPath){
    if(!videoPath || !supabaseClient) return null;
    const { data, error } = await supabaseClient.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(videoPath, 3600);
    if(error){ console.warn('Could not load saved video', error); return null; }
    return data.signedUrl;
  }

  async function deleteBallotFromHistory(id, videoPath){
    if(!supabaseClient) return;
    await supabaseClient.from('ballots').delete().eq('id', id);
    if(videoPath) await supabaseClient.storage.from(VIDEO_BUCKET).remove([videoPath]);
  }

  // ===================================================================
  // ===== STREAK / CALENDAR / GOALS ====================================
  // ===================================================================
  // Two new tables are required in Supabase (same RLS pattern as `ballots`
  //user_id, RLS restricting rows to auth.uid()):
  //
  //   calendar_events(id uuid pk, user_id uuid, event_date date,
  //                    title text, notes text, created_at timestamptz)
  //   user_goals(id uuid pk, user_id uuid, type text, params jsonb,
  //              target_date date null, status text default 'active',
  //              created_at timestamptz)
  //
  // An "active" day = any day you recorded a ballot, set a goal, or had a
  // goal complete. This is computed entirely client-side from the same
  // `ballots`/`user_goals` rows already loaded for My History, no extra
  // table needed for the streak itself.
  const GOAL_CATEGORIES = DATA.GOAL_CATEGORIES;
  const STREAK_MILESTONES = DATA.STREAK_MILESTONES;

  function dateKey(d){
    // Local-time YYYY-MM-DD (never UTC, avoids the classic "yesterday at
    // 8pm" off-by-one when the user is west of UTC).
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function keyToLocalDate(key){
    const [y,m,d] = key.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  // date -> true if anything happened that day: a ballot was recorded, a
  // goal was set, or (best-effort, since we don't store a completion date)
  // a goal is currently complete, that last case can only credit today.
  function activeDaysByDay(list, goals, events){
    const map = {};
    list.forEach(e => { map[dateKey(new Date(e.ts))] = true; }); // any ballot made
    (goals||[]).forEach(g => {
      if(g.created_at) map[dateKey(new Date(g.created_at))] = true; // any goal set
    });
    const anyGoalCompleteNow = (goals||[]).some(g => {
      if(g.type === 'streak') return false; // avoid circularity with the streak we're computing
      return goalProgress(g, list, { current:0, best:0 }, events||[]).done;
    });
    if(anyGoalCompleteNow) map[dateKey(new Date())] = true; // any goal completed
    return map;
  }
  function computeStreak(list, goals, events){
    const byDay = activeDaysByDay(list, goals, events);
    const today = new Date(); today.setHours(0,0,0,0);
    let cursor = new Date(today);
    // Today doesn't have to have activity yet for the streak to still be
    // "alive", only step back to yesterday as the start if today has no
    // recorded activity yet.
    if(!byDay[dateKey(cursor)]) cursor.setDate(cursor.getDate()-1);
    let streak = 0;
    while(byDay[dateKey(cursor)]){
      streak++;
      cursor.setDate(cursor.getDate()-1);
    }
    // Best-ever streak, scanning every day that has any activity.
    let best = 0, run = 0;
    const days = Object.keys(byDay).sort();
    let prevDate = null;
    days.forEach(k => {
      const d = keyToLocalDate(k);
      if(byDay[k]){
        if(prevDate && (d - prevDate) === 86400000) run++; else run = 1;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
      prevDate = d;
    });
    best = Math.max(best, streak);
    return { current: streak, best, byDay };
  }

  async function loadCalendarEvents(){
    if(!currentUser || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('calendar_events').select('*').eq('user_id', currentUser.id).order('event_date', { ascending:true });
    if(error){ console.warn('Could not load calendar events', error); return []; }
    return data || [];
  }
  async function addCalendarEvent(eventDate, title, notes){
    if(!currentUser || !supabaseClient) return null;
    const id = (crypto.randomUUID && crypto.randomUUID()) || ('ev_' + Date.now());
    const { error } = await supabaseClient.from('calendar_events').insert({
      id, user_id: currentUser.id, event_date: eventDate, title, notes: notes || '', created_at: new Date().toISOString()
    });
    if(error){ console.warn('Could not save event', error); showToast('Could not save that event'); return null; }
    return id;
  }
  async function deleteCalendarEvent(id){
    if(!supabaseClient) return;
    await supabaseClient.from('calendar_events').delete().eq('id', id);
  }

  async function loadGoals(){
    if(!currentUser || !supabaseClient) return [];
    const { data, error } = await supabaseClient
      .from('user_goals').select('*').eq('user_id', currentUser.id).order('created_at', { ascending:false });
    if(error){ console.warn('Could not load goals', error); return []; }
    return data || [];
  }
  async function addGoal(type, params, targetDate){
    if(!currentUser || !supabaseClient) return null;
    const id = (crypto.randomUUID && crypto.randomUUID()) || ('g_' + Date.now());
    const { error } = await supabaseClient.from('user_goals').insert({
      id, user_id: currentUser.id, type, params, target_date: targetDate || null,
      status:'active', created_at: new Date().toISOString()
    });
    if(error){ console.warn('Could not save goal', error); showToast('Could not save that goal'); return null; }
    showToast('Goal added');
    return id;
  }
  async function deleteGoal(id){
    if(!supabaseClient) return;
    await supabaseClient.from('user_goals').delete().eq('id', id);
  }

  // Short label suffix reflecting a goal's practice-type scope (blank for "all").
  function goalPracticeTypeSuffix(pt){
    if(pt === 'regular') return ' (Regular Practice)';
    if(pt === 'introdrill') return ' (Rapid Drill: Intro)';
    if(pt === 'bodydrill') return ' (Rapid Drill: Body)';
    if(pt === 'roughdraft') return ' (Rough Draft)';
    return '';
  }
  function goalLabel(g){
    const suffix = goalPracticeTypeSuffix(g.params && g.params.practiceType);
    if(g.type === 'streak') return `Hit a ${g.params.days}-day Exemplary streak`;
    if(g.type === 'score') return `Score above ${g.params.threshold} overall in a speech${suffix}`;
    if(g.type === 'category') return `Score above ${g.params.threshold} in ${escHtml(g.params.category)}${suffix}`;
    if(g.type === 'rounds') return `Complete ${g.params.count} practice rounds this month${suffix}`;
    if(g.type === 'videos') return `Record ${g.params.count} live video ballots this month${suffix}`;
    if(g.type === 'tournament') return `Compete at ${escHtml(g.params.title || 'the upcoming tournament')}`;
    return 'Goal';
  }
  // Returns {current, target, pct, done}
  function goalProgress(g, list, streakInfo, events){
    if(g.type === 'streak'){
      const cur = Math.min(streakInfo.current, g.params.days);
      return { current: streakInfo.current, target: g.params.days, pct: Math.min(100, cur/g.params.days*100), done: streakInfo.current >= g.params.days };
    }
    // Every other goal type (besides streak/tournament, which aren't tied to
    // individual ballots) is measured only against the practice type chosen
    // when the goal was created, "Regular Practice", "Rapid Drill:
    // Introduction", or "All" (the default for goals saved before this
    // filter existed).
    const scopedList = filterByPracticeType(list, (g.params && g.params.practiceType) || 'all');
    if(g.type === 'score'){
      const best = scopedList.reduce((m,e) => (e.total!==null && e.total!==undefined && e.total>m) ? e.total : m, 0);
      return { current: best, target: g.params.threshold, pct: Math.min(100, best/g.params.threshold*100), done: best >= g.params.threshold };
    }
    if(g.type === 'category'){
      let best = 0;
      scopedList.forEach(e => (e.categories||[]).forEach(c => {
        if(c.name === g.params.category){ const pct = (c.score/(c.max||10))*100; if(pct>best) best = pct; }
      }));
      return { current: Math.round(best), target: g.params.threshold, pct: Math.min(100, best/g.params.threshold*100), done: best >= g.params.threshold };
    }
    if(g.type === 'rounds' || g.type === 'videos'){
      const now = new Date();
      const count = scopedList.filter(e => {
        const d = new Date(e.ts);
        if(d.getFullYear()!==now.getFullYear() || d.getMonth()!==now.getMonth()) return false;
        if(g.type === 'rounds') return true; // every completed round this month, video or not
        // 'videos': only rounds actually recorded live via camera this month, 
        // excludes rounds where a video was merely uploaded from a file or
        // captured from a shared tab/YouTube playback, since those aren't a
        // live recording of your own delivery.
        return e.hasVideo && e.recordSource === 'camera';
      }).length;
      return { current: count, target: g.params.count, pct: Math.min(100, count/g.params.count*100), done: count >= g.params.count };
    }
    if(g.type === 'tournament'){
      const ev = (events||[]).find(e => e.id === g.params.eventId);
      const passed = ev ? (new Date(ev.event_date) < new Date(new Date().toDateString())) : false;
      return { current: passed?1:0, target:1, pct: passed?100:0, done: passed };
    }
    return { current:0, target:1, pct:0, done:false };
  }

  // ---- suggested goals (My Ballot History), derived from the user's own
  // weaknesses and Coach's Overall Notes, no extra AI call needed since
  // the weakness ranking is already computed from their ballot data. ----
  function computeSuggestedGoals(list, goals, events){
    if(!list.length) return [];
    const rows = computeTrends(list);
    if(!rows.length) return [];
    const weakest = rows[rows.length-1];
    const secondWeakest = rows.length > 1 ? rows[rows.length-2] : null;
    const totals = list.map(e=>e.total).filter(t=>t!==null&&t!==undefined);
    const avgTotal = totals.length ? totals.reduce((a,b)=>a+b,0)/totals.length : 0;
    const bestTotal = totals.length ? Math.max(...totals) : 0;
    const streakInfo = computeStreak(list, goals, events);
    const suggestions = [];
    // 1) Category goal targeting the single weakest graded category.
    suggestions.push({
      type:'category', params:{ category: weakest.name, threshold: Math.min(95, Math.round(weakest.avgPct + 15)) },
      why: `Your weakest area across your ballots is ${weakest.name} (avg ${weakest.avgPct.toFixed(0)}%).`
    });
    if(secondWeakest){
      suggestions.push({
        type:'category', params:{ category: secondWeakest.name, threshold: Math.min(95, Math.round(secondWeakest.avgPct + 15)) },
        why: `${secondWeakest.name} is also trending as a recurring weak spot (avg ${secondWeakest.avgPct.toFixed(0)}%).`
      });
    }
    // 2) Overall-score goal, a stretch above their current average.
    suggestions.push({
      type:'score', params:{ threshold: Math.min(100, Math.round(avgTotal/5)*5 + 10) },
      why: `Your average overall score is ${avgTotal.toFixed(0)}/100 — this pushes just past your recent best of ${bestTotal.toFixed(0)}.`
    });
    // 3) A streak goal calibrated to where they already are.
    const nextMilestone = STREAK_MILESTONES.find(m => m > streakInfo.current) || STREAK_MILESTONES[STREAK_MILESTONES.length-1];
    suggestions.push({
      type:'streak', params:{ days: nextMilestone },
      why: streakInfo.current > 0
        ? `You're on a ${streakInfo.current}-day streak already — keep it going.`
        : `Building a short streak — recording a ballot, setting a goal, or hitting one — is the fastest way to build the habit.`
    });
    return suggestions.slice(0,3);
  }

  // ---- goal creation modal (shared by Streak Calendar + My History) ----
  const goalModalBackdrop = document.getElementById('goalModalBackdrop');
  const goalModal = document.getElementById('goalModal');
  const goalModalBody = document.getElementById('goalModalBody');
  let goalModalOnSaved = null;
  function closeGoalModal(){
    goalModal.classList.add('hidden');
    goalModalBackdrop.classList.add('hidden');
  }
  document.getElementById('goalModalCloseBtn').addEventListener('click', closeGoalModal);
  goalModalBackdrop.addEventListener('click', closeGoalModal);

  function openGoalModal(onSaved, prefill){
    goalModalOnSaved = onSaved || null;
    const p = prefill || {};
    goalModalBody.innerHTML = `
      <div class="gm-field">
        <label>Goal type</label>
        <select id="gmType">
          <option value="streak">Exemplary streak</option>
          <option value="score">Overall score in a speech</option>
          <option value="category">Score in a specific category</option>
          <option value="rounds">Practice rounds this month</option>
          <option value="videos">Live video ballots this month</option>
        </select>
      </div>
      <div class="gm-field" data-for="streak">
        <label>Consecutive Exemplary days</label>
        <select id="gmStreakDays">
          ${STREAK_MILESTONES.map(d => `<option value="${d}">${d} days</option>`).join('')}
        </select>
      </div>
      <div class="gm-field" data-for="score">
        <label>Target overall score (out of 100)</label>
        <input type="number" id="gmScoreThreshold" min="1" max="100" value="90">
      </div>
      <div class="gm-field" data-for="category">
        <label>Category</label>
        <select id="gmCategory">
          ${GOAL_CATEGORIES.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
        </select>
        <label style="margin-top:10px;">Target score (%)</label>
        <input type="number" id="gmCategoryThreshold" min="1" max="100" value="85">
      </div>
      <div class="gm-field" data-for="rounds">
        <label>Number of rounds this month</label>
        <input type="number" id="gmRoundsCount" min="1" max="60" value="5">
      </div>
      <div class="gm-field" data-for="videos">
        <label>Number of live video ballots this month</label>
        <input type="number" id="gmVideosCount" min="1" max="60" value="3">
      </div>
      <div class="gm-field" id="gmPracticeTypeField">
        <label>Practice type</label>
        <select id="gmPracticeType">
          <option value="all">All</option>
          <option value="regular">Regular Practice</option>
          <option value="introdrill">Rapid Drill: Intro</option>
          <option value="bodydrill">Rapid Drill: Body</option>
          <option value="roughdraft">Rough Draft</option>
        </select>
      </div>
      <button type="button" class="btn primary" id="gmSaveBtn" style="width:100%;margin-top:6px;">Save Goal</button>
    `;
    const typeSel = document.getElementById('gmType');
    function syncFields(){
      goalModalBody.querySelectorAll('.gm-field[data-for]').forEach(f => {
        f.style.display = (f.dataset.for === typeSel.value) ? 'flex' : 'none';
      });
      // The practice-type filter applies to every goal type except streak
      // (a streak isn't tied to any one round's practice mode).
      const ptField = document.getElementById('gmPracticeTypeField');
      if(ptField) ptField.style.display = (typeSel.value === 'streak') ? 'none' : 'flex';
    }
    typeSel.value = p.type || 'streak';
    if(p.type === 'category' && p.params){
      document.getElementById('gmCategory').value = p.params.category;
      document.getElementById('gmCategoryThreshold').value = p.params.threshold;
    }
    if(p.type === 'score' && p.params) document.getElementById('gmScoreThreshold').value = p.params.threshold;
    if(p.type === 'streak' && p.params) document.getElementById('gmStreakDays').value = p.params.days;
    if(p.params && p.params.practiceType) document.getElementById('gmPracticeType').value = p.params.practiceType;
    typeSel.addEventListener('change', syncFields);
    syncFields();
    document.getElementById('gmSaveBtn').addEventListener('click', async () => {
      const type = typeSel.value;
      let params = {};
      if(type === 'streak') params = { days: Number(document.getElementById('gmStreakDays').value) };
      else if(type === 'score') params = { threshold: Number(document.getElementById('gmScoreThreshold').value) };
      else if(type === 'category') params = { category: document.getElementById('gmCategory').value, threshold: Number(document.getElementById('gmCategoryThreshold').value) };
      else if(type === 'rounds') params = { count: Number(document.getElementById('gmRoundsCount').value) };
      else if(type === 'videos') params = { count: Number(document.getElementById('gmVideosCount').value) };
      if(type !== 'streak') params.practiceType = document.getElementById('gmPracticeType').value;
      await addGoal(type, params, null);
      closeGoalModal();
      if(goalModalOnSaved) goalModalOnSaved();
    });
    goalModal.classList.remove('hidden');
    goalModalBackdrop.classList.remove('hidden');
  }

  // ---- Goals list markup (shared renderer for both the Streak Calendar
  // view and the My History tab) ----
  function renderGoalsList(goals, list, streakInfo, events){
    if(!goals.length) return '<div class="goals-empty">No goals yet — set one to track your progress.</div>';
    return goals.map(g => {
      const prog = goalProgress(g, list, streakInfo, events);
      return `
        <div class="goal-card ${prog.done?'done':''}" data-goal-id="${g.id}">
          <div class="goal-card-seal" style="--goal-pct:${prog.pct.toFixed(0)}">
            <div class="goal-card-seal-ring"></div>
            <div class="goal-card-seal-hole">
              <span class="goal-card-seal-pct">${prog.pct.toFixed(0)}%</span>
              <svg class="goal-card-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
          </div>
          <div class="goal-card-main">
            <div class="goal-card-label">${escHtml(goalLabel(g))}</div>
            <div class="goal-card-progress">${prog.current}/${prog.target}${g.type==='category'?'%':''}</div>
          </div>
          <button type="button" class="goal-card-del" data-del-goal="${g.id}" aria-label="Remove goal" title="Remove goal">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-58"></use></svg>
          </button>
        </div>`;
    }).join('');
  }
  function wireGoalDeleteButtons(container, refreshFn){
    container.querySelectorAll('[data-del-goal]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteGoal(btn.dataset.delGoal);
        refreshFn();
      });
    });
  }

  // ---- "My Ballot History" goals + suggested-goals section ----
  async function renderHistoryGoals(list){
    const el = document.getElementById('historyGoals');
    if(!el) return;
    if(!list.length){ el.innerHTML = ''; return; }
    const [goals, events] = await Promise.all([loadGoals(), loadCalendarEvents()]);
    const streakInfo = computeStreak(list, goals, events);
    const suggestions = computeSuggestedGoals(list, goals, events);
    el.innerHTML = `
      <div class="history-goals">
        <div class="hg-head">
          <div class="sec-head-title">
            <span class="sec-icon sec-icon-target"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-71"></use></svg></span>
            <h3>Your Goals</h3>
          </div>
          <button type="button" class="btn primary" id="historyAddGoalBtn">+ New Goal</button>
        </div>
        <div class="goals-list" id="historyGoalsList">${renderGoalsList(goals, list, streakInfo, events)}</div>
        ${suggestions.length ? `
        <div class="suggested-goals">
          <h4>Suggested for you</h4>
          <div class="suggested-goals-list">
            ${suggestions.map((s,i) => `
              <div class="suggested-goal-card">
                <div class="sg-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.6 1 1.4 1 2.5h6c0-1.1.3-1.9 1-2.5A6 6 0 0 0 12 3Z"/></svg></div>
                <div class="sg-text">
                  <div class="sg-label">${escHtml(goalLabel({type:s.type, params:s.params}))}</div>
                  <div class="sg-why">${escHtml(s.why)}</div>
                </div>
                <button type="button" class="sg-add" data-sg="${i}">+ Add</button>
              </div>`).join('')}
          </div>
        </div>` : ''}
      </div>`;
    document.getElementById('historyAddGoalBtn').addEventListener('click', () => {
      openGoalModal(() => renderHistoryGoals(list));
    });
    wireGoalDeleteButtons(el, () => renderHistoryGoals(list));
    el.querySelectorAll('.sg-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const s = suggestions[Number(btn.dataset.sg)];
        await addGoal(s.type, s.params, null);
        renderHistoryGoals(list);
      });
    });
  }

  // ---- Streak Calendar view ----
  let streakCalMonth = new Date(); streakCalMonth.setDate(1);
  const flameFilledSvg = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><use href="#icon-59"></use></svg>';
  const flameOutlineSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-60"></use></svg>';

  async function renderStreakView(){
    const list = await loadHistory();
    const [events, goals] = await Promise.all([loadCalendarEvents(), loadGoals()]);
    const streakInfo = computeStreak(list, goals, events);

    const fabCount = document.getElementById('streakFabCount');
    const fabIcon = document.getElementById('streakFabIcon');
    if(fabCount){ fabCount.textContent = streakInfo.current; }
    if(fabIcon){ fabIcon.classList.toggle('flame-live', streakInfo.current > 0); }
    document.getElementById('streakToggle')?.classList.toggle('has-streak', streakInfo.current > 0);

    document.getElementById('streakSummary').innerHTML = `
      <div class="streak-summary-card">
        <div class="ssc-flame">${flameFilledSvg}</div>
        <div class="ssc-stats">
          <div class="ssc-stat"><span class="ssc-val">${streakInfo.current}</span><span class="ssc-cap">Current Streak</span></div>
          <div class="ssc-stat"><span class="ssc-val">${streakInfo.best}</span><span class="ssc-cap">Best Streak</span></div>
        </div>
      </div>`;

    renderStreakCalendar(streakInfo, events, goals);
    renderStreakEvents(events);
    renderStreakGoals(list, streakInfo, events, goals);
  }

  function renderStreakCalendar(streakInfo, events, goals){
    const wrap = document.getElementById('streakCalendarWrap');
    const year = streakCalMonth.getFullYear(), month = streakCalMonth.getMonth();
    const monthLabel = streakCalMonth.toLocaleDateString('en-US', { month:'long', year:'numeric' });
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const todayKey = dateKey(new Date());

    const eventsByDay = {};
    events.forEach(e => { (eventsByDay[e.event_date] = eventsByDay[e.event_date] || []).push(e); });
    const goalDatesByDay = {};
    goals.forEach(g => { if(g.target_date) (goalDatesByDay[g.target_date] = goalDatesByDay[g.target_date] || []).push(g); });

    let cells = '';
    for(let i=0;i<firstDow;i++) cells += `<div class="scal-cell empty"></div>`;
    for(let d=1; d<=daysInMonth; d++){
      const cellDate = new Date(year, month, d);
      const k = dateKey(cellDate);
      const hasActivity = !!streakInfo.byDay[k];
      const isToday = k === todayKey;
      const dayEvents = eventsByDay[k] || [];
      cells += `
        <div class="scal-cell ${isToday?'today':''} ${hasActivity?'lit':''}" data-date="${k}">
          <span class="scal-daynum">${d}</span>
          <span class="scal-flame ${hasActivity?'lit':'none'}">${hasActivity ? flameFilledSvg : ''}</span>
          ${dayEvents.length ? `<span class="scal-event-label" data-event-names="${escHtml(dayEvents.map(e=>e.title).join(', '))}">${escHtml(dayEvents.length > 1 ? dayEvents.length+' events' : dayEvents[0].title)}</span>` : ''}
          ${goalDatesByDay[k] ? `<span class="scal-goal-ring" title="Goal target date"></span>` : ''}
        </div>`;
    }

    wrap.innerHTML = `
      <div class="streak-calendar">
        <div class="scal-head">
          <button type="button" class="scal-nav" id="scalPrev" aria-label="Previous month">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-61"></use></svg>
          </button>
          <h3>${monthLabel}</h3>
          <button type="button" class="scal-nav" id="scalNext" aria-label="Next month">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-62"></use></svg>
          </button>
        </div>
        <div class="scal-dow">${['S','M','T','W','T','F','S'].map(d=>`<span>${d}</span>`).join('')}</div>
        <div class="scal-grid">${cells}</div>
        <div class="scal-legend">
          <span><span class="scal-flame lit" style="width:14px;height:14px;">${flameFilledSvg}</span> Active day</span>
          <span><span class="scal-event-label" style="position:static;display:inline-block;padding:2px 6px;">States</span> Tournament</span>
          <span><span class="scal-goal-ring" style="position:static;display:inline-block;"></span> Goal date</span>
        </div>
      </div>`;

    document.getElementById('scalPrev').addEventListener('click', () => {
      streakCalMonth.setMonth(streakCalMonth.getMonth()-1);
      renderStreakCalendar(streakInfo, events, goals);
    });
    document.getElementById('scalNext').addEventListener('click', () => {
      streakCalMonth.setMonth(streakCalMonth.getMonth()+1);
      renderStreakCalendar(streakInfo, events, goals);
    });
    wrap.querySelectorAll('.scal-cell[data-date]').forEach(cell => {
      cell.addEventListener('click', () => {
        const dEl = document.getElementById('streakEventDateInput');
        if(dEl) dEl.value = cell.dataset.date;
        const tEl = document.getElementById('streakEventTitleInput');
        if(tEl) tEl.focus();
      });
    });

    // Tournament name popup: tapping/clicking the brass dot shows the
    // tournament name(s) for that day in a small bubble (works on touch,
    // unlike a hover-only title attribute), and doesn't also trigger the
    // cell's "add event on this date" click behavior.
    let openEventTooltip = null;
    function closeEventTooltip(){
      if(openEventTooltip){ openEventTooltip.remove(); openEventTooltip = null; }
    }
    wrap.querySelectorAll('.scal-event-label[data-event-names]').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpenForThisDot = openEventTooltip && openEventTooltip.dataset.forDot === dot.dataset.eventNames && openEventTooltip._dotEl === dot;
        closeEventTooltip();
        if(wasOpenForThisDot) return;
        const tip = document.createElement('div');
        tip.className = 'scal-event-tooltip';
        tip.textContent = dot.dataset.eventNames;
        tip._dotEl = dot;
        document.body.appendChild(tip);
        const r = dot.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(r.left + window.scrollX - tip.offsetWidth/2 + r.width/2, window.innerWidth - tip.offsetWidth - 8)) + 'px';
        tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 8) + 'px';
        openEventTooltip = tip;
        document.addEventListener('click', closeEventTooltip, { once:true });
      });
    });
  }

  function renderStreakEvents(events){
    const wrap = document.getElementById('streakEventsWrap');
    const now = new Date(new Date().toDateString());
    const upcoming = events.filter(e => new Date(e.event_date) >= now).sort((a,b)=> new Date(a.event_date)-new Date(b.event_date));
    const past = events.filter(e => new Date(e.event_date) < now);
    wrap.innerHTML = `
      <div class="streak-events">
        <div class="sec-head">
          <div class="sec-head-title">
            <span class="sec-icon sec-icon-trophy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-72"></use></svg></span>
            <h3>Tournaments &amp; Events</h3>
          </div>
        </div>
        <div class="se-add-row">
          <input type="date" id="streakEventDateInput">
          <input type="text" id="streakEventTitleInput" placeholder="Event name (e.g. State Qualifier)">
          <button type="button" class="btn primary" id="streakEventAddBtn">Add</button>
        </div>
        <div class="se-list">
          ${upcoming.length ? upcoming.map(e => `
            <div class="se-item">
              <div class="se-item-date">${keyToLocalDate(e.event_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
              <div class="se-item-title">${escHtml(e.title)}</div>
              <button type="button" class="se-item-del" data-del-event="${e.id}" aria-label="Remove event">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-63"></use></svg>
              </button>
            </div>`).join('') : '<div class="goals-empty">No upcoming events — add a tournament date above.</div>'}
        </div>
        ${past.length ? `<div class="se-past-toggle" id="sePastToggle">Show ${past.length} past event${past.length===1?'':'s'}</div>
        <div class="se-list hidden" id="sePastList">
          ${past.map(e => `
            <div class="se-item past">
              <div class="se-item-date">${keyToLocalDate(e.event_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
              <div class="se-item-title">${escHtml(e.title)}</div>
              <button type="button" class="se-item-del" data-del-event="${e.id}" aria-label="Remove event">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-64"></use></svg>
              </button>
            </div>`).join('')}
        </div>` : ''}
      </div>`;
    const dateInput = document.getElementById('streakEventDateInput');
    dateInput.value = dateKey(new Date());
    document.getElementById('streakEventAddBtn').addEventListener('click', async () => {
      const title = document.getElementById('streakEventTitleInput').value.trim();
      const d = dateInput.value;
      if(!title || !d){ showToast('Add a date and a name for the event'); return; }
      await addCalendarEvent(d, title, '');
      showToast('Event added');
      renderStreakView();
    });
    wrap.querySelectorAll('[data-del-event]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteCalendarEvent(btn.dataset.delEvent);
        showToast('Event removed');
        renderStreakView();
      });
    });
    const pastToggle = document.getElementById('sePastToggle');
    if(pastToggle) pastToggle.addEventListener('click', () => {
      document.getElementById('sePastList').classList.toggle('hidden');
    });
  }

  function renderStreakGoals(list, streakInfo, events, goals){
    const wrap = document.getElementById('streakGoalsWrap');
    wrap.innerHTML = `
      <div class="streak-goals">
        <div class="hg-head">
          <div class="sec-head-title">
            <span class="sec-icon sec-icon-target"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-71"></use></svg></span>
            <h3>Goals</h3>
          </div>
          <button type="button" class="btn primary" id="streakAddGoalBtn">+ New Goal</button>
        </div>
        <div class="goals-list">${renderGoalsList(goals, list, streakInfo, events)}</div>
      </div>`;
    document.getElementById('streakAddGoalBtn').addEventListener('click', () => {
      openGoalModal(() => renderStreakView());
    });
    wireGoalDeleteButtons(wrap, () => renderStreakView());
  }

  // Keep the top-left streak fab's count fresh once signed in, without
  // needing the Streak Calendar view to have been opened yet.
  async function refreshStreakFab(){
    if(!currentUser) return;
    const list = await loadHistory();
    const [goals, events] = await Promise.all([loadGoals(), loadCalendarEvents()]);
    const info = computeStreak(list, goals, events);
    const fabCount = document.getElementById('streakFabCount');
    const fabIcon = document.getElementById('streakFabIcon');
    if(fabCount) fabCount.textContent = info.current;
    if(fabIcon) fabIcon.classList.toggle('flame-live', info.current > 0);
    document.getElementById('streakToggle')?.classList.toggle('has-streak', info.current > 0);
  }

  // ---- rendering "My History" ----
  function computeTrends(list){
    const byCategory = {};
    list.forEach(entry => {
      (entry.categories||[]).forEach(c => {
        if(!byCategory[c.name]) byCategory[c.name] = { sum:0, max:0, n:0 };
        byCategory[c.name].sum += (c.score / (c.max||10)) * 100;
        byCategory[c.name].n += 1;
      });
    });
    const rows = Object.keys(byCategory).map(name => ({
      name, avgPct: byCategory[name].sum / byCategory[name].n
    }));
    rows.sort((a,b) => b.avgPct - a.avgPct);
    return rows;
  }

  // Builds a larger inline SVG line chart (values expected 0-100) with a
  // real labeled coordinate grid, Y ticks at 0/25/50/75/100 ("Score"),
  // X ticks per round ("Round"), used in the single big chart panel with
  // a dropdown selector. Returns an empty string if there's nothing to plot.
  function buildTrendChartSvg(values, color, rounds){
    if(!values || !values.length) return '';
    color = color || '#2356a8';
    const w = 640, h = 300;
    const marginLeft = 54, marginRight = 18, marginTop = 16, marginBottom = 48;
    const plotW = w - marginLeft - marginRight;
    const plotH = h - marginTop - marginBottom;
    const n = values.length;
    const xForI = i => n === 1 ? marginLeft + plotW/2 : marginLeft + i * (plotW / (n - 1));
    const yForV = v => marginTop + (1 - Math.max(0, Math.min(100, v))/100) * plotH;

    const yTicks = [0, 25, 50, 75, 100];
    const yGrid = yTicks.map(t => {
      const y = yForV(t);
      return `<line class="grid-line" x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${w-marginRight}" y2="${y.toFixed(1)}"/>
        <text class="axis-label" x="${marginLeft-9}" y="${(y+3.5).toFixed(1)}" text-anchor="end">${t}</text>`;
    }).join('');

    const xLabels = (rounds && rounds.length === n) ? rounds : values.map((_,i)=>i+1);
    // With many rounds (e.g. 20-30+ practice speeches), printing every
    // single "R<n>" label side by side overflows the ~640px plot width
    // and the text overlaps into an unreadable smear — exactly what was
    // happening once a user built up enough ballot history. Cap how many
    // labels actually get drawn and space the rest out evenly instead of
    // rendering one per data point; the vertical gridline itself still
    // marks every round, just not every round gets a text label under it.
    const MAX_X_LABELS = 10;
    const labelStep = Math.max(1, Math.ceil(n / MAX_X_LABELS));
    const xGrid = xLabels.map((r,i) => {
      const x = xForI(i);
      // Always label the first and last round (so the range is never
      // ambiguous) plus every labelStep-th one in between.
      const showLabel = i === 0 || i === n - 1 || i % labelStep === 0;
      const label = showLabel
        ? `<text class="axis-label" x="${x.toFixed(1)}" y="${(h-marginBottom+18).toFixed(1)}" text-anchor="middle">R${r}</text>`
        : '';
      return `<line class="grid-line" x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${h-marginBottom}"/>
        ${label}`;
    }).join('');

    const axisLines = `<line class="axis-line" x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${h-marginBottom}"/>
      <line class="axis-line" x1="${marginLeft}" y1="${h-marginBottom}" x2="${w-marginRight}" y2="${h-marginBottom}"/>`;

    const axisTitles = `
      <text class="axis-label" x="${(marginLeft+plotW/2).toFixed(1)}" y="${h-8}" text-anchor="middle" style="letter-spacing:1px;">ROUND</text>
      <text class="axis-label" x="14" y="${(marginTop+plotH/2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 14 ${(marginTop+plotH/2).toFixed(1)})" style="letter-spacing:1px;">SCORE</text>`;

    let dataViz;
    if(n === 1){
      const y = yForV(values[0]);
      dataViz = `<line x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${w-marginRight}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="3" stroke-dasharray="7,7"/>
        <circle cx="${xForI(0).toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}"/>`;
    } else {
      const pts = values.map((v,i) => [xForI(i), yForV(v)]);
      const path = pts.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      const areaPath = path + ` L${pts[pts.length-1][0].toFixed(1)},${(h-marginBottom).toFixed(1)} L${pts[0][0].toFixed(1)},${(h-marginBottom).toFixed(1)} Z`;
      const dots = pts.map((p,i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="${color}" style="animation-delay:${(0.9 + i*0.03).toFixed(2)}s"/>`).join('');
      dataViz = `<path d="${areaPath}" fill="${color}" opacity="0.09" stroke="none"/>
        <path class="tc-line" d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}`;
    }

    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      ${yGrid}
      ${xGrid}
      ${axisLines}
      ${axisTitles}
      ${dataViz}
    </svg>`;
  }

  // Chronological (oldest → newest) per-round series for the overall score
  // and each of the graded categories, used to draw the trend line charts.
  function computeSeries(listDesc){
    const asc = [...listDesc].sort((a,b) => a.ts - b.ts);
    const overall = asc.map((e,i) => ({ round:i+1, val: e.total }));
    const catSeries = {};
    asc.forEach((e,i) => {
      (e.categories||[]).forEach(c => {
        if(!catSeries[c.name]) catSeries[c.name] = [];
        catSeries[c.name].push({ round:i+1, val:(c.score/(c.max||10))*100, raw:c.score, max:c.max||10 });
      });
    });
    return { asc, overall, catSeries };
  }

  // Practice-type filter applied to the "Trends Across X Ballots" bars and
  // the "View trend" line chart. Persists (module-level) for as long as the
  // page is open, so re-renders (e.g. after adding a ballot) keep whatever
  // the user last picked.
  let historyTrendsMode = 'all'; // 'all' | 'regular' | 'introdrill' | 'bodydrill' | 'roughdraft'
  const HISTORY_MODE_OPTIONS = [
    { v:'all', l:'All' },
    { v:'regular', l:'Regular Practice' },
    { v:'introdrill', l:'Rapid Drill: Intro' },
    { v:'bodydrill', l:'Rapid Drill: Body' },
    { v:'roughdraft', l:'Rough Draft' }
  ];
  function filterByPracticeType(list, mode){
    if(mode === 'regular') return list.filter(e => !e.isIntroDrill && !e.isBodyDrill && !e.isRoughDraft);
    if(mode === 'introdrill') return list.filter(e => !!e.isIntroDrill);
    if(mode === 'bodydrill') return list.filter(e => !!e.isBodyDrill);
    if(mode === 'roughdraft') return list.filter(e => !!e.isRoughDraft);
    return list;
  }

  function renderHistoryTrends(fullList){
    const el = document.getElementById('historyTrends');
    if(!fullList.length){ el.innerHTML = ''; return; }

    function paintPanel(){
      const list = filterByPracticeType(fullList, historyTrendsMode);
      const modeFilterHtml = `
        <div class="trend-mode-filter">
          <label for="historyModeFilter">Practice type</label>
          <select class="tcp-select" id="historyModeFilter">
            ${HISTORY_MODE_OPTIONS.map(o => `<option value="${o.v}" ${o.v===historyTrendsMode?'selected':''}>${o.l}</option>`).join('')}
          </select>
        </div>`;

      if(!list.length){
        el.innerHTML = `
          <div class="history-trends">
            <div class="trend-head-row">
              <h3>Trends Across 0 Ballots</h3>
              ${modeFilterHtml}
            </div>
            <div class="history-empty">No ${escHtml((HISTORY_MODE_OPTIONS.find(o=>o.v===historyTrendsMode)||{}).l||'')} ballots yet — try a different filter.</div>
          </div>`;
        const modeSel0 = document.getElementById('historyModeFilter');
        if(modeSel0) modeSel0.addEventListener('change', () => { historyTrendsMode = modeSel0.value; paintPanel(); });
        return;
      }

      const rows = computeTrends(list);
      const strengths = rows.slice(0,2);
      const weaknesses = rows.slice(-2).reverse();
      const { overall, catSeries } = computeSeries(list);

      // Build a lookup of every chart the dropdown can show: "overall" plus
      // one entry per graded category, each carrying its own values/axis/color
      // so switching the <select> just re-renders the single big chart panel.
      const chartOptions = [];
      const overallVals = overall.map(p => p.val).filter(v => v !== null && v !== undefined);
      if(overallVals.length){
        const overallPts = overall.filter(p=>p.val!==null&&p.val!==undefined);
        chartOptions.push({
          key: 'overall', label: 'Overall Score',
          latest: overallVals[overallVals.length-1].toFixed(0) + '/100',
          values: overallVals, rounds: overallPts.map(p=>p.round), color: '#16283c'
        });
      }
      Object.keys(catSeries).forEach(name => {
        const series = catSeries[name];
        const vals = series.map(p => p.val);
        const lastRaw = series[series.length-1];
        chartOptions.push({
          key: name, label: name,
          latest: lastRaw.raw + '/' + lastRaw.max,
          values: vals, rounds: series.map(p=>p.round), color: colorFromRatio(vals[vals.length-1]/100)
        });
      });

      const strengthIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-65"></use></svg>';
      const weaknessIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-66"></use></svg>';

      // Latest vs. average overall score, so the user can see how the most
      // recent round stacks up against their own history.
      const overallValsAll = overall.map(p => p.val).filter(v => v !== null && v !== undefined);
      const latestOverallScore = overallValsAll.length ? overallValsAll[overallValsAll.length-1] : null;
      const avgOverallScore = overallValsAll.length ? overallValsAll.reduce((a,b)=>a+b,0) / overallValsAll.length : null;

      el.innerHTML = `
        <div class="history-trends">
          <div class="trend-head-row">
            <h3>Trends Across ${list.length} Ballot${list.length===1?'':'s'}</h3>
            ${modeFilterHtml}
          </div>
          <div class="trend-rows">
            ${overallValsAll.length ? `
              <div class="trend-row trend-row-overall">
                <span class="trend-name">Overall Score</span>
                <span class="trend-bar-wrap"><span class="trend-bar" data-w="${latestOverallScore.toFixed(0)}" style="width:0%;background:${colorFromRatio(latestOverallScore/100)}"></span></span>
                <span class="trend-avg">${latestOverallScore.toFixed(0)}%<span class="trend-avg-sub">avg ${avgOverallScore.toFixed(0)}%</span></span>
              </div>` : ''}
            ${rows.map(r => `
              <div class="trend-row">
                <span class="trend-name">${escHtml(r.name)}</span>
                <span class="trend-bar-wrap"><span class="trend-bar" data-w="${r.avgPct.toFixed(0)}" style="width:0%;background:${colorFromRatio(r.avgPct/100)}"></span></span>
                <span class="trend-avg">${r.avgPct.toFixed(0)}%</span>
              </div>`).join('')}
          </div>
          <div class="trend-summary">
            <div class="col strength">
              <h4>${strengthIcon} Overall Strengths</h4>
              <ul>${strengths.map(s=>`<li>${escHtml(s.name)}</li>`).join('')}</ul>
            </div>
            <div class="col weakness">
              <h4>${weaknessIcon} Overall Weaknesses</h4>
              <ul>${weaknesses.map(s=>`<li>${escHtml(s.name)}</li>`).join('')}</ul>
            </div>
          </div>
          ${chartOptions.length ? `
          <div class="trend-chart-panel">
            <div class="tcp-head">
              <label for="trendChartSelect">View trend</label>
              <select class="tcp-select" id="trendChartSelect">
                ${chartOptions.map(c => `<option value="${escHtml(c.key)}">${escHtml(c.label)}</option>`).join('')}
              </select>
            </div>
            <div class="trend-chart-big" id="trendChartBig"></div>
          </div>` : ''}
        </div>`;

      // Animate the summary bars in on a rAF tick so the width transition fires.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.querySelectorAll('.trend-bar').forEach(bar => { bar.style.width = bar.dataset.w + '%'; });
        });
      });

      // Wire the practice-type filter to re-run the whole panel.
      const modeSel = document.getElementById('historyModeFilter');
      if(modeSel){
        modeSel.addEventListener('change', () => { historyTrendsMode = modeSel.value; paintPanel(); });
      }

      // Wire the dropdown to (re)render the single big chart panel.
      function paintChart(key){
        const c = chartOptions.find(o => o.key === key) || chartOptions[0];
        const big = document.getElementById('trendChartBig');
        if(!c || !big) return;
        big.innerHTML = `
          <div class="tcb-head">
            <h5>${escHtml(c.label)}</h5>
            <span class="tcb-latest">${escHtml(c.latest)}</span>
          </div>
          ${buildTrendChartSvg(c.values, c.color, c.rounds)}`;
      }
      const select = document.getElementById('trendChartSelect');
      if(select){
        select.addEventListener('change', () => paintChart(select.value));
        paintChart(chartOptions[0] ? chartOptions[0].key : null);
      }
    }

    paintPanel();
  }

  // ---- overall AI coaching comment (Gemini) ----
  // Synthesizes a short, whole-history coaching note. To avoid burning API
  // calls (and to keep the note stable round-to-round), it's only
  // regenerated at milestone round counts or after a clear breakthrough, 
  // never on every single history view open.
  function isMilestoneCount(n){
    if([1,2,3,5,7,10].includes(n)) return true;
    return n > 10 && (n - 10) % 5 === 0;
  }
  function detectBreakthrough(asc){
    if(asc.length < 2) return false;
    const latest = asc[asc.length-1];
    if(latest.total === null || latest.total === undefined) return false;
    const priorTotals = asc.slice(0,-1).map(e=>e.total).filter(t=>t!==null&&t!==undefined);
    if(!priorTotals.length) return false;
    const priorBest = Math.max(...priorTotals);
    const priorAvg = priorTotals.reduce((a,b)=>a+b,0) / priorTotals.length;
    return (latest.total - priorBest >= 12) || (latest.total - priorAvg >= 15);
  }
  async function loadOverallFeedback(){
    if(!currentUser || !supabaseClient) return null;
    const { data, error } = await supabaseClient
      .from('user_overall_feedback').select('*').eq('user_id', currentUser.id).maybeSingle();
    if(error){ console.warn('Could not load overall feedback', error); return null; }
    return data || null;
  }
  async function saveOverallFeedback(feedback, basedOnCount){
    if(!currentUser || !supabaseClient) return;
    const { error } = await supabaseClient.from('user_overall_feedback').upsert({
      user_id: currentUser.id, feedback, based_on_count: basedOnCount, updated_at: new Date().toISOString()
    });
    if(error) console.warn('Could not save overall feedback', error);
  }
  function buildOverallFeedbackPrompt(asc){
    // Give the model real per-round substance to point to — not just
    // scores — so the write-up can cite specific topics, specific category
    // trends, and specific judge comments instead of staying generic. Full
    // feedback text is only included for the most recent rounds (it's the
    // most relevant and keeps the prompt a reasonable size); older rounds
    // still contribute their topic/score/category data for trend-spotting.
    const RECENT_FEEDBACK_COUNT = 5;
    const FEEDBACK_EXCERPT_CHARS = 600;
    const rounds = asc.map((e,i) => {
      const cats = (e.categories||[]).map(c => `${c.name} ${c.score}/${c.max||10}`).join(', ');
      const date = e.ts ? new Date(e.ts).toLocaleDateString() : '';
      const isRecent = i >= asc.length - RECENT_FEEDBACK_COUNT;
      let line = `Round ${i+1} (${date}) — Topic: "${e.question || 'n/a'}". Total: ${e.total !== null && e.total !== undefined ? e.total : '—'}/100. Categories — ${cats || 'n/a'}.`;
      if(isRecent && e.feedback){
        const excerpt = e.feedback.slice(0, FEEDBACK_EXCERPT_CHARS).trim();
        line += `\nJudge notes excerpt: ${excerpt}${e.feedback.length > FEEDBACK_EXCERPT_CHARS ? '…' : ''}`;
      }
      return line;
    }).join('\n\n');
    return `You are an expert NSDA Extemporaneous Speaking coach who has personally watched and judged a student's full practice history across ${asc.length} round${asc.length===1?'':'s'}. Here is the detailed record, in chronological order:\n\n${rounds}\n\nWrite a thorough, honest, encouraging OVERALL coaching write-up addressed directly to the student ("you"). This should read like a coach who has actually paid close attention to THIS student's rounds — not a generic extemp pep talk. Be as SPECIFIC and PERSONAL as the data allows:\n- Reference actual round numbers and/or topics when you bring up an example ("back in your round on [topic]...", "since round 3...").\n- Cite actual category names and how their scores moved over time, not just vague category labels ("your Evidence & Analysis score climbed from X to Y over your last three rounds" beats "your evidence has improved").\n- Pull concrete language or specific issues from the judge notes excerpts where relevant (a recurring phrase a judge used, a specific structural habit, a specific delivery tic) rather than restating category names.\n- If you don't have enough rounds or detail to be specific about something, don't fabricate specifics — just say it plainly instead.\n\nStructure it as 3-4 full paragraphs, in this order: (1) their recurring strengths, with specific evidence; (2) their recurring weaknesses / areas to improve, with specific evidence; (3) the clearest trend or trajectory you can see across the rounds over time (improving, plateauing, or backsliding, and in what specifically); (4) an overall summary with one or two concrete, actionable next steps tailored to what you actually saw, not generic extemp advice. Write each paragraph as complete, natural flowing coaching prose — full sentences, never cut off, not a list of category names. Return ONLY the paragraphs of the write-up — no headers, no markdown, no preamble.`;
  }
  async function generateOverallCoachingComment(asc){
    const candidate = await callGemini(buildOverallFeedbackPrompt(asc), 2048, 'ballot_feedback');
    if(window.RateLimitUI) window.RateLimitUI.addBallotFeedbackUsage('llama');
    return (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
  }
  function renderOverallFeedbackBox(text, loading){
    const el = document.getElementById('historyOverallFeedback');
    if(!el) return;
    if(loading && !text){
      el.innerHTML = `<div class="history-overall loading">Reviewing your full ballot history…</div>`;
      return;
    }
    if(!text){ el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="history-overall">
        <div class="ho-head">
          <span class="ho-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-67"></use></svg></span>
          <h3>Coach's Overall Notes</h3>
        </div>
        <p>${inlineMd(text)}</p>
      </div>`;
  }
  // Loads (and, when due, regenerates) the overall coaching comment in the
  // background so opening My History never blocks on a Gemini call.
  async function refreshOverallFeedback(listDesc){
    if(!currentUser || !supabaseClient || !listDesc.length) { renderOverallFeedbackBox(null); return; }
    const asc = [...listDesc].sort((a,b) => a.ts - b.ts);
    const n = asc.length;
    let existing = null;
    try{ existing = await loadOverallFeedback(); }catch(e){ /* ignore, fall through to generation */ }
    if(existing && existing.feedback) renderOverallFeedbackBox(existing.feedback);
    else renderOverallFeedbackBox(null, true);

    const upToDate = existing && existing.based_on_count === n;
    const shouldGenerate = !upToDate && (isMilestoneCount(n) || detectBreakthrough(asc));
    if(!shouldGenerate) return;
    try{
      if(!existing || !existing.feedback) renderOverallFeedbackBox(null, true);
      const text = await generateOverallCoachingComment(asc);
      if(text){
        await saveOverallFeedback(text, n);
        renderOverallFeedbackBox(text);
      }
    }catch(err){
      console.warn('Could not generate overall coaching comment', err);
      // Leave whatever was already shown (cached comment, or nothing), never block the page on this.
    }
  }

  async function renderHistoryList(){
    const wrap = document.getElementById('historyList');
    wrap.innerHTML = '<div class="history-empty">Loading your ballots…</div>';
    const list = (await loadHistory()).sort((a,b) => b.ts - a.ts);
    renderHistoryTrends(list);
    refreshOverallFeedback(list);
    renderHistoryGoals(list);
    if(!list.length){
      wrap.innerHTML = '<div class="history-empty">No saved ballots yet! finish a practice round and it will show up here.</div>';
      return;
    }
    const ascForNumbering = [...list].sort((a,b) => a.ts - b.ts);
    const roundNumberById = new Map(ascForNumbering.map((e,i) => [e.id, i+1]));
    wrap.innerHTML = list.map(entry => {
      const date = new Date(entry.ts).toLocaleString();
      const scoreColor = entry.total !== null && entry.total !== undefined ? colorFromRatio(entry.total/100) : 'var(--slate)';
      const roundNum = roundNumberById.get(entry.id) || entry.round;
      return `
      <div class="history-card" data-id="${entry.id}">
        <div class="history-card-head">
          <div class="hc-top">
            <div class="hc-top-left">
              <span class="hc-round">Round ${roundNum}</span>
              <span class="hc-mode-badge ${entry.isIntroDrill ? 'is-intro' : entry.isBodyDrill ? 'is-body' : entry.isRoughDraft ? 'is-roughdraft' : 'is-regular'}">${entry.isIntroDrill ? 'Rapid Drill: Intro' : entry.isBodyDrill ? 'Rapid Drill: Body' : entry.isRoughDraft ? 'Rough Draft' : 'Regular Practice'}</span>
              <span class="hc-date">${date}</span>
            </div>
            <div class="hc-score" style="color:${scoreColor}">${entry.total!==null && entry.total!==undefined ? `${entry.total}<span class="hc-score-max">/100</span>` : '—'}</div>
          </div>
          ${entry.question ? `<div class="hc-question">${escHtml(entry.question)}</div>` : ''}
        </div>
        <div class="history-card-body">
          <div class="hc-video-slot"></div>
          <div class="hc-cats">
            ${(entry.categories||[]).map(c => `<div class="hc-cat"><b>${c.score}/${c.max||10}</b> ${escHtml(c.name)}</div>`).join('')}
          </div>
          <div class="hc-actions">
            <button type="button" class="hc-toggle-transcript">Show full ballot &amp; transcript</button>
            <button type="button" class="hc-delete">Delete</button>
          </div>
          <div class="hc-transcript hidden"></div>
        </div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('.history-card').forEach(card => {
      const id = card.getAttribute('data-id');
      const head = card.querySelector('.history-card-head');
      const body = card.querySelector('.history-card-body');
      head.addEventListener('click', async () => {
        const opening = !body.classList.contains('open');
        body.classList.toggle('open');
        if(opening && !body.dataset.videoLoaded){
          body.dataset.videoLoaded = '1';
          const entry = list.find(e => e.id === id);
          if(entry && entry.hasVideo){
            const url = await getVideoUrl(entry.videoPath);
            if(url){
              const slot = card.querySelector('.hc-video-slot');
              slot.innerHTML = '<video controls playsinline src="'+url+'"></video>';
            }
          }
        }
      });
      const toggleBtn = card.querySelector('.hc-toggle-transcript');
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = list.find(e2 => e2.id === id);
        const t = card.querySelector('.hc-transcript');
        if(t.classList.contains('hidden')){
          if(!t.dataset.built){
            t.dataset.built = '1';
            const parsed = parseBallot(entry.feedback || '');
            const ballotHtml = buildBallotBodyHtml(parsed, entry.feedback || '(no feedback saved)', entry.factCheck);
            const deliveryHtml = buildDeliveryGridHtml(entry.deliveryMetrics);
            const transcriptHtml = buildTranscriptSectionHtml(entry.transcript || '', entry.annotations);
            t.innerHTML = `<div class="hc-full-ballot">${ballotHtml}</div>${deliveryHtml}${transcriptHtml}`;
            attachCommentListeners(t, ()=>{}); // history has no per-word video sync, just show the note on click
          }
          t.classList.remove('hidden');
          toggleBtn.textContent = 'Hide full ballot & transcript';
        }else{
          t.classList.add('hidden');
          toggleBtn.textContent = 'Show full ballot & transcript';
        }
      });
      card.querySelector('.hc-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        if(confirm('Delete this saved ballot? This cannot be undone.')){
          deleteBallotFromHistory(id, list.find(e2 => e2.id === id)?.videoPath).then(renderHistoryList);
        }
      });
    });
  }


  document.getElementById('signOutBtn').addEventListener('click', async () => {
    if(supabaseClient) await supabaseClient.auth.signOut();
    onSignedOut();
  });

  document.getElementById('historyToggle').addEventListener('click', () => {
    renderHistoryList();
    showView(viewHistory);
  });
  document.getElementById('historyBackBtn').addEventListener('click', () => showView(viewRecord));

  document.getElementById('streakToggle').addEventListener('click', () => {
    renderStreakView();
    showView(viewStreak);
  });
  document.getElementById('streakBackBtn').addEventListener('click', () => showView(viewRecord));
  document.getElementById('streakFab').addEventListener('click', () => {
    renderStreakView();
    showView(viewStreak);
  });


  // ----- "See an Example" preview. Reached via index.html?preview=example -----
  // ----- (linked from the landing page, landingsite.html, which no longer -----
  // ----- lives in this file). -----
  let exampleOpenedFromLanding = false;
  document.getElementById('previewExitBtn').addEventListener('click', () => {
    if(exampleOpen) closeExampleBallot();
  });


  function toHandle(name){
    const clean = (name || '').trim().slice(0, 20).toLowerCase().replace(/\s+/g, '');
    return '@' + (clean || 'you');
  }
  function applySpeakerName(email){
    if(!speakerNameEl) return;
    var stored = null;
    // The "latest" key (set the moment the tutorial's name step is
    // submitted) always takes priority -- it's exactly what the person
    // typed, and doesn't depend on this session's email matching the
    // email it was originally saved under.
    try{ stored = localStorage.getItem('extemplary_speaker_name_latest'); }catch(e){}
    if(!stored){
      try{ stored = localStorage.getItem('extemplary_speaker_name:' + (email||'').toLowerCase()); }catch(e){}
    }
    speakerNameEl.textContent = toHandle(stored);
  }

  window.addEventListener('extemplary:speaker-name-set', function(ev){
    if(!speakerNameEl) return;
    var name = (ev.detail && ev.detail.name || '').trim().slice(0, 20);
    speakerNameEl.textContent = toHandle(name);
  });

  const accountChip = document.getElementById('signOutBtn');
  const accountEmail = document.getElementById('accountEmail');

  function onSignedIn(user){
    currentUser = { id: user.id, email: user.email };
    accountChip.classList.remove('hidden');
    accountEmail.classList.remove('hidden');
    accountEmail.textContent = currentUser.email;
    accountEmail.title = currentUser.email;
    document.body.classList.remove('previewing-example');
    document.getElementById('streakFab')?.classList.remove('hidden');
    refreshStreakFab();
    applySpeakerName(currentUser.email);
  }
  function onSignedOut(){
    currentUser = null;
    accountChip.classList.add('hidden');
    accountEmail.classList.add('hidden');
    try{ localStorage.removeItem('extemplary_speaker_name_latest'); }catch(e){}
    applySpeakerName(null);
    // No auth form lives in this file anymore -- signing out sends the
    // person back to the landing page to log in or make a new account.
    window.location.href = 'landingsite.html';
  }

  // Restore session on load / whenever it changes (this is what makes
  // "stay signed in when you reopen the tab" work automatically), and
  // gate the whole app behind landingsite.html for anyone who isn't
  // signed in -- except for the unauthenticated "See an Example" preview
  // reached via index.html?preview=example.
  (async function initAuth(){
    const params = new URLSearchParams(window.location.search);
    const previewRequested = params.get('preview') === 'example';

    if(!supabaseClient){
      // No client library (e.g. offline) -- let the person in anyway so the
      // recorder still works, just without saved history.
      return;
    }
    const { data } = await supabaseClient.auth.getSession();
    if(data && data.session){
      onSignedIn(data.session.user);
    }else if(previewRequested){
      exampleOpenedFromLanding = true;
      document.body.classList.add('previewing-example');
      exampleOpen = true;
      helpToggle.classList.add('active');
      viewBeforeExample = viewRecord;
      renderExampleBallot();
      showView(viewExample);
    }else{
      window.location.href = 'landingsite.html';
      return;
    }
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if(event === 'SIGNED_IN' && session) onSignedIn(session.user);
      else if(event === 'SIGNED_OUT') onSignedOut();
      if(window.RateLimitUI) window.RateLimitUI.refresh();
    });
  })();


  // ===== Decorative side-margin parallax words (purely visual, no interaction) =====
  (function setupSideWords(){
    const leftInner  = document.getElementById('sideWordsLeftInner');
    const rightInner = document.getElementById('sideWordsRightInner');
    const leftGlowInner  = document.getElementById('sideWordsLeftGlowInner');
    const rightGlowInner = document.getElementById('sideWordsRightGlowInner');
    const leftGlow  = document.getElementById('sideWordsLeftGlow');
    const rightGlow = document.getElementById('sideWordsRightGlow');
    if(!leftInner || !rightInner) return;
    const WORDS = DATA.WORDS;

    // Picks `count` distinct random words from the list and joins them into
    // one line, regenerated fresh every time a row's animation loops, so
    // the wall never repeats the same phrase twice in a row.
    function randomLineText(wordList){
      const count = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4 words
      const pool = wordList.slice();
      const picked = [];
      for(let k = 0; k < count && pool.length; k++){
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(idx, 1)[0]);
      }
      return picked.join('\u00A0\u00A0\u00A0');
    }

    // Builds each row twice: once into the faint base layer, once into the
    // bright glow layer (masked to a circle around the cursor — see the
    // mousemove handler below). Both spans share identical position/timing
    // and have their text swapped together in lockstep, so the glow layer
    // is always showing exactly what's underneath it, just brighter.
    function fillColumn(container, glowContainer, wordList, spacing){
      const totalHeight = container.offsetHeight || (window.innerHeight * 4);
      const count = Math.ceil(totalHeight / spacing);
      for(let i=0;i<count;i++){
        const span = document.createElement('div');
        span.className = 'side-word';
        const text = randomLineText(wordList);
        span.textContent = text;
        span.style.top = (i * spacing + 40) + 'px';

        // Every row uses the same wobble keyframe but with direction:alternate,
        // so motion continuously reverses at each extreme instead of ever
        // snapping back to its start, that snap was what caused the visible
        // "skip" whenever the old animation looped. Half the rows start out
        // of phase (alternate-reverse) so they don't all move in lockstep.
        const direction = (i % 2 === 0) ? 'alternate' : 'alternate-reverse';
        const duration = 18 + (i % 5) * 3; // 18–30s, slow and varied per row
        const anim = 'driftWobble ' + duration + 's ease-in-out infinite';
        const delay = '-' + ((i * 1.7) % duration).toFixed(1) + 's';
        span.style.animation = anim;
        span.style.animationDirection = direction;
        span.style.animationDelay = delay;

        const glowSpan = glowContainer ? document.createElement('div') : null;
        if(glowSpan){
          glowSpan.className = 'side-word';
          glowSpan.textContent = text;
          glowSpan.style.top = span.style.top;
          glowSpan.style.animation = anim;
          glowSpan.style.animationDirection = direction;
          glowSpan.style.animationDelay = delay;
        }

        // Swap in new random words only at the extremes of the wobble (where
        // horizontal velocity is momentarily zero), and crossfade the text via
        // opacity rather than popping it, so the content change is never
        // visible as a jump, satisfies a smooth, continuous-feeling wall.
        // Both layers swap together so the glow layer never shows text that
        // doesn't match what's directly underneath it.
        span.addEventListener('animationiteration', () => {
          span.style.opacity = '0';
          if(glowSpan) glowSpan.style.opacity = '0';
          setTimeout(() => {
            const next = randomLineText(wordList);
            span.textContent = next;
            span.style.opacity = '1';
            if(glowSpan){
              glowSpan.textContent = next;
              glowSpan.style.opacity = '1';
            }
          }, 300);
        });

        container.appendChild(span);
        if(glowSpan) glowContainer.appendChild(glowSpan);
      }
    }
    fillColumn(leftInner, leftGlowInner, WORDS, 30);
    fillColumn(rightInner, rightGlowInner, WORDS, 30);

    // Smooth, dramatic depth parallax: the word wall should barely move
    // relative to the page, scrolling far only shifts it a tiny bit, and
    // that tiny shift is eased continuously (lerp) each frame instead of
    // being snapped straight to the scroll position, so it never feels
    // jumpy even on fast/trackpad scrolling.
    let targetLeftY = 0, targetRightY = 0;
    let currentLeftY = 0, currentRightY = 0;
    function computeParallaxTargets(){
      const y = window.scrollY || window.pageYOffset || 0;
      targetLeftY  = -(y * 0.16);
      targetRightY = -(y * 0.11);
    }
    function animateParallax(){
      currentLeftY  += (targetLeftY  - currentLeftY)  * 0.06;
      currentRightY += (targetRightY - currentRightY) * 0.06;
      const leftT  = 'translateY(' + currentLeftY.toFixed(2)  + 'px)';
      const rightT = 'translateY(' + currentRightY.toFixed(2) + 'px)';
      leftInner.style.transform  = leftT;
      rightInner.style.transform = rightT;
      if(leftGlowInner)  leftGlowInner.style.transform  = leftT;
      if(rightGlowInner) rightGlowInner.style.transform = rightT;
      requestAnimationFrame(animateParallax);
    }
    window.addEventListener('scroll', computeParallaxTargets, { passive:true });
    computeParallaxTargets();
    requestAnimationFrame(animateParallax);

    // Flashlight cursor tracking: converts the pointer's viewport position
    // into each glow container's own local coordinate space (CSS mask
    // position is relative to the masked box, not the viewport), then
    // writes it into --gx/--gy, which the radial-gradient mask in CSS
    // reads to position the circle. rAF-throttled so fast mouse movement
    // doesn't spam layout reads/writes.
    if(leftGlow && rightGlow){
      let pendingX = null, pendingY = null, rafScheduled = false;
      function applyPointer(){
        rafScheduled = false;
        if(pendingX === null) return;
        const lRect = leftGlow.getBoundingClientRect();
        const rRect = rightGlow.getBoundingClientRect();
        leftGlow.style.setProperty('--gx', (pendingX - lRect.left) + 'px');
        leftGlow.style.setProperty('--gy', (pendingY - lRect.top) + 'px');
        rightGlow.style.setProperty('--gx', (pendingX - rRect.left) + 'px');
        rightGlow.style.setProperty('--gy', (pendingY - rRect.top) + 'px');
      }
      window.addEventListener('mousemove', (e) => {
        pendingX = e.clientX;
        pendingY = e.clientY;
        if(!rafScheduled){ rafScheduled = true; requestAnimationFrame(applyPointer); }
      }, { passive:true });
      // Cursor leaving the window entirely — send the circle far off so
      // nothing lingers lit up after the mouse is gone.
      document.addEventListener('mouseleave', () => {
        leftGlow.style.setProperty('--gx', '-9999px');
        rightGlow.style.setProperty('--gx', '-9999px');
      });
    }
  })();

  const RUBRIC_PROMPT = DATA.RUBRIC_PROMPT;
  const INTRO_RUBRIC_PROMPT = DATA.INTRO_RUBRIC_PROMPT;
  const BODY_RUBRIC_PROMPT = DATA.BODY_RUBRIC_PROMPT;
  const ROUGHDRAFT_RUBRIC_PROMPT = DATA.ROUGHDRAFT_RUBRIC_PROMPT;
  // Split-judging prompts used ONLY for GPT-OSS 120B on the Regular
  // Practice (8-category) rubric — see runGptOssSplitJudging below for
  // why. Not used for Intro Drill / Body Drill / Rough Draft, whose
  // rubrics are already small enough to fit one call's token budget.
  // 1 category per call (8 calls total) rather than 2-per-call: the
  // 2-per-call version still truncated mid-category ("Judging failed:
  // GPT-OSS 120B's pass covering 'Strength of Evidence and Clarity' got
  // cut off...") on a transcript that was evidently long/dense enough to
  // eat further into the 8,000 TPM budget than a flat 2-per-call
  // estimate assumed. Rather than keep guessing at a granularity that
  // can still fail on the next unusually long speech, going all the way
  // to 1 category per call scales safely regardless of transcript
  // length — the fixed preamble+format overhead is now spread across
  // twice as many calls, so every single call has far more real output
  // headroom than even the 2-per-call version did.
  const GPT_OSS_RUBRIC_CAT1 = DATA.GPT_OSS_RUBRIC_CAT1; // Creative Hook & Intro
  const GPT_OSS_RUBRIC_CAT2 = DATA.GPT_OSS_RUBRIC_CAT2; // Structure
  const GPT_OSS_RUBRIC_CAT3 = DATA.GPT_OSS_RUBRIC_CAT3; // Strength of Argument & Analysis
  const GPT_OSS_RUBRIC_CAT4 = DATA.GPT_OSS_RUBRIC_CAT4; // Flaws in Reasoning
  const GPT_OSS_RUBRIC_CAT5 = DATA.GPT_OSS_RUBRIC_CAT5; // Strength of Evidence
  const GPT_OSS_RUBRIC_CAT6 = DATA.GPT_OSS_RUBRIC_CAT6; // Clarity
  const GPT_OSS_RUBRIC_CAT7 = DATA.GPT_OSS_RUBRIC_CAT7; // Conclusion Strength
  const GPT_OSS_RUBRIC_CAT8 = DATA.GPT_OSS_RUBRIC_CAT8; // Speech Quality
  const GPT_OSS_RUBRIC_SYNTHESIS = DATA.GPT_OSS_RUBRIC_SYNTHESIS;
  const ROUGHDRAFT_PIPELINE_PHRASES = DATA.ROUGHDRAFT_PIPELINE_PHRASES || { judging: [] };

  const ANNOTATION_PROMPT = DATA.ANNOTATION_PROMPT;
  const INTRO_ANNOTATION_PROMPT = DATA.INTRO_ANNOTATION_PROMPT;
  const BODY_ANNOTATION_PROMPT = DATA.BODY_ANNOTATION_PROMPT;

  const CIRCLE_PATH = DATA.CIRCLE_PATH;

  // ===== DEFAULT TIME SIGNALS =====
  const DEFAULT_SIGNALS = DATA.DEFAULT_SIGNALS;

  // ===== STATE =====
  let stream = null;
  let cameraStream = null;
  let captureStream = null;
  let captureMode = 'camera'; // 'camera' | 'capture' | 'upload'
  let recorder = null;
  let chunks = [];
  let recordedBlob = null;
  let recordedMime = 'video/webm';
  let timerInterval = null;
  let elapsedSeconds = 0;
  let roundNo = 1;
  let flightHistory = [];
  let lastTranscript = '';
  let lastTranscriptAnnotations = null;
  let lastFactCheck = null;
  let lastRawFeedback = '';
  let lastQuestion = '';
  let lastDeliveryMetrics = null;
  // Assembled plaintext of the Rough Draft form (see rdSubmitBtn handler),
  // read by runPipeline in place of a transcribed recording.
  let roughDraftTranscriptText = '';
  let lastWordTimestamps = [];
  let wordTokenSpans = []; // [{s,e,ts,te}] char offsets into lastTranscript <-> seconds into recordedBlob
  let resultsVideoURL = null;
  let activeWordSpanEl = null;
  // Auto-scroll-to-active-word is suspended the moment the user manually
  // scrolls/touches/wheels the page, so playback never fights the user for
  // control of the viewport. It's re-armed when they click a transcript
  // word (an explicit "take me there/follow along again" action) or when a
  // fresh transcript/example is rendered.
  let autoScrollToWordEnabled = true;
  let lastProgrammaticScrollAt = 0;
  function suspendAutoScrollToWord(){
    // Ignore scroll/touch events that fire right after our own
    // scrollIntoView call, only a scroll the user actually initiated
    // should suspend auto-scroll.
    if(Date.now() - lastProgrammaticScrollAt < 400) return;
    autoScrollToWordEnabled = false;
  }
  window.addEventListener('wheel', suspendAutoScrollToWord, { passive:true });
  window.addEventListener('touchmove', suspendAutoScrollToWord, { passive:true });
  window.addEventListener('keydown', (e)=>{
    if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(e.key)) suspendAutoScrollToWord();
  });
  let timeSignals = JSON.parse(JSON.stringify(DEFAULT_SIGNALS));
  let overlayTimeout = null;
  let settingsOpen = false;
  let editingIndex = -1; // index in timeSignals being edited

  // ===== ELEMENTS =====
  const liveVideo      = document.getElementById('liveVideo');
  const reviewVideo    = document.getElementById('reviewVideo');
  const playbackSection = document.getElementById('playbackSection');
  const resultsVideo   = document.getElementById('resultsVideo');
  const pbPlayBtn      = document.getElementById('pbPlayBtn');
  const pbPlayIcon     = document.getElementById('pbPlayIcon');
  const pbScrub        = document.getElementById('pbScrub');
  const pbTimeCur      = document.getElementById('pbTimeCur');
  const pbTimeDur      = document.getElementById('pbTimeDur');
  const recBtn         = document.getElementById('recBtn');
  const recBtnLabel    = document.getElementById('recBtnLabel');
  const recPill        = document.getElementById('recPill');
  const clockPill      = document.getElementById('clockPill');
  const permError      = document.getElementById('permError');
  const questionInput  = document.getElementById('extempQuestion');
  const questionError  = document.getElementById('questionError');
  const qModeCustomBtn       = document.getElementById('qModeCustomBtn');
  const qModeReceiveBtn      = document.getElementById('qModeReceiveBtn');
  const qModeError           = document.getElementById('qModeError');
  const customQuestionBlock  = document.getElementById('customQuestionBlock');
  const generatedQuestionBlock = document.getElementById('generatedQuestionBlock');
  const qCategoryStep   = document.getElementById('qCategoryStep');
  const qDifficultyStep       = document.getElementById('qDifficultyStep');
  const qDifficultyCatLabel   = document.getElementById('qDifficultyCatLabel');
  const qDifficultySlider     = document.getElementById('qDifficultySlider');
  const qDifficultyLevelLabel = document.getElementById('qDifficultyLevelLabel');
  const qDifficultyLevelNum   = document.getElementById('qDifficultyLevelNum');
  const qDifficultyStops      = document.getElementById('qDifficultyStops');
  const qDifficultyExample    = document.getElementById('qDifficultyExample');
  const qDifficultyBackBtn    = document.getElementById('qDifficultyBackBtn');
  const qDifficultyContinueBtn = document.getElementById('qDifficultyContinueBtn');
  const qGenLoading     = document.getElementById('qGenLoading');
  const qGenLoadingText = document.getElementById('qGenLoadingText');
  const qGenProgressFill   = document.getElementById('qGenProgressFill');
  const qGenProgressPhrase = document.getElementById('qGenProgressPhrase');
  const procProgressFill   = document.getElementById('procProgressFill');
  const procProgressPhrase = document.getElementById('procProgressPhrase');

  // ===== Animated progress bar + rotating-phrase controller, used any time =====
  // ===== an AI call is "thinking" (question generation, judging pipeline). =====
  function createProgressController(fillEl, phraseEl, colorFn){
    let target = 0, current = 0, raf = null, phraseTimer = null, phrases = [], phraseIdx = 0;
    function paint(){
      fillEl.style.width = current.toFixed(1) + '%';
      // colorFn (when supplied) recolors the fill live by how far along it
      // is — reuses the same red-to-green spectrum as ballot scores
      // (colorFromRatio) rather than a fixed brand color, so the bar
      // itself communicates "how close to done" the same way a score bar
      // communicates "how good." Left undefined for qGenProgress, which
      // keeps its plain CSS color.
      if(colorFn) fillEl.style.background = colorFn(current / 100);
    }
    function tick(){
      if(current < target){
        current += Math.max((target - current) * 0.045, 0.12);
        if(current > target) current = target;
        paint();
      }
      raf = requestAnimationFrame(tick);
    }
    function showPhrase(i){
      if(!phraseEl || !phrases.length) return;
      phraseEl.style.opacity = '0';
      setTimeout(()=>{
        phraseEl.textContent = phrases[i % phrases.length];
        phraseEl.style.opacity = '1';
      }, 180);
    }
    function rotatePhrase(){ phraseIdx++; showPhrase(phraseIdx); }
    return {
      // Begin a fresh run: resets to 0%, climbs toward `capPct` (default 90) and
      // never gets there on its own, call setStage()/finish() to move it further.
      start(initialPhrases, capPct){
        current = 0; target = (capPct === undefined ? 90 : capPct);
        paint();
        phrases = initialPhrases || [];
        phraseIdx = 0;
        if(phraseEl){ phraseEl.textContent = phrases[0] || ''; phraseEl.style.opacity = '1'; }
        if(raf) cancelAnimationFrame(raf);
        tick();
        if(phraseTimer) clearInterval(phraseTimer);
        if(phrases.length > 1) phraseTimer = setInterval(rotatePhrase, 2100);
      },
      // Move the target percentage up (e.g. when a new pipeline stage begins),
      // optionally swapping in a new set of phrases for that stage.
      setStage(pct, stagePhrases){
        if(Number.isFinite(pct)) target = Math.max(target, pct);
        if(stagePhrases){
          phrases = stagePhrases;
          phraseIdx = 0;
          showPhrase(0);
        }
      },
      // Snap straight to 100% (call right before hiding the loading state).
      finish(){
        target = 100; current = 100; paint();
        if(raf) cancelAnimationFrame(raf);
        if(phraseTimer) clearInterval(phraseTimer);
      },
      // Abort immediately (e.g. on error) without forcing 100%.
      stop(){
        if(raf) cancelAnimationFrame(raf);
        if(phraseTimer) clearInterval(phraseTimer);
      }
    };
  }

  const QGEN_PHRASES = DATA.QGEN_PHRASES;
  const qGenProgress = createProgressController(qGenProgressFill, qGenProgressPhrase);

  const PIPELINE_PHRASES = DATA.PIPELINE_PHRASES;
  const INTRO_PIPELINE_PHRASES = DATA.INTRO_PIPELINE_PHRASES || PIPELINE_PHRASES;
  const BODY_PIPELINE_PHRASES = DATA.BODY_PIPELINE_PHRASES || PIPELINE_PHRASES;
  const pipelineProgress = createProgressController(procProgressFill, procProgressPhrase, (ratio) => colorFromRatio(ratio));

  // ===== Pipeline timeline (mirrors the .proc-tick markup in index.html,
  // ===== positioned along the .proc-timeline-track itself) — driven from
  // ===== the real stage transitions in runPipeline below, not a
  // ===== separate decorative timer.
  const PROC_STEP_ORDER = ['audio', 'transcribe', 'delivery', 'judging', 'annotate', 'factcheck'];
  const PROC_STEP_DEFAULT_LABELS = {
    audio: 'Audio', transcribe: 'Transcription', delivery: 'Delivery',
    judging: 'Judging', annotate: 'Notes', factcheck: 'Verify'
  };
  // Fuller names for the explicit "which phase, specifically" indicator —
  // the tick captions themselves stay short since space on the bar is
  // tight, but this line has room to spell it out plainly.
  const PROC_STEP_PHASE_NAMES = {
    audio: 'Prepping Audio', transcribe: 'Transcribing Testimony', delivery: 'Analyzing Vocal Delivery',
    judging: 'Panel Deliberating', annotate: 'Annotating Transcript', factcheck: 'Verifying Evidence'
  };
  const procTimeline = document.getElementById('procTimeline');
  const procPhaseLabel = document.getElementById('procPhaseLabel');
  // Marks every tick before `id` as done (checkmark), `id` itself as
  // active (pulsing line), and leaves everything after `id` pending.
  // `label`, when given, is shown in the phase indicator above the bar
  // (e.g. "Transcribing Testimony 42%" or "Panel Deliberating (Wave 2)")
  // for extra specificity. The tick's own caption under the bar always
  // stays on its plain default word (e.g. "Transcription") — it doesn't
  // get overridden by live details like the percentage, which stays
  // reserved for the phase label above so the tick row reads as a clean,
  // stable set of stage names. Called with no id to reset the whole
  // timeline (fresh pipeline run).
  function setProcStep(id, label){
    if(!procTimeline) return;
    const targetIdx = id ? PROC_STEP_ORDER.indexOf(id) : -1;
    PROC_STEP_ORDER.forEach((stepId, i) => {
      const el = procTimeline.querySelector(`.proc-tick[data-step="${stepId}"]`);
      const labelEl = document.getElementById('procTickLabel-' + stepId);
      if(!el) return;
      el.classList.remove('active', 'done');
      if(targetIdx !== -1){
        if(i < targetIdx) el.classList.add('done');
        else if(i === targetIdx) el.classList.add('active');
      }
      if(labelEl) labelEl.textContent = PROC_STEP_DEFAULT_LABELS[stepId];
    });
    if(procPhaseLabel){
      let detail = '';
      if(label && label.trim()){
        const t = label.trim();
        // A bare percentage (the live transcription progress) reads
        // directly onto the phase name with no parens/prefix — anything
        // else (e.g. "Wave 2") still gets the parenthetical treatment.
        detail = /^\d+%$/.test(t) ? ' ' + t : ' (' + t + ')';
      }
      procPhaseLabel.textContent = (targetIdx === -1) ? '' : `${PROC_STEP_PHASE_NAMES[id]}${detail}`;
    }
  }
  function finishProcSteps(){
    if(!procTimeline) return;
    PROC_STEP_ORDER.forEach(stepId => {
      const el = procTimeline.querySelector(`.proc-tick[data-step="${stepId}"]`);
      if(el){ el.classList.remove('active'); el.classList.add('done'); }
    });
    if(procPhaseLabel) procPhaseLabel.textContent = 'Ballot complete';
  }
  const qGenError       = document.getElementById('qGenError');
  const qPickStep       = document.getElementById('qPickStep');
  const qOptionsList    = document.getElementById('qOptionsList');
  const qConfirmedStep  = document.getElementById('qConfirmedStep');
  const qConfirmedText  = document.getElementById('qConfirmedText');
  const viewRecord     = document.getElementById('view-record');
  const viewReview     = document.getElementById('view-review');
  const viewProcessing = document.getElementById('view-processing');
  const viewResults    = document.getElementById('view-results');
  const viewExample    = document.getElementById('view-example');
  const viewBriefing   = document.getElementById('view-briefing');
  const viewAiCompare  = document.getElementById('view-aiCompare');
  const viewCitation   = document.getElementById('view-citation');
  const viewHistory    = document.getElementById('view-history');
  const viewStreak     = document.getElementById('view-streak');
  const statusText     = document.getElementById('statusText');
  const statusSub      = document.getElementById('statusSub');
  const processError   = document.getElementById('processError');
  const processErrorActions = document.getElementById('processErrorActions');
  const roundNoEl      = document.getElementById('roundNo');
  const speakerNameEl  = document.getElementById('speakerName');
  function showCopyConfirmToast(message){
    const t = document.createElement('div');
    t.className = 'copy-confirm-toast';
    t.textContent = message;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, 1800);
  }
  if(speakerNameEl){
    speakerNameEl.addEventListener('click', async () => {
      const text = speakerNameEl.textContent || '';
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){
          await navigator.clipboard.writeText(text);
        }else{
          // Fallback for contexts where the async Clipboard API isn't available.
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showCopyConfirmToast('Copied to clipboard');
      }catch(e){
        console.warn('copy failed', e);
      }
    });
  }
  const sessionTag     = document.getElementById('sessionTag');
  // Header used to show a static "Round 1" placeholder here — now shows
  // today's date instead, in the same span/font/color, computed once on
  // load since it's just a date display, not tied to round state.
  const sessionDateLabel = document.getElementById('sessionDateLabel');
  if(sessionDateLabel){
    sessionDateLabel.textContent = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  }
  const flightStripResults = document.getElementById('flightStripResults');
  const resultsContent = document.getElementById('resultsContent');
  const transcriptBody = document.getElementById('transcriptBody');
  const commentPopover = document.getElementById('commentPopover');
  // .ballot (the card wrapping every view, including the transcript) has both
  // `transform: rotate(...)` and `overflow:hidden`. A CSS transform on an
  // ancestor makes that ancestor the positioning context for any
  // position:fixed descendant (instead of the viewport), and overflow:hidden
  // then clips it away entirely, so the popover was being positioned wrong
  // and invisibly clipped every time. Moving it to a direct child of <body>
  // escapes that ancestor entirely so the viewport-relative math in
  // showCommentPopover() actually lines up with the real fixed position.
  if(commentPopover && commentPopover.parentElement !== document.body){
    document.body.appendChild(commentPopover);
  }
  const cpTag = document.getElementById('cpTag');
  const cpText = document.getElementById('cpText');
  const deliverySection = document.getElementById('deliverySection');
  const deliveryGrid = document.getElementById('deliveryGrid');
  const deliveryNote = document.getElementById('deliveryNote');
  const tsMeta_round   = document.getElementById('tsMeta_round');
  const signalOverlay  = document.getElementById('signalOverlay');
  const overlayCard    = document.getElementById('overlayCard');
  const overlayLabel   = document.getElementById('overlayLabel');
  const overlayTime    = document.getElementById('overlayTime');
  const overlaySub     = document.getElementById('overlaySub');
  const overlayWarn    = document.getElementById('overlayWarn');
  const overlayDismiss = document.getElementById('overlayDismiss');
  const settingsToggle = document.getElementById('settingsToggle');
  const settingsPanel  = document.getElementById('settingsPanel');
  // Like commentPopover above, settingsPanel used to live inside #view-record,
  // so it vanished whenever a different view (e.g. the example ballot) was
  // shown, since showView() hides the whole ancestor. Moving it to a direct
  // child of <body> and positioning it as a floating dropdown under the gear
  // icon means it now works from any view.
  if(settingsPanel && settingsPanel.parentElement !== document.body){
    document.body.appendChild(settingsPanel);
  }
  function positionSettingsPanel(){
    const rect = settingsToggle.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 24);
    settingsPanel.style.width = width + 'px';
    settingsPanel.style.left = 'auto';
    let right = window.innerWidth - rect.right;
    right = Math.max(12, Math.min(right, window.innerWidth - width - 12));
    settingsPanel.style.right = right + 'px';
    settingsPanel.style.top = (rect.bottom + 8) + 'px';
  }
  const signalList     = document.getElementById('signalList');
  const signalCount    = document.getElementById('signalCount');
  // ----- AI judge model picker (button + menu next to the practice-mode
  // tabs, styled like the model switcher on LLM chat sites) -----
  const modelPicker      = document.getElementById('modelPicker');
  const modelPickerBtn   = document.getElementById('modelPickerBtn');
  const modelPickerLabel = document.getElementById('modelPickerLabel');
  const modelPickerMenu  = document.getElementById('modelPickerMenu');
  const JUDGE_MODEL_KEY = 'extemplary_judge_model';
  // Maps the picker's stored value to what the judging call actually
  // needs: which edge function to hit, and (for Hack Club AI) which model
  // id to send. Keep this in sync with ALLOWED_MODELS in the hackclub-chat
  // edge function. `label` drives the picker button text.
  const JUDGE_MODELS = {
    llama:    { fn: 'groq-chat',     model: 'openai/gpt-oss-120b',       label: 'GPT-OSS 120B' },
    opus5:    { fn: 'hackclub-chat', model: 'anthropic/claude-opus-5',   label: 'Claude Opus 5' },
    kimik3:   { fn: 'hackclub-chat', model: 'moonshotai/kimi-k3',        label: 'Kimi K3' },
    sonnet5:  { fn: 'hackclub-chat', model: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    deepseekv4pro: { fn: 'hackclub-chat', model: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro' },
    qwen38:   { fn: 'hackclub-chat', model: 'qwen/qwen3.8-2.4t-a95b',     label: 'Qwen3.8 2.4T A95B' },
    gemini37flash: { fn: 'gemini-generate', model: 'gemini-3.7-flash',   label: 'Gemini 3.7 Flash' },
    // NVIDIA's own build.nvidia.com/NIM catalog listing for this model
    // (docs.api.nvidia.com/nim/reference/z-ai-glm-5.2) documents a
    // 1,000,000-token *output* context, not a small hard cap like
    // AIHubMix's free Kimi tier — so this uses the same uncapped 32000
    // (STREAMING_JUDGE_FNS below) as every Hack Club model, no special
    // per-model max_tokens override needed.
    glm52:    { fn: 'nvidia-chat',   model: 'z-ai/glm-5.2',              label: 'GLM 5.2' }
  };
  // Every edge function here speaks the identical SSE-streaming +
  // chunked-continuation protocol (TIME_BUDGET_MS server-side cutoff,
  // the {"extemplary_continue":true} sentinel, chained rounds via
  // runHackClubChatToCompletion) — groq-chat is the only one-shot
  // buffered exception.
  const STREAMING_JUDGE_FNS = new Set(['hackclub-chat', 'nvidia-chat']);
  let judgeModelValue = 'llama';
  // Different chat-completion backends shape their JSON response
  // differently. Groq (and most OpenAI-compatible endpoints) use
  // choices[0].message.content. Anthropic's native Messages API (which
  // hackclub-chat may be proxying to for the Claude options) uses a
  // content[] array of blocks instead. This tries every shape we know
  // about so a real, billed response never gets discarded as "empty"
  // just because of a format mismatch.
  function extractChatContent(json){
    if(!json) return '';
    const asText = (v) => {
      if(typeof v === 'string') return v.trim();
      if(Array.isArray(v)){
        // Claude-style responses can return an array of typed content
        // blocks — e.g. { type: 'thinking', thinking: '...' } for extended
        // reasoning and { type: 'text', text: '...' } for the actual
        // answer. Reasoning blocks store their content under `.thinking`,
        // not `.text`, so reading only `.text` (as before) silently
        // dropped the whole response whenever a model returned thinking
        // blocks — the call succeeded and billed real tokens, but
        // extractChatContent saw '' and the caller treated it as a
        // failure, triggering an unnecessary fallback to Llama.
        // Prefer real `text` blocks; only fall back to `thinking` content
        // if no text block was present at all, so a genuinely
        // thinking-only response still surfaces something instead of
        // silently failing.
        const textBlocks = v
          .map(b => (typeof b === 'string' ? b : (b?.type === 'thinking' ? '' : b?.text || '')))
          .join('').trim();
        if(textBlocks) return textBlocks;
        const thinkingBlocks = v
          .map(b => (typeof b === 'string' ? '' : (b?.type === 'thinking' ? b?.thinking || '' : '')))
          .join('').trim();
        return thinkingBlocks;
      }
      return '';
    };
    return (
      asText(json.choices?.[0]?.message?.content) ||
      asText(json.choices?.[0]?.text) ||
      asText(json.content) ||
      asText(json.message?.content) ||
      asText(json.completion) ||
      asText(json.output_text) ||
      ''
    );
  }
  // hackclub-chat now always streams its response back as Server-Sent
  // Events instead of one buffered JSON blob — see the comment in
  // supabase/functions/hackclub-chat/index.ts for why (Supabase kills
  // any edge function invocation that runs past a fixed wall-clock
  // limit, ~150s observed, even though slow models like Opus 5 routinely
  // take 4+ minutes and still bill/finish successfully upstream).
  // Reading the stream and reassembling text here is what lets those
  // slower calls actually make it back to the app instead of dying
  // server-side before a response is ever returned.
  async function readHackClubStream(res){
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    // Some reasoning models expose their internal reasoning under a
    // separate field (reasoning_content / thinking) rather than the
    // normal `content` delta. Track it separately and only fall back to
    // it if the model genuinely never produced real answer text, same
    // principle as the thinking-block handling in extractChatContent.
    let reasoning = '';
    // Set when hackclub-chat's own time budget (well under Supabase's
    // wall-clock ceiling) runs out before the model naturally finished —
    // signaled by one synthetic sentinel line, {"extemplary_continue":true},
    // appended right before the stream closes. Not an error: it just means
    // the caller (runHackClubChatToCompletion below) should re-request with
    // the partial answer fed back in and let the model keep going.
    let needsContinuation = false;
    // Processes any complete "data: {...}" lines found in `chunk` and
    // folds their content into text/reasoning. Shared by the main read
    // loop and by the final flush below, so the last line read from the
    // stream is handled identically to every other line instead of being
    // silently dropped.
    const consumeLines = (chunk) => {
      for(const line of chunk.split('\n')){
        const trimmed = line.trim();
        if(!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if(!data || data === '[DONE]') continue;
        let json;
        try{ json = JSON.parse(data); }catch(e){ continue; }
        if(json && json.extemplary_continue === true){ needsContinuation = true; continue; }
        const delta = json?.choices?.[0]?.delta || json?.choices?.[0]?.message || {};
        if(typeof delta.content === 'string') text += delta.content;
        if(typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if(typeof delta.thinking === 'string') reasoning += delta.thinking;
        // OpenRouter's own streaming format (which is what Hack Club AI
        // proxies) exposes reasoning under a plain `reasoning` field for
        // reasoning-heavy models — Kimi K3 in particular defaults to
        // reasoning effort "max", so without this its entire response
        // was landing here and being silently dropped, producing an
        // empty completion that surfaced as "model unavailable."
        if(typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      }
    };
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last line may be a partial chunk — keep it for next read
      consumeLines(lines.join('\n'));
    }
    // The stream is done, but `buffer` can still hold the final line —
    // the underlying connection has no obligation to end on a '\n', so
    // the last SSE event (often the tail of the actual answer, right
    // before the closing "data: [DONE]") was landing here and getting
    // thrown away instead of parsed. Flush the decoder for any trailing
    // multi-byte characters, then process whatever's left the same way
    // as every other line.
    buffer += decoder.decode();
    if(buffer) consumeLines(buffer);
    return { text: text.trim(), reasoning: reasoning.trim(), needsContinuation };
  }
  // Repeatedly calls hackclub-chat, feeding the partial answer back in as
  // prior context whenever a call gets cut off by the server's own time
  // budget (needsContinuation), until the model genuinely finishes or a
  // safety cap on rounds is hit. This is what lets a single logical
  // judging request span multiple short server invocations — each one
  // safely under Supabase's wall-clock ceiling — instead of requiring one
  // continuous call long enough to hold the whole thing, which isn't
  // possible on the Free plan for slow models like Opus 5 (observed
  // 280-300s total, well over the 150s Free-tier ceiling).
  //
  // `doFetch(messages)` runs one round: POST the given message list to
  // hackclub-chat and resolve to the raw streaming Response, or throw
  // (rate-limited / non-ok) exactly like every other call in this file —
  // so normal withKeyFallback retry/error handling upstream still works
  // unchanged. This function only adds the "ask it to keep going" loop
  // on top of that.
  // Rubric category names, used only to build a cheap "already covered"
  // list for continuation rounds (see below) — not used for scoring.
  const RUBRIC_CATEGORY_NAMES = [
    'Creative Hook & Intro','Structure','Strength of Argument & Analysis',
    'Flaws in Reasoning','Strength of Evidence','Clarity',
    'Conclusion Strength','Speech Quality'
  ];
  // Caps how much of the already-written answer gets resent verbatim on
  // a continuation round. Sending the *entire* accumulated text back
  // every round means round 2 pays for round 1's output as input tokens,
  // round 3 pays for rounds 1+2's, etc — real, avoidable cost that grows
  // roughly with the square of the round count, not just a straight
  // split of one total. A bounded tail keeps the model's immediate
  // continuation point sharp (which is what actually matters for not
  // repeating itself or breaking mid-sentence) without re-billing
  // everything written several rounds ago.
  const CONTINUATION_TAIL_CHARS = 6000;
  async function runHackClubChatToCompletion(doFetch, messages, onRound){
    const MAX_ROUNDS = 6; // ~6 * 128s server-side time budget per round ≈ 12.8 minutes of total generation headroom — comfortably above any observed Opus 5 / DeepSeek run
    let fullText = '';
    let fullReasoning = '';
    let currentMessages = messages;
    for(let round = 0; round < MAX_ROUNDS; round++){
      if(typeof onRound === 'function'){ try{ onRound(round + 1); }catch(e){} }
      // A short pause before every round after the first spaces out the
      // burst of requests the continuation loop fires, which is what was
      // tripping Supabase's platform-level rate limit (separate from our
      // own daily-quota system) in the first place — see
      // readRateLimitInfo above.
      if(round > 0) await new Promise(r => setTimeout(r, 800));
      const res = await doFetch(currentMessages);
      const { text, reasoning, needsContinuation } = await readHackClubStream(res);
      fullText += text;
      fullReasoning += reasoning;
      // "Composite Score" is the one line every complete ballot always
      // reaches (see RUBRIC_PROMPT/INTRO/BODY_RUBRIC_PROMPT — it's the
      // second-to-last thing the model writes, right before Judge's Rank
      // and Feedback). Previously, needsContinuation===false (i.e. the
      // model sent a real stop, not one of our own time-budget cutoffs)
      // was trusted outright as "done" — but a model can send a genuine
      // stop well before actually finishing the ballot, especially on a
      // continuation round handed a truncated tail of its own earlier
      // output. That's exactly what was happening: round 2 would stop
      // naturally partway through a category with no Composite Score in
      // sight, and this loop accepted it as final. Now a natural stop
      // only ends the loop if the ballot actually looks finished;
      // otherwise it's treated the same as a forced continuation and
      // given another round, same as our own time-budget cutoffs get.
      const looksComplete = /composite score/i.test(fullText);
      if(!needsContinuation && looksComplete) return fullText.trim() || fullReasoning.trim();
      if(!needsContinuation && round === MAX_ROUNDS - 1) return fullText.trim() || fullReasoning.trim();
      // Covered-category list is a cheap substitute for re-sending
      // everything already written — the model just needs to know which
      // categories are done so it doesn't redo one it covered several
      // rounds back and outside the tail window below.
      const covered = RUBRIC_CATEGORY_NAMES.filter(name => fullText.includes(name));
      const tail = fullText.length > CONTINUATION_TAIL_CHARS
        ? '…(earlier categories omitted here to save tokens — see the "already covered" list above; they are already complete, do not rewrite them)…\n\n' + fullText.slice(-CONTINUATION_TAIL_CHARS)
        : fullText;
      // IMPORTANT: this used to inject the partial answer as a fake
      // trailing `assistant` turn (a "prefill", asking the model to
      // resume from exactly that text) followed by a new `user` turn
      // asking it to continue. That silently broke on Opus 5: models
      // running with extended thinking enabled don't support assistant
      // message prefill — the API can reject the whole request outright
      // when a thinking-enabled model gets a prefilled final assistant
      // turn. Hack Club's proxy appears to swallow that rejection into
      // an empty-but-200 response rather than surfacing a real error,
      // which showed up as a "0 in / 0 out · Free · OK" call that
      // produced no content at all — not a time-budget cutoff, a
      // silently rejected request.
      //
      // Fix: never inject a synthetic assistant turn. Every round is a
      // fresh, single system+user exchange — the partial answer is
      // embedded as quoted context *inside* the user message asking for
      // continuation, not passed off as a real prior assistant turn.
      // This can't collide with prefill/thinking restrictions because
      // there's no prefill involved, and it trivially satisfies strict
      // user/assistant alternation since there's only ever one user turn.
      currentMessages = [
        messages[0], // system prompt (rubric)
        { role:'user', content:
          messages[1].content
          + '\n\n---\n\nYou already began writing this ballot below but stopped before it was actually finished. Continue writing IMMEDIATELY after the partial content shown below, in the exact same format. Do NOT repeat, restate, quote, or re-include any of the partial content shown below in your reply — your reply should contain ONLY new content that picks up exactly where the partial content stops (mid-sentence if needed), through to the fully finished ballot (including the Composite Score, Judge\'s Rank, and Feedback section).'
          + (covered.length ? ('\n\nCategories already fully covered in earlier rounds (do not redo these): ' + covered.join(', ') + '.') : '')
          + '\n\n=== PARTIAL BALLOT ALREADY WRITTEN (do not repeat any of this) ===\n' + tail
        }
      ];
    }
    // Hit the round cap without the model ever signaling it was done —
    // return whatever was assembled so far rather than throwing, since
    // the graceful "cut off" ballot UI already handles a partial result
    // reasonably. This should be rare: 6 rounds is a lot of headroom.
    return fullText.trim() || fullReasoning.trim();
  }
  function getJudgeModelChoice(){
    return JUDGE_MODELS[judgeModelValue] || JUDGE_MODELS.llama;
  }
  function setJudgeModel(val, persist){
    if(!JUDGE_MODELS[val]) val = 'llama';
    judgeModelValue = val;
    if(modelPickerLabel) modelPickerLabel.textContent = JUDGE_MODELS[val].label;
    if(modelPickerMenu){
      modelPickerMenu.querySelectorAll('.model-picker-option').forEach(opt => {
        const isActive = opt.dataset.model === val;
        opt.classList.toggle('active', isActive);
        opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }
    if(persist){ try{ localStorage.setItem(JUDGE_MODEL_KEY, val); }catch(e){} }
  }
  function closeModelPicker(){
    if(!modelPicker) return;
    modelPicker.classList.remove('open');
    if(modelPickerMenu) modelPickerMenu.classList.add('hidden');
    if(modelPickerBtn) modelPickerBtn.setAttribute('aria-expanded', 'false');
  }
  if(modelPickerBtn && modelPickerMenu && modelPicker){
    try{
      const saved = localStorage.getItem(JUDGE_MODEL_KEY);
      setJudgeModel(saved && JUDGE_MODELS[saved] ? saved : 'llama', false);
    }catch(e){ setJudgeModel('llama', false); }
    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = modelPickerMenu.classList.contains('hidden');
      if(willOpen){
        modelPicker.classList.add('open');
        modelPickerMenu.classList.remove('hidden');
        modelPickerBtn.setAttribute('aria-expanded', 'true');
      }else{
        closeModelPicker();
      }
    });
    modelPickerMenu.querySelectorAll('.model-picker-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        setJudgeModel(opt.dataset.model, true);
        closeModelPicker();
      });
    });
    document.addEventListener('click', (e) => {
      if(!modelPickerMenu.classList.contains('hidden') && !modelPicker.contains(e.target)) closeModelPicker();
    });
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && !modelPickerMenu.classList.contains('hidden')) closeModelPicker();
    });
  }
  const sigMin         = document.getElementById('sigMin');
  const sigSec         = document.getElementById('sigSec');
  const sigLabel       = document.getElementById('sigLabel');
  const sigColor       = document.getElementById('sigColor');

  // ===== VIEWS =====
  let viewBeforeExample = null;
  let viewBeforeBriefing = null;
  function showView(v){
    [viewRecord, viewReview, viewProcessing, viewResults, viewExample, viewBriefing, viewAiCompare, viewHistory, viewCitation, viewStreak].forEach(x => x.classList.add('hidden'));
    v.classList.remove('hidden');
    if(v !== viewExample && typeof exampleOpen !== 'undefined' && exampleOpen){
      exampleOpen = false;
      document.getElementById('helpToggle')?.classList.remove('active');
    }
    if(v !== viewBriefing && typeof briefingOpen !== 'undefined' && briefingOpen){
      briefingOpen = false;
      document.getElementById('briefingToggle')?.classList.remove('active');
    }
    if(v !== viewCitation && typeof citationOpen !== 'undefined' && citationOpen){
      citationOpen = false;
      document.getElementById('citationToggle')?.classList.remove('active');
    }
    // Same cleanup pattern as exampleOpen/briefingOpen/citationOpen above —
    // this one was missing, which is what let the icon get stuck "active"
    // (blue) after navigating away via any path other than
    // closeAiComparePanel() (e.g. Home, History, a fresh recording). Worse,
    // aiCompareOpen staying true meant the *next* click on the icon called
    // closeAiComparePanel() instead of opening it, silently jumping to
    // whatever stale viewBeforeAiCompare had been captured last time —
    // sometimes an old Results view, which is the "random ballot feedback"
    // behavior being reported.
    if(v !== viewAiCompare && typeof aiCompareOpen !== 'undefined' && aiCompareOpen){
      aiCompareOpen = false;
      document.getElementById('aiCompareToggle')?.classList.remove('active');
    }
    document.getElementById('streakToggle')?.classList.toggle('active', v === viewStreak);
    document.querySelector('.nav-menu-item[data-target="historyToggle"]')?.classList.toggle('active', v === viewHistory);
    document.getElementById('navHomeBtn')?.classList.toggle('active', v === viewRecord);
  }

  // ===== CAMERA =====
  async function initCamera(){
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      cameraStream = stream;
      liveVideo.srcObject = stream;
      permError.classList.add('hidden');
    }catch(e){
      permError.classList.remove('hidden');
      recBtn.disabled = true;
    }
  }
  initCamera();

  // ===== TIMER =====
  function fmt(s){
    return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  }

  function tickTimer(){
    elapsedSeconds++;
    clockPill.textContent = fmt(elapsedSeconds);
    clockPill.classList.remove('warn','over');

    if(introDrillMode){
      // Intro Drill: only the intro is recorded, so the cap is ~1 minute
      // instead of the full 7:30 speech clock, and none of the full-speech
      // time signals apply.
      if(elapsedSeconds >= INTRO_RECORD_CAP_SECONDS){
        fireSignalOverlay('⏹ Time Expired', fmt(elapsedSeconds), 'Introduction recording stopped automatically', '', '#a3322a');
        stopRecording();
        return;
      }
      if(elapsedSeconds >= INTRO_RECORD_CAP_SECONDS - 15){
        clockPill.classList.add('over');
        if(elapsedSeconds === INTRO_RECORD_CAP_SECONDS - 15) fireSignalOverlay('⚠ Wrap It Up', fmt(elapsedSeconds), '15 seconds left in the intro cap', '', '#a3322a');
      }else if(elapsedSeconds >= 45){
        clockPill.classList.add('warn');
      }
      return;
    }

    if(bodyDrillMode){
      // Body Drill: only a single body paragraph is recorded, so the cap is
      // ~2 minutes instead of the full 7:30 speech clock, and none of the
      // full-speech time signals apply.
      if(elapsedSeconds >= BODY_RECORD_CAP_SECONDS){
        fireSignalOverlay('⏹ Time Expired', fmt(elapsedSeconds), 'Body point recording stopped automatically', '', '#a6790c');
        stopRecording();
        return;
      }
      if(elapsedSeconds >= BODY_RECORD_CAP_SECONDS - 15){
        clockPill.classList.add('over');
        if(elapsedSeconds === BODY_RECORD_CAP_SECONDS - 15) fireSignalOverlay('⚠ Wrap It Up', fmt(elapsedSeconds), '15 seconds left in the body cap', '', '#a6790c');
      }else if(elapsedSeconds >= 90){
        clockPill.classList.add('warn');
      }
      return;
    }

    if(elapsedSeconds >= 450){
      // Auto-stop at 7:30
      stopRecording();
      return;
    }

    if(elapsedSeconds >= 420){
      clockPill.classList.add('over');
      if(elapsedSeconds === 420) fireSignalOverlay('⚠ Overtime Warning', fmt(elapsedSeconds), '7 Minutes — Hard stop in 30 seconds', '', '#a3322a');
    } else if(elapsedSeconds >= 360){
      clockPill.classList.add('warn');
    }

    // Auto-stop message
    if(elapsedSeconds === 450){
      fireSignalOverlay('⏹ Time Expired', '7:30', 'Recording stopped automatically', '', '#a3322a');
    }

    // Custom time signals
    timeSignals.forEach(sig => {
      if(elapsedSeconds === sig.seconds){
        fireSignalOverlay('Time Signal', fmt(sig.seconds), sig.label, '', sig.color);
      }
    });
  }

  // ===== SIGNAL OVERLAY =====
  function fireSignalOverlay(label, timeStr, sub, warn, color){
    clearTimeout(overlayTimeout);
    overlayLabel.textContent = label;
    overlayTime.textContent = timeStr;
    overlayTime.style.color = color || '#fff';
    overlaySub.textContent = sub;
    overlayWarn.textContent = warn;
    overlayCard.style.borderColor = color || '#fff';
    signalOverlay.classList.add('visible');
    // Auto-dismiss after 3s (except 7:30 stop)
    overlayTimeout = setTimeout(dismissOverlay, 3000);
  }

  function dismissOverlay(){
    signalOverlay.classList.remove('visible');
    clearTimeout(overlayTimeout);
  }
  overlayDismiss.addEventListener('click', dismissOverlay);
  document.getElementById('signalOverlay').addEventListener('click', (e) => {
    if(e.target === signalOverlay || e.target.classList.contains('overlay-backdrop')) dismissOverlay();
  });

  // ===== RECORDING =====
  function pickMimeType(){
    const candidates = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    for(const c of candidates){
      if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  recBtn.addEventListener('click', () => {
    if(!recorder || recorder.state === 'inactive') startRecording();
    else stopRecording();
  });

  function startRecording(){
    if(!stream) return;
    const q = requireQuestion();
    if(!q){ recordQuestionError.style.display = 'block'; return; }
    recordQuestionError.style.display = 'none';
    closeIntroPrepIfOpen();
    lastQuestion = q;
    chunks = [];
    elapsedSeconds = 0;
    recordedMime = pickMimeType() || 'video/webm';
    try{
      recorder = recordedMime ? new MediaRecorder(stream,{mimeType:recordedMime}) : new MediaRecorder(stream);
    }catch(e){
      recorder = new MediaRecorder(stream);
      recordedMime = recorder.mimeType || 'video/webm';
    }
    recorder.ondataavailable = e => { if(e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.start(1000);
    recBtn.classList.add('recording');
    recBtn.setAttribute('aria-label','Stop recording');
    recBtnLabel.textContent = 'Stop';
    recPill.classList.remove('hidden');
    clockPill.classList.remove('hidden');
    clockPill.classList.remove('warn','over');
    clockPill.textContent = '00:00';
    timerInterval = setInterval(tickTimer, 1000);
    settingsPanel.classList.add('hidden');
    settingsToggle.classList.remove('active');
    settingsOpen = false;
  }

  function stopRecording(){
    clearInterval(timerInterval);
    if(recorder && recorder.state !== 'inactive') recorder.stop();
    recBtn.classList.remove('recording');
    recBtn.setAttribute('aria-label','Start recording');
    recBtnLabel.textContent = 'Record';
    recPill.classList.add('hidden');
  }

  function onRecordingStopped(){
    recordedBlob = new Blob(chunks,{type:recordedMime});
    reviewVideo.src = URL.createObjectURL(recordedBlob);
    // Release the shared tab/screen now that it's been captured into recordedBlob.
    if(captureMode === 'capture' && captureStream){
      captureStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} });
      captureStream = null;
    }
    showView(viewReview);
  }

  document.getElementById('rerecordBtn').addEventListener('click', () => {
    recordedBlob = null;
    revertToCamera();
    showView(viewRecord);
  });

  // ===== UPLOAD VIDEO INSTEAD OF RECORDING =====
  const uploadVideoBtn   = document.getElementById('uploadVideoBtn');
  const uploadVideoInput = document.getElementById('uploadVideoInput');
  const uploadError      = document.getElementById('uploadError');

  // ===== DRAWN QUESTION: custom entry vs AI-generated =====
  let questionMode = null; // null | 'custom' | 'generated'
  let lastGenCategory = null;

  // ===== INTRO DRILL MODE / BODY DRILL MODE =====
  // When Intro Drill is active: after a question is confirmed, a 5-minute
  // prep countdown auto-starts (pause/skip/exit available). Recording is
  // then capped at ~1 minute and graded with a trimmed rubric (hook/link/
  // thesis, clarity, and vocal delivery only, no body/conclusion/evidence
  // categories).
  // When Body Drill is active: same shape, but a 10-minute prep countdown
  // and a recording cap of ~2 minutes, capturing just a single body
  // paragraph, graded with a trimmed rubric (structure, argument/analysis,
  // reasoning, evidence, clarity, and vocal delivery, no hook/intro or
  // conclusion categories).
  // practiceMode is the single source of truth for which of the three
  // modes is active; introDrillMode/bodyDrillMode below are kept as
  // convenience booleans derived from it so existing call sites reading
  // "introDrillMode" keep working unchanged.
  let practiceMode = 'regular'; // 'regular' | 'introdrill' | 'bodydrill' | 'roughdraft'
  let introDrillMode = false;
  let bodyDrillMode = false;
  let roughDraftMode = false;
  const INTRO_PREP_SECONDS = 5 * 60;
  const INTRO_RECORD_CAP_SECONDS = 65; // ~1 minute, with a few seconds of grace
  const BODY_PREP_SECONDS = 10 * 60;
  const BODY_RECORD_CAP_SECONDS = 125; // ~2 minutes, with a few seconds of grace
  const REGULAR_PREP_SECONDS = 30 * 60;
  // Rough Draft's prep length is chosen by the user (10-15 minutes) rather
  // than fixed, so this is just the default shown before they pick.
  const ROUGHDRAFT_DEFAULT_PREP_MINUTES = 10;
  let regularPrepSecondsLeft = REGULAR_PREP_SECONDS;
  let regularPrepRunning = false;
  let regularPrepInterval = null;
  let regularPrepPhraseTimer = null;
  let introPrepSecondsLeft = INTRO_PREP_SECONDS;
  let introPrepRunning = false;
  let introPrepInterval = null;
  let introPrepPhraseTimer = null;
  let bodyPrepSecondsLeft = BODY_PREP_SECONDS;
  let bodyPrepRunning = false;
  let bodyPrepInterval = null;
  let bodyPrepPhraseTimer = null;
  let roughDraftPrepSeconds = ROUGHDRAFT_DEFAULT_PREP_MINUTES * 60;
  let roughDraftPrepSecondsLeft = roughDraftPrepSeconds;
  let roughDraftPrepRunning = false;
  let roughDraftPrepInterval = null;
  let roughDraftPrepPhraseTimer = null;
  let roughDraftPrepStartedForCurrentQuestion = false;

  const modeSwitch         = document.getElementById('modeSwitch');
  const modeRegularBtn     = document.getElementById('modeRegularBtn');
  const modeIntroDrillBtn  = document.getElementById('modeIntroDrillBtn');
  const modeBodyDrillBtn   = document.getElementById('modeBodyDrillBtn');
  const modeRoughDraftBtn  = document.getElementById('modeRoughDraftBtn');
  const modeSwitchHint     = document.getElementById('modeSwitchHint');
  const roughDraftFormBlock  = document.getElementById('roughDraftFormBlock');
  const recordStageEl        = document.getElementById('recordStage');
  const recordControlsRowEl  = document.getElementById('recordControlsRow');
  const recordOrDividerEl    = document.getElementById('recordOrDivider');
  const recordAvBtnRowEl     = document.getElementById('recordAvBtnRow');
  const startTimerBtn      = document.getElementById('startTimerBtn');
  const ballotModeLabel    = document.getElementById('ballotModeLabel');
  const ballotTitleEl      = document.getElementById('ballotTitle');
  const regularPrepModal     = document.getElementById('regularPrepModal');
  const regularPrepDisplay   = document.getElementById('regularPrepDisplay');
  const regularPrepPhrase    = document.getElementById('regularPrepPhrase');
  const regularPrepPauseBtn  = document.getElementById('regularPrepPauseBtn');
  const regularPrepResumeBtn = document.getElementById('regularPrepResumeBtn');
  const regularPrepSkipBtn   = document.getElementById('regularPrepSkipBtn');
  const regularPrepExitBtn   = document.getElementById('regularPrepExitBtn');
  const REGULAR_PREP_PHRASES = DATA.REGULAR_PREP_PHRASES || [];
  const introPrepModal     = document.getElementById('introPrepModal');
  const introPrepDisplay   = document.getElementById('introPrepDisplay');
  const introPrepPhrase    = document.getElementById('introPrepPhrase');
  const introPrepPauseBtn  = document.getElementById('introPrepPauseBtn');
  const introPrepResumeBtn = document.getElementById('introPrepResumeBtn');
  const introPrepSkipBtn   = document.getElementById('introPrepSkipBtn');
  const introPrepExitBtn   = document.getElementById('introPrepExitBtn');
  const INTRO_PREP_PHRASES = DATA.INTRO_PREP_PHRASES || [];
  const bodyPrepModal     = document.getElementById('bodyPrepModal');
  const bodyPrepDisplay   = document.getElementById('bodyPrepDisplay');
  const bodyPrepPhrase    = document.getElementById('bodyPrepPhrase');
  const bodyPrepPauseBtn  = document.getElementById('bodyPrepPauseBtn');
  const bodyPrepResumeBtn = document.getElementById('bodyPrepResumeBtn');
  const bodyPrepSkipBtn   = document.getElementById('bodyPrepSkipBtn');
  const bodyPrepExitBtn   = document.getElementById('bodyPrepExitBtn');
  const BODY_PREP_PHRASES = DATA.BODY_PREP_PHRASES || [];
  const roughDraftPrepModal     = document.getElementById('roughDraftPrepModal');
  const roughDraftPrepDisplay   = document.getElementById('roughDraftPrepDisplay');
  const roughDraftPrepPhrase    = document.getElementById('roughDraftPrepPhrase');
  const roughDraftPrepPauseBtn  = document.getElementById('roughDraftPrepPauseBtn');
  const roughDraftPrepResumeBtn = document.getElementById('roughDraftPrepResumeBtn');
  const roughDraftPrepSkipBtn   = document.getElementById('roughDraftPrepSkipBtn');
  const roughDraftPrepExitBtn   = document.getElementById('roughDraftPrepExitBtn');
  const roughDraftPrepChooseRow = document.getElementById('roughDraftPrepChooseRow');
  const roughDraftPrepMinutesSel = document.getElementById('roughDraftPrepMinutes');
  const roughDraftPrepBeginBtn  = document.getElementById('roughDraftPrepBeginBtn');
  const ROUGHDRAFT_PREP_PHRASES = DATA.ROUGHDRAFT_PREP_PHRASES || [];

  function setPracticeMode(mode){
    practiceMode = mode;
    introDrillMode = (mode === 'introdrill');
    bodyDrillMode = (mode === 'bodydrill');
    roughDraftMode = (mode === 'roughdraft');
    if(roughDraftMode) syncRoughDraftQuestion();
    const isRegular = mode === 'regular';
    modeRegularBtn.classList.toggle('active', isRegular);
    modeIntroDrillBtn.classList.toggle('active', introDrillMode);
    modeBodyDrillBtn.classList.toggle('active', bodyDrillMode);
    modeRoughDraftBtn.classList.toggle('active', roughDraftMode);
    modeRegularBtn.setAttribute('aria-selected', String(isRegular));
    modeIntroDrillBtn.setAttribute('aria-selected', String(introDrillMode));
    modeBodyDrillBtn.setAttribute('aria-selected', String(bodyDrillMode));
    modeRoughDraftBtn.setAttribute('aria-selected', String(roughDraftMode));
    modeSwitchHint.textContent = introDrillMode
      ? '5-minute prep, then record just the introduction up to 1 minute. Graded only on hook, link, thesis, clarity, and delivery.'
      : bodyDrillMode
      ? '10-minute prep, then record just 1 body paragraph up to 2 minutes. Graded on everything the full round is graded on except the intro and conclusion.'
      : roughDraftMode
      ? '10-15 minute prep, then type up a plaintext rough draft of your speech (no recording). Graded only on content, not delivery.'
      : '30-minute prep, then record a full 7-minute. Graded on all 8 rubric categories.';
    modeSwitchHint.classList.toggle('is-intro', introDrillMode);
    modeSwitchHint.classList.toggle('is-body', bodyDrillMode);
    modeSwitchHint.classList.toggle('is-roughdraft', roughDraftMode);
    ballotModeLabel.textContent = introDrillMode ? 'Rapid Drill: Intro' : bodyDrillMode ? 'Rapid Drill: Body' : roughDraftMode ? 'Rough Draft' : 'Regular Practice';
    ballotModeLabel.classList.toggle('is-intro', introDrillMode);
    ballotModeLabel.classList.toggle('is-body', bodyDrillMode);
    ballotModeLabel.classList.toggle('is-roughdraft', roughDraftMode);
    ballotModeLabel.classList.toggle('is-regular', isRegular);
    ballotTitleEl.textContent = introDrillMode ? 'Intro Drill Ballot' : bodyDrillMode ? 'Body Drill Ballot' : roughDraftMode ? 'Rough Draft Ballot' : 'Practice Ballot';
    startTimerBtn.classList.toggle('mode-regular', isRegular);
    startTimerBtn.classList.toggle('mode-introdrill', introDrillMode);
    startTimerBtn.classList.toggle('mode-bodydrill', bodyDrillMode);
    startTimerBtn.classList.toggle('mode-roughdraft', roughDraftMode);
    // Swap the camera/record stage for the plaintext rough-draft form (and
    // back) whenever the mode changes.
    if(roughDraftFormBlock) roughDraftFormBlock.classList.toggle('hidden', !roughDraftMode);
    if(recordStageEl) recordStageEl.classList.toggle('hidden', roughDraftMode);
    if(recordControlsRowEl) recordControlsRowEl.classList.toggle('hidden', roughDraftMode);
    if(recordOrDividerEl) recordOrDividerEl.classList.toggle('hidden', roughDraftMode);
    if(recordAvBtnRowEl) recordAvBtnRowEl.classList.toggle('hidden', roughDraftMode);
    if(!isRegular){
      stopRegularPrepTimer();
      regularPrepModal.classList.add('hidden');
    }
    if(!introDrillMode){
      stopIntroPrepTimer();
      introPrepModal.classList.add('hidden');
    }
    if(!bodyDrillMode){
      stopBodyPrepTimer();
      bodyPrepModal.classList.add('hidden');
    }
    if(!roughDraftMode){
      stopRoughDraftPrepTimer();
      roughDraftPrepModal.classList.add('hidden');
    }
  }

  function switchPracticeMode(mode){
    if(recorder && recorder.state === 'recording') return; // don't toggle mid-recording
    if(mode === practiceMode) return;
    setPracticeMode(mode);
    recordedBlob = null;
    revertToCamera();
    resetHomeView();
    showView(viewRecord);
  }
  modeRegularBtn.addEventListener('click', () => switchPracticeMode('regular'));
  modeIntroDrillBtn.addEventListener('click', () => switchPracticeMode('introdrill'));
  modeBodyDrillBtn.addEventListener('click', () => switchPracticeMode('bodydrill'));
  modeRoughDraftBtn.addEventListener('click', () => switchPracticeMode('roughdraft'));

  // ---- Regular Practice prep timer (30:00 countdown), mirrors the Intro
  // and Body Drill prep timer functions below, just with its own state/DOM
  // and only ever opened by the "Start Timer" button, never automatically. ----
  function fmtRegularPrep(s){
    const m = Math.floor(s/60), sec = s%60;
    return m + ':' + String(sec).padStart(2,'0');
  }
  function renderRegularPrepTimer(){
    regularPrepDisplay.textContent = fmtRegularPrep(regularPrepSecondsLeft);
    regularPrepDisplay.classList.toggle('warn', regularPrepSecondsLeft <= 60 && regularPrepSecondsLeft > 0);
    regularPrepPauseBtn.classList.toggle('hidden', !regularPrepRunning);
    regularPrepResumeBtn.classList.toggle('hidden', regularPrepRunning || regularPrepSecondsLeft === 0);
  }
  function rotateRegularPrepPhrase(){
    if(!REGULAR_PREP_PHRASES.length) return;
    const i = Math.floor(Math.random() * REGULAR_PREP_PHRASES.length);
    regularPrepPhrase.textContent = REGULAR_PREP_PHRASES[i];
  }
  function startRegularPrepTimer(){
    if(regularPrepRunning || regularPrepSecondsLeft <= 0) return;
    regularPrepRunning = true;
    clearInterval(regularPrepInterval);
    regularPrepInterval = setInterval(() => {
      regularPrepSecondsLeft = Math.max(0, regularPrepSecondsLeft - 1);
      renderRegularPrepTimer();
      if(regularPrepSecondsLeft === 0){
        clearInterval(regularPrepInterval);
        regularPrepRunning = false;
        finishRegularPrep();
      }
    }, 1000);
    clearInterval(regularPrepPhraseTimer);
    rotateRegularPrepPhrase();
    regularPrepPhraseTimer = setInterval(rotateRegularPrepPhrase, 12000);
    renderRegularPrepTimer();
  }
  function pauseRegularPrepTimer(){
    regularPrepRunning = false;
    clearInterval(regularPrepInterval);
    clearInterval(regularPrepPhraseTimer);
    renderRegularPrepTimer();
  }
  function stopRegularPrepTimer(){
    regularPrepRunning = false;
    clearInterval(regularPrepInterval);
    clearInterval(regularPrepPhraseTimer);
    regularPrepSecondsLeft = REGULAR_PREP_SECONDS;
  }
  function finishRegularPrep(){
    regularPrepModal.classList.add('hidden');
    fireSignalOverlay('⏰ Prep Time\'s Up', '0:00', 'Your 30 minutes of prep time have ended.', '', '#1d5c9e');
  }
  regularPrepPauseBtn.addEventListener('click', pauseRegularPrepTimer);
  regularPrepResumeBtn.addEventListener('click', startRegularPrepTimer);
  regularPrepSkipBtn.addEventListener('click', () => {
    clearInterval(regularPrepInterval);
    clearInterval(regularPrepPhraseTimer);
    regularPrepRunning = false;
    regularPrepSecondsLeft = 0;
    regularPrepModal.classList.add('hidden');
  });
  regularPrepExitBtn.addEventListener('click', () => {
    stopRegularPrepTimer();
    regularPrepModal.classList.add('hidden');
  });

  function openRegularPrepModal(){
    regularPrepSecondsLeft = REGULAR_PREP_SECONDS;
    renderRegularPrepTimer();
    regularPrepModal.classList.remove('hidden');
    startRegularPrepTimer();
  }

  function fmtIntroPrep(s){
    const m = Math.floor(s/60), sec = s%60;
    return m + ':' + String(sec).padStart(2,'0');
  }
  function renderIntroPrepTimer(){
    introPrepDisplay.textContent = fmtIntroPrep(introPrepSecondsLeft);
    introPrepDisplay.classList.toggle('warn', introPrepSecondsLeft <= 30 && introPrepSecondsLeft > 0);
    introPrepPauseBtn.classList.toggle('hidden', !introPrepRunning);
    introPrepResumeBtn.classList.toggle('hidden', introPrepRunning || introPrepSecondsLeft === 0);
  }
  function rotateIntroPrepPhrase(){
    if(!INTRO_PREP_PHRASES.length) return;
    const i = Math.floor(Math.random() * INTRO_PREP_PHRASES.length);
    introPrepPhrase.textContent = INTRO_PREP_PHRASES[i];
  }
  function startIntroPrepTimer(){
    if(introPrepRunning || introPrepSecondsLeft <= 0) return;
    introPrepRunning = true;
    clearInterval(introPrepInterval);
    introPrepInterval = setInterval(() => {
      introPrepSecondsLeft = Math.max(0, introPrepSecondsLeft - 1);
      renderIntroPrepTimer();
      if(introPrepSecondsLeft === 0){
        clearInterval(introPrepInterval);
        introPrepRunning = false;
        finishIntroPrep();
      }
    }, 1000);
    clearInterval(introPrepPhraseTimer);
    rotateIntroPrepPhrase();
    introPrepPhraseTimer = setInterval(rotateIntroPrepPhrase, 12000);
    renderIntroPrepTimer();
  }
  function pauseIntroPrepTimer(){
    introPrepRunning = false;
    clearInterval(introPrepInterval);
    clearInterval(introPrepPhraseTimer);
    renderIntroPrepTimer();
  }
  function stopIntroPrepTimer(){
    introPrepRunning = false;
    clearInterval(introPrepInterval);
    clearInterval(introPrepPhraseTimer);
    introPrepSecondsLeft = INTRO_PREP_SECONDS;
  }
  function finishIntroPrep(){
    introPrepModal.classList.add('hidden');
    fireSignalOverlay('⏰ Prep Time\'s Up', '0:00', 'Record your introduction now.', '', '#a3322a');
  }
  introPrepPauseBtn.addEventListener('click', pauseIntroPrepTimer);
  introPrepResumeBtn.addEventListener('click', startIntroPrepTimer);
  introPrepSkipBtn.addEventListener('click', () => {
    clearInterval(introPrepInterval);
    clearInterval(introPrepPhraseTimer);
    introPrepRunning = false;
    introPrepSecondsLeft = 0;
    introPrepModal.classList.add('hidden');
  });
  introPrepExitBtn.addEventListener('click', () => {
    stopIntroPrepTimer();
    introPrepModal.classList.add('hidden');
    setPracticeMode('regular');
  });

  function openIntroPrepModal(){
    introPrepSecondsLeft = INTRO_PREP_SECONDS;
    renderIntroPrepTimer();
    introPrepModal.classList.remove('hidden');
    startIntroPrepTimer();
  }

  // ---- Body Drill prep timer (10:00 countdown), mirrors the Intro Drill
  // prep timer functions above exactly, just with its own state/DOM. ----
  function fmtBodyPrep(s){
    const m = Math.floor(s/60), sec = s%60;
    return m + ':' + String(sec).padStart(2,'0');
  }
  function renderBodyPrepTimer(){
    bodyPrepDisplay.textContent = fmtBodyPrep(bodyPrepSecondsLeft);
    bodyPrepDisplay.classList.toggle('warn', bodyPrepSecondsLeft <= 30 && bodyPrepSecondsLeft > 0);
    bodyPrepPauseBtn.classList.toggle('hidden', !bodyPrepRunning);
    bodyPrepResumeBtn.classList.toggle('hidden', bodyPrepRunning || bodyPrepSecondsLeft === 0);
  }
  function rotateBodyPrepPhrase(){
    if(!BODY_PREP_PHRASES.length) return;
    const i = Math.floor(Math.random() * BODY_PREP_PHRASES.length);
    bodyPrepPhrase.textContent = BODY_PREP_PHRASES[i];
  }
  function startBodyPrepTimer(){
    if(bodyPrepRunning || bodyPrepSecondsLeft <= 0) return;
    bodyPrepRunning = true;
    clearInterval(bodyPrepInterval);
    bodyPrepInterval = setInterval(() => {
      bodyPrepSecondsLeft = Math.max(0, bodyPrepSecondsLeft - 1);
      renderBodyPrepTimer();
      if(bodyPrepSecondsLeft === 0){
        clearInterval(bodyPrepInterval);
        bodyPrepRunning = false;
        finishBodyPrep();
      }
    }, 1000);
    clearInterval(bodyPrepPhraseTimer);
    rotateBodyPrepPhrase();
    bodyPrepPhraseTimer = setInterval(rotateBodyPrepPhrase, 12000);
    renderBodyPrepTimer();
  }
  function pauseBodyPrepTimer(){
    bodyPrepRunning = false;
    clearInterval(bodyPrepInterval);
    clearInterval(bodyPrepPhraseTimer);
    renderBodyPrepTimer();
  }
  function stopBodyPrepTimer(){
    bodyPrepRunning = false;
    clearInterval(bodyPrepInterval);
    clearInterval(bodyPrepPhraseTimer);
    bodyPrepSecondsLeft = BODY_PREP_SECONDS;
  }
  function finishBodyPrep(){
    bodyPrepModal.classList.add('hidden');
    fireSignalOverlay('⏰ Prep Time\'s Up', '0:00', 'Record your body point now.', '', '#a6790c');
  }
  bodyPrepPauseBtn.addEventListener('click', pauseBodyPrepTimer);
  bodyPrepResumeBtn.addEventListener('click', startBodyPrepTimer);
  bodyPrepSkipBtn.addEventListener('click', () => {
    clearInterval(bodyPrepInterval);
    clearInterval(bodyPrepPhraseTimer);
    bodyPrepRunning = false;
    bodyPrepSecondsLeft = 0;
    bodyPrepModal.classList.add('hidden');
  });
  bodyPrepExitBtn.addEventListener('click', () => {
    stopBodyPrepTimer();
    bodyPrepModal.classList.add('hidden');
    setPracticeMode('regular');
  });

  function openBodyPrepModal(){
    bodyPrepSecondsLeft = BODY_PREP_SECONDS;
    renderBodyPrepTimer();
    bodyPrepModal.classList.remove('hidden');
    startBodyPrepTimer();
  }

  // ---- Rough Draft prep timer (10:00-15:00 countdown, user's choice),
  // mirrors the Intro/Body Drill prep timer functions above, except the
  // modal first shows a minute picker (roughDraftPrepChooseRow) before the
  // countdown itself starts, since the length isn't fixed. ----
  function fmtRoughDraftPrep(s){
    const m = Math.floor(s/60), sec = s%60;
    return m + ':' + String(sec).padStart(2,'0');
  }
  function renderRoughDraftPrepTimer(){
    roughDraftPrepDisplay.textContent = fmtRoughDraftPrep(roughDraftPrepSecondsLeft);
    roughDraftPrepDisplay.classList.toggle('warn', roughDraftPrepSecondsLeft <= 30 && roughDraftPrepSecondsLeft > 0);
    roughDraftPrepPauseBtn.classList.toggle('hidden', !roughDraftPrepRunning);
    roughDraftPrepResumeBtn.classList.toggle('hidden', roughDraftPrepRunning || roughDraftPrepSecondsLeft === 0);
  }
  function rotateRoughDraftPrepPhrase(){
    if(!ROUGHDRAFT_PREP_PHRASES.length) return;
    const i = Math.floor(Math.random() * ROUGHDRAFT_PREP_PHRASES.length);
    roughDraftPrepPhrase.textContent = ROUGHDRAFT_PREP_PHRASES[i];
  }
  function startRoughDraftPrepTimer(){
    if(roughDraftPrepRunning || roughDraftPrepSecondsLeft <= 0) return;
    roughDraftPrepRunning = true;
    clearInterval(roughDraftPrepInterval);
    roughDraftPrepInterval = setInterval(() => {
      roughDraftPrepSecondsLeft = Math.max(0, roughDraftPrepSecondsLeft - 1);
      renderRoughDraftPrepTimer();
      if(roughDraftPrepSecondsLeft === 0){
        clearInterval(roughDraftPrepInterval);
        roughDraftPrepRunning = false;
        finishRoughDraftPrep();
      }
    }, 1000);
    clearInterval(roughDraftPrepPhraseTimer);
    rotateRoughDraftPrepPhrase();
    roughDraftPrepPhraseTimer = setInterval(rotateRoughDraftPrepPhrase, 12000);
    renderRoughDraftPrepTimer();
  }
  function pauseRoughDraftPrepTimer(){
    roughDraftPrepRunning = false;
    clearInterval(roughDraftPrepInterval);
    clearInterval(roughDraftPrepPhraseTimer);
    renderRoughDraftPrepTimer();
  }
  function stopRoughDraftPrepTimer(){
    roughDraftPrepRunning = false;
    clearInterval(roughDraftPrepInterval);
    clearInterval(roughDraftPrepPhraseTimer);
    roughDraftPrepSecondsLeft = roughDraftPrepSeconds;
  }
  function finishRoughDraftPrep(){
    roughDraftPrepModal.classList.add('hidden');
    fireSignalOverlay('⏰ Prep Time\'s Up', '0:00', 'Start writing your rough draft now.', '', '#2f7d3c');
  }
  roughDraftPrepPauseBtn.addEventListener('click', pauseRoughDraftPrepTimer);
  roughDraftPrepResumeBtn.addEventListener('click', startRoughDraftPrepTimer);
  roughDraftPrepSkipBtn.addEventListener('click', () => {
    clearInterval(roughDraftPrepInterval);
    clearInterval(roughDraftPrepPhraseTimer);
    roughDraftPrepRunning = false;
    roughDraftPrepSecondsLeft = 0;
    roughDraftPrepModal.classList.add('hidden');
  });
  roughDraftPrepExitBtn.addEventListener('click', () => {
    stopRoughDraftPrepTimer();
    roughDraftPrepModal.classList.add('hidden');
    setPracticeMode('regular');
  });
  // The user picks a 10-15 minute prep length before the countdown starts,
  // since (unlike the other two drills) Rough Draft prep isn't fixed.
  roughDraftPrepBeginBtn.addEventListener('click', () => {
    const mins = Math.min(15, Math.max(10, parseInt(roughDraftPrepMinutesSel.value, 10) || ROUGHDRAFT_DEFAULT_PREP_MINUTES));
    roughDraftPrepSeconds = mins * 60;
    roughDraftPrepSecondsLeft = roughDraftPrepSeconds;
    roughDraftPrepChooseRow.classList.add('hidden');
    roughDraftPrepDisplay.classList.remove('hidden');
    roughDraftPrepPhrase.classList.remove('hidden');
    roughDraftPrepSkipBtn.classList.remove('hidden');
    renderRoughDraftPrepTimer();
    startRoughDraftPrepTimer();
  });

  function openRoughDraftPrepModal(){
    roughDraftPrepSecondsLeft = roughDraftPrepSeconds;
    roughDraftPrepChooseRow.classList.remove('hidden');
    roughDraftPrepDisplay.classList.add('hidden');
    roughDraftPrepSkipBtn.classList.add('hidden');
    roughDraftPrepPauseBtn.classList.add('hidden');
    roughDraftPrepResumeBtn.classList.add('hidden');
    roughDraftPrepPhrase.textContent = '';
    // Hidden (rather than just empty) during the "choose your prep
    // length" step, since an empty-but-still-laid-out phrase line plus
    // an all-buttons-hidden timer-btn-row underneath it was exactly the
    // "too much empty space" the modal used to show before a length was
    // picked and the countdown actually started.
    roughDraftPrepPhrase.classList.add('hidden');
    roughDraftPrepModal.classList.remove('hidden');
  }

  const QUESTION_EXAMPLES = DATA.QUESTION_EXAMPLES;
  // Difficulty scale for the "Receive a Question" flow. Index 0 = Easy,
  // 1 = Medium, 2 = Hard. Each level carries prompt instructions (fed to
  // Gemini alongside the category) plus a static example question shown
  // next to the slider so the user knows what that difficulty looks like
  // before drafting. Falls back to a safe default set if data.js is old.
  const DIFFICULTY_LEVELS = DATA.DIFFICULTY_LEVELS || [
    { label:'Extremely Easy', instructions:'Keep this an EXTREMELY EASY question — the simplest possible tier, built around a universal, unmistakable current trend or topic that virtually every American adult would recognize on sight, requiring zero specific names, dates, or policy detail.', example:'Is artificial intelligence making American workers more productive?' },
    { label:'Very Easy', instructions:'Keep this a VERY EASY question, built around a major, front-page current event or globally recognized leader that almost anyone would know, with no specific policy detail required.', example:'Will inflation continue to cool in the United States this year?' },
    { label:'Easy', instructions:'Keep this an EASY question, built around a simple, widely-known current event that any generally informed reader would recognize.', example:'How are rising oil prices affecting American consumers this summer?' },
    { label:'Fairly Easy', instructions:'Keep this an EASY-PLUS question, tied to a major well-known topic but requiring awareness of one specific recent headline within it.', example:'Can the U.S. and China finalize a lasting trade agreement this year?' },
    { label:'Mostly Easy', instructions:'Keep this a SOMEWHAT-EASY question, tied to a widely covered domestic policy debate that dominates mainstream news, requiring one specific but well-known detail.', example:'Should Congress pass new background-check legislation for gun purchases?' },
    { label:'Very Simple', instructions:'Keep this a MILDLY-EASY question, tied to a well-known institution or alliance but framed around a specific recent decision rather than the general topic.', example:'Should NATO members commit to higher defense-spending targets this year?' },
    { label:'Simple', instructions:'Keep this a LEANING-EASY question: build it around a fairly well-known event, policy, or public figure that a generally informed reader would likely recognize, but with slightly more specificity than a purely surface-level topic. Avoid truly obscure names or narrow regional policy details.', example:'Should the U.S. expand tariffs on Chinese-made electric vehicles and batteries?' },
    { label:'Fairly Simple', instructions:'Keep this an EASY-TO-MEDIUM question, tied to a well-known economic institution but requiring slightly more specific awareness of a recent development.', example:'Is the Federal Reserve right to hold interest rates steady at its next meeting?' },
    { label:'Moderate', instructions:'Keep this a MEDIUM question that leans slightly easy, tied to a specific ongoing domestic policy debate covered widely enough that most attentive news readers would recognize it.', example:'Should more states adopt no-excuse mail-in voting ahead of the midterms?' },
    { label:'Fairly Moderate', instructions:'Keep this a MEDIUM-EASY question, tied to a specific recent development within a well-covered ongoing international story, requiring more than headline-level knowledge but nothing obscure.', example:'Can Mexico\'s president sustain her approval ratings amid rising cartel violence?' },
    { label:'High Moderate', instructions:'Keep this a MEDIUM-EASY-PLUS question, tied to a specific, actively-developing domestic regulatory or corporate story that requires having followed recent business/tech news, not just the general topic.', example:'Will the FTC\'s latest antitrust suit change how Big Tech companies acquire startups?' },
    { label:'Low Medium', instructions:'Keep this an EASY-LEANING-MEDIUM question, tied to a specific piece of domestic economic legislation or its expiring provisions, requiring more than surface awareness of the policy debate.', example:'Should Congress renew the expiring provisions of the CHIPS Act\'s semiconductor subsidies?' },
    { label:'Fairly Medium', instructions:'Keep this a MEDIUM-MINUS question, built around a well-known international institution but tied to a specific recent funding or leadership development within it.', example:'Can the World Health Organization close the funding gap left by the U.S. withdrawal?' },
    { label:'Medium', instructions:'Keep this a MEDIUM-MINUS-PLUS question, built around a specific U.S. space-policy program and a concrete funding or scheduling development within it, not just general space news.', example:'Will NASA\'s commercial low-Earth-orbit station timeline survive further funding delays before the ISS retires?' },
    { label:'High Medium', instructions:'Keep this a question just below true MEDIUM, built around a specific pending court ruling or legal dispute with concrete business/governance implications, requiring more than headline familiarity with corporate law.', example:'Could a pending Delaware Chancery Court ruling reshape how founders retain voting control after IPOs?' },
    { label:'Low Intermediate', instructions:'Keep this a MEDIUM-difficulty question: it should require knowing a specific recent event, policy, or somewhat-less-famous public figure, but still be findable in mainstream news coverage from the last couple weeks — not obscure enough to require specialty trade press.', example:'Should the European Central Bank cut rates again after its latest inflation report?' },
    { label:'Intermediate', instructions:'Keep this a MEDIUM-PLUS question, built around a specific international legal or diplomatic development that requires having followed the story beyond a single headline.', example:'Will the International Criminal Court\'s arrest warrant change how governments host wanted officials at summits?' },
    { label:'Upper Intermediate', instructions:'Keep this a MEDIUM-PLUS question, built around a specific trade/environmental regulation and its concrete effect on a named export industry, requiring more than general awareness of the policy area.', example:'Will a new EU deforestation-import rule force Brazilian soy exporters to overhaul their supply chains?' },
    { label:'Fairly Difficult', instructions:'Keep this a MEDIUM-HARD question, tied to a specific domestic regulatory or health-policy debate that requires having followed the story somewhat closely, not just the headline.', example:'Should the FDA speed up approval timelines for next-generation weight-loss drugs?' },
    { label:'Difficult', instructions:'Keep this a MEDIUM question that leans slightly hard, built around a specific financial-regulatory body and a narrow rule change that requires having read beyond general headlines to recognize.', example:'Should the Basel Committee tighten capital rules for regional banks after last year\'s mid-size bank failures?' },
    { label:'Extremely Difficult', instructions:'Keep this a MOSTLY-HARD question, built around a specific regional economic institution or trade bloc and a narrow, less mainstream development within it.', example:'Can the African Continental Free Trade Area deliver tariff-free trade before member states abandon its timeline?' },
    { label:'Hard', instructions:'Keep this a LEANING-HARD question: build it around a specific, less mainstream event, policy, or regional figure that requires having read somewhat deeper coverage (not just front-page headlines) to recognize.', example:'Can Kenya\'s president rebuild public trust after last year\'s finance-bill protests?' },
    { label:'Very Hard', instructions:'Keep this a SOMEWHAT-HARD question, built around a regional political crisis or lesser-known transitional government that requires having followed specific ongoing coverage, not just general world news.', example:'Can Bangladesh\'s interim government deliver credible elections after last year\'s unrest?' },
    { label:'Low Advanced', instructions:'Keep this a HARD-LEANING question, built around a specific obscure treaty, territorial dispute, or narrow diplomatic ambiguity that would require having read a full article on the subject, not just a headline, to recognize. Prefer treaties, disputes, or narrow policies over \'can this leader survive\' framings.', example:'Will the Svalbard Treaty\'s mineral-rights ambiguity spark a diplomatic dispute between Norway and Russia?' },
    { label:'Advanced', instructions:'Keep this a VERY-HARD-LEANING question, built around a specific niche international regulatory or certification body and a narrow enforcement dispute most people would not have encountered outside dedicated coverage.', example:'Should the Kimberley Process suspend a member after new evidence of conflict-diamond smuggling through Zimbabwe?' },
    { label:'Upper Advanced', instructions:'Keep this a HARD, NICHE question: build it around a specific, lesser-known event, policy, or figure that most people would never have heard of — the kind of question that requires having read niche news coverage closely, not just general headlines. Favor obscure names, minor regional leaders, or narrow specific policies/deals over broad well-known topics.', example:'Can East Timor\'s José Ramos-Horta defuse backlash over the AB Digital Technology Resort deal?' },
    { label:'Near Impossible', instructions:'Keep this a question just below the hardest tier, built around a specific regional political bloc or forum and a narrow diplomatic strain within it, requiring specialist-level regional news familiarity.', example:'Can the Pacific Islands Forum hold together after Kiribati\'s renewed ties with Beijing strain the bloc?' },
    { label:'Borderline Impossible', instructions:'Keep this a VERY HARD, deeply niche question, built around an extremely obscure bilateral agreement, minor deal, or narrow trade-press-only development that virtually no one outside specialist coverage would recognize. Prefer a specific treaty, compact, or agreement over a \'can this leader survive\' framing.', example:'Will the U.S.–Micronesia Compact of Free Association renewal survive this session\'s congressional budget fights?' },
    { label:'Virtually Impossible', instructions:'Keep this an EXTREMELY niche question, built around an extremely obscure regional figure and a disputed political development that virtually no one outside specialist coverage would recognize.', example:'Can Comoros President Azali Assoumani consolidate power after his disputed reelection and the opposition\'s boycott?' },
    { label:'Impossible', instructions:'Keep this an EXTREMELY HARD question — the most niche tier available, built around a highly specific, emerging international regulatory dispute (deep-sea mining rights, orbital slot allocation, submarine cable law, river-basin water treaties, etc.) that only someone reading specialist/trade press coverage within the last few days would recognize. Go more obscure than the \'Very Hard\' tier, and prefer an institutional/legal/regulatory angle over a \'can this leader survive\' framing.', example:'Will the International Seabed Authority\'s stalled mining code push Pacific nations toward issuing unilateral deep-sea mining licenses?' }
  ];
  let selectedCategory = null;
  let lastGenDifficultyIdx = 2;

  function buildQuestionGenPrompt(category, dateStr, difficultyIdx){
    const examples = QUESTION_EXAMPLES[category].slice(0,5).map(q => '- '+q).join('\n');
    const maxIdx = DIFFICULTY_LEVELS.length - 1;
    const idx = (difficultyIdx === undefined || difficultyIdx === null || !DIFFICULTY_LEVELS[difficultyIdx])
      ? Math.floor(DIFFICULTY_LEVELS.length/2) : difficultyIdx;
    const difficulty = DIFFICULTY_LEVELS[idx];
    const easierNeighbor = DIFFICULTY_LEVELS[idx-1];
    const harderNeighbor = DIFFICULTY_LEVELS[idx+1];
    let calibrationNote = '';
    if(easierNeighbor && harderNeighbor){
      calibrationNote = `For calibration, this should be noticeably harder/more obscure than a "${easierNeighbor.label}" question and noticeably easier/more mainstream than a "${harderNeighbor.label}" question.`;
    } else if(easierNeighbor){
      calibrationNote = `For calibration, this should be noticeably harder/more obscure than a "${easierNeighbor.label}" question — this is the hardest, most niche tier on the scale.`;
    } else if(harderNeighbor){
      calibrationNote = `For calibration, this should be noticeably easier/more mainstream than a "${harderNeighbor.label}" question — this is the easiest, most mainstream tier on the scale.`;
    }
    return `You write NSDA competitive extemp questions. Today: ${dateStr}.

=== DIFFICULTY TARGET — READ FIRST, THIS IS THE MOST IMPORTANT CONSTRAINT ===
Target difficulty: "${difficulty.label}" — Level ${idx + 1} of ${DIFFICULTY_LEVELS.length} on an Easy-to-Hard obscurity scale (Level 1 = "${DIFFICULTY_LEVELS[0].label}", most mainstream; Level ${DIFFICULTY_LEVELS.length} = "${DIFFICULTY_LEVELS[maxIdx].label}", most obscure/niche).
${difficulty.instructions}
${calibrationNote}
A calibration example at exactly this difficulty level: "${difficulty.example}"
Every one of the 3 questions you write MUST match this exact difficulty level — not the category's usual mainstream coverage, not one tier easier, not one tier harder. If you're unsure whether a topic is obscure enough (or mainstream enough), err toward matching this level's calibration example over defaulting to well-known headline stories.
=== END DIFFICULTY TARGET ===

Use Google Search to find real ${category} news from the last 7-14 days that fits the difficulty target above. Then write 3 new ${category} extemp questions, each tied to a specific real event/person/policy you found. One sentence each, ending in "?", under 30 words, analytical/predictive phrasing ("Will...","Can...","Should...","How will..."). No older than a few weeks unless still developing.

The style examples below show typical PHRASING and CATEGORY conventions only — ignore whatever difficulty level they happen to be at, and do NOT copy them verbatim:
${examples}
Output ONLY this JSON, nothing else: {"questions":["...","...","..."]}`;
  }

  function renderDifficultyExample(){
    const idx = Number(qDifficultySlider.value);
    const max = Number(qDifficultySlider.max) || (DIFFICULTY_LEVELS.length - 1);
    const level = DIFFICULTY_LEVELS[idx] || DIFFICULTY_LEVELS[Math.floor(DIFFICULTY_LEVELS.length/2)];
    qDifficultyLevelLabel.textContent = level.label;
    if(qDifficultyLevelNum) qDifficultyLevelNum.textContent = `Level ${idx + 1} of ${DIFFICULTY_LEVELS.length}`;
    qDifficultyExample.textContent = level.example;
    const pct = max > 0 ? (idx / max) * 100 : 0;
    qDifficultySlider.style.setProperty('--fillpct', pct + '%');

    if(qDifficultyStops){
      qDifficultyStops.querySelectorAll('.q-diff-stop').forEach(stop => {
        const stopIdx = Number(stop.dataset.idx);
        stop.classList.toggle('is-active', stopIdx === idx);
        stop.classList.toggle('is-passed', stopIdx < idx);
      });
    }
    document.querySelectorAll('.q-diff-ticks span').forEach(tick => {
      tick.classList.toggle('is-active', Number(tick.dataset.idx) === idx);
    });
  }

  qDifficultySlider.addEventListener('input', renderDifficultyExample);
  if(qDifficultyStops){
    qDifficultyStops.querySelectorAll('.q-diff-stop').forEach(stop => {
      stop.addEventListener('click', () => {
        qDifficultySlider.value = stop.dataset.idx;
        renderDifficultyExample();
      });
    });
  }
  renderDifficultyExample();

  qDifficultyBackBtn.addEventListener('click', () => {
    qDifficultyStep.classList.add('hidden');
    qCategoryStep.classList.remove('hidden');
    document.querySelectorAll('.q-cat-btn').forEach(b=>b.classList.remove('active'));
    selectedCategory = null;
  });

  qDifficultyContinueBtn.addEventListener('click', () => {
    if(!selectedCategory || qGenBusy) return;
    generateQuestions(selectedCategory, Number(qDifficultySlider.value));
  });

  function resetGeneratedSteps(){
    qCategoryStep.classList.remove('hidden');
    qDifficultyStep.classList.add('hidden');
    qGenLoading.classList.add('hidden');
    qGenError.style.display = 'none';
    qPickStep.classList.add('hidden');
    qConfirmedStep.classList.add('hidden');
    document.querySelectorAll('.q-cat-btn').forEach(b=>b.classList.remove('active'));
    selectedCategory = null;
    qDifficultySlider.value = 2;
    renderDifficultyExample();
  }

  function setQuestionMode(mode){
    questionMode = mode;
    introPrepStartedForCurrentQuestion = false;
    bodyPrepStartedForCurrentQuestion = false;
    roughDraftPrepStartedForCurrentQuestion = false;
    qModeError.style.display = 'none';
    qModeCustomBtn.classList.toggle('active', mode === 'custom');
    qModeReceiveBtn.classList.toggle('active', mode === 'generated');
    customQuestionBlock.classList.toggle('hidden', mode !== 'custom');
    generatedQuestionBlock.classList.toggle('hidden', mode !== 'generated');
    if(mode === 'generated') resetGeneratedSteps();
    questionError.style.display = 'none';
    questionInput.classList.remove('error');
    if(youtubeQuestionError) youtubeQuestionError.style.display = 'none';
    if(recordQuestionError) recordQuestionError.style.display = 'none';
  }

  qModeCustomBtn.addEventListener('click', () => setQuestionMode('custom'));
  qModeReceiveBtn.addEventListener('click', () => setQuestionMode('generated'));

  // In custom-question mode, Intro Drill's prep countdown should start as
  // soon as the user finishes typing their question, mirrors the
  // AI-generated path's confirmGeneratedQuestion() trigger.
  // Timers no longer auto-start when the question input loses focus. The
  // user now starts prep explicitly via the "Start Timer" button next to
  // the practice mode switch (see startSelectedTimer() below).

  ['qModeChangeFromCustom','qModeChangeFromCat','qModeChangeFromPick','qModeChangeFromConfirmed'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', (e) => { e.preventDefault(); setQuestionMode(null); });
  });

  document.querySelectorAll('.q-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if(qGenBusy) return; // ignore clicks while a generation is already in flight or cooling down
      document.querySelectorAll('.q-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedCategory = btn.dataset.cat;
      if(qDifficultyCatLabel) qDifficultyCatLabel.textContent = selectedCategory.toLowerCase();
      qCategoryStep.classList.add('hidden');
      qDifficultyStep.classList.remove('hidden');
      qDifficultySlider.value = 2;
      renderDifficultyExample();
    });
  });

  document.getElementById('qRegenLink').addEventListener('click', (e) => {
    e.preventDefault();
    if(qGenBusy) return; // ignore clicks while a generation is already in flight or cooling down
    if(lastGenCategory) generateQuestions(lastGenCategory, lastGenDifficultyIdx);
  });

  // Guards against the exact failure mode that was happening: rapid/duplicate
  // clicks firing multiple overlapping generateQuestions() calls, each kicking
  // off its own up-to-9-request cascade, all stacking into the same shared
  // per-minute token budget at once. While qGenBusy is true, the category
  // buttons and "Draft 3 new questions" link are both inert.
  let qGenBusy = false;
  const Q_GEN_COOLDOWN_MS = 20000; // stay locked briefly after success/failure too

  function setQGenBusy(busy, cooldownMs){
    qGenBusy = busy;
    const btns = [...document.querySelectorAll('.q-cat-btn'), document.getElementById('qRegenLink')];
    btns.forEach(b => {
      if(!b) return;
      b.classList.toggle('is-locked', busy);
      b.style.pointerEvents = busy ? 'none' : '';
      b.style.opacity = busy ? '0.5' : '';
    });
    if(!busy && cooldownMs){
      // After a request resolves, keep the lock briefly so a quick double-tap
      // can't immediately re-trigger another cascade before the per-minute
      // window has had a chance to recover.
      qGenBusy = true;
      btns.forEach(b => { if(b){ b.style.pointerEvents = 'none'; b.style.opacity = '0.5'; } });
      setTimeout(() => setQGenBusy(false, 0), cooldownMs);
    }
  }

  // Question generation uses Gemini (Google AI Studio) with the built-in
  // Google Search grounding tool. The real Gemini key never lives in this
  // file, it's a Supabase secret, and this call goes through the
  // `gemini-generate` edge function proxy (see SUPABASE_URL below).
  const GEMINI_MODEL = 'gemini-3.7-flash';

  // Gemini calls go through the edge function's own server-side keys, 
  // there's no user-supplied override key anymore.
  function geminiKeyList(){
    return [];
  }

  async function callGeminiWithKey(prompt, apiKey, maxOutputTokens, category){
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/gemini-generate`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer '+(await getAuthToken()),
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ prompt, maxOutputTokens: maxOutputTokens||1024, overrideKey: apiKey || undefined, category })
    });
    if(res.status === 429){
      const { info, isRealQuotaBlock, fallback } = await readRateLimitInfo(res, category);
      if(window.RateLimitUI) window.RateLimitUI.refresh();
      if(isRealQuotaBlock){
        const err = new Error('rate_limited');
        err.rateLimited = true; err.category = info.category || category;
        err.count = info.currentCount ?? fallback.count; err.limit = info.usageLimit ?? fallback.limit;
        throw err;
      }
      // Not our app's own quota (see readRateLimitInfo) — most likely
      // Supabase's platform-level rate limit. Throw a plain transient
      // error (no .rateLimited flag) so this gets retried instead of
      // shown as a fake "you hit your limit" toast.
      throw new Error('platform_rate_limited:429:'+JSON.stringify(info).slice(0,200));
    }
    if(!res.ok){
      const bodyText = await res.text().catch(()=> '');
      throw new Error('gemini_failed:'+res.status+':'+bodyText.slice(0,300));
    }
    if(window.RateLimitUI) window.RateLimitUI.refresh();
    const json = await res.json();
    const candidate = json.candidates?.[0];
    if(!candidate) throw new Error('gemini_no_candidate:'+JSON.stringify(json).slice(0,200));
    return candidate;
  }

  // Tries each available override key in order, then lets the edge function
  // fall back through its own server-side keys if none are supplied/work.
  async function callGemini(prompt, maxOutputTokens, category){
    const keys = geminiKeyList();
    if(!keys.length) return await callGeminiWithKey(prompt, null, maxOutputTokens, category);
    let lastErr = null;
    for(const key of keys){
      try{
        return await callGeminiWithKey(prompt, key, maxOutputTokens, category);
      }catch(err){
        lastErr = err;
        if(err.rateLimited) throw err;
      }
    }
    throw lastErr || new Error('gemini_no_keys');
  }

  function extractQuestions(candidate){
    const raw = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if(jsonMatch) cleaned = jsonMatch[0];
    let questions = [];
    try{
      const data = JSON.parse(cleaned);
      questions = Array.isArray(data.questions)
        ? data.questions.filter(q => typeof q === 'string' && q.trim()).map(q => q.trim())
        : [];
    }catch(parseErr){
      // Response was likely truncated or had stray text around the JSON, 
      // fall back to pulling out individual quoted strings directly rather
      // than failing the whole generation.
      const strMatches = [...cleaned.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g,'"').trim());
      questions = strMatches.filter(q => q.length > 15 && q.includes('?'));
    }
    questions = questions.slice(0,3);
    if(questions.length < 3) throw new Error('q_gen_bad_output');
    return questions;
  }

  async function generateQuestions(category, difficultyIdx){
    if(qGenBusy) return;
    setQGenBusy(true);
    lastGenCategory = category;
    lastGenDifficultyIdx = (difficultyIdx === undefined || difficultyIdx === null) ? lastGenDifficultyIdx : difficultyIdx;
    qCategoryStep.classList.add('hidden');
    qDifficultyStep.classList.add('hidden');
    qPickStep.classList.add('hidden');
    qConfirmedStep.classList.add('hidden');
    qGenError.style.display = 'none';
    const difficultyLabel = (DIFFICULTY_LEVELS[lastGenDifficultyIdx] || DIFFICULTY_LEVELS[Math.floor(DIFFICULTY_LEVELS.length/2)]).label.toLowerCase();
    qGenLoadingText.textContent = `Drafting three ${difficultyLabel} ${category.toLowerCase()} questions…`;
    qGenLoading.classList.remove('hidden');
    qGenProgress.start(QGEN_PHRASES, 90);

    const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const prompt = buildQuestionGenPrompt(category, dateStr, lastGenDifficultyIdx);

    let lastErr = null;
    let questions = null;
    let searchVerified = false;

    try{
      const candidate = await callGemini(prompt, 3200, 'question_generator');
      questions = extractQuestions(candidate);
      // groundingMetadata is present when Gemini actually used Google Search;
      // use that to decide whether to show the "unverified" warning.
      const grounding = candidate.groundingMetadata;
      searchVerified = !!(grounding && (grounding.webSearchQueries?.length || grounding.groundingChunks?.length));
    }catch(err){
      console.warn('Gemini question generation failed:', err);
      lastErr = err;
    }

    try{
      if(!questions) throw lastErr || new Error('q_gen_unknown_failure');

      qGenProgress.finish();
      await new Promise(r => setTimeout(r, 260));
      qGenLoading.classList.add('hidden');
      qOptionsList.innerHTML = '';
      if(!searchVerified){
        const warn = document.createElement('div');
        warn.className = 'q-gen-warning';
        warn.style.cssText = 'background:#fff3cd;color:#7a5b00;border:1px solid #ffe08a;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:0.9em;';
        warn.textContent = '⚠️ Live web search may not have been used, so these questions could not be confirmed against this week\'s news. Double-check them against current headlines before using them, or click Regenerate to try again.';
        qOptionsList.appendChild(warn);
      }
      questions.forEach(q => {
        const card = document.createElement('div');
        card.className = 'q-option-card';
        card.textContent = q;
        card.addEventListener('click', () => confirmGeneratedQuestion(q));
        qOptionsList.appendChild(card);
      });
      qPickStep.classList.remove('hidden');
      setQGenBusy(false, Q_GEN_COOLDOWN_MS);
    }catch(err){
      console.warn('Question generation failed:', err);
      qGenProgress.stop();
      qGenLoading.classList.add('hidden');
      const wasRateLimited = /:429:/.test(err?.message || '');
      const cooldown = wasRateLimited ? 45000 : Q_GEN_COOLDOWN_MS;
      const waitNote = wasRateLimited ? ' This account is at its per-minute usage limit — please wait about 45 seconds before trying again.' : '';
      const detail = (err && err.message) ? ' ('+err.message.slice(0,200)+')' : '';
      qGenError.textContent = err?.rateLimited
        ? `You've hit today's Question Generator limit (${err.count||'?'}/${err.limit||'?'}). It resets tomorrow — check the usage button in the bottom-left corner.`
        : "Couldn't draft questions right now — check your connection and try again." + waitNote + detail;
      qGenError.style.display = 'block';
      if(selectedCategory){
        qDifficultyStep.classList.remove('hidden');
      } else {
        qCategoryStep.classList.remove('hidden');
      }
      setQGenBusy(false, cooldown);
    }
  }

  function confirmGeneratedQuestion(q){
    questionInput.value = q;
    syncRoughDraftQuestion();
    qConfirmedText.textContent = q;
    qPickStep.classList.add('hidden');
    qConfirmedStep.classList.remove('hidden');
    questionError.style.display = 'none';
    qModeError.style.display = 'none';
    questionInput.classList.remove('error');
  }

  // ===== TOURNAMENT BRIEFING =====
  // Gives someone with a tournament coming up a quick, Gemini-drafted (with
  // live Google Search grounding) rundown of recent domestic, international,
  // and economic news, plus the kinds of questions/angles likely to show up
  // at extemp that day, tuned by how soon their tournament actually is.
  // Opens in place of the Official Practice Ballot, the same way the
  // helpToggle ("?") button swaps in the example ballot.
  const briefingToggle    = document.getElementById('briefingToggle');
  const briefingBackBtn   = document.getElementById('briefingBackBtn');
  const briefingBackBtn2  = document.getElementById('briefingBackBtn2');
  const bfSetupStep       = document.getElementById('bfSetupStep');
  const bfTimingRow       = document.getElementById('bfTimingRow');
  const bfCustomRow       = document.getElementById('bfCustomRow');
  const bfCustomDate      = document.getElementById('bfCustomDate');
  const bfSetupError      = document.getElementById('bfSetupError');
  const bfGenerateBtn     = document.getElementById('bfGenerateBtn');
  const bfLoading         = document.getElementById('bfLoading');
  const bfLoadingText     = document.getElementById('bfLoadingText');
  const bfProgressFill    = document.getElementById('bfProgressFill');
  const bfProgressPhrase  = document.getElementById('bfProgressPhrase');
  const bfError           = document.getElementById('bfError');
  const bfResultStep      = document.getElementById('bfResultStep');
  const bfVerifiedWrap    = document.getElementById('bfVerifiedWrap');
  const bfResultContent   = document.getElementById('bfResultContent');
  const bfRegenBtn        = document.getElementById('bfRegenBtn');

  const bfProgress = createProgressController(bfProgressFill, bfProgressPhrase);
  const BF_PHRASES = DATA.BF_PHRASES;

  let bfTiming = null; // 'today' | 'tomorrow' | 'custom'
  let bfBusy = false;
  let briefingOpen = false;
  let lastBriefingRaw = '';

  function closeBriefingView(){
    briefingOpen = false;
    briefingToggle.classList.remove('active');
    showView(viewBeforeBriefing || viewRecord);
  }
  briefingToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(briefingOpen){
      closeBriefingView();
      return;
    }
    if(typeof settingsOpen !== 'undefined' && settingsOpen){
      settingsOpen = false;
      settingsPanel.classList.add('hidden');
      settingsToggle.classList.remove('active');
    }
    if(typeof timerOpen !== 'undefined' && timerOpen){
      timerOpen = false;
      timerPanel.classList.add('hidden');
      timerToggle.classList.remove('active');
    }
    if(typeof exampleOpen !== 'undefined' && exampleOpen){
      exampleOpen = false;
      helpToggle.classList.remove('active');
    }
    briefingOpen = true;
    briefingToggle.classList.add('active');
    viewBeforeBriefing = [viewRecord, viewReview, viewProcessing, viewResults].find(v => !v.classList.contains('hidden')) || viewRecord;
    showView(viewBriefing);
  });
  briefingBackBtn.addEventListener('click', closeBriefingView);
  briefingBackBtn2.addEventListener('click', closeBriefingView);

  bfTimingRow.querySelectorAll('.bf-timing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bfTimingRow.querySelectorAll('.bf-timing-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bfTiming = btn.dataset.timing;
      bfCustomRow.classList.toggle('show', bfTiming === 'custom');
      bfSetupError.style.display = 'none';
    });
  });

  // Turns the chosen timing into a plain-language description for the prompt,
  // e.g. "in a few hours (today)" or "on Saturday, July 4, 2026".
  function describeBriefingTiming(){
    const now = new Date();
    if(bfTiming === 'today'){
      return `in a few hours, later today (${now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })})`;
    }
    if(bfTiming === 'tomorrow'){
      const t = new Date(now.getTime() + 24*60*60*1000);
      return `tomorrow (${t.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })})`;
    }
    if(bfTiming === 'custom' && bfCustomDate.value){
      const d = new Date(bfCustomDate.value);
      if(!isNaN(d.getTime())){
        return `on ${d.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`;
      }
    }
    return 'soon';
  }

  function buildBriefingPrompt(){
    const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const timingDesc = describeBriefingTiming();
    return `You are prepping a competitive NSDA extemp speaker whose tournament is ${timingDesc}. Today is ${dateStr}.
Use Google Search to find real, current news. Follow this recency rule strictly:
- Prefer stories from THIS WEEK or the past month — these are the safest and most likely to be asked about.
- A story from 1-3 months ago is only acceptable if it is STILL actively developing, with a genuinely NEW update, ruling, escalation, or turn of events within roughly the last 1-2 weeks (e.g. an ongoing conflict, a court case still working through appeals, a policy fight still unresolved). If you include one of these, the bullet must describe the recent update itself, not just the original story.
- Do not include anything older than 3 months, and do not include anything stale that hasn't had real movement recently, even if it's within 3 months.
Write a brief but comprehensive briefing in exactly this plain-text structure (use these exact "## " headers, nothing before the first header):

## Domestic
5-6 bullet points ("- ") on the most important U.S. domestic stories, following the recency rule above (politics, policy, courts, elections, economy-adjacent domestic news). Each bullet MUST start with a short name/label for the story followed by a colon, like "- Government Shutdown Fight: description here." The description itself should be written the way an extemper would frame it for research: name the key actors, the core tension or disagreement, and the current state of play — not just a headline restatement. Within the description, wrap the 2-4 most important key terms, names, or facts (the ones a speaker would most want to remember) in double asterisks like **this** so they stand out.

## International
5-6 bullet points, same "Label: description" format with key terms wrapped in ** **, on the most important world/foreign-policy stories, following the recency rule above.

## Economic
5-6 bullet points, same "Label: description" format with key terms wrapped in ** **, on the most important economic/business/markets stories, following the recency rule above (Fed, inflation, trade, major companies, labor market, etc).

## What to Expect at Your Tournament
5-6 bullet points, same "Label: description" format with key terms wrapped in ** **, where the label is the SPECIFIC topic from above most likely to become an actual extemp question, and the description is phrased as an extemp-style analytical/predictive question stem (e.g. "Will X policy survive its court challenge?", "How will Y election reshape Z?", "Can A country manage B crisis?"). Be concrete and resolutional in tone, not generic.

Formatting rules: plain text only, with the sole exception of wrapping key terms in "**double asterisks**" as instructed above — do not bold the label itself, do not use any other markdown, no numbered lists, no intro or closing remarks, no text before "## Domestic" or after the last bullet. Keep the whole thing tight enough to read in under 4-5 minutes.`;
  }

  // Very small, purpose-built markdown-ish renderer for the specific
  // "## Header" / "- Label: description with **key terms**" shape we asked
  // Gemini to produce. Not a general markdown parser, just enough to make
  // the briefing readable: the label becomes a bolded link to a Google
  // search for that topic, and any "**...**" spans in the description
  // become bolded key terms (asterisks never shown literally).
  function boldInlineMd(escapedText){
    return escapedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  function googleSearchLink(topic){
    return 'https://www.google.com/search?q=' + encodeURIComponent(topic);
  }
  function renderBriefingText(raw){
    const lines = raw.replace(/\r\n/g,'\n').split('\n');
    let html = '';
    let inList = false;
    function closeList(){ if(inList){ html += '</ul>'; inList = false; } }
    function formatBullet(text){
      // Pull out a leading "Label:" (optionally wrapped in stray asterisks)
      // and turn it into a bolded link to a Google search for that topic.
      const labelMatch = text.match(/^\*{0,2}([^*:]{2,80}?)\*{0,2}:\s*([\s\S]*)$/);
      if(labelMatch){
        const label = labelMatch[1].trim();
        const rest = labelMatch[2].trim();
        const link = googleSearchLink(label);
        return `<a href="${link}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(label)}</strong></a>: ${boldInlineMd(escapeHtml(rest))}`;
      }
      return boldInlineMd(escapeHtml(text));
    }
    for(let line of lines){
      line = line.trim();
      if(!line) continue;
      const headerMatch = line.match(/^#{1,3}\s+(.*)$/);
      if(headerMatch){
        closeList();
        html += `<h4>${escapeHtml(headerMatch[1])}</h4>`;
        continue;
      }
      const bulletMatch = line.match(/^[-•*]\s+(.*)$/);
      if(bulletMatch){
        if(!inList){ html += '<ul>'; inList = true; }
        html += `<li>${formatBullet(bulletMatch[1])}</li>`;
        continue;
      }
      closeList();
      html += `<p>${formatBullet(line)}</p>`;
    }
    closeList();
    return html;
  }
  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function setBriefingBusy(busy){
    bfBusy = busy;
    bfGenerateBtn.disabled = busy;
    bfRegenBtn.disabled = busy;
  }

  async function generateBriefing(){
    if(bfBusy) return;
    if(!bfTiming){
      bfSetupError.style.display = 'block';
      return;
    }
    if(bfTiming === 'custom' && !bfCustomDate.value){
      bfSetupError.textContent = 'Please pick a date for your tournament.';
      bfSetupError.style.display = 'block';
      return;
    }
    bfSetupError.style.display = 'none';
    setBriefingBusy(true);
    bfSetupStep.classList.add('hidden');
    bfResultStep.classList.add('hidden');
    bfError.style.display = 'none';
    bfLoadingText.textContent = 'Pulling together your briefing…';
    bfLoading.classList.remove('hidden');
    bfProgress.start(BF_PHRASES, 92);

    const prompt = buildBriefingPrompt();
    try{
      const candidate = await callGemini(prompt, 2400, 'current_events');
      const raw = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
      if(!raw) throw new Error('bf_empty_response');
      const grounding = candidate.groundingMetadata;
      const searchVerified = !!(grounding && (grounding.webSearchQueries?.length || grounding.groundingChunks?.length));

      bfProgress.finish();
      await new Promise(r => setTimeout(r, 220));
      bfLoading.classList.add('hidden');

      bfVerifiedWrap.innerHTML = '';
      if(!searchVerified){
        const warn = document.createElement('div');
        warn.className = 'bf-warning';
        warn.textContent = "⚠️ Live web search may not have been used, so this briefing could not be confirmed against current headlines. Double-check the details below before relying on them, or click Regenerate to try again.";
        bfVerifiedWrap.appendChild(warn);
      }
      bfResultContent.innerHTML = renderBriefingText(raw);
      lastBriefingRaw = raw;
      bfResultStep.classList.remove('hidden');
      setBriefingBusy(false);
    }catch(err){
      console.warn('Tournament briefing failed:', err);
      bfProgress.stop();
      bfLoading.classList.add('hidden');
      const wasRateLimited = /:429:/.test(err?.message || '');
      const waitNote = wasRateLimited ? ' This account is at its per-minute usage limit — please wait about 45 seconds before trying again.' : '';
      const detail = (err && err.message) ? ' ('+err.message.slice(0,200)+')' : '';
      bfError.textContent = err?.rateLimited
        ? `You've hit today's Current Events limit (${err.count||'?'}/${err.limit||'?'}). It resets tomorrow — check the usage button in the bottom-left corner.`
        : "Couldn't put together a briefing right now — check your connection and try again." + waitNote + detail;
      bfError.style.display = 'block';
      bfSetupStep.classList.remove('hidden');
      setBriefingBusy(false);
    }
  }

  bfGenerateBtn.addEventListener('click', generateBriefing);
  bfRegenBtn.addEventListener('click', () => {
    bfResultStep.classList.add('hidden');
    bfSetupStep.classList.remove('hidden');
    bfError.style.display = 'none';
  });

  // ===== CITATION CHECKER =====
  // Verifies a specific claim-and-source pair (e.g. "On May 23rd, 2026,
  // Trump said inflation went down 25%, according to CNN") using Gemini +
  // live Google Search grounding, the same edge-function-backed
  // callGemini() used by question generation and the tournament briefing
  // above. Opens in place of the Official Practice Ballot, the same way
  // helpToggle/briefingToggle do.
  const citationToggle    = document.getElementById('citationToggle');
  const citationBackBtn   = document.getElementById('citationBackBtn');
  const citationBackBtn2  = document.getElementById('citationBackBtn2');
  const ccSetupStep       = document.getElementById('ccSetupStep');
  const ccClaimInput      = document.getElementById('ccClaimInput');
  const ccDateInput       = document.getElementById('ccDateInput');
  const ccSourceInput     = document.getElementById('ccSourceInput');
  const ccClaimError      = document.getElementById('ccClaimError');
  const ccDateError       = document.getElementById('ccDateError');
  const ccSourceError     = document.getElementById('ccSourceError');
  const ccCheckBtn        = document.getElementById('ccCheckBtn');
  const ccLoading         = document.getElementById('ccLoading');
  const ccLoadingText     = document.getElementById('ccLoadingText');
  const ccProgressFill    = document.getElementById('ccProgressFill');
  const ccProgressPhrase  = document.getElementById('ccProgressPhrase');
  const ccError           = document.getElementById('ccError');
  const ccResultStep      = document.getElementById('ccResultStep');
  const ccVerdictStamp    = document.getElementById('ccVerdictStamp');
  const ccVerdictNum      = document.getElementById('ccVerdictNum');
  const ccClaimRecap      = document.getElementById('ccClaimRecap');
  const ccExplanation     = document.getElementById('ccExplanation');
  const ccSourceLink      = document.getElementById('ccSourceLink');
  const ccCheckAnotherBtn = document.getElementById('ccCheckAnotherBtn');

  const ccProgress = createProgressController(ccProgressFill, ccProgressPhrase);
  const CC_PHRASES = DATA.CC_PHRASES;

  let ccBusy = false;
  let citationOpen = false;
  let viewBeforeCitation = null;

  function closeCitationView(){
    citationOpen = false;
    citationToggle.classList.remove('active');
    showView(viewBeforeCitation || viewRecord);
  }
  citationToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(citationOpen){
      closeCitationView();
      return;
    }
    if(typeof settingsOpen !== 'undefined' && settingsOpen){
      settingsOpen = false;
      settingsPanel.classList.add('hidden');
      settingsToggle.classList.remove('active');
    }
    if(typeof timerOpen !== 'undefined' && timerOpen){
      timerOpen = false;
      timerPanel.classList.add('hidden');
      timerToggle.classList.remove('active');
    }
    if(typeof exampleOpen !== 'undefined' && exampleOpen){
      exampleOpen = false;
      document.getElementById('helpToggle')?.classList.remove('active');
    }
    if(typeof briefingOpen !== 'undefined' && briefingOpen){
      briefingOpen = false;
      briefingToggle.classList.remove('active');
    }
    citationOpen = true;
    citationToggle.classList.add('active');
    viewBeforeCitation = [viewRecord, viewReview, viewProcessing, viewResults].find(v => !v.classList.contains('hidden')) || viewRecord;
    showView(viewCitation);
  });
  citationBackBtn.addEventListener('click', closeCitationView);
  citationBackBtn2.addEventListener('click', closeCitationView);

  function buildCitationPrompt(claim, date, source){
    const hasWildcard = date.includes('?');
    const dateNote = hasWildcard
      ? `The speaker is unsure of part of the date and has marked the unknown digits with "?" — treat this as a range/approximation (e.g. "06/??/2025" means "sometime in June 2025") rather than a literal string.`
      : `Treat this as the exact date being claimed.`;
    return `You are a rigorous fact-checker helping a competitive extemp speaker verify a citation before they use it in a speech.

CLAIM (as the speaker plans to say it): "${claim}"
DATE ATTRIBUTED TO THIS CLAIM: "${date}" — ${dateNote}
CITED SOURCE: "${source}"

Use Google Search to determine whether ${source} actually reported or said this, at or around the date given. Search specifically for coverage from ${source} (or reliable reporting ABOUT what ${source} said/reported) that matches the claim's substance and date.

Respond with ONLY this exact JSON shape, nothing else — no markdown fences, no text before or after:
{"verdict":"true","explanation":"2-3 sentence explanation of exactly what you found and why the claim does or doesn't check out","sourceUrl":"the single best URL that supports your verdict, or an empty string if none was found","sourceTitle":"a short title or description of that source page, or an empty string"}

Grading rules:
- "verdict":"true" ONLY if you found a real source — ideally the cited outlet itself, or credible reporting confirming it — that matches the claim's substance AND is consistent with the stated date (within a few days is fine; a flatly wrong date should count against it).
- "verdict":"false" if you found reporting that contradicts the claim, or found what the source actually said/reported and it does not match what's being attributed to it here.
- "verdict":"unverified" if you could not find enough information via search to confirm or deny it either way — never guess.
- Never fabricate a URL — only include sourceUrl if it's a real link you found via search, and leave it as an empty string otherwise.`;
  }

  // Parses Gemini's JSON verdict, and, critically, never trusts a
  // model-typed URL at face value: it's only shown to the user if it
  // actually matches one of the real links Google Search grounding
  // surfaced for this request (candidate.groundingMetadata.groundingChunks).
  function extractCitationVerdict(candidate){
    const raw = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if(jsonMatch) cleaned = jsonMatch[0];
    let data;
    try{
      data = JSON.parse(cleaned);
    }catch(e){
      throw new Error('cc_bad_output');
    }
    const verdict = ['true','false','unverified'].includes(data.verdict) ? data.verdict : 'unverified';
    let sourceUrl = typeof data.sourceUrl === 'string' ? data.sourceUrl.trim() : '';
    const groundedUrls = (candidate.groundingMetadata?.groundingChunks || [])
      .map(c => c?.web?.uri).filter(Boolean);
    if(sourceUrl && !groundedUrls.some(u => u === sourceUrl || u.includes(sourceUrl) || sourceUrl.includes(u))){
      sourceUrl = groundedUrls[0] || '';
    }else if(!sourceUrl && groundedUrls.length){
      sourceUrl = groundedUrls[0];
    }
    return {
      verdict,
      explanation: typeof data.explanation === 'string' ? data.explanation.trim() : '',
      sourceUrl,
      sourceTitle: typeof data.sourceTitle === 'string' ? data.sourceTitle.trim() : ''
    };
  }

  // ===== POST-BALLOT FACT-CHECK PASS =====
  // The judging model is now explicitly told NOT to verify evidence (see
  // EVIDENCE_TRUTH_ASSUMPTION_NOTE below) — it assumes every citation is
  // true and grades citation PRACTICE only. This independent pass covers
  // the actual truth-checking afterward, via Gemini + Google Search
  // grounding, the same way the Citation Checker tool does. It never
  // blocks or changes the ballot's score — it's purely informational and
  // rendered in its own clearly-labeled section.
  function buildFactCheckPrompt(transcript){
    return `You are a rigorous, neutral fact-checker reviewing every piece of evidence used in a competitive speech transcript.

TRANSCRIPT:

${transcript}

TASK: Find EVERY SINGLE fact, statistic, quote, or piece of evidence in this transcript that is attributed to a specific outside source — do not skip any, and do not limit yourself to only the "most significant" ones. Competitive extemp speakers cite constantly and formulaically, almost always in a pattern like "According to [source] on [date]..." or "[Source] tells/reports/found us that..." or "an article from [source] from/on [date]...". Scan the ENTIRE transcript from start to finish and pull out every one of these citation instances — each source+date+claim combination is its own separate entry, even if the same publication is cited multiple times at different points for different claims. A transcript with many citations should produce many entries; do not artificially cap yourself. Only skip a claim if it is a generic, unattributed statement of opinion or analysis with no source or date attached at all.

For each citation instance you find, use Google Search to verify whether it checks out: does that source exist, did it actually report/say what's attributed to it, and is the date consistent with reality?

Respond with ONLY this exact JSON shape, nothing else — no markdown fences, no text before or after:
{"claims":[{"claim":"a short paraphrase of the claim as stated (under 25 words)","source":"the source AND date named together, e.g. \\"The Washington Post, April 3, 2019\\" — or \\"(no source given)\\" if truly none was cited","verdict":"true","explanation":"1-2 sentence explanation of what you found","sourceUrl":"a real URL you found via search that supports your verdict, or an empty string"}]}

Grading rules per claim:
- "verdict":"true" only if you found real, matching supporting evidence for the claim's substance (and, where checkable, the date roughly lines up).
- "verdict":"false" if you found reporting that contradicts the claim, found that the source's actual reporting doesn't match what's attributed to it here, or the cited date is inconsistent with when that event/report actually happened.
- "verdict":"unverified" if you couldn't confirm it either way via search — never guess.
- Never fabricate a URL — only include sourceUrl if it's a real link you found via search.
- If the transcript contains no checkable, sourced claims at all, return {"claims":[]}.`;
  }

  function extractFactCheckClaims(candidate){
    const raw = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if(jsonMatch) cleaned = jsonMatch[0];
    let data;
    try{
      data = JSON.parse(cleaned);
    }catch(e){
      throw new Error('factcheck_bad_output');
    }
    const groundedUrls = (candidate.groundingMetadata?.groundingChunks || [])
      .map(c => c?.web?.uri).filter(Boolean);
    const claims = Array.isArray(data.claims) ? data.claims : [];
    // Speeches can legitimately cite a couple dozen distinct sources —
    // this used to cap at 10 (and the prompt itself said "up to 8 most
    // significant"), which silently dropped citations instead of
    // covering every one made in the speech. 40 is just a sanity
    // ceiling against a runaway/malformed response, not a real target.
    return claims.slice(0, 40).map(c => {
      const verdict = ['true','false','unverified'].includes(c.verdict) ? c.verdict : 'unverified';
      let sourceUrl = typeof c.sourceUrl === 'string' ? c.sourceUrl.trim() : '';
      if(sourceUrl && !groundedUrls.some(u => u === sourceUrl || u.includes(sourceUrl) || sourceUrl.includes(u))){
        sourceUrl = '';
      }
      return {
        claim: typeof c.claim === 'string' ? c.claim.trim() : '',
        source: typeof c.source === 'string' ? c.source.trim() : '',
        verdict,
        explanation: typeof c.explanation === 'string' ? c.explanation.trim() : '',
        sourceUrl
      };
    }).filter(c => c.claim);
  }

  // Never blocks or fails the ballot's score. Unlike the first version of
  // this, it does NOT swallow failures silently — it returns a tagged
  // result so buildFactCheckHtml can always render *something* (success
  // with claims, success with none found, or a visible "this failed"
  // note) instead of the section just quietly not appearing, which made
  // failures indistinguishable from "nothing to check."
  //
  // Retries added after a live failure surfaced a Supabase Edge Function
  // error — "gemini_failed:546:...WORKER_RESOURCE_LIMIT...Function
  // failed due to not having enough compute resources" — that was being
  // shown to the user as a permanent, one-shot failure. A 546/compute-
  // resource error is a transient infrastructure hiccup on Supabase's
  // side (the function's container ran out of resources for that one
  // invocation), not a real problem with the transcript or a genuine
  // quota block — callGemini() made exactly one attempt with no retry at
  // all, since geminiKeyList() always returns [] now (server-side keys
  // only), so any transient failure was immediately fatal. This retries
  // up to 3 times with a short backoff before giving up, and still gives
  // up immediately on a real rate-limit (retrying that would just waste
  // the user's daily cap allowance for nothing).
  async function runFactCheckPass(transcript){
    if(!transcript || !transcript.trim()) return { claims: [], failed: false };
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      try{
        // Raised from 2600 — a speech with 15-20+ citations (typical for a
        // dense extemp round) needs real room for that many full
        // claim/source/explanation entries in the JSON output without
        // getting truncated mid-response.
        const candidate = await callGemini(buildFactCheckPrompt(transcript), 6000, 'citation_checker');
        return { claims: extractFactCheckClaims(candidate), failed: false };
      }catch(e){
        lastErr = e;
        if(e && e.rateLimited) break; // real daily-cap block — retrying can't help, and would just burn more of the user's quota
        if(attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    const reason = (lastErr && lastErr.rateLimited) ? 'daily fact-check limit reached'
      : (lastErr && lastErr.message) ? String(lastErr.message).slice(0, 160)
      : 'unknown error';
    console.warn('Post-ballot fact-check pass failed after retries (non-blocking):', lastErr);
    return { claims: [], failed: true, reason };
  }

  function escFactCheckHtml(s){
    return String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // Accepts either the current shape ({claims, failed, reason}) or the
  // plain array shape used by the very first version of this feature, so
  // older saved history entries still render correctly.
  function buildFactCheckHtml(factCheck){
    if(!factCheck) return '';
    const normalized = Array.isArray(factCheck) ? { claims: factCheck, failed: false } : factCheck;
    const claims = normalized.claims || [];
    const wrap = (bodyHtml) => `
      <div class="drill" style="margin-top:24px;border-style:solid;">
        <span class="tag" style="font-size:16px;font-weight:800;">Fact Check</span>
        ${bodyHtml}
      </div>`;
    if(normalized.failed){
      return wrap(`<p style="font-size:13px;color:var(--slate);margin:12px 0 0;">This automated check couldn't complete for this round${normalized.reason ? ` (${escFactCheckHtml(normalized.reason)})` : ''} — your score above is unaffected. Try again on your next round.</p>`);
    }
    if(!claims.length){
      return wrap(`<p style="font-size:13px;color:var(--slate);margin:12px 0 0;">No independently checkable, attributed claims (a specific stat or quote tied to a named source) were detected in this transcript.</p>`);
    }
    const verdictLabel = v => v === 'true' ? 'TRUE' : v === 'false' ? 'FALSE' : 'UNVERIFIED';
    const rows = claims.map(c => {
      // Prefer turning the "Cited source: ..." line itself into the link
      // when we have a real URL; only fall back to a separate raw-link
      // line if for some reason there's a URL but no source name to attach it to.
      const sourceLine = c.source
        ? (c.sourceUrl
            ? `<div style="font-size:12px;color:var(--slate);margin-bottom:4px;"><b>Cited source:</b> <a href="${escFactCheckHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escFactCheckHtml(c.source)}</a></div>`
            : `<div style="font-size:12px;color:var(--slate);margin-bottom:4px;"><b>Cited source:</b> ${escFactCheckHtml(c.source)}</div>`)
        : (c.sourceUrl
            ? `<div style="font-size:12px;color:var(--slate);margin-bottom:4px;"><b>Source:</b> <a href="${escFactCheckHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escFactCheckHtml(c.sourceUrl)}</a></div>`
            : '');
      return `
      <div class="cat-row" style="border-left:3px solid var(--rule);padding:10px 12px;margin-bottom:10px;margin-top:12px;background:rgba(0,0,0,0.02);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
          <span class="cc-verdict-stamp ${c.verdict}" style="padding:4px 12px;display:inline-block;">
            <span class="num" style="font-size:13px;">${verdictLabel(c.verdict)}</span>
          </span>
          <strong style="font-size:13px;">${escFactCheckHtml(c.claim)}</strong>
        </div>
        ${sourceLine}
        ${c.explanation ? `<div style="font-size:13px;line-height:1.5;">${escFactCheckHtml(c.explanation)}</div>` : ''}
      </div>`;
    }).join('');
    return wrap(rows);
  }

  function setCcBusy(busy){
    ccBusy = busy;
    ccCheckBtn.disabled = busy;
    if(ccCheckAnotherBtn) ccCheckAnotherBtn.disabled = busy;
  }

  async function checkCitation(){
    if(ccBusy) return;
    const claim = ccClaimInput.value.trim();
    const date = ccDateInput.value.trim();
    const source = ccSourceInput.value.trim();
    const datePattern = /^[0-9?]{2}\/[0-9?]{2}\/[0-9?]{4}$/;
    let hasError = false;
    ccClaimInput.classList.remove('error'); ccClaimError.style.display = 'none';
    ccDateInput.classList.remove('error'); ccDateError.style.display = 'none';
    ccSourceInput.classList.remove('error'); ccSourceError.style.display = 'none';
    if(!claim){ ccClaimInput.classList.add('error'); ccClaimError.style.display = 'block'; hasError = true; }
    if(!date || !datePattern.test(date)){ ccDateInput.classList.add('error'); ccDateError.style.display = 'block'; hasError = true; }
    if(!source){ ccSourceInput.classList.add('error'); ccSourceError.style.display = 'block'; hasError = true; }
    if(hasError) return;

    setCcBusy(true);
    ccSetupStep.classList.add('hidden');
    ccResultStep.classList.add('hidden');
    ccError.style.display = 'none';
    ccLoadingText.textContent = 'Searching the web to verify this citation…';
    ccLoading.classList.remove('hidden');
    ccProgress.start(CC_PHRASES, 92);

    const prompt = buildCitationPrompt(claim, date, source);
    try{
      const candidate = await callGemini(prompt, 700, 'citation_checker');
      const result = extractCitationVerdict(candidate);

      ccProgress.finish();
      await new Promise(r => setTimeout(r, 220));
      ccLoading.classList.add('hidden');

      ccVerdictStamp.className = 'cc-verdict-stamp ' + result.verdict;
      ccVerdictNum.textContent = result.verdict === 'true' ? 'TRUE' : result.verdict === 'false' ? 'FALSE' : 'UNVERIFIED';
      ccClaimRecap.innerHTML = `<b>Claim:</b> ${escapeHtml(claim)}<br><b>Date:</b> ${escapeHtml(date)}<br><b>Source:</b> ${escapeHtml(source)}`;
      ccExplanation.textContent = result.explanation || (result.verdict === 'unverified' ? "Couldn't confirm this either way from what's publicly searchable." : '');
      if(result.verdict === 'true' && result.sourceUrl){
        ccSourceLink.innerHTML = `Source: <a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.sourceTitle || result.sourceUrl)}</a>`;
      }else if(result.verdict === 'true'){
        ccSourceLink.innerHTML = `<span class="q-hint">Confirmed, but no direct link was found via search.</span>`;
      }else{
        ccSourceLink.innerHTML = '';
      }
      ccResultStep.classList.remove('hidden');
      setCcBusy(false);
    }catch(err){
      console.warn('Citation check failed:', err);
      ccProgress.stop();
      ccLoading.classList.add('hidden');
      const wasRateLimited = /:429:/.test(err?.message || '');
      const waitNote = wasRateLimited ? ' This account is at its per-minute usage limit — please wait about 45 seconds before trying again.' : '';
      const detail = (err && err.message) ? ' ('+err.message.slice(0,200)+')' : '';
      ccError.textContent = err?.rateLimited
        ? `You've hit today's Citation Checker limit (${err.count||'?'}/${err.limit||'?'}). It resets tomorrow — check the usage button in the bottom-left corner.`
        : "Couldn't check that citation right now — check your connection and try again." + waitNote + detail;
      ccError.style.display = 'block';
      ccSetupStep.classList.remove('hidden');
      setCcBusy(false);
    }
  }

  ccCheckBtn.addEventListener('click', checkCitation);
  ccCheckAnotherBtn.addEventListener('click', () => {
    ccResultStep.classList.add('hidden');
    ccClaimInput.value = '';
    ccDateInput.value = '';
    ccSourceInput.value = '';
    ccSetupStep.classList.remove('hidden');
    ccError.style.display = 'none';
  });

  // Turns the raw "## Header" / "- Label: **key** term" text into clean,
  // asterisk-free plain text for copying or printing to PDF.
  function formatBriefingPlainText(raw){
    const lines = String(raw||'').replace(/\r\n/g,'\n').split('\n');
    let out = [];
    for(let line of lines){
      line = line.trim();
      if(!line){ out.push(''); continue; }
      const headerMatch = line.match(/^#{1,3}\s+(.*)$/);
      if(headerMatch){ out.push(headerMatch[1].toUpperCase()); continue; }
      const bulletMatch = line.match(/^[-•*]\s+(.*)$/);
      const text = bulletMatch ? bulletMatch[1] : line;
      const clean = text.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1');
      out.push(bulletMatch ? ('• ' + clean) : clean);
    }
    return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }

  const bfCopyBtn = document.getElementById('bfCopyBtn');
  const bfPdfBtn  = document.getElementById('bfPdfBtn');

  bfCopyBtn.addEventListener('click', async () => {
    if(!lastBriefingRaw) return;
    const text = formatBriefingPlainText(lastBriefingRaw);
    try{
      await navigator.clipboard.writeText(text);
      showToast('Briefing copied to clipboard');
    }catch(e){
      // Clipboard API can be blocked (e.g. non-HTTPS or embedded preview), 
      // fall back to a temporary textarea + execCommand copy.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try{ document.execCommand('copy'); showToast('Briefing copied to clipboard'); }
      catch(e2){ alert("Couldn't copy automatically — please select and copy the text manually."); }
      document.body.removeChild(ta);
    }
  });

  bfPdfBtn.addEventListener('click', () => {
    if(!lastBriefingRaw) return;
    if(!window.jspdf || !window.jspdf.jsPDF){
      alert("Couldn't load the PDF library — check your internet connection and try again, or use Copy Transcript instead.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'pt', format:'letter' });
    const marginX = 54, marginTop = 56, marginBottom = 56;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - marginX*2;
    let y = marginTop;
    function ensureSpace(lineHeight){
      if(y + lineHeight > pageHeight - marginBottom){ doc.addPage(); y = marginTop; }
    }
    function addHeading(text, size){
      doc.setFont('helvetica','bold'); doc.setFontSize(size);
      ensureSpace(size + 10);
      doc.text(text, marginX, y);
      y += size + 10;
      doc.setFont('helvetica','normal');
    }
    function addParagraph(text, size, lineGap){
      doc.setFontSize(size);
      const wrapped = doc.splitTextToSize(text, usableWidth);
      wrapped.forEach(line=>{
        ensureSpace(lineGap);
        doc.text(line, marginX, y);
        y += lineGap;
      });
    }
    function addRule(){
      ensureSpace(14);
      doc.setDrawColor(180,170,140);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 14;
    }
    const plainLines = formatBriefingPlainText(lastBriefingRaw).split('\n');
    addHeading('EXTEMPLARY — TOURNAMENT BRIEFING', 16);
    addParagraph('Generated ' + new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' }), 10, 14);
    y += 6;
    addRule();
    plainLines.forEach(line=>{
      if(!line){ y += 6; return; }
      const isHeader = line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 60 && !line.startsWith('•');
      if(isHeader){ addHeading(line, 13); }
      else{ addParagraph(line, 10, 13.5); }
    });
    doc.save('extemp-tournament-briefing.pdf');
    showToast('Briefing PDF downloaded');
  });

  function requireQuestion(){
    const q = questionInput.value.trim();
    if(!q){
      if(questionMode === 'generated'){
        qGenError.textContent = 'Please choose one of the generated questions before recording.';
        qGenError.style.display = 'block';
      }else if(questionMode === 'custom'){
        questionError.style.display = 'block';
        questionInput.classList.add('error');
        questionInput.focus();
      }else{
        qModeError.style.display = 'block';
      }
      return null;
    }
    questionError.style.display = 'none';
    qModeError.style.display = 'none';
    questionInput.classList.remove('error');
    if(youtubeQuestionError) youtubeQuestionError.style.display = 'none';
    if(recordQuestionError) recordQuestionError.style.display = 'none';
    return q;
  }

  uploadVideoBtn.addEventListener('click', () => {
    uploadError.classList.add('hidden');
    const q = requireQuestion(); // same required-question check as recording
    if(!q) return;
    uploadVideoInput.click();
  });

  function closeIntroPrepIfOpen(){
    if(!introDrillMode && !bodyDrillMode && regularPrepModal && !regularPrepModal.classList.contains('hidden')){
      clearInterval(regularPrepInterval);
      clearInterval(regularPrepPhraseTimer);
      regularPrepRunning = false;
      regularPrepModal.classList.add('hidden');
    }
    if(introDrillMode && introPrepModal && !introPrepModal.classList.contains('hidden')){
      clearInterval(introPrepInterval);
      clearInterval(introPrepPhraseTimer);
      introPrepRunning = false;
      introPrepModal.classList.add('hidden');
    }
    if(bodyDrillMode && bodyPrepModal && !bodyPrepModal.classList.contains('hidden')){
      clearInterval(bodyPrepInterval);
      clearInterval(bodyPrepPhraseTimer);
      bodyPrepRunning = false;
      bodyPrepModal.classList.add('hidden');
    }
  }

  uploadVideoInput.addEventListener('change', () => {
    const file = uploadVideoInput.files && uploadVideoInput.files[0];
    uploadVideoInput.value = ''; // allow re-selecting the same file later
    if(!file) return;
    const q = requireQuestion();
    if(!q) return;
    closeIntroPrepIfOpen();
    if(!file.type.startsWith('video/')){
      uploadError.textContent = 'That file doesn\'t look like a video — please choose a video file (mp4, mov, webm, etc).';
      uploadError.classList.remove('hidden');
      return;
    }
    uploadError.classList.add('hidden');
    lastQuestion = q;
    recordedBlob = file;
    captureMode = 'upload';
    recordedMime = file.type || 'video/mp4';
    reviewVideo.src = URL.createObjectURL(recordedBlob);
    showView(viewReview);
  });

  // ===== CAPTURE A YOUTUBE VIDEO (via tab/screen share, no scraping/downloading) =====
  const youtubeUrlInput   = document.getElementById('youtubeUrl');
  const captureYoutubeBtn = document.getElementById('captureYoutubeBtn');
  const youtubePopover    = document.getElementById('youtubePopover');
  const youtubeGoBtn      = document.getElementById('youtubeGoBtn');
  const youtubeQuestionError = document.getElementById('youtubeQuestionError');
  const recordQuestionError  = document.getElementById('recordQuestionError');
  const captureError      = document.getElementById('captureError');
  const captureStatus     = document.getElementById('captureStatus');
  const stopCaptureBtn    = document.getElementById('stopCaptureBtn');

  if(youtubePopover && youtubePopover.parentElement !== document.body){
    document.body.appendChild(youtubePopover);
  }
  function positionYoutubePopover(){
    const width = Math.min(320, window.innerWidth - 24);
    youtubePopover.style.width = width + 'px';
    youtubePopover.style.left = '50%';
    youtubePopover.style.right = 'auto';
    youtubePopover.style.top = '50%';
    youtubePopover.style.transform = 'translate(-50%, -50%)';
  }
  let youtubePopoverOpen = false;
  function closeYoutubePopover(){
    youtubePopoverOpen = false;
    youtubePopover.classList.add('hidden');
  }
  captureYoutubeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    youtubePopoverOpen = !youtubePopoverOpen;
    if(youtubePopoverOpen){
      positionYoutubePopover();
      youtubeUrlInput.focus();
    }
    youtubePopover.classList.toggle('hidden', !youtubePopoverOpen);
  });
  document.addEventListener('click', (e) => {
    if(suppressPanelClose) return;
    if(youtubePopoverOpen && !e.target.closest('#youtubePopover') && !e.target.closest('#captureYoutubeBtn')){
      closeYoutubePopover();
    }
  });
  window.addEventListener('resize', () => { if(youtubePopoverOpen) positionYoutubePopover(); });
  window.addEventListener('scroll', () => { if(youtubePopoverOpen) positionYoutubePopover(); }, true);
  youtubeUrlInput.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); youtubeGoBtn.click(); }
  });

  function revertToCamera(){
    if(captureStream){
      captureStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} });
      captureStream = null;
    }
    captureMode = 'camera';
    if(cameraStream){
      stream = cameraStream;
      liveVideo.srcObject = cameraStream;
      recBtn.disabled = false;
    }else{
      stream = null;
      recBtn.disabled = true;
    }
    captureStatus.classList.add('hidden');
  }

  youtubeGoBtn.addEventListener('click', async () => {
    captureError.classList.add('hidden');
    const q = requireQuestion(); // same required-question check as recording
    if(!q){ youtubeQuestionError.style.display = 'block'; return; }
    youtubeQuestionError.style.display = 'none';

    const url = youtubeUrlInput.value.trim();
    if(url){
      if(!/(youtube\.com|youtu\.be)/i.test(url)){
        captureError.textContent = "That doesn't look like a YouTube link — paste a youtube.com or youtu.be URL.";
        captureError.classList.remove('hidden');
        return;
      }
      window.open(url, '_blank', 'noopener');
    }
    closeYoutubePopover();

    if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
      captureError.textContent = "This browser doesn't support tab/screen capture — try uploading the video file instead.";
      captureError.classList.remove('hidden');
      return;
    }

    try{
      const newStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
      if(newStream.getAudioTracks().length === 0){
        newStream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} });
        captureError.textContent = 'No audio was shared. When the picker appears, choose the YouTube tab and make sure "Share tab audio" (or "Share audio") is checked.';
        captureError.classList.remove('hidden');
        return;
      }
      captureStream = newStream;
      captureMode = 'capture';
      stream = captureStream;
      liveVideo.srcObject = captureStream;
      recBtn.disabled = false;
      captureStatus.classList.remove('hidden');
      // If sharing is stopped from the browser's native "Stop sharing" UI, fall back to the camera.
      const vTrack = captureStream.getVideoTracks()[0];
      if(vTrack) vTrack.addEventListener('ended', revertToCamera);
    }catch(e){
      captureError.textContent = 'Tab/screen sharing was cancelled or blocked — allow the share prompt to capture the video.';
      captureError.classList.remove('hidden');
    }
  });

  stopCaptureBtn.addEventListener('click', revertToCamera);

  // ===== SETTINGS PANEL =====
  let settingsPositioned = false;
  settingsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    if(settingsOpen && !settingsPositioned){
      positionSettingsPanel();
      settingsPositioned = true;
    }
    settingsPanel.classList.toggle('hidden', !settingsOpen);
    settingsToggle.classList.toggle('active', settingsOpen);
  });
  document.addEventListener('click', (e) => {
    if(suppressPanelClose) return;
    if(settingsOpen && !e.target.closest('.settings-panel') && !e.target.closest('#settingsToggle')){
      settingsOpen = false;
      settingsPanel.classList.add('hidden');
      settingsToggle.classList.remove('active');
    }
  });
  window.addEventListener('resize', () => { if(settingsOpen) positionSettingsPanel(); });

  // ===== PREP TIMER (30-minute countdown) =====
  const timerToggle    = document.getElementById('timerToggle');
  const timerPanel     = document.getElementById('timerPanel');
  const timerBadge     = document.getElementById('timerBadge');
  const timerDisplay   = document.getElementById('timerDisplay');
  const timerStateTag  = document.getElementById('timerStateTag');
  const timerStartBtn  = document.getElementById('timerStartBtn');
  const timerPauseBtn  = document.getElementById('timerPauseBtn');
  const timerResumeBtn = document.getElementById('timerResumeBtn');
  const timerResetBtn  = document.getElementById('timerResetBtn');
  if(timerPanel && timerPanel.parentElement !== document.body){
    document.body.appendChild(timerPanel);
  }
  function positionTimerPanel(){
    const rect = timerToggle.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    timerPanel.style.width = width + 'px';
    timerPanel.style.left = 'auto';
    let right = window.innerWidth - rect.right;
    right = Math.max(12, Math.min(right, window.innerWidth - width - 12));
    timerPanel.style.right = right + 'px';
    timerPanel.style.top = (rect.bottom + 8) + 'px';
  }

  // ===== Keyboard shortcuts panel =====
  const shortcutsToggle = document.getElementById('shortcutsToggle');
  const shortcutsPanel  = document.getElementById('shortcutsPanel');
  // Like settingsPanel/commentPopover above, shortcutsPanel used to live
  // inside #view-record, so it never appeared when a different view (e.g.
  // Citation Checker, Tournament Briefing, My History) was the active one,
  // since showView() hides that whole ancestor. Moving it to a direct child
  // of <body> means it now always opens in front, regardless of which view
  // is currently showing.
  if(shortcutsPanel && shortcutsPanel.parentElement !== document.body){
    document.body.appendChild(shortcutsPanel);
  }
  let shortcutsOpen = false;
  function positionShortcutsPanel(){
    const rect = shortcutsToggle.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    shortcutsPanel.style.width = width + 'px';
    shortcutsPanel.style.left = 'auto';
    let right = window.innerWidth - rect.right;
    right = Math.max(12, Math.min(right, window.innerWidth - width - 12));
    shortcutsPanel.style.right = right + 'px';
    shortcutsPanel.style.top = (rect.bottom + 8) + 'px';
  }
  function openShortcutsPanel(){
    shortcutsOpen = true;
    positionShortcutsPanel();
    shortcutsPanel.classList.remove('hidden');
    shortcutsToggle.classList.add('active');
  }
  function closeShortcutsPanel(){
    shortcutsOpen = false;
    shortcutsPanel.classList.add('hidden');
    shortcutsToggle.classList.remove('active');
  }
  shortcutsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(shortcutsOpen) closeShortcutsPanel(); else openShortcutsPanel();
  });
  document.addEventListener('click', (e) => {
    if(shortcutsOpen && !e.target.closest('#shortcutsPanel') && !e.target.closest('#shortcutsToggle')){
      closeShortcutsPanel();
    }
  });
  window.addEventListener('resize', () => { if(shortcutsOpen) positionShortcutsPanel(); });

  // ===== Grading Rubric panel (icon lives on the ballot paper itself) =====
  const rubricToggle     = document.getElementById('rubricToggle');
  const rubricPanel      = document.getElementById('rubricPanel');
  const rubricModeBar    = document.getElementById('rubricModeBar');
  const rubricModeLabel  = document.getElementById('rubricModeLabel');
  const rubricModeSelect = document.getElementById('rubricModeSelect');
  if(rubricPanel && rubricPanel.parentElement !== document.body){
    document.body.appendChild(rubricPanel);
  }
  let rubricOpen = false;
  function positionRubricPanel(){
    const rect = rubricToggle.getBoundingClientRect();
    const width = Math.min(640, window.innerWidth - 24);
    rubricPanel.style.width = width + 'px';
    rubricPanel.style.left = 'auto';
    let right = window.innerWidth - rect.right;
    right = Math.max(12, Math.min(right, window.innerWidth - width - 12));
    rubricPanel.style.right = right + 'px';
    rubricPanel.style.top = (rect.bottom + 8) + 'px';
  }
  // Swaps which of the two tables is shown and colors/labels the header bar
  // to match, used both for the real practice mode (Home page) and for
  // someone just browsing a rubric for reference (every other page).
  function displayRubricMode(mode){
    const isIntro = mode === 'introdrill';
    const isBody = mode === 'bodydrill';
    const isRoughDraft = mode === 'roughdraft';
    const fullTable = rubricPanel.querySelector('.rubric-table:not(#introRubricTable):not(#bodyRubricTable):not(#roughDraftRubricTable)');
    const introTable = document.getElementById('introRubricTable');
    const bodyTable = document.getElementById('bodyRubricTable');
    const roughDraftTable = document.getElementById('roughDraftRubricTable');
    if(fullTable) fullTable.classList.toggle('hidden', isIntro || isBody || isRoughDraft);
    if(introTable) introTable.classList.toggle('hidden', !isIntro);
    if(bodyTable) bodyTable.classList.toggle('hidden', !isBody);
    if(roughDraftTable) roughDraftTable.classList.toggle('hidden', !isRoughDraft);
    rubricModeLabel.textContent = isIntro ? 'Rapid Drill: Intro Rubric' : isBody ? 'Rapid Drill: Body Rubric' : isRoughDraft ? 'Rough Draft Rubric' : 'Regular Practice Rubric';
    rubricModeLabel.classList.toggle('is-intro', isIntro);
    rubricModeLabel.classList.toggle('is-body', isBody);
    rubricModeLabel.classList.toggle('is-roughdraft', isRoughDraft);
    rubricModeLabel.classList.toggle('is-regular', !isIntro && !isBody && !isRoughDraft);
  }
  function openRubricPanel(){
    rubricOpen = true;
    positionRubricPanel();
    // On the Home page the practice mode switch is the real control, so the
    // rubric just mirrors it (no dropdown needed). Everywhere else, offer
    // the dropdown so the rubric can be browsed independent of whichever
    // mode was last practiced in.
    const onHome = currentViewEl === viewRecord;
    rubricModeSelect.classList.toggle('hidden', onHome);
    rubricModeBar.classList.toggle('browsable', !onHome);
    const mode = introDrillMode ? 'introdrill' : bodyDrillMode ? 'bodydrill' : roughDraftMode ? 'roughdraft' : 'regular';
    rubricModeSelect.value = mode;
    displayRubricMode(mode);
    rubricPanel.classList.remove('hidden');
    rubricToggle.classList.add('active');
  }
  function closeRubricPanel(){
    rubricOpen = false;
    rubricPanel.classList.add('hidden');
    rubricToggle.classList.remove('active');
  }
  rubricModeSelect.addEventListener('change', () => displayRubricMode(rubricModeSelect.value));
  rubricToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(rubricOpen) closeRubricPanel(); else openRubricPanel();
  });
  document.addEventListener('click', (e) => {
    if(rubricOpen && !e.target.closest('#rubricPanel') && !e.target.closest('#rubricToggle')){
      closeRubricPanel();
    }
  });
  window.addEventListener('resize', () => { if(rubricOpen) positionRubricPanel(); });

  // ===== LLM Model Rankings page (icon sits left of the rubric icon on
  // the ballot paper) — opens as its own page on the paper, the same
  // way the briefingToggle button swaps in the Tournament Briefing
  // view, instead of an anchored popup. =====
  // Sample judge ballots shown when a row in the LLM Model Rankings panel
  // is clicked (see aiCompareToggle / openAiComparePanel below). Real
  // ballots this app generated with each model, on the identical
  // transcript/question, so the difference in feedback quality/depth
  // between models is visible side by side rather than just claimed.
  const AI_MODEL_EXAMPLE_BALLOTS = {
    opus5: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n# NSDA EXTEMPORANEOUS SPEAKING \u2014 FULL SPEECH BALLOT\n**Question:** How will the Green New Deal influence future environmental legislation?\n\n---\n\n### Creative Hook & Intro - 7/8\n\n**What Worked:**\n1) The AGD is genuinely original rather than the standard quote-or-statistic opener \u2014 the mispronunciation runner (\"One cable pundit called her Alessandra Oxycontin\") earns real audience buy-in and, critically, the humor is *topical* rather than decorative.\n2) The link is the single best mechanical move in the speech: \"we commonly know her as AOC, there are three letters also attached to her name, GND.\" The hook converts into the topic through a letter-motif pivot rather than a forced \"and just like that\u2026\" bridge.\n3) The thesis is explicit and flowable in one line \u2014 \"it will serve as the bedrock for future environmental legislation\" \u2014 and the preview formally numbers all three points with a hierarchy cue (\"finally, and perhaps most importantly\").\n4) The intro establishes stakes with a dated urgency stat rather than assertion: \"Scientific American from January of this year that emissions rose by 3.8%.\"\n\n**Critical Flaws:**\n1) The intro is structurally bloated at ~290 words (~23% of the speech) because it carries three separate background paragraphs \u2014 the 14-page white paper, the Paris withdrawal, *and* the New Consensus 2020 agenda. The New Consensus detail in particular (\"the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020\") is never used again anywhere in the body, so it is pure dead weight.\n2) A word-level error damages credibility inside the first 30 seconds: \"the deal was met with regret, but also immense popularity.\" \"Regret\" is almost certainly a misspoken \"derision\" or \"criticism\" \u2014 as delivered it is nonsense, since a deal cannot be \"met with regret\" by its opponents.\n3) The \"crises around the world, in Sudan and Yemen, but this is a crisis of the natural world\" line is a throwaway comparison that raises two humanitarian catastrophes and then abandons them for rhetorical contrast \u2014 a judge hears it as trivializing rather than escalating.\n\n**What You Could Have Done:**\n1) \"AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution **\u2014 a resolution the U.S. desperately needs, because after withdrawing from the Paris Climate Accords we have no sweeping environmental legislation on the books.**\" (Cut the New Consensus sentence entirely and bank those ~22 words for Body 3.)\n2) \"The Atlantic continues that the deal was met with **derision from Congressional Republicans**, but also immense popularity across the United States.\"\n3) \"**Emissions rose by 3.8% last January alone \u2014 and unlike a war or a famine, this is a crisis where the deadline is set by chemistry, not by politics.**\"\n\n---\n\n### Structure - 7/10\n\n**What Worked:**\n1) The skeleton is fully intact and correctly ordered: single AGD \u2192 link \u2192 thesis \u2192 three-point preview \u2192 three bodies \u2192 conclusion. Nothing is missing or blurred.\n2) Two of the three body points restate their own tagline immediately after the anecdote, which is excellent flowing practice \u2014 \"This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action.\"\n3) The body 3 \u2192 conclusion seam is explicitly signposted and returns to the exact question: \"That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation?\"\n4) There is a real AGD callback buried in Body 3 \u2014 \"Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source\" \u2014 which reactivates the name motif late rather than letting it die in the intro.\n\n**Critical Flaws:**\n1) The intro \u2192 Body 1 seam is a hard jump. The speaker ends on \"a new global paradigm on climate policy\" and immediately opens with \"Republicans for years have said that innovation is the way that we can solve climate change\" \u2014 no bridging clause, and the point's actual label arrives 44 words later, after the nickel joke. A judge without the transcript loses their place for roughly ten seconds.\n2) The Body 1 \u2192 Body 2 transition is a bare enumerator with no logical link: \"Secondly, we have to look more broadly to the question of environmental justice.\" Nothing connects bipartisan mitigation to justice; contrast this with how cleanly the conclusion re-hooks.\n3) The AGD callbacks are back-loaded. Between \"GND, standing for the Green New Deal\" in the intro and the AOC reference in Body 3, there is no name-motif touchpoint at all \u2014 Body 1's nickel gag and Body 2's Comic-Con gag are *new* jokes, not throughline maintenance, so the framing device goes dark for roughly two full minutes.\n4) **TIMING & LENGTH BREAKDOWN** (word-count based, mapped to the 470s recording): Introduction ~290 words = **~23%, approximately 109s**; Body 1 ~325 words = **~26%, approximately 122s**; Body 2 ~305 words = **~24%, approximately 114s**; Body 3 ~255 words = **~20%, approximately 95s**; Conclusion ~80 words = **~6%, approximately 30s**. Against the 14/26/26/26/7 benchmark, Body 1 and Body 2 are on target and the conclusion is essentially perfect, but the Introduction runs **9 points hot** while Body 3 runs **6 points cold**. The competitive cost is concrete and visible: Body 3 is the point the speaker himself billed as \"perhaps most importantly,\" yet it gets the least development, which is why its two central claims (Paris has no mechanism; four countries' candidates ran on GND) sit unwarranted. Roughly 25-30 seconds should move from the intro's background block directly into Body 3.\n\n**What You Could Have Done:**\n1) \"\u2026by leading to a new global paradigm on climate policy. **Before any of that global reach matters, though, the Deal has to move the one body that can pass it \u2014 Congress.** Republicans for years have said that innovation is the way that we can solve climate change.\"\n2) \"\u2026one that allows us to grow our economy while cutting emissions. **But a bipartisan bill that only counts carbon molecules still misses the Americans breathing them.** Secondly, we have to look more broadly to the question of environmental justice.\"\n3) In Body 2: \"\u2026better subsidies to allow minorities to get equity. **Pundits couldn't get her name right, but Ocasio-Cortez got the constituency right \u2014 the communities in this bill are the ones cable news never bothered to pronounce either.**\"\n4) Cut the New Consensus sentence and the Sudan/Yemen aside (~45 words, ~17s) and spend it in Body 3 warranting the mechanism gap: \"**Paris sets a 1.5 degree target and then leaves it to voluntary national pledges; the Green New Deal instead specifies sectors, timelines, and public financing \u2014 which is precisely the template Spain and Canada's candidates borrowed.**\"\n\n---\n\n### Strength of Argument & Analysis - 10/16\n\n**What Worked:**\n1) Body 1's core claim \u2014 that the GND is dragging Republicans from denial into counter-proposal \u2014 is the most convincing point in the speech because the speaker traces a genuine timeline: Romney's 2011 \"he didn't even know if humans were a cause,\" a 2016 platform with no climate plan, then two named 2019 GOP bills (Alexander's Manhattan Project on Clean Energy, Gaetz's Green Real Deal). Evidence \u2192 warrant \u2192 impact is actually completed here.\n2) The speaker earns credibility by conceding a rival cause instead of hiding it: \"Both of these solutions are certainly influenced by popularity.\" That is a fairness move most competitors skip.\n3) Body 2 passes the \"So What?\" test on the incinerator statistic better than anywhere else in the speech \u2014 1.6 million Americans near incinerators is immediately converted into a policy consequence (\"this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies\"), showing why the GND's design differs from prior bills that \"looked to just alternative energy.\"\n4) The Paris comparison in Body 3 identifies a real and sophisticated distinction \u2014 target versus mechanism: \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there.\" That is the sharpest analytical observation in the round.\n\n**Critical Flaws:**\n1) **Body 2 rests on a category error that collapses its link to the thesis.** Trash incinerators, asthma, and maternal mortality are *local air pollution* harms, not climate change harms \u2014 CO\u2082 does not cause asthma. Yet the speaker frames them as climate: \"Americans are tangibly being hurt by climate change\u2026 1.6 million Americans live near a trash incinerator.\" Because the question asks about *environmental legislation*, the point survives, but it proves something adjacent \u2014 that the GND addresses pollution equity \u2014 rather than proving it will be the \"bedrock\" of future *climate* law. The missing warrant is one sentence explaining that the GND is the first bill to legislatively fuse decarbonization with pollution siting, so future bills must now clear both bars.\n2) **Body 2's Illinois evidence has no warrant at all.** \"In the state of Illinois this led to an equity environmental\u2026Justice Bill being passed, where there will be 40 million solar panels installed by 2050.\" The speaker never explains the mechanism by which a *federal* congressional resolution introduced in early 2019 produced a *state* energy bill, nor why a state solar procurement program demonstrates influence on **future federal environmental legislation** \u2014 the question actually drawn. The missing warrant: \"Illinois legislators explicitly borrowed the GND's hiring-equity language, which is the first proof that the Deal functions as template text other bodies copy rather than as a standalone bill.\"\n\n3) **Body 3 contains a self-inflicted wound the speaker never repairs.** He cites the New York Times to say \"the Green New Deal has been around before the United States proposed it in 2018. It came from the UK.\" That directly weakens the thesis that AOC's GND will be the *bedrock* of a new global paradigm \u2014 if the framework is imported, the US is a late adopter, not an originator. His patch is one vague noun: \"Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source.\" That is assertion, not analysis; it never explains what \"accessibility\" did mechanically to make Spain's or Norway's platforms possible.\n\n4) **Body 3's strongest evidence proves the wrong thing.** \"Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" is evidence about *campaign platforms*, not about *legislation*. Running on an agenda and enacting binding law are separated by exactly the gap the speaker himself identified in Paris \u2014 goal versus mechanism \u2014 and he never notices that his own evidence sits on the goal side of that line.\n\n5) **Body 1 never engages the strongest opposing view, which is the obvious one.** The best case against the speaker is that the GND *polarized* climate policy rather than opening it \u2014 Senate Republicans forced a procedural show vote in March 2019 that failed 0\u201357 with Democrats voting \"present,\" precisely to weaponize the resolution. The speaker also volunteers the opposition's most damaging number as a punchline \u2014 \"I'd be able to pay for the $93 trillion Green New Deal\" \u2014 and then never rebuts it, leaving the round's largest cost objection standing unanswered by his own hand.\n\n**VERDICT: MODERATE.** Point 1 is genuinely well-built and would survive cross-examination; Points 2 and 3 gather good evidence and then fail to connect it to the specific words \"future environmental legislation.\"\n\n**What You Could Have Done:**\n1) \"\u2026better subsidies to allow minorities to get equity. **That fusion is the influence: no prior federal climate bill made pollution siting and decarbonization pass or fail together, so every bill after this one has to clear both bars or explain why it doesn't.**\"\n2) \"In the state of Illinois this led to an equity environmental Justice Bill being passed **\u2014 and legislators there lifted the resolution's hiring-equity language almost verbatim, which is the first hard evidence the GND works as template text rather than as a one-off bill.**\"\n3) \"It came from the UK, but Alexandria Ocasio-Cortez's **fourteen-page draft turned a British think-tank concept into a legislative document other parties could actually copy \u2014 that's the difference between an idea circulating and a bill being ported.**\"\n4) \"\u2026have run on a Green New Deal agenda **\u2014 and in Spain, that platform became the 2050 Climate Law's binding sectoral targets, which is Paris's missing mechanism finally written down.**\"\n5) \"Both of these solutions are certainly influenced by popularity **\u2014 and yes, Senate Republicans forced a 0-to-57 show vote in March to kill the resolution outright. But you don't write a Green Real Deal to counter a bill you think is dead; the counter-proposals are the concession.**\"\n\n---\n\n### Flaws in Reasoning - 6/12\n\n**What Worked:**\n1) The speaker pre-empts the single most obvious rival explanation in Body 1 rather than pretending it doesn't exist: \"Both of these solutions are certainly influenced by popularity.\" Naming a confound is the beginning of good causal reasoning even when the follow-through is thin.\n2) The Paris critique is logically clean and commits no identifiable fallacy \u2014 \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" is a valid structural objection, not an ad hominem or a strawman of the accord.\n\n**Critical Flaws:**\n1) **Post hoc ergo propter hoc, severe \u2014 undermines all of Body 2's second half.** \"We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed.\" A federal resolution introduced in February 2019 cannot plausibly have caused a state energy-equity bill weeks later; Illinois' equity-and-solar architecture traces to the 2016 Future Energy Jobs Act, which predates the GND entirely. The missing context \u2014 that state clean-energy equity provisions were already moving before AOC's resolution existed \u2014 would flip this from \"the GND caused it\" to \"the GND joined a trend,\" which is a much weaker version of the thesis.\n2) **Correlation asserted as causation, moderate-to-severe \u2014 weakens Body 1's payoff.** \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal.\" The word \"also\" is doing all the causal work. The speaker's own Politico evidence establishes only temporal sequence and polling pressure; he needed a Republican on record saying the resolution forced their hand. As written, he concedes the confound and then overrides it by assertion.\n3) **Equivocation on \"climate change,\" severe \u2014 this is the structural crack in Body 2.** \"Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator\u2026 that has led to higher rates of asthma and maternal mortality.\" Incinerator particulates cause asthma; atmospheric CO\u2082 does not. The speaker silently swaps the meaning of \"climate change\" from *global warming* to *local pollution* and reasons across the swap, which is why \"In my home state of New Jersey, it's doubled the rate of asthma because of climate\" comes out as a claim no atmospheric scientist would sign.\n4) **Hasty generalization plus unsupported premise, moderate.** \"While the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally.\" Zero evidence supports either characterization, yet the whiteness premise is load-bearing \u2014 the entire justification for the environmental-justice point depends on it. It also sits awkwardly against real data the speaker could have used: Yale's climate-opinion research consistently finds Black and Hispanic Americans *more* concerned about climate than white Americans, meaning the deficit is in movement leadership and funding, not in constituency concern. Stating it that way would have saved the premise.\n5) **Fabricated-quotation hyperbole, moderate.** \"Climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die.\" The IPCC 1.5\u00b0C report was released in October 2018, not \"at the beginning of this year,\" and no IPCC author said that. Inventing a quote to stand in for a finding is the kind of thing a judge who knows the report will hold against the entire evidence package.\n6) **Appeal to popularity that also self-undercuts, minor-to-moderate.** \"45% of all Americans believe that we need immediate action\" is offered as proof that pressure is irresistible \u2014 but 45% is a minority, and citing it immediately after \"Republicans, now 64%\" invites the judge to notice the speaker's mandate is thinner than his rhetoric.\n\n**What You Could Have Done:**\n1) \"\u2026that in the state of Illinois **legislators drafting their 2019 equity bill imported the resolution's labor-and-hiring language, layering it onto the 2016 Future Energy Jobs Act framework they already had** \u2014 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\"\n2) \"Both of these solutions are certainly influenced by popularity, but **Gaetz told Politico he drafted the Green Real Deal specifically because his party needed 'something to say' when constituents raised the Green New Deal \u2014 the resolution set the terms of the answer.**\"\n3) \"Americans are tangibly being hurt by **the same fossil-fuel infrastructure driving climate change.** 1.6 million Americans live near a trash incinerator\u2026 **and in my home state of New Jersey, incinerator siting has doubled asthma rates in the neighborhoods next door.**\"\n4) \"While the climate movement is right, **its leadership doesn't look like its constituency \u2014 Yale's research finds Black and Hispanic Americans are more alarmed about climate than white Americans, yet the movement's boardrooms and marches don't reflect that.**\"\n5) \"At the beginning of **last October**, climate scientists with the Intergovernmental Panel on Climate Change **gave the world twelve years to halve emissions \u2014 and then watched almost nothing happen.**\"\n6) \"**64% of Republicans under 40 now call climate change a serious threat, and even the 45% of all Americans demanding immediate action is enough to make denial electorally expensive** \u2014 which is why Republicans stopped denying and started drafting.\"\n\n---\n\n### Strength of Evidence - 12/16\n\n**What Worked:**\n1) **Nine unique sources across three points** \u2014 The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, National Interest \u2014 comfortably clearing the 1-2-per-point benchmark and giving the round a genuinely researched feel rather than a two-source skeleton.\n2) **Five of the nine carry full day/month/year dates**: \"The Atlantic tells us on June the 12th of 2019,\" \"Washington Post tells us on April the 3rd of 2019,\" \"Politico on March the 26th of 2019,\" \"The Guardian tells us on May the 21st of 2019,\" \"Vox on March the 7th of 2019,\" and \"The national interest tells us on June the 4th of 2019.\" For a topic moving as fast as GND politics in 2019, the Atlantic and National Interest citations are within weeks of the round \u2014 that is exemplary timeliness.\n3) **Source-to-claim matching is strong in Body 1.** Politico is the correct outlet for congressional-behavior claims, and the specific named bills \u2014 \"Senator Lamar Alexander of Tennessee\u2026 his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling\" \u2014 are the kind of granular, verifiable detail that separates researched extemp from summarized-headline extemp.\n\n**Critical Flaws:**\n1) **The single largest number in the speech is cited to nobody.** \"I'd be able to pay for the $93 trillion Green New Deal\" arrives with no outlet, no author, and no date \u2014 and it is not a neutral figure; it comes from the American Action Forum, a center-right advocacy shop, and includes contested single-payer and jobs-guarantee assumptions. Delivering a partisan estimate as though it were consensus arithmetic, undated, is the worst evidence moment in the round; timeliness and provenance both cannot be verified.\n2) **Two citations are dated to month-and-year only, and one of them is stale for its own claim.** \"Los Angeles Times from December of 2018\" and \"the New York Times, from March of 2019\" both lack a day. The LA Times problem is substantive, not clerical: it is used to establish that Paris is \"the most sweeping piece of climate legislation we have around the world\" with \"no actual mechanism,\" but the COP24 Katowice rulebook \u2014 negotiated that very December \u2014 was specifically about implementation mechanics. A six-month-old, day-less citation cannot carry a claim that December's own conference was busy complicating.\n3) **\"Scientific American from January of this year\" is both day-less and unattributed as to scope.** \"Emissions rose by 3.8%\" \u2014 whose emissions, over what period? US energy-related CO\u2082 rose roughly 3.4% in 2018 by Rhodium Group's estimate; global emissions rose about 2%. A bare \"3.8%\" with no subject makes the statistic unfalsifiable, and the missing referent is exactly the kind of thing a judge probes in the hallway afterward.\n4) **A poll number is attributed in a way that is almost certainly wrong.** \"The Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival.\" No 2019 polling put 64% of Republicans at \"severe threat to future survival\"; that figure tracks the *general population*'s concern in the Post-Kaiser survey. Misassigning a headline number to the opposing party is the kind of error that, if caught, discredits the strongest point in the speech.\n5) **The evidence base is entirely journalistic \u2014 no primary documents.** For a question about legislative influence, the speaker never cites H.Res.109 itself, the IPCC 1.5\u00b0C report he paraphrases, or the Paris text whose mechanism he critiques. Nine newspapers reporting on a document is weaker than the document.\n\n**What You Could Have Done:**\n1) \"If I had a nickel for every time they said innovation, I'd be able to pay for **the American Action Forum's contested $93 trillion price tag \u2014 a figure whose July 2019 estimate bundles in single-payer healthcare, not decarbonization.**\"\n2) \"We see in an article from the Los Angeles Times from December **the 15th** of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is **even after the Katowice rulebook set reporting standards that month, compliance stayed voluntary \u2014 a goal of 1.5 degrees with no enforcement behind it.**\"\n3) \"We see in an article from the Scientific American from January **the 8th** of this year that **US energy-related carbon emissions** rose by 3.8% **in 2018, the sharpest annual jump in eight years.**\"\n4) \"The Washington Post continues that **64% of Americans \u2014 and a majority of Republicans under 40 \u2014** believe that climate change is a severe threat to our future survival.\"\n5) \"\u2026as a 14-page white paper congressional resolution **\u2014 House Resolution 109 itself, whose text commits to net-zero by 2030 alongside a federal jobs guarantee, which is the specific pairing every citation after this one is reacting to.**\"\n\n---\n\n### Clarity - 6/10\n\n**What Worked:**\n1) The preview is verbally numbered and the body points reuse the same labels, so a judge can flow without the transcript: \"First, by forcing bipartisan action on climate mitigation\u2026 more broadly by addressing the critical concept of environmental justice, and finally\u2026 by leading to a new global paradigm.\"\n2) The acronym housekeeping is handled properly on first use \u2014 \"we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal\" \u2014 and the IPCC is spoken in full as \"Intergovernmental Panel on Climate Change\" before being relied upon.\n3) Body 1's timeline is narrated in plain chronological English \u2014 \"Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change\" \u2014 which is the most listenable stretch of the speech.\n4) The conclusion's restatement is compressed and parallel \u2014 \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 three clauses, same grammatical shape, easy to retain.\n\n**Critical Flaws:**\n1) **Broken and garbled sentences, several of which a live judge would stumble on.** In order: \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" (stutter plus three hedges stacked \u2014 \"a showing,\" \"part of,\" \"a way to\"). \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" \u2014 a dropped clause leaves a sentence fragment starting with \"to come to.\" \"This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice\" \u2014 an abandoned construction (\"that we can change that\") that never recovers. And \"the Green New Deal is creating a unified platform where we can all cut reductions\" says the opposite of what he means; you cut *emissions*, you don't cut *reductions*### Clarity - 6/10 *(continued)*\n\n**Critical Flaws (continued):**\n\n2) **A cluster of sentences collapses under its own hedging or reverses its own meaning.** \"This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing\" \u2014 a double negative nested inside a comparative, and \"swimming all the time\" is a sea-level-rise image the judge has to reverse-engineer mid-sentence. Worse is \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" \u2014 \"climate and motivations\" is not a phrase in English, and the listener is left guessing whether he meant siting decisions, permitting, or profit motive. And \"Their dead face was a little apathetic\" attaches a singular \"face\" to a panel of scientists while repeating \"apathetic\" from the sentence immediately prior.\n\n3) **Vague pronouns at three of the speech's load-bearing moments.** (a) \"by democratizing it with environmental justice\" \u2014 \"it\" should be *future environmental legislation*, but the nearest noun is \"the Green New Deal,\" which makes the sentence say the GND democratizes itself. (b) \"that in the state of Illinois this led to an equity environmental Justice Bill being passed\" \u2014 \"this\" has no antecedent at all; he means *the Green New Deal's framing*, but the previous sentence was about New Jersey incinerators, so \"this\" plausibly points at asthma rates. (c) \"In my home state of New Jersey, it's doubled the rate of asthma\" \u2014 \"it\" is presumably incinerator proximity, but the subject of the prior clause was \"1.6 million Americans.\"\n\n4) **Hedge-and-intensifier padding throughout, and it consistently softens the strongest claims.** \"just\" \u00d74 (\"not simply going to just pass,\" \"we won't just have a world,\" \"we've often looked to just alternative energy,\" \"isn't just a greener world\"), \"simply\" \u00d72 (\"The answer simply is that\u2026\"), \"very\" \u00d73 (\"sat very apathetically,\" \"This is very different,\" \"Thank you very much\"), plus \"certainly\" in \"Both of these solutions are certainly influenced by popularity\" \u2014 a concession dropped exactly where he needed to isolate the GND as the cause \u2014 and \"actually\" in \"forcing Republicans to actually innovate.\" The thesis itself is weakened by its own adverb: \"The answer simply is that it will serve as the bedrock.\"\n\n5) **Two accessibility gaps and one joke that risks the room.** \"the think tank New Consensus is working to transform this resolution into a sweeping policy agenda\" \u2014 a judge with no background has no idea whether New Consensus is a two-person shop or a Brookings-scale institution, and its credibility is what makes the claim matter. Second, \"1.5 degrees of Celsius of heating\" is never anchored to a baseline (above pre-industrial levels, by 2100) so the number floats. Third, \"while the climate movement is right, they're also very white\u2026 a cross between a Comic-Con convention and a Bernie Sanders rally\" is a punchline that presupposes the judge shares the speaker's politics; it also does the analytical work of the point *instead of* the demographic evidence he actually had available.\n\n**Verdict: MODERATELY CLEAR.** The macro-architecture is trackable and the acronym discipline is genuinely good, but at the sentence level Body 2 and the seams of Body 1 contain at least four constructions a flowing judge would have to reconstruct in real time.\n\n**What You Could Have Done:**\n1) \"This is **evidence** that the Green New Deal **guides** future climate debate. We're not **going to pass this 14-page resolution as written \u2014 we're going to use it to force** bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions.\" (And later: \"the Green New Deal is creating a unified platform where we can all cut **emissions**.\")\n2) \"This is **why the deal matters beyond carbon: it builds a future where we're not just holding back the water, but where the people hit hardest are the ones who benefit first.** In my home state of New Jersey, **incinerator siting has** doubled the rate of asthma **in the communities forced to live next to them.** **The IPCC's scientists delivered that finding flatly, almost bored \u2014 and that flatness is the global apathy I'm describing.**\"\n3) \"This is the second way the Green New Deal is influencing future environmental legislation \u2014 by democratizing **that legislation** with environmental justice\u2026 **The Green New Deal's equity framing** led to an **Illinois** environmental Justice Bill being passed.\"\n4) \"The answer is that it will serve as the bedrock\u2026 Both of these solutions **respond to polling, but neither existed before the Green New Deal set the terms** \u2014 **which is the point:** the Green New Deal turned 'innovation' from a talking point into a bill Republicans have to write.\"\n5) \"the think tank New Consensus \u2014 **the group AOC herself tasked with drafting the implementing legislation** \u2014 is working to transform this resolution into a sweeping policy agenda\u2026 **1.5 degrees Celsius of warming above pre-industrial levels by 2100**\u2026 **The climate movement's own leadership doesn't look like the communities breathing the worst air, and that gap is exactly what the deal's justice provisions target.**\"\n\n---\n\n### Conclusion Strength - 6/8\n\n**What Worked:**\n1) The question is restated verbatim before the answer, which is textbook and gives the judge a clean landing point: \"we have to return back to today's question. How will the Green New Deal influence future environmental legislation?\"\n2) The three-point summary is accurate to what was actually argued and delivered in tight parallel structure \u2014 \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 no drift, no invented fourth point.\n3) The AGD echo is genuinely intentional and among the better closers in this event: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\" Spelling out the affirmative roll-call vote turns the opening name-mispronunciation bit into a legislative punchline, and it recycles the \"three letters\" mechanic from the intro rather than inventing a new image.\n\n**Critical Flaws:**\n1) **There is no call to action or forward-looking statement \u2014 the pun substitutes for one.** \"Y-E-A. Thank you very much\" ends on wordplay, not on stakes. The speech spent its intro asserting the US \"has no sweeping environmental legislation to protect us in the near future,\" and never returns to what happens if the bedrock never gets built on.\n2) **A brand-new, unlinked metaphor is dropped in immediately before the close.** \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\" is a second AGD arriving at 90% of the way through, and it collides with the AOC hook the very next sentence tries to resolve. It also contradicts the only moon reference in the body \u2014 Lamar Alexander's \"Manhattan Project on Clean Energy\" is the innovation-mobilization frame, not lunar escape.\n3) **The label for point three quietly changes at the close.** The preview and Body 3 both promised \"a new unified global paradigm on climate policy\"; the summary says \"global universality.\" Those are not synonyms \u2014 \"universality\" implies every state participating, which is Paris's existing (and, per his own argument, failed) model, so the restatement accidentally names the thing he criticized.\n4) **The conclusion carries no insight the body didn't already state.** Every clause is either a restatement or a joke; there is no sentence answering why *bedrock* is the right metaphor \u2014 i.e., that the GND's function is to be built on and superseded rather than passed.\n\n**What You Could Have Done:**\n1) \"\u2026there are only three letters we need to learn about the Green New Deal. Y-E-A. **Because the 116th Congress will not pass this resolution \u2014 but the Congress that writes the carbon tax, the justice provisions, and the global pledge will be voting on the language AOC wrote first.**\"\n2) *(Cut the moon lines entirely.)* \"\u2026the Green New Deal is creating a unified platform where we can all cut emissions. **Pundits couldn't pronounce her name in January; by June, four countries were running on her legislation.** That's exactly why we have to return back to today's question.\"\n3) \"and finally, by leading to **a unified global paradigm \u2014 not Paris's voluntary pledges, but a shared mechanism.**\"\n4) \"The answer is that it will serve as a fundamental bedrock **\u2014 and bedrock is the right word, because nobody lives in bedrock. It's what everything after it gets built on.**\"\n\n---\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 16/20\n\n**What Worked:**\n1) **Classic disfluencies are almost nonexistent for a 470-second speech.** The auto-count found 4 crutch words total (\"actually\"\u00d71, \"like\"\u00d73) and my own read confirms the three \"like\"s are grammatically legitimate, not verbal crutches \u2014 \"a table much like yours,\" \"solutions like a carbon tax.\" Zero \"um,\" zero \"uh,\" one stutter across roughly 1,253 words is championship-level fluency control.\n2) **Vocal variety is a legitimate strength and it tracks content.** 3,151 significant pitch shifts with an 81.6Hz standard deviation (\"High \u2014 expressive\") is consistent with the transcript's tonal range: the deadpan of \"Lou Dobbs, the paradigm of journalistic integrity\" and the flatness of \"we're all going to die\" only function if pitch drops, and the metrics indicate it did.\n3) **Pace is dead-center competitive.** 160 wpm sits in the middle of the 150\u2013175 target, which is why the granular material \u2014 \"Senator Lamar Alexander of Tennessee\u2026 his Manhattan Project on Clean Energy\" \u2014 stayed followable rather than becoming a data blur.\n4) **A meaningful share of emphasis lands on rhetorically correct words.** The spikes on \"SOLVE\" (\"attempted to SOLVE the ever-pressing emergency\"), \"DON'T\" (\"we DON'T have much time to waste\"), \"BROADLY\" (the point-two signpost), and \"WHAT\" (\"But WHAT exactly is innovation?\") are all doing real work \u2014 urgency verbs, the signpost, and the rhetorical question that frames Body 1.\n\n**Critical Flaws:**\n1) **The speech is over time.** 470 seconds is 7:50 \u2014 roughly 50 seconds past the 7:00 NSDA maximum, and past even a generous 30-second grace. At most tournaments that is a rank penalty independent of content quality, and it means the timing proportions praised elsewhere were achieved on a budget the speaker didn't have.\n2) **Emphasis lands on function words at a high rate.** Of the 40 logged contexts, spikes fall on \"THE\" (twice \u2014 \"an article from THE Atlantic,\" \"continues that THE deal\"), \"A\" (\"into A sweeping policy agenda,\" \"leading to A new global paradigm\"), \"TO,\" \"BUT,\" \"ALSO,\" \"IF,\" and \"I.\" At 20% of all words carrying a loudness spike, emphasis is being sprayed rather than placed \u2014 and the cost is specific: the $93 trillion figure, the \"64%,\" the \"3.8%,\" and the word \"bedrock\" are the four terms that needed the spike and none appear in the emphasized set.\n3) **Almost no strategic pausing.** 7 pauses over 0.4s across 7:50 is roughly one pause per 67 seconds. The two biggest rhetorical beats in the round \u2014 \"and said, we're all going to die\" and the final \"Y-E-A\" \u2014 both need a held silence to land, and a punchline delivered into continuous speech dies. The intro's thesis (\"it will serve as the bedrock for future environmental legislation\") likewise runs straight into the preview with no separation.\n4) **Volume is merely adequate, not commanding.** \u221223.1 dBFS average sits about 5 dB under the strong-projection threshold, subscoring 8/10. In a room without amplification, a speech built on deadpan jokes and low-pitch delivery is the exact profile that loses intelligibility at the back row \u2014 the \"Alessandra Oxycontin\" bit fails entirely if the judge only half-hears it.\n5) **The one stutter falls on a thesis-restating sentence.** \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" \u2014 the repetition lands on the sentence that was supposed to close Body 1's link back to the thesis, so the fluency slip and the analytical hedge compound each other.\n\n**What You Could Have Done:**\n1) Cut the Lou Dobbs second joke and the moon couplet \u2014 approximately 45 seconds of material that carries no argumentative load \u2014 bringing the speech to roughly **6:55**.\n2) Place the spikes deliberately and sparingly: \"I'd be able to pay for the **NINETY-THREE TRILLION** dollar Green New Deal,\" \"Republicans, now **SIXTY-FOUR PERCENT**, believe,\" \"emissions rose by **THREE POINT EIGHT** percent,\" and \"it will serve as the **BEDROCK**\" \u2014 rather than on \"an article from THE Atlantic.\"\n3) \"and said, **[full 1.5-second hold]** we're all going to die.\" And: \"there are only three letters we need to learn about the Green New Deal. **[hold]** Y-E-A.\"\n4) Project from the diaphragm through the comedic lines specifically \u2014 the deadpan bits are the moments where pitch drops *and* volume naturally drops, so **lift volume as pitch falls** on \"Lou Dobbs, the paradigm of journalistic integrity.\"\n5) \"This is **evidence that** the Green New Deal **guides** future climate debate\" \u2014 one clean subject-verb-object clause is far harder to stumble over than \"a showing that\u2026 is part of a way to.\"\n\n---\n\n### Total Composite Score: 74/100\n\n### Judge's Rank: 2/5\n\n### Rank Explanation:\nThis speech would place 2nd against five other competitors on this question. Its ceiling is high: nine sourced citations with named legislators and named bills, three points that genuinely answer *influence on future legislation* rather than drifting into \"is the GND good,\" and a closing \"Y-E-A\" callback that is the most intentional intro-to-conclusion echo I expect to hear in this flight. What keeps it off the top is that the speaker's analytical instincts outrun his precision \u2014 the $93 trillion figure enters uncited and partisan, the 64% is attributed to Republicans when it almost certainly describes the general public, and Body 2 contains three sentences (\"climate and motivations on these incinerators,\" \"we're not swimming all the time,\" \"the second way that we can change that\") that a judge has to translate rather than absorb. Add a 7:50 delivery that is fifty seconds over the limit, and a competitor with cleaner sourcing and a legal clock beats him even with less charisma. The fix here is subtraction, not addition: this speaker already has more material than the time permits, and trimming the second joke in the intro plus the moon couplet buys back both the time violation and the room to warrant his numbers properly.\n\n### Actionable Drill for Next Round:\n**The Uncited-Number Sweep.** Take this transcript and highlight every numeral in it \u2014 14-page, 3.8%, 93 trillion, 64%, 45%, 1.6 million, 40 million, 2050, 1.5 degrees. For each one, write on an index card, in this exact order: (1) outlet, (2) day/month/year, (3) the subject of the number (\"US energy-related CO\u2082,\" not \"emissions\"), (4) the one-sentence warrant for why the number proves the point. Any card you cannot complete from memory in under fifteen seconds is a number you are forbidden from saying out loud in your next four practice rounds \u2014 say the qualitative claim instead. Then re-record only the intro and Body 1 with the surviving numbers, deliberately spiking volume on each figure and holding a full one-second pause after it. Repeat until every number in the speech carries an outlet, a date with a day attached, a subject, and a beat of silence behind it.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal last November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  Alexandria Ocasio-Cortez and Senator Edward Markey released a 14-page resolution for their Green New Deal (House Resolution 109) on February 7, 2019, which aligns with the 'last November' (2018) timeframe for its initial proposal or discussion, preceding the formal resolution.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific article from The Atlantic on June 12, 2019, was not found, other sources from early 2019 indicate that the Green New Deal, or its core concepts, had broad popularity among voters (including some Republicans initially) but also faced significant political polarization and opposition.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE9SsjgxWKh0zU9RPgtIz9bZPXgjQsZQFFXTsohMGhp1e6NmPyCI4CM5DFffvH77Ljrqw-Qjf420HhNF-vy_0Cf3XJDMwOWUD1hCSneSkA2thHgwHnEaJtQSTZcAX_UqQyVUlkRZRbty4nec3qmormIGNipWIlflMaoY202w8s54zWltA0PGtHqJAKWvEXQzjtnyu6MI8qHsTMWIPEOWoS6tMOEWEKyenmE5ohNsTnlunAshqcfgmgOd_CMSm2dP02RzGCFL8c\n\n[UNVERIFIED] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  While New Consensus is a think tank associated with the Green New Deal, and the goal was to develop a policy agenda, a specific article from The Atlantic on June 12, 2019, stating this exact timeline and effort by New Consensus was not found in the search results.\n\n[FALSE] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (2019)\n  Reports from January 2019, including coverage of Rhodium Group data, indicated that U.S. carbon dioxide emissions rose by an estimated 3.4% in 2018, not 3.8%.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  An article from The Washington Post on April 3, 2019, discusses how Republicans for years cast doubt on climate change, but some are now acknowledging human-caused climate change.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHn7AGEZu6RA-gO93CA7m8ZUB0cTDTHO0CVP1yd347WfsTGEVgguEf3pIlHNPI5AxT7c4UqvFDtR-PQvDOQHhqJCa7-iTEQzoy8FaP76i3Otm6ucfe85un8G5lq3ArdhG2D24Q9SpY=\n\n[FALSE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change.\n  Cited source: (no source given)\n  In June 2011, Mitt Romney publicly stated that he believed the world was getting warmer and that humans contributed to it. However, his stance later shifted, and in October 2011, he said, 'We don't know what's causing climate change on this planet.' The claim that he ran on a campaign saying he 'didn't even know' if humans were a cause is an oversimplification and misrepresents his initial 2011 statement.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF2tOj2srV__voNm42S3XnJA79hw7AM4Tu6-EDkVwG49VszQbzJ4xYDHIr97UzR74tobLngl0QVqrp0gqi835VCrrHIWzYLQWRSa6aqpZ78x-S9Q7x_10v6JXXiDPhIFlDKnalrDh1BW4nsEy3pRy8KqA5folNxNWJKws_MEje5rkdO5A_n1IjT\n\n[FALSE] Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action.\n  Cited source: The Washington Post (continues from April 3, 2019, but likely a different article)\n  A Washington Post-Kaiser Family Foundation poll from summer 2019 (reported Sept 13, 2019) found that 60% of Republicans believed human activity caused climate change, and 46% of all Americans said the U.S. needs to 'drastically reduce' fossil fuel use in the next few years. Another Post-KFF poll from 2020 indicated that almost 7 in 10 Republican adults under 45 believed human activity was causing climate change. The specific numbers cited (64% Republicans, 45% Americans) for these exact claims were not found in the provided search results for the given timeframe.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEyv4mw3q1sLas2mS5BGQjelGIpaQQgc-MPZHk-FlsO5QbEyA4zOMOtME1Hgv2sbOrwJGMCvhCty2w87r_8ZSOuyB5M0-hsLQ0TEh5xe0VrQZoVRtSsv9gFPnJxHI4-xBRlzXhDEVlHHnyUA-FTmNZANwAP9m7iNMl2nBq7UD5iJVYmfLca8nhoCGHsYoPFNbAtTHE8H6rLQrvrl6_6kre2ECVZHvxZdnUSaiQKEydz-7wA5Ue1Y9GHhK_qSElgO7SlC6EhDYWTO2w8reel5bmbN4lQ-i8J0WBelF8tBjnnmQ\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen, leading Senator Lamar Alexander to propose his Manhattan Project on Clean Energy and Matt Gaetz to propose a Green Real Deal combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  A March 26, 2019, article reported that the Green New Deal was forcing a discussion on climate change among Republicans. Senator Lamar Alexander proposed a 'New Manhattan Project' for clean energy, and Representative Matt Gaetz announced plans to draft a 'Green Real Deal' offering conservative solutions.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHSy0RUhd-Avp-LYGQJfksUyQtfoJMSB4aq0IF3jw-llL8DUcFk-YPOEBAQ7DjdB7uwC3ql-6N2dW23hkk8s4nb4LhfeHninH6WCly2O4czay-VoRwrntNlEEIruzH-xo91-vt_IP0ONiIpWLD8DbY=\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators, with these pollutants linked to health problems like asthma and heart disease. The article also highlights that these incinerators are disproportionately located near low-income and minority communities.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1cBXxCktTJWQvPB3F8s5pPEyUmJVdmPPWHcoTZf2Gn0bB1NCOchV0SooL8vWVlqeS8Cfq8QRiMNxI_lzgCIhdu3trnE1gV1z06dWzfQnSKvbUWl0_8TeW4ZGzx9jgO0YdMFWUHDSTjNbLCV3Nvw4j-2yh35jAl1NXgUnLcqohxAD9WVD7B7ourRBl5tlnf3U--jToCrjF887SrgzCzlPF-OYGXA==\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act), a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and explicit hiring focus on marginalized people was not found in the search results. The date is also quite early for such detailed legislative outcomes.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) said 'we're all going to die' at the beginning of this year (2019), representing global apathy.\n  Cited source: (no source given, but attributed to IPCC scientists)\n  The IPCC reports are scientific assessments, not statements like 'we're all going to die.' While IPCC reports, such as the 2018 Special Report on Global Warming of 1.5\u00b0C, highlighted dire consequences of inaction, they do not use such emotional language. The claim of 'dead face' and 'apathetic' scientists is a dramatic interpretation, not a factual report from the IPCC.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEU0O1IACbuw1WncDR82UmpTRdRfJ4Ldr1OZNdjMeqjLD4TA9d7_rLziRd80IjyCuspuSfeimpBdyJVxvqM1fC5PdBWfwVPJvbpaNYwx_00tOi8YCX8tm3KPb2PYis3ca13LkhIPUY-AR3htuVUQ9HPGLObbjImq3XkJk6I6923\n\n[TRUE] The most sweeping piece of climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  Los Angeles Times articles from December 2018 and later confirm that the Paris Agreement sets a goal of limiting global warming to 'well below 2 degrees Celsius' and pursuing efforts for 1.5 degrees Celsius. It is also noted that the agreement, while a breakthrough, left many details to be firmed up later and lacked strong enforcement mechanisms.\n\n[TRUE] The Green New Deal originated in the UK, but AOC's accessibility has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  Multiple sources, including Wikipedia, confirm that the concept of a 'Green New Deal' originated earlier in the UK and Europe (around 2008) and was adopted by the Green Party in the U.S. in 2010, before Alexandria Ocasio-Cortez popularized it in 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest published an article on June 4, 2019, discussing how the Green New Deal concept was gaining traction internationally, including in Canada and Europe.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    opus48: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n\n**What Worked:**\n1) The AGD is genuinely creative and topically anchored \u2014 the mispronunciation bit (\"One cable pundit called her Alessandra Oxycontin\") uses real media flubs to establish the AOC-to-GND pivot, which is far more memorable than a stat or quote hook.\n2) The link from name-mangling into the drawn question is elegant and thematic: \"while we commonly know her as AOC, there are three letters also attached to her name, GND\" \u2014 the three-letters device does double duty as both a bridge and a motif.\n3) The thesis is explicit and the preview is formally numbered with escalating weight: \"First, by forcing bipartisan action... more broadly by addressing... environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm.\"\n\n**Critical Flaws:**\n1) The middle transitional word \"more broadly\" replaces a clean \"second\" in the preview \u2014 the first and third points are cleanly numbered (\"First,\" \"finally\"), but the second is softened to \"more broadly by addressing,\" creating a slight asymmetry that a flowing judge will notice as a stumble in the three-part list.\n2) The urgency-building lines pile up disconnected crises without a tight causal tie: \"We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world\" \u2014 Sudan and Yemen are dropped and abandoned, adding stakes-inflation rather than a warranted link into the GND question.\n\n**What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation. **Second,** by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"We face crises around the world, in Sudan and Yemen, but **none of those matter if the natural world collapses underneath them \u2014 which is exactly why** we have to ask today's question.\"\n\n### Structure - 8/10\n\n**What Worked:**\n1) The full skeleton is present and correctly ordered \u2014 creative AGD, clear thesis, three distinctly numbered body points, and a conclusion that re-poses the question and re-previews all three points.\n2) The transition into point three is a strong, vivid signpost that doubles as a callback structure: \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours\" \u2014 it marks the shift AND re-engages the room.\n3) The conclusion delivers a real \"So What?\" echo, not just a summary \u2014 the \"three letters\" motif resolves into \"there are only three letters we need to learn about the Green New Deal. Y-E-A,\" which ties the vote-affirmative payoff directly back to the opening AOC/GND device.\n\n**Critical Flaws:**\n1) The transition from point one into point two is functional but abrupt in its labeling: \"Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white.\" The joke lands, but there's no linking sentence connecting bipartisanship (point one's payoff) to the justice pivot \u2014 the two ideas are stacked, not bridged.\n2) TIMING & LENGTH BREAKDOWN (word-count based, mapped to the stated 470s recording): Introduction ~300 words (~24%, ~113s); Body 1 ~300 words (~24%, ~113s); Body 2 ~245 words (~19%, ~92s); Body 3 ~230 words (~18%, ~86s); Conclusion ~90 words (~7%, ~33s). Against the 14/26/26/26/7 benchmark, the Introduction runs badly hot at ~24% versus 14% \u2014 nearly 50 seconds of overrun \u2014 while Body 2 and Body 3 are underweight at ~19% and ~18% versus 26%. The competitive cost: the intro's cleverness is eating the analytical time points two and three need, which is exactly why environmental justice and the global paragraph feel thinner than the bipartisanship point.\n3) The AGD motif goes silent through most of Body 1 and Body 2 \u2014 the \"three letters\" / AOC framing appears in the intro and conclusion but not as a callback in the middle; the \"table much like yours\" callback in point three is the only mid-speech thread, leaving the first half of the body disconnected from the frame.\n\n**What You Could Have Done:**\n1) \"one that allows us to grow our economy while cutting emissions. **But bipartisan action only fixes who's at the table \u2014 it says nothing about who's been left out. Secondly,** we have to look more broadly to the question of environmental justice.\"\n2) Reallocate roughly 40-50 seconds out of the introduction \u2014 cut the doubled crisis list and one of the mispronunciation examples \u2014 and push it into Body 2 and Body 3 so each **body point reaches the ~26% benchmark and the justice and global arguments get the warrant depth point one already enjoys.**\n3) Add a mid-speech callback in Body 1: \"...forcing Republicans to actually innovate. **Those two letters, GND, are already rewriting what the other side is willing to put on paper.**\"\n\n### Strength of Argument & Analysis - 12/16\n\n**What Worked:**\n1) Point one (bipartisanship) is the strongest of the three and passes all three tests. Core claim: the GND is pressuring Republicans into proposing their own climate policy. It's WELL-SUPPORTED with two named GOP counter-proposals \u2014 \"Senator Lamar Alexander... proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal\" \u2014 and the warrant is explicit: popularity + the GND as a \"Democratic ploy... to change innovation into forcing Republicans to actually innovate.\"\n2) Point one is also FAIR \u2014 it engages the strongest opposing GOP position (\"innovation is the way that we can solve climate change\") head-on rather than a strawman, then shows how the GND weaponized that very rhetoric back at Republicans.\n3) The environmental-justice point clears the \"So What?\" test on its central evidence: the incinerator statistic (\"1.6 million Americans live near a trash incinerator... higher rates of asthma and maternal mortality\") is followed by a genuine impact \u2014 the GND's jobs guarantee and subsidies \"allow minorities to get equity\" \u2014 connecting the harm to the policy remedy.\n4) The Illinois example carries a real warrant rather than being dropped: \"40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people\" concretely demonstrates the justice-plus-energy design the point claims the GND advances.\n\n**Critical Flaws:**\n1) Point three (global paradigm) has the weakest Evidence\u2192Warrant\u2192Impact chain. Core claim: the GND is creating global climate unity. The evidence \u2014 \"candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" \u2014 proves something ADJACENT (the label is spreading) but not the thesis (that a US resolution is CAUSING global policy). The specific gap: running \"on a Green New Deal agenda\" is a campaign slogan, not enacted \"unified platform where we can all cut reductions.\" The missing \"so what\": the speaker never explains the mechanism by which AOC's US resolution actually coordinates emissions cuts across sovereign nations.\n2) Point three internally contradicts its own causal story. The speaker says the GND \"has been around before the United States proposed it... It came from the UK,\" then claims AOC \"made it more of a globally accessible source.\" If the idea originated abroad, the argument that the US version drives global adoption is undercut \u2014 the direction of influence is muddled and never resolved.\n3) The justice point's biggest analytical leap is the New Jersey line: \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators.\" The phrase \"climate and motivations on these incinerators\" is analytically incoherent \u2014 the causal claim (climate change doubled NJ asthma) is asserted with no warrant connecting incinerator siting to climate change specifically rather than to ordinary industrial pollution, which weakens the whole justice-through-GND link.\n4) VERDICT: MODERATE. Point one is STRONG and could anchor a winning speech; point two is MODERATE with strong evidence but shaky causal glue; point three is WEAK, proving diffusion of a slogan rather than the thesis's claimed global policy coordination.\n\n**What You Could Have Done:**\n1) \"the Green New Deal is creating a unified platform where we can all cut reductions. **Concretely, when Canada's opposition adopts GND targets, it imports the resolution's enforceable-timeline framework the Paris Accords lacked \u2014 that shared mechanism, not just a shared name, is how AOC's version actually coordinates cuts across borders.**\"\n2) \"ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but **what AOC added was the missing piece the UK version never had \u2014 a legislative price tag and timeline \u2014 which is what turned a slogan other countries admired into a template they could actually copy.**\"\n3) \"In my home state of New Jersey, **living near these incinerators has doubled asthma rates \u2014 and because the GND explicitly targets pollution siting in marginalized communities, it fixes the exact injustice ordinary energy bills ignore.**\"\n\n### Flaws in Reasoning - 8/12\n\n**What Worked:**\n1) The speaker avoids slippery slope in point one \u2014 the claim stays proportionate, arguing the GND produces specific GOP counter-proposals (Alexander, Gaetz) rather than escalating into an unfounded \"and this will inevitably pass sweeping legislation\" prediction.\n2) The bipartisanship argument correctly identifies correlation-vs-causation risk and partly addresses it: \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal\" \u2014 the speaker concedes the confound (popularity) rather than pretending the GND is the sole cause.\n\n**Critical Flaws:**\n1) POST HOC ERGO PROPTER HOC in point three: \"the Green New Deal is creating a unified platform\" because \"candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\" The speaker infers causation from the temporal sequence (AOC proposes it, then foreign candidates use the label) with no mechanism \u2014 and this is fatally complicated by the speaker's own admission that the concept \"came from the UK\" first, meaning the foreign adoption may predate or run independent of AOC entirely. Severity: undermines the whole third point.\n2) UNPROVEN CAUSAL LEAP on the New Jersey asthma claim: \"it's doubled the rate of asthma because of climate and motivations on these incinerators.\" Incinerator pollution and climate change are conflated as if identical; particulate emissions causing asthma is not the same phenomenon as greenhouse warming, and the speaker never bridges them. Missing content: the speaker needed to say the GND treats local pollution and carbon as a joint problem \u2014 that link would rescue the claim, but as delivered it's a category error. Severity: soft spot that weakens, but doesn't collapse, point two.\n3) APPEAL TO POPULARITY substituting for policy merit: \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" and \"45% of all Americans believe that we need immediate action.\" Public opinion is presented as evidence the GND WILL influence legislation, but popularity of a goal does not establish that this specific 14-page resolution is the causal driver \u2014 the 45% figure is actually a MINORITY, quietly undercutting the \"forcing\" framing. Severity: moderate; weakens the strength of point one's central claim.\n3b) HYPERBOLE substituting for analysis: the IPCC scientists \"said, we're all going to die\" and \"if we're not careful about climate change, we're all gonna have to move to the moon.\" These are rhetorical flourishes standing in for the actual stakes argument \u2014 entertaining, but they replace a warranted impact (\"here is what 1.5\u00b0C of overshoot concretely costs\") with a punchline. Severity: minor, but it recurs and thins the analytical payload.\n4) MISSING COUNTERARGUMENT on cost: the speaker jokes about \"the $93 trillion Green New Deal\" but never engages the most obvious opposition rebuttal \u2014 that a $93T price tag is precisely why bipartisan action is UNLIKELY. Supplying the missing content: an opponent would argue the cost makes Republican adoption of the actual GND (versus their own cheaper counter-proposals) implausible, which would force the speaker to clarify that his thesis is about the GND as an \"influence/bedrock,\" not as literally passable \u2014 a distinction he gestures at (\"We're not simply going to just pass this 14-page resolution\") but never fully defends.\n\n**What You Could Have Done:**\n1) \"the Green New Deal is creating a unified platform where we can all cut reductions. **The UK may have coined the idea, but AOC's version is what these campaigns are actually citing by name \u2014 so the influence runs through her legislative framing, not just a shared slogan.**\"\n2) \"In my home state of New Jersey, it's doubled the rate of asthma **from incinerator pollution \u2014 and the GND is the first proposal to treat that local pollution and carbon emissions as one connected fight, which is exactly why it reaches communities past bills ignored.**\"\n3) \"45% of all Americans believe that we need immediate action **\u2014 and while that's not yet a majority, it's a doubling since Romney's 2011 campaign, and it's the trajectory, not the current number, that's forcing Republicans to move.**\"\n\n### Strength of Evidence - 13/16\n\n**What Worked:**\n1) High source density and authoritative outlets \u2014 nine distinct sources across three points (The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, LA Times, New York Times, The National Interest), well above the 1-2-per-point benchmark and drawn from credible, mainstream-to-elite publications.\n2) Nearly every citation carries a specific date: \"The Atlantic tells us on June the 12th of 2019,\" \"Politico on March the 26th of 2019,\" \"The Guardian... on May the 21st of 2019,\" \"Vox on March the 7th of 2019.\" For a June-2019 speech on a fast-moving policy story, these are impeccably recent \u2014 days-to-weeks old \u2014 which is exactly the timeliness the topic's pace demands.\n3) Evidence is genuinely applied, not name-dropped, in point one: the Politico citation directly yields the two named GOP counter-proposals (Alexander's \"Manhattan Project on Clean Energy,\" Gaetz's \"Green Real Deal\"), which is the evidence doing real proving-work for the claim.\n\n**Critical Flaws:**\n1) Two of the nine sources have DEGRADED date precision: \"the Los Angeles Times from December of 2018\" and \"the New York Times, from March of 2019\" give month-and-year only, no day, and both anchor the weakest point (global paradigm). The LA Times source is also six months old on a topic the speaker himself calls one where \"we don't have much time to waste\" \u2014 a slight timeliness mismatch for the point already carrying the heaviest causal burden.\n2) The $93 trillion figure \u2014 the speech's single most dramatic number \u2014 is cited with NO source at all (\"I'd be able to pay for the $93 trillion Green New Deal\"). This is the exact figure most contested by opponents, and delivering it bare, as a punchline, means its accuracy and provenance can't be verified by a judge.\n3) The New York Times claim that the GND \"came from the UK\" is a strong, counterintuitive assertion carrying real argumentative weight (it partly contradicts point three), yet it's supported only by a month-only citation with no specificity about what the article actually documented \u2014 the load-bearing historical claim is under-sourced relative to its importance.\n\n**What You Could Have Done:**\n1) \"the Los Angeles Times **this month** that the most sweeping piece of climate legislation we have... **is the Paris Climate Accords** \u2014 swap in a more recent source, or explicitly acknowledge the six-month gap and why the Accords' structure hasn't changed since.\n2) \"I'd be able to pay for the $93 trillion Green New Deal **\u2014 a figure from the American Action Forum's February 2019 analysis** \u2014 folding the source into the joke so the number survives an opponent's challenge.\n3) \"the New York Times, from March **the 12th of** 2019, that ultimately the Green New Deal... came from the UK, **where the New Economics Foundation first published the framework in 2008** \u2014 grounding the historical claim in the specific origin the article documented.\n\n### Clarity - 8/10\n\n**What Worked:**\n1) Signposting is verbally explicit throughout \u2014 \"First,\" \"Secondly,\" \"Finally, and perhaps most importantly\" \u2014 a listener without the transcript could track their exact place in the speech at every seam.\n2) The wit is largely accessible and sharpens rather than obscures \u2014 \"while the climate movement is right, they're also very white\" and \"a cross between a Comic-Con convention and a Bernie Sanders rally\" compress a real demographic point into a line a judge grasps instantly.\n3) Technical terms are consistently unpacked for a lay judge \u2014 \"environmental justice\" is immediately illustrated (incinerators, asthma, jobs guarantee), and \"the Paris Climate Accords\" is explained (\"proposes a goal, 1.5 degrees of Celsius... with no actual mechanism\").\n\n**Critical Flaws:**\n1) One genuinely garbled phrase a live judge would stumble on: \"it's doubled the rate of asthma because of climate and motivations on these incinerators.\" The words \"climate and motivations on these incinerators\" do not parse \u2014 it reads like a compression of two half-finished thoughts.\n2) Awkward, redundant construction: \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate.\" Both the stutter (\"the that the\") and \"This is a showing that... is part of a way to\" are clunky throat-clearing; \"This shows the Green New Deal is guiding future climate debate\" is tighter.\n3) Vague pronoun in point two: \"This is great because we're designing a new future where we won't just have a world where we're not swimming all the time.\" \"This\" has no clear antecedent (the jobs guarantee? the whole GND? the equity subsidies?), and \"a world where we're not swimming all the time\" is an under-cooked image that a listener has to decode mid-sentence.\n4) A mid-speech sentence fragment breaks the flow: \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" \u2014 the period-then-lowercase \"to come to bipartisan solutions\" leaves a dangling clause; it should be one connected sentence.\n5) Minor filler/hedge redundancy: \"we're not simply going to just pass\" stacks \"simply,\" \"just,\" and the negation for one idea \u2014 verbal padding around a simple point.\n6) VERDICT: MODERATELY CLEAR \u2014 strong signposting and accessible wit, dragged down by two genuinely garbled sentences on the justice point and a scatter of clunky constructions.\n\n**What You Could Have Done:**\n1) \"In my home state of New Jersey, **incinerator pollution has doubled asthma rates.**\"\n2) \"**This shows the Green New Deal is already guiding future climate debate.**\"\n3) \"**The jobs guarantee is what makes this transformative \u2014 we're designing a future that isn't just greener, but fairer.**\"\n4) \"We're not going to pass this 14-page resolution **as-is; instead it pushes us toward** bipartisan solutions like a carbon tax.\"\n5) \"We're **not going to pass** this 14-page resolution as-is.\"\n\n### Conclusion Strength - 7/8\n\n**What Worked:**\n1) The summary accurately and cleanly re-states all three points in order: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 a faithful, floweable recap.\n2) The AGD echo is genuinely satisfying and intentional \u2014 the \"three letters\" motif that opened the speech (AOC / GND) resolves into a punchline call to action: \"there are only three letters we need to learn about the Green New Deal. Y-E-A.\" It converts the running device into an implicit vote-affirmative close.\n3) The moon callback (\"We landed a man on the moon, and if we're not careful... we're all gonna have to move to the moon\") gives the conclusion a forward-looking stakes beat before the summary.\n\n**Critical Flaws:**\n1) The \"Y-E-A\" close is clever but functions as a partisan endorsement rather than an analytical answer to an analysis question \u2014 the drawn question asked HOW the GND will influence legislation, and ending on \"vote yea\" subtly shifts from prediction to advocacy, which a purist judge may ding.\n2) The moon line is a pun (\"move to the moon\") standing in for a concrete forward-looking insight \u2014 it's entertaining but adds no new analytical content beyond generic \"climate is urgent.\"\n\n**What You Could Have Done:**\n1) \"there are only three letters we need to learn about the Green New Deal **\u2014 and whatever you think of the price tag, GND is the framework every future climate bill will now be measured against.**\"\n2) \"We landed a man on the moon **through the same forced, bipartisan, generational mobilization the Green New Deal is now triggering \u2014 that's the influence, and it's already underway.**\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 17/20\n\n**What Worked:**\n1) Pace is dialed to competitive ideal \u2014 160 wpm over 470s sits squarely in the 150-175 target, fast enough to convey urgency but controlled enough that the dense nine-source case remains followable.\n2) Tone/pitch variety is excellent \u2014 3151 pitch shifts and an 81.6Hz std-dev rated \"High \u2014 expressive,\" which tracks the content's comedic-to-serious swings (the mispronunciation jokes vs. the IPCC \"we're all going to die\" beat).\n3) Filler discipline is elite \u2014 only 4 crutch words in a ~1250-word speech (\"actually\"\u00d71, \"like\"\u00d73), and a single stutter (\"the that the\"). For a speech this dense, that's a near-clean fluency record.\n\n**Critical Flaws:**\n1) EMPHASIS PLACEMENT is the clear weak spot: of 245 emphasized words, a heavy cluster lands on function words rather than rhetorical anchors \u2014 \"tells us on **THE** Atlantic,\" \"resolution into **A** sweeping policy,\" \"the answer simply is **THAT** it will serve,\" \"on climate mitigation. **MORE**.\" Spiking loudness on \"THE,\" \"A,\" \"THAT,\" and \"IN\" wastes emphasis that should be landing on the numbers ($93 trillion, 64%, 1.5 degrees) and thesis nouns (bedrock, bipartisan, justice).\n2) VOLUME is only adequate \u2014 average -23.1 dBFS (subscore 8/10), below the -18 dBFS strong-projection threshold. In a flight, this reads as slightly under-projected next to a competitor who fills the room.\n3) The single stutter (\"This is a showing that the that the Green New Deal\") is minor in count but lands mid-warrant, momentarily muddying the point-one payoff sentence.\n4) PAUSES are sparse \u2014 only 7 pauses over 0.4s in a 470s speech. With so few strategic silences, the punchlines (Oxycontin, Comic-Con, \"we're all going to die\") get less room to land than a well-timed beat before each would allow.\n\n**What You Could Have Done:**\n1) Redirect loudness spikes off function words and onto load-bearing terms: hit **$93 trillion**, **64%**, **1.5 degrees**, and **bedrock** \u2014 the numbers and thesis words are what a judge flows, not \"THE\" and \"A.\"\n2) Push projection up roughly 5 dB toward the **-18 dBFS** threshold so the delivery fills the room and reads as confident rather than merely adequate.\n3) Slow and re-articulate the point-one payoff so the **stutter disappears**: \"This shows the Green New Deal is guiding future climate debate.\"\n4) Insert deliberate **beat-pauses before each punchline** \u2014 a half-second of silence before \"Y-E-A\" and before \"we're all going to die\" would let the comedy and the pathos both land harder.\n\n### Total Composite Score: 80/100\n\n### Judge's Rank: 2/5\n\n### Rank Explanation: This speech would place 2nd against five other competitors on this question. Its strengths are real and tournament-caliber: a creative, self-referential \"three letters\" motif that bookends the speech cleanly, elite source density with near-perfect date discipline, a genuinely strong bipartisanship point that engages the opposition's actual position, and confident, expressive delivery at competitive pace with almost no filler. What keeps it out of the one-slot is analytical erosion across the back half \u2014 the global-paradigm point rests on a post hoc leap fatally complicated by the speaker's own admission that the idea \"came from the UK,\" the environmental-justice point conflates incinerator pollution with climate change in a garbled sentence, and the single most dramatic number ($93 trillion) is delivered with no source at all. The intro also runs badly hot at ~24%, starving points two and three of the warrant depth point one enjoys. This is a witty, well-researched speaker whose case is front-loaded; tighten the causal chains in points two and three and rebalance the time, and this is a 1.\n\n### Actionable Drill for Next Round: Run a \"So What / Says Who\" gauntlet on point three only. Write the third point's core claim (\"the GND is creating global climate unity\") at the top of a page. Underneath, for each piece of evidence you cite (Spain/Sweden/Norway/Canada campaigns, the UK origin, the Paris Accords), write two forced sentences: (1) the exact causal MECHANISM linking that evidence to the claim \u2014 how does a US resolution actually coordinate emissions cuts across sovereign borders? \u2014 and (2) how you reconcile it with the fact the idea originated in the UK. Then rebuild the point out loud using only claims you could complete both sentences for. Repeat until the post hoc leap and the origin contradiction are both resolved before you speak them.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal last November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  Alexandria Ocasio-Cortez and Senator Edward Markey released a 14-page resolution for their Green New Deal (House Resolution 109) on February 7, 2019, which aligns with the 'last November' (2018) timeframe for its initial proposal or discussion, preceding the formal resolution.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific article from The Atlantic on June 12, 2019, was not found, other sources from early 2019 indicate that the Green New Deal, or its core concepts, had broad popularity among voters (including some Republicans initially) but also faced significant political polarization and opposition.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE9SsjgxWKh0zU9RPgtIz9bZPXgjQsZQFFXTsohMGhp1e6NmPyCI4CM5DFffvH77Ljrqw-Qjf420HhNF-vy_0Cf3XJDMwOWUD1hCSneSkA2thHgwHnEaJtQSTZcAX_UqQyVUlkRZRbty4nec3qmormIGNipWIlflMaoY202w8s54zWltA0PGtHqJAKWvEXQzjtnyu6MI8qHsTMWIPEOWoS6tMOEWEKyenmE5ohNsTnlunAshqcfgmgOd_CMSm2dP02RzGCFL8c\n\n[UNVERIFIED] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  While New Consensus is a think tank associated with the Green New Deal, and the goal was to develop a policy agenda, a specific article from The Atlantic on June 12, 2019, stating this exact timeline and effort by New Consensus was not found in the search results.\n\n[FALSE] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (2019)\n  Reports from January 2019, including coverage of Rhodium Group data, indicated that U.S. carbon dioxide emissions rose by an estimated 3.4% in 2018, not 3.8%.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  An article from The Washington Post on April 3, 2019, discusses how Republicans for years cast doubt on climate change, but some are now acknowledging human-caused climate change.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHn7AGEZu6RA-gO93CA7m8ZUB0cTDTHO0CVP1yd347WfsTGEVgguEf3pIlHNPI5AxT7c4UqvFDtR-PQvDOQHhqJCa7-iTEQzoy8FaP76i3Otm6ucfe85un8G5lq3ArdhG2D24Q9SpY=\n\n[FALSE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change.\n  Cited source: (no source given)\n  In June 2011, Mitt Romney publicly stated that he believed the world was getting warmer and that humans contributed to it. However, his stance later shifted, and in October 2011, he said, 'We don't know what's causing climate change on this planet.' The claim that he ran on a campaign saying he 'didn't even know' if humans were a cause is an oversimplification and misrepresents his initial 2011 statement.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF2tOj2srV__voNm42S3XnJA79hw7AM4Tu6-EDkVwG49VszQbzJ4xYDHIr97UzR74tobLngl0QVqrp0gqi835VCrrHIWzYLQWRSa6aqpZ78x-S9Q7x_10v6JXXiDPhIFlDKnalrDh1BW4nsEy3pRy8KqA5folNxNWJKws_MEje5rkdO5A_n1IjT\n\n[FALSE] Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action.\n  Cited source: The Washington Post (continues from April 3, 2019, but likely a different article)\n  A Washington Post-Kaiser Family Foundation poll from summer 2019 (reported Sept 13, 2019) found that 60% of Republicans believed human activity caused climate change, and 46% of all Americans said the U.S. needs to 'drastically reduce' fossil fuel use in the next few years. Another Post-KFF poll from 2020 indicated that almost 7 in 10 Republican adults under 45 believed human activity was causing climate change. The specific numbers cited (64% Republicans, 45% Americans) for these exact claims were not found in the provided search results for the given timeframe.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEyv4mw3q1sLas2mS5BGQjelGIpaQQgc-MPZHk-FlsO5QbEyA4zOMOtME1Hgv2sbOrwJGMCvhCty2w87r_8ZSOuyB5M0-hsLQ0TEh5xe0VrQZoVRtSsv9gFPnJxHI4-xBRlzXhDEVlHHnyUA-FTmNZANwAP9m7iNMl2nBq7UD5iJVYmfLca8nhoCGHsYoPFNbAtTHE8H6rLQrvrl6_6kre2ECVZHvxZdnUSaiQKEydz-7wA5Ue1Y9GHhK_qSElgO7SlC6EhDYWTO2w8reel5bmbN4lQ-i8J0WBelF8tBjnnmQ\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen, leading Senator Lamar Alexander to propose his Manhattan Project on Clean Energy and Matt Gaetz to propose a Green Real Deal combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  A March 26, 2019, article reported that the Green New Deal was forcing a discussion on climate change among Republicans. Senator Lamar Alexander proposed a 'New Manhattan Project' for clean energy, and Representative Matt Gaetz announced plans to draft a 'Green Real Deal' offering conservative solutions.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHSy0RUhd-Avp-LYGQJfksUyQtfoJMSB4aq0IF3jw-llL8DUcFk-YPOEBAQ7DjdB7uwC3ql-6N2dW23hkk8s4nb4LhfeHninH6WCly2O4czay-VoRwrntNlEEIruzH-xo91-vt_IP0ONiIpWLD8DbY=\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators, with these pollutants linked to health problems like asthma and heart disease. The article also highlights that these incinerators are disproportionately located near low-income and minority communities.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1cBXxCktTJWQvPB3F8s5pPEyUmJVdmPPWHcoTZf2Gn0bB1NCOchV0SooL8vWVlqeS8Cfq8QRiMNxI_lzgCIhdu3trnE1gV1z06dWzfQnSKvbUWl0_8TeW4ZGzx9jgO0YdMFWUHDSTjNbLCV3Nvw4j-2yh35jAl1NXgUnLcqohxAD9WVD7B7ourRBl5tlnf3U--jToCrjF887SrgzCzlPF-OYGXA==\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act), a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and explicit hiring focus on marginalized people was not found in the search results. The date is also quite early for such detailed legislative outcomes.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) said 'we're all going to die' at the beginning of this year (2019), representing global apathy.\n  Cited source: (no source given, but attributed to IPCC scientists)\n  The IPCC reports are scientific assessments, not statements like 'we're all going to die.' While IPCC reports, such as the 2018 Special Report on Global Warming of 1.5\u00b0C, highlighted dire consequences of inaction, they do not use such emotional language. The claim of 'dead face' and 'apathetic' scientists is a dramatic interpretation, not a factual report from the IPCC.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEU0O1IACbuw1WncDR82UmpTRdRfJ4Ldr1OZNdjMeqjLD4TA9d7_rLziRd80IjyCuspuSfeimpBdyJVxvqM1fC5PdBWfwVPJvbpaNYwx_00tOi8YCX8tm3KPb2PYis3ca13LkhIPUY-AR3htuVUQ9HPGLObbjImq3XkJk6I6923\n\n[TRUE] The most sweeping piece of climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  Los Angeles Times articles from December 2018 and later confirm that the Paris Agreement sets a goal of limiting global warming to 'well below 2 degrees Celsius' and pursuing efforts for 1.5 degrees Celsius. It is also noted that the agreement, while a breakthrough, left many details to be firmed up later and lacked strong enforcement mechanisms.\n\n[TRUE] The Green New Deal originated in the UK, but AOC's accessibility has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  Multiple sources, including Wikipedia, confirm that the concept of a 'Green New Deal' originated earlier in the UK and Europe (around 2008) and was adopted by the Green Party in the U.S. in 2010, before Alexandria Ocasio-Cortez popularized it in 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest published an article on June 4, 2019, discussing how the Green New Deal concept was gaining traction internationally, including in Canada and Europe.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    kimik3: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n- **What Worked:**\n1) The AGD is genuinely creative and specific \u2014 opening with cable pundits mangling AOC's name (\"One cable pundit called her Alessandra Oxycontin\") is a memorable, humorous narrative hook rather than a clich\u00e9 quote or statistic.\n2) The \"three letters\" device is a clever structural frame: \"while we commonly know her as AOC, there are three letters also attached to her name, GND\" converts the hook into a substantive link without an awkward gap.\n3) The thesis is explicit and answers the exact question drawn: \"The answer simply is that it will serve as the bedrock for future environmental legislation\" \u2014 no ambiguity about the speaker's side.\n4) The preview formally marks all three points: \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally... by leading to a new global paradigm on climate policy.\"\n- **Critical Flaws:**\n1) The Lou Dobbs joke misfires logically \u2014 \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" delivers the *correct* pronunciation as the punchline, so the sarcasm lands only if the audience already knows Dobbs mispronounced it; as written, the joke contradicts the setup that pundits \"are not always successful.\"\n2) The intro spends significant time on background summary (the Atlantic history of the resolution, New Consensus's 2020 agenda) before arriving at the question, delaying the link-to-question moment well past where a judge expects it.\n- **What You Could Have Done:**\n1) \"One cable pundit called her Alessandra Oxycontin**, and Lou Dobbs \u2014 the self-styled paradigm of journalistic integrity \u2014 managed to invent three entirely new syllables trying.**\"\n2) \"**We don't have much time to waste \u2014 emissions rose 3.8% last year alone. So before I trace the history of this resolution, let's answer the question that matters:** How will the Green New Deal influence future environmental legislation?\"\n\n### Structure - 8/10\n- **What Worked:**\n1) The full skeleton is present and correctly ordered: single AGD, link, explicit thesis, three-point preview, three distinct body paragraphs, and a conclusion that re-previews the points.\n2) The point-two-to-point-three transition is signposted with a vivid mini-AGD: \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die\" \u2014 a real transitional moment, not an abrupt jump.\n3) The conclusion delivers a genuine callback to the hook: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 the letters device bookends the speech intentionally.\n4) Timing breakdown (word-count-based, against the 470s recording): Introduction ~24% (~113s), Body 1 ~22% (~103s), Body 2 ~22% (~103s), Body 3 ~20% (~94s), Conclusion ~12% (~56s). The three body points are evenly weighted, which is a real strength.\n- **Critical Flaws:**\n1) The intro runs severely hot at ~24% versus the 14% benchmark (~113s vs. ~66s) \u2014 nearly a minute of background on the Atlantic article and New Consensus crowds out body development time, and the conclusion at ~12% (~56s vs. the 7%/~33s target) is correspondingly padded with a re-asked question and re-stated thesis.\n2) The intro-to-body-one transition is abrupt: the speaker jumps from the preview straight into \"Republicans for years have said that innovation is the way that we can solve climate change\" with no linking sentence connecting the preview to the innovation framing.\n3) There are no mid-body callbacks to the AOC-name hook \u2014 the letters device goes silent through all three body points and only resurfaces in the final sentence, so the throughline disappears for the middle four minutes.\n- **What You Could Have Done:**\n1) \"**We don't have much time to waste, so let's get straight to the question.** How will the Green New Deal influence future environmental legislation?\" \u2014 cutting the New Consensus paragraph entirely to bring the intro toward ~15%.\n2) \"...by leading to a new global paradigm on climate policy. **Let's start where the political fight is fiercest.** Republicans for years have said that innovation is the way that we can solve climate change.\"\n3) \"**Just as pundits fumbled AOC's name, Republicans fumbled her policy \u2014 until now.** An article from the Washington Post tells us on April the 3rd of 2019...\"\n\n### Strength of Argument & Analysis - 11/16\n- **What Worked:**\n1) Point 1's core claim \u2014 the GND forces bipartisan action \u2014 is well-supported and convincing: the Politico evidence (Alexander's \"Manhattan Project on Clean Energy,\" Gaetz's \"Green Real Deal\") shows named Republicans responding, and the speaker supplies the warrant: \"they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate.\" Evidence \u2192 warrant \u2192 thesis link is complete.\n2) Point 2's core claim \u2014 the GND democratizes climate policy via environmental justice \u2014 has the strongest \"so what\" moment in the speech: \"We're making sure that those who have been the most marginalized by our pollution are now the most advantaged\" explicitly explains why the Illinois bill matters rather than dropping it.\n3) Point 3's diagnosis of the Paris Accords is analytically sharp: \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" identifies a concrete gap that the GND-as-paradigm claim can plausibly fill.\n4) Point 1 engages the opposing view fairly at the top \u2014 \"Republicans for years have said that innovation is the way that we can solve climate change\" \u2014 then refutes it with the Romney 2011 evidence rather than ignoring it.\n- **Critical Flaws:**\n1) Point 3 proves something adjacent but not the thesis. The claim is that the GND creates \"a new unified global paradigm,\" but the NYT evidence concedes \"the Green New Deal has been around before the United States proposed it in 2018. It came from the UK\" \u2014 if the concept predates AOC's resolution, foreign candidates running on it doesn't prove *this* resolution influenced *future* legislation; the missing warrant is a sentence explaining why the U.S. version, specifically, is what globalized the agenda.\n2) Point 1's causal attribution is asserted, not demonstrated: \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal\" \u2014 the speaker never shows Alexander or Gaetz citing the GND; the missing \"so what\" is that correlation between the GND's introduction and GOP proposals isn't proof of influence without a statement, vote, or timeline linking them.\n3) Point 2's New Jersey claim is dropped without a warrant: \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" \u2014 no source, no mechanism, and the phrase \"climate and motivations\" is incoherent; the missing analysis is who conducted the study and how incinerator proximity (not \"climate\") drives the asthma rate.\n4) The \"$93 trillion\" figure is used only as a joke (\"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\") and never engaged as a substantive cost objection \u2014 the strongest argument against the GND-as-bedrock thesis is waved off, leaving the fairness test unmet at the speech level.\n- **Verdict: MODERATE** \u2014 Point 1 is genuinely convincing, Point 2 is strong on impact but soft on evidence, and Point 3's own sourcing undercuts its causal chain.\n- **What You Could Have Done:**\n1) \"It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. **That's the mechanism: before her resolution, 'Green New Deal' was a British think-tank phrase; after it, the National Interest shows candidates in Spain, Sweden, Norway, and Canada running on it as a platform \u2014 the U.S. resolution is what turned a concept into a campaign.**\"\n2) \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal**. Neither Alexander nor Gaetz proposed climate legislation in a decade in Congress \u2014 both moved within sixty days of the GND's introduction, and Gaetz explicitly branded his bill the 'Green Real Deal,' a direct response in name and substance.**\"\n3) \"In my home state of New Jersey, it's doubled the rate of asthma **\u2014 a Rutgers environmental health study found communities within a mile of the Newark incinerator suffer asthma at twice the state average, because particulate matter from incineration concentrates in the low-income neighborhoods zoned around them.**\"\n4) \"**Yes, critics peg the cost at $93 trillion \u2014 but that figure prices in the jobs guarantee and health care, not just energy, and the point of this speech is that even its critics are now legislating in its shadow.**\"\n\n### Flaws in Reasoning - 8/12\n- **What Worked:**\n1) The speaker avoids slippery-slope escalation \u2014 claims stay proportionate to evidence (e.g., the GND \"guides\" future debate rather than \"guaranteeing\" passage), and no fallacy of that type appears.\n2) The internal framing is consistent: \"bedrock\" is defined in the thesis and each point ties back to influence on *future* legislation rather than drifting into whether the GND itself should pass.\n- **Critical Flaws:**\n1) **Post hoc ergo propter hoc** in Point 1: \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" \u2014 the speaker's own sentence offers two causes (poll numbers AND the GND), then attributes the GOP shift to the GND without ruling out the polling explanation he himself cites. Severity: undermines Point 1's causal core, though the Gaetz naming evidence partially rescues it.\n2) **Hasty generalization** in Point 2: \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" \u2014 a joke substituting for evidence that the movement is demographically exclusionary; one punchline cannot establish the premise the entire point rests on. Severity: minor-to-moderate; the Guardian incinerator data does the real work anyway.\n3) **Straw man** in Point 1's framing of the GOP position: \"Republicans saw climate change as a figment of political imagination\" backed by a 2011 Romney quote \u2014 using an eight-year-old primary statement to represent the 2019 Republican position, when the speaker's own evidence shows the position has already evolved to \"innovation.\" Severity: moderate; it weakens the fairness of the setup.\n4) **Unproven causal leap** in Point 3: candidates in \"Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" is asserted to be the GND \"creating a unified platform\" \u2014 but the NYT evidence dates the concept to the UK before 2018, so the speaker never proves these foreign campaigns descend from AOC's resolution rather than the earlier British lineage. Severity: significant; it's the gap that keeps Point 3 from proving the thesis.\n- **What You Could Have Done:**\n1) \"The Green New Deal and the poll numbers are finally forcing Republicans to listen **\u2014 and while the polls set the stage, the GND wrote the script: Gaetz didn't name his bill the 'Green Real Deal' because of a poll.**\"\n2) \"**The climate movement's leadership and membership remain overwhelmingly white and affluent \u2014 which is why frontline communities have historically been afterthoughts in climate bills.**\"\n3) \"**As recently as 2016, the GOP platform rejected climate action outright \u2014 Romney's 2011 skepticism was the norm, not the exception \u2014 which makes the post-GND shift to actual proposals all the more striking.**\"\n4) \"**The concept may have been born in the UK, but the National Interest shows these candidates campaigning on it only after AOC's resolution made it a global brand \u2014 the U.S. version is the node that connected the network.**\"\n\n### Strength of Evidence - 12/16\n- **What Worked:**\n1) Source count and diversity exceed benchmark: eight unique citations (The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, plus National Interest) \u2014 roughly 2-3 per point, all reputable outlets.\n2) Dating discipline is strong: nearly every citation carries a day/month/year (\"The Atlantic tells us on June the 12th of 2019,\" \"Politico on March the 26th of 2019,\" \"The Guardian... on May the 21st of 2019\"), appropriate for a 2019 topic.\n3) The Politico citation is the best-applied evidence in the speech \u2014 named senators, named proposals, directly proving the \"bipartisan action\" claim rather than decorative name-dropping.\n- **Critical Flaws:**\n1) The Scientific American citation is under-specified: \"an article from the Scientific American from January of this year that emissions rose by 3.8%\" \u2014 no day attached, and no scope given (U.S. emissions? global?), so the statistic can't be weighed.\n2) The National Interest citation is misattributed in delivery: \"The national interest tells us on June the 4th of 2019\" appears mid-sentence inside the NYT discussion with no signposting that a new source has begun, making it flow as if the NYT said it.\n3) The New Jersey asthma doubling claim carries no citation at all \u2014 \"it's doubled the rate of asthma\" is the single most striking statistic in the speech and the only one delivered with zero sourcing.\n4) The Washington Post polling evidence is garbled as delivered: \"Republicans, now 64%, believe that climate change is a severe threat\" \u2014 64% of Republicans believing climate change is a severe threat is implausible on its face and likely a misread of an all-Americans figure; as delivered, the citation's application is confusing.\n- **What You Could Have Done:**\n1) \"**An article from Scientific American on January 8th of this year shows U.S. carbon emissions rose 3.8% in 2018 \u2014 the largest increase in eight years.**\"\n2) \"**And it's not just the New York Times \u2014 the National Interest reported on June 4th of 2019 that** candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\"\n3) \"**According to a Rutgers environmental health study,** in my home state of New Jersey, **living near these incinerators has** doubled the rate of asthma.\"\n4) \"**The Washington Post continues that 64% of Americans \u2014 including a growing share of Republicans \u2014** believe that climate change is a severe threat to our future survival.\"\n\n### Clarity - 7/10\n- **What Worked:**\n1) Signposting is consistent and audible: \"This is the first way...\", \"Secondly, we have to look more broadly...\", \"Finally, and perhaps most importantly...\" \u2014 a listener without the transcript can track position throughout.\n2) Technical terms are mostly made accessible: GND is defined on first use (\"GND, standing for the Green New Deal\"), and the Paris Accords' \"1.5 degrees\" is explained as \"a goal... with no actual mechanism.\"\n3) The conclusion's re-preview (\"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\") is crisply parallel to the intro preview.\n- **Critical Flaws:**\n1) Awkward phrasing: \"because of climate and motivations on these incinerators\" is word salad \u2014 the intended claim is presumably \"because of pollution from these incinerators.\"\n2) Awkward phrasing: \"This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it\" \u2014 \"we can change that\" collides with the point's actual claim; rephrase to \"This is the second way the Green New Deal is influencing future environmental legislation.\"\n3) Broken sentence: \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" \u2014 the fragment after the period has no subject; it should read \"We're not simply going to pass this 14-page resolution; we're going to use it to come to bipartisan solutions like a carbon tax.\"\n4) Vague pronoun: \"The problem with it is it proposes a goal\" \u2014 both \"it\"s refer to the Paris Accords, but stacked back-to-back they force a stumble; \"The problem is that it proposes a goal\" is cleaner.\n5) Filler/hedge audit (text-based): \"just\" appears as padding in \"We're not simply going to just pass,\" \"we've often looked to just alternative energy,\" and \"isn't just a greener world\"; \"very\" in \"they're also very white\" and \"sat very apathetically\" \u2014 low overall, but clustered at key lines.\n- **Verdict: MODERATELY CLEAR** \u2014 the skeleton is easy to follow, but three garbled sentences land at analytically important moments.\n- **What You Could Have Done:**\n1) \"In my home state of New Jersey, **living near these incinerators has** doubled the rate of asthma.\"\n2) \"This is the second way **the Green New Deal is influencing** future environmental legislation \u2014 by democratizing it with environmental justice.\"\n3) \"We're not simply going to pass this 14-page resolution**; we're going to use it as leverage** to come to bipartisan solutions like a carbon tax.\"\n4) \"The problem **is that the Accords propose** a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there.\"\n\n### Conclusion Strength - 7/8\n- **What Worked:**\n1) The summary accurately restates all three points in preview-parallel language: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\"\n2) The callback is the best moment of the speech: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 it resolves the name-mispronunciation hook with a genuine twist (GND \u2192 YEA) rather than a flat restatement.\n3) The question is explicitly re-asked and re-answered (\"How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock\"), giving the judge a clean flowable close.\n- **Critical Flaws:**\n1) The moon line is a missed opportunity that veers toward flippancy: \"if we're not careful about climate change, we're all gonna have to move to the moon\" \u2014 it undercuts the urgency the conclusion is trying to build and adds no analytical weight.\n2) There is no forward-looking \"so what\" beyond the pun \u2014 no statement of what happens if the GND's influence fails or what the audience should watch for (e.g., the 2020 New Consensus agenda mentioned in the intro is never recalled).\n- **What You Could Have Done:**\n1) \"We landed a man on the moon **because this country decided the impossible was a deadline, not a dream \u2014 the Green New Deal sets that same kind of deadline for our own planet.**\"\n2) \"**Watch the 2020 agenda New Consensus releases \u2014 every provision in it will trace back to this 14-page resolution.** AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\"\n\n### Speech Quality - 16/20\n- **What Worked:**\n1) Pace is squarely competitive: 160 WPM over 470s sits in the 150-175 target band \u2014 brisk enough to hold energy, controlled enough to flow.\n2) Tone/pitch variety is a standout: 3151 significant pitch shifts with 81.6Hz std-dev (\"High \u2014 expressive\") \u2014 the delivery tracks the content's humor and urgency rather than reading flat.\n3) Filler discipline is excellent: only 4 auto-detected fillers (\"actually\"\u00d71, \"like\"\u00d73) and 1 stutter across a ~7-minute speech \u2014 my own read confirms \"like\" in \"a table much like yours\" is grammatical, not a crutch, so the true crutch count is even lower.\n4) Emphasis frequently lands on rhetorically important words: \"SOLVE,\" \"DON'T have much time,\" \"WILL the Green New Deal,\" and the signpost cue \"MORE broadly\" are exactly where a judge wants vocal weight.\n- **Critical Flaws:**\n1) Volume is merely adequate at -23.1 dBFS (subscore 8/10) \u2014 below the -18 dBFS strong-projection threshold; in a large round room this reads as under-projected, particularly on the quieter evidentiary stretches.\n2) Emphasis placement is erratic in the intro: spikes land on function words \u2014 \"THE Atlantic,\" \"MET with,\" \"TO transform,\" \"IN an article,\" \"THAT it will serve\" \u2014 diluting the impact of the well-placed hits; roughly a third of the sampled emphasized words are articles, prepositions, or conjunctions.\n3) Only 7 pauses over 0.4s in 470 seconds (averaging 1.05s) \u2014 the delivery rarely stops to let a joke or a thesis land; the \"Alessandra Oxycontin\" punchline and the \"Y-E-A\" close both deserve a beat of silence they don't get.\n4) The opening line triple-emphasizes \"CABLE NEWS PUNDITS LOVE\" \u2014 front-loading four spikes in the first sentence leaves the actual punchline (the mispronunciations) with less dynamic contrast.\n- **What You Could Have Done:**\n1) **Project from the diaphragm on evidence lines \u2014 treat \"emissions rose by 3.8%\" as a headline, not an aside.**\n2) \"**Strip emphasis from connective words and save it for content:** an article from The Atlantic tells us that AOC proposed the influential **Green New Deal** last November.\"\n3) \"**Pause a full beat after the punchlines:** One cable pundit called her Alessandra Oxycontin. [beat] And Lou Dobbs...\"\n4) \"**Open at conversational volume and build:** Cable news pundits love to pronounce one freshman Congresswoman's name \u2014 **Alexandria. Ocasio-Cortez.**\"\n\n### Total Composite Score: 76/100\n### Judge's Rank: 2/5\n### Rank Explanation:\nThis speech would place 2nd against 5 other competitors on this question. The speaker pairs one of the most original hooks in the round \u2014 the AOC-name device that pays off brilliantly in the \"Y-E-A\" close \u2014 with genuinely strong source discipline (eight dated, reputable citations) and expressive, well-paced delivery. What holds it out of first is analytical follow-through: Point 3's own New York Times evidence undercuts its causal claim, the bipartisan-influence argument rests on post hoc reasoning the speaker half-concedes in the same sentence, and the most striking statistic in the speech (the New Jersey asthma doubling) arrives with no source at all. The intro also runs nearly a minute long, and several garbled sentences (\"climate and motivations on these incinerators\") land at analytically important moments. Against a typical state-level field, the polish and structure beat most competitors, but a sharper analyst with equal delivery would take the round.\n\n### Actionable Drill for Next Round:\n**The \"Prove the Cause\" drill:** Take your three main points from this speech. For each, write the causal claim in one sentence (e.g., \"The GND forced Republicans to propose climate bills\"), then list every *alternative* explanation your own evidence mentions (poll numbers, UK origins, pre-existing trends). For each alternative, write one sentence of warrant that rules it out or subordinates it \u2014 the way the \"Gaetz named his bill the Green Real Deal\" detail rules out pure polling. Practice delivering those ruling-out sentences verbatim until causal attribution becomes automatic rather than asserted.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal last November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  Alexandria Ocasio-Cortez and Senator Edward Markey released a 14-page resolution for their Green New Deal (House Resolution 109) on February 7, 2019, which aligns with the 'last November' (2018) timeframe for its initial proposal or discussion, preceding the formal resolution.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific article from The Atlantic on June 12, 2019, was not found, other sources from early 2019 indicate that the Green New Deal, or its core concepts, had broad popularity among voters (including some Republicans initially) but also faced significant political polarization and opposition.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE9SsjgxWKh0zU9RPgtIz9bZPXgjQsZQFFXTsohMGhp1e6NmPyCI4CM5DFffvH77Ljrqw-Qjf420HhNF-vy_0Cf3XJDMwOWUD1hCSneSkA2thHgwHnEaJtQSTZcAX_UqQyVUlkRZRbty4nec3qmormIGNipWIlflMaoY202w8s54zWltA0PGtHqJAKWvEXQzjtnyu6MI8qHsTMWIPEOWoS6tMOEWEKyenmE5ohNsTnlunAshqcfgmgOd_CMSm2dP02RzGCFL8c\n\n[UNVERIFIED] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  While New Consensus is a think tank associated with the Green New Deal, and the goal was to develop a policy agenda, a specific article from The Atlantic on June 12, 2019, stating this exact timeline and effort by New Consensus was not found in the search results.\n\n[FALSE] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (2019)\n  Reports from January 2019, including coverage of Rhodium Group data, indicated that U.S. carbon dioxide emissions rose by an estimated 3.4% in 2018, not 3.8%.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  An article from The Washington Post on April 3, 2019, discusses how Republicans for years cast doubt on climate change, but some are now acknowledging human-caused climate change.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHn7AGEZu6RA-gO93CA7m8ZUB0cTDTHO0CVP1yd347WfsTGEVgguEf3pIlHNPI5AxT7c4UqvFDtR-PQvDOQHhqJCa7-iTEQzoy8FaP76i3Otm6ucfe85un8G5lq3ArdhG2D24Q9SpY=\n\n[FALSE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change.\n  Cited source: (no source given)\n  In June 2011, Mitt Romney publicly stated that he believed the world was getting warmer and that humans contributed to it. However, his stance later shifted, and in October 2011, he said, 'We don't know what's causing climate change on this planet.' The claim that he ran on a campaign saying he 'didn't even know' if humans were a cause is an oversimplification and misrepresents his initial 2011 statement.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF2tOj2srV__voNm42S3XnJA79hw7AM4Tu6-EDkVwG49VszQbzJ4xYDHIr97UzR74tobLngl0QVqrp0gqi835VCrrHIWzYLQWRSa6aqpZ78x-S9Q7x_10v6JXXiDPhIFlDKnalrDh1BW4nsEy3pRy8KqA5folNxNWJKws_MEje5rkdO5A_n1IjT\n\n[FALSE] Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action.\n  Cited source: The Washington Post (continues from April 3, 2019, but likely a different article)\n  A Washington Post-Kaiser Family Foundation poll from summer 2019 (reported Sept 13, 2019) found that 60% of Republicans believed human activity caused climate change, and 46% of all Americans said the U.S. needs to 'drastically reduce' fossil fuel use in the next few years. Another Post-KFF poll from 2020 indicated that almost 7 in 10 Republican adults under 45 believed human activity was causing climate change. The specific numbers cited (64% Republicans, 45% Americans) for these exact claims were not found in the provided search results for the given timeframe.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEyv4mw3q1sLas2mS5BGQjelGIpaQQgc-MPZHk-FlsO5QbEyA4zOMOtME1Hgv2sbOrwJGMCvhCty2w87r_8ZSOuyB5M0-hsLQ0TEh5xe0VrQZoVRtSsv9gFPnJxHI4-xBRlzXhDEVlHHnyUA-FTmNZANwAP9m7iNMl2nBq7UD5iJVYmfLca8nhoCGHsYoPFNbAtTHE8H6rLQrvrl6_6kre2ECVZHvxZdnUSaiQKEydz-7wA5Ue1Y9GHhK_qSElgO7SlC6EhDYWTO2w8reel5bmbN4lQ-i8J0WBelF8tBjnnmQ\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen, leading Senator Lamar Alexander to propose his Manhattan Project on Clean Energy and Matt Gaetz to propose a Green Real Deal combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  A March 26, 2019, article reported that the Green New Deal was forcing a discussion on climate change among Republicans. Senator Lamar Alexander proposed a 'New Manhattan Project' for clean energy, and Representative Matt Gaetz announced plans to draft a 'Green Real Deal' offering conservative solutions.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHSy0RUhd-Avp-LYGQJfksUyQtfoJMSB4aq0IF3jw-llL8DUcFk-YPOEBAQ7DjdB7uwC3ql-6N2dW23hkk8s4nb4LhfeHninH6WCly2O4czay-VoRwrntNlEEIruzH-xo91-vt_IP0ONiIpWLD8DbY=\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators, with these pollutants linked to health problems like asthma and heart disease. The article also highlights that these incinerators are disproportionately located near low-income and minority communities.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1cBXxCktTJWQvPB3F8s5pPEyUmJVdmPPWHcoTZf2Gn0bB1NCOchV0SooL8vWVlqeS8Cfq8QRiMNxI_lzgCIhdu3trnE1gV1z06dWzfQnSKvbUWl0_8TeW4ZGzx9jgO0YdMFWUHDSTjNbLCV3Nvw4j-2yh35jAl1NXgUnLcqohxAD9WVD7B7ourRBl5tlnf3U--jToCrjF887SrgzCzlPF-OYGXA==\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act), a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and explicit hiring focus on marginalized people was not found in the search results. The date is also quite early for such detailed legislative outcomes.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) said 'we're all going to die' at the beginning of this year (2019), representing global apathy.\n  Cited source: (no source given, but attributed to IPCC scientists)\n  The IPCC reports are scientific assessments, not statements like 'we're all going to die.' While IPCC reports, such as the 2018 Special Report on Global Warming of 1.5\u00b0C, highlighted dire consequences of inaction, they do not use such emotional language. The claim of 'dead face' and 'apathetic' scientists is a dramatic interpretation, not a factual report from the IPCC.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEU0O1IACbuw1WncDR82UmpTRdRfJ4Ldr1OZNdjMeqjLD4TA9d7_rLziRd80IjyCuspuSfeimpBdyJVxvqM1fC5PdBWfwVPJvbpaNYwx_00tOi8YCX8tm3KPb2PYis3ca13LkhIPUY-AR3htuVUQ9HPGLObbjImq3XkJk6I6923\n\n[TRUE] The most sweeping piece of climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  Los Angeles Times articles from December 2018 and later confirm that the Paris Agreement sets a goal of limiting global warming to 'well below 2 degrees Celsius' and pursuing efforts for 1.5 degrees Celsius. It is also noted that the agreement, while a breakthrough, left many details to be firmed up later and lacked strong enforcement mechanisms.\n\n[TRUE] The Green New Deal originated in the UK, but AOC's accessibility has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  Multiple sources, including Wikipedia, confirm that the concept of a 'Green New Deal' originated earlier in the UK and Europe (around 2008) and was adopted by the Green Party in the U.S. in 2010, before Alexandria Ocasio-Cortez popularized it in 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest published an article on June 4, 2019, discussing how the Green New Deal concept was gaining traction internationally, including in Canada and Europe.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    sonnet5: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 6/8\n**What Worked:**\n1) The AGD leans on genuine humor rather than a stock quote or statistic \u2014 \"One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" is a memorable, original opening that immediately distinguishes this speech from a generic cold-open.\n2) The thesis is stated with zero ambiguity \u2014 \"The answer simply is that it will serve as the bedrock for future environmental legislation\" gives the judge a clean, flowable line to anchor the rest of the speech to.\n3) The wordplay bridge from the AGD into the topic is clever rather than forced \u2014 \"there are three letters also attached to her name, GND, standing for the Green New Deal\" uses the same \"letters\" device from the mispronunciation joke to pivot into substance.\n\n**Critical Flaws:**\n1) The formal preview breaks parallel structure \u2014 \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally...\" skips the word \"second\" entirely, replacing it with \"more broadly,\" which makes the three-point architecture harder to flow cleanly off the intro alone.\n2) The intro runs long before the question is even asked \u2014 a Scientific American emissions statistic, a Sudan/Yemen comparison, and think-tank details on New Consensus all pile up between the hook and the thesis, delaying the pivot the audience needs.\n\n**What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation, **second**, by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"This deal attempted to solve the ever-pressing emergency of climate change... **and that's exactly why, with the clock already running, we have to ask today's question**: how will the Green New Deal influence future environmental legislation?\"\n\n### Structure - 7/10\n**What Worked:**\n1) All five structural elements are present and correctly ordered \u2014 a single AGD, an explicit thesis, three distinct signposted body points, and a conclusion \u2014 with none of the pieces missing or merged.\n2) The intro-to-body and body-to-body transitions are explicitly marked rather than left implicit: \"This is the first way in which the Green New Deal will influence future environmental legislation,\" \"Secondly, we have to look more broadly to the question of environmental justice,\" and \"Finally, and perhaps most importantly, at the beginning of this year...\" all function as real verbal signposts.\n3) The conclusion's return to the question \u2014 \"That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation?\" \u2014 is an explicit, not implied, callback to the exact frame set up in the intro.\n\n**Critical Flaws:**\n1) Word-count-based timing: Introduction \u2248289 words (23.3%, ~109s), Body 1 \u2248321 words (25.9%, ~122s), Body 2 \u2248300 words (24.2%, ~114s), Body 3 \u2248225 words (18.2%, ~86s), Conclusion \u2248104 words (8.4%, ~39s) of a 470-second recording. Against the 14/26/26/26/7 benchmark, the Introduction runs nearly 10 points hot,the Introduction runs nearly 10 points hot, while Body 3 is shortchanged by roughly 8 points against benchmark \u2014 meaning the \"most important\" point (global paradigm) is structurally the shortest, undercutting the speaker's own claim of its primacy.\n2) The AGD (the AOC mispronunciation bit) receives zero callback anywhere in the body \u2014 after the intro, \"Lou Dobbs,\" \"Oxycontin,\" and \"AOC\" vanish entirely until the conclusion's \"AOC might have a complicated name\" line, leaving the throughline dark for roughly 320 seconds of the speech.\n3) The transition into point three is a hard cut rather than a signposted bridge \u2014 \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours\" introduces a brand-new extended metaphor with no linking sentence connecting it back to the environmental justice content that just ended.\n4) The conclusion's return to the AGD is stylistically clever but substantively thin \u2014 \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" delivers a pun-based echo rather than an explicit final insight about why the bedrock metaphor matters going forward.\n\n**What You Could Have Done:**\n1) Trim roughly two sentences of intro throat-clearing (e.g., the New Consensus think-tank detail) and reinvest that time into point three so it reaches closer to the 26% benchmark instead of closing at ~18%.\n2) \"It will force some kind of bipartisan action on climate mitigation... **and just like Lou Dobbs never quite gets AOC's name right, Republicans spent a decade never quite getting climate policy right \u2014 until the Green New Deal forced them to.**\"\n3) \"In climate legislation, we've often looked to just alternative energy... **Now, picking back up on that same apathetic panel of scientists,** this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity.\"\n4) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. **Because just like the pundits eventually learn to say her name right, the world is learning to say the Green New Deal's name right too \u2014 as the bedrock, not the punchline, of climate policy.**\"\n\n### Strength of Argument & Analysis - 10/16\n**What Worked:**\n1) Point one's evidence-to-warrant chain is mostly traceable: Romney's 2011 \"didn't even know if humans were a cause of climate change\" is used as a baseline, then the Washington Post's 64%/45% polling shift is offered as the change, and Alexander's \"Manhattan Project on Clean Energy\" and Gaetz's \"Green Real Deal\" are offered as the resulting bipartisan output \u2014 a genuine Evidence\u2192Warrant\u2192Impact structure rather than a bare assertion.\n2) Point two's \"So What?\" is explicitly answered rather than dropped \u2014 after citing the Guardian's 1.6 million Americans near trash incinerators, the speaker ties it to a personal stake: \"In my home state of New Jersey, it's doubled the rate of asthma,\" which converts a national statistic into a concrete, felt harm.\n3) Point three correctly engages a real weakness in the strongest counter-framework rather than a straw man \u2014 noting the Paris Accords \"proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" is a fair, specific critique of the leading alternative rather than dismissing it.\n\n**Critical Flaws:**\n1) Point one's causal chain is asserted rather than proven \u2014 \"they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate\" asserts that GND specifically caused Alexander's and Gaetz's proposals, but the Politico citation is only described as showing \"poll numbers are finally forcing Republicans to listen,\" which credits polling generally, not GND specifically \u2014 the leap from \"polling shifted\" to \"GND caused Gaetz's bill\" skips a warrant.\n2) Point one never closes the loop to the stated impact \u2014 the speaker asserts \"we're not simply going to just pass this 14-page resolution... to come to bipartisan solutions like a carbon tax,\" but no evidence is offered that a carbon tax is actually forthcoming; this is an aspiration standing in for proof, so point one proves \"Republicans are proposing more climate bills\" but not fully \"GND is the bedrock forcing bipartisan legislation.\"\n3) Point two's foundational premise is dropped without support \u2014 \"the climate movement is right, they're also very white... looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" is presented as an established fact with no citation, yet the entire environmental-justice point is built on top of this uncited characterization.\n4) Point two's Illinois evidence skips the \"so what\" of causation \u2014 \"in the state of Illinois this led to an equity environmental Justice Bill being passed\" asserts GND caused the Illinois bill, but the speaker never explains the specific mechanism (e.g., did GND language get copied into the bill? Did legislators cite it?) connecting the Vox article's content to that causal claim.\n5) Point three is directly undercut by its own evidence \u2014 the speaker's NYT citation states the Green New Deal \"has been around before the United States proposed it in 2018. It came from the UK,\" which means the \"new global paradigm\" claimed in point three cannot be attributed to AOC's version of GND specifically, since the concept predates it; the speaker never reconciles this admission with the point's core claim that GND itself is \"leading to\" the global shift.\n\nPoint-by-point verdict: Point one is MODERATE \u2014 well-sourced but the final causal link to bipartisan legislative outcome is asserted, not warranted. Point two is MODERATE \u2014 emotionally resonant and specific, but rests on an uncited generalization at its foundation. Point three is WEAK on its own terms \u2014 the evidence used to build it partially contradicts its central claim. Overall category verdict: MODERATE. The speech is evidence-rich and each point traces some warrant, but all three points ultimately prove \"the Green New Deal is associated with these developments\" more convincingly than \"the Green New Deal caused these developments,\" which is the actual thesis.\n\n### Flaws in Reasoning - 6/12\n**Critical Flaws:**\n1) Correlation-as-causation: \"they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate\" treats Gaetz's and Alexander's proposals as GND's direct product when the cited Politico evidence only supports a general polling shift \u2014 this is a moderate flaw that weakens, but doesn't collapse, point one, since the correlation itself is still real.\n2) Self-contradiction between point three's claim and its own citation: the speaker argues GND \"will serve\" as a new global paradigm, but the New York Times evidence states the Green New Deal concept \"came from the UK\" and predates the AOC version \u2014 this is a significant flaw because it directly undercuts the causal ownership point three needs to claim credit for the global spread.\n3) Hasty generalization: \"the climate movement is right, they're also very white\" is a sweeping characterization of an entire movement's demographics with zero citation or data attached \u2014 this is a moderate-to-major flaw because point two's entire justification for pivoting to environmental justice rests on this unproven premise.\n4) Straw man: \"Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\" mocks \"innovation\" as an empty buzzword without engaging the substantive market-based mechanisms (R&D tax credits, carbon capture subsidies) that actually underlie the Republican innovation argument \u2014 this weakens the fairness of point one's opposing-view engagement.\n5) Unproven causal assumption stated as settled fact: \"in the state of Illinois this led to an equity environmental Justice Bill being passed\" presents GND as the direct cause of a specific state bill with no stated mechanism (no quote from a legislator, no bill text reference tying it to GND) \u2014 a moderate flaw since the underlying Illinois bill is real, but the causal attribution to GND specifically is unsupported.\n\n**What You Could Have Done:**\n1) \"...forcing Republicans to actually innovate. **Or, at minimum, the polling shift the Green New Deal helped produce created the political cover Gaetz and Alexander needed to act.**\"\n2) \"It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. **In other words, the paradigm isn't new \u2014 what's new is that AOC's version gave it the mainstream American platform it never had before.**\"\n3) \"...they're also very white. **A 2019 Yale program on climate communication survey, for instance, found the movement's leadership is disproportionately white and affluent \u2014 which is exactly the gap the Green New Deal's equity provisions are designed to close.**\"\n4) \"But what exactly is innovation? **Republicans have historically pointed to R&D tax credits and carbon capture subsidies \u2014 but even those market mechanisms have produced far less emissions reduction than the polling shift the Green New Deal triggered.**\"\n5) \"...this led to an equity Environmental Justice Bill being passed, **with Illinois legislators explicitly citing Green New Deal language in their floor debate,** where there will be 40 million solar panels installed by 2050.\"\n\n### Strength of Evidence - 13/16\n**What Worked:**\n1) Source diversity and authority are genuinely strong across all three points \u2014 The Atlantic, Washington Post, Politico, The Guardian, Vox, the Los Angeles Times, and the New York Times are all nationally recognized, editorially rigorous outlets, giving the speech roughly 9 unique sources across three points, well above the 1-2-per-point benchmark.\n2) Most citations carry full day/month/year dating appropriate to a fast-moving 2019 political topic \u2014 \"an article from the Washington Post tells us on April the 3rd of 2019,\" \"a further article from Politico on March the 26th of 2019,\" and \"an article from The Guardian tells us on May the 21st of 2019\" all allow a judge to verify recency at a glance.\n3) The Guardian citation is applied with genuine specificity rather than just dropped for credibility \u2014 the \"1.6 million Americans live near a trash incinerator\" statistic is immediately localized with the New Jersey asthma anecdote, giving the number concrete stakes.\n\n**Critical Flaws:**\n1) Three citations lack day-level dating, making timeliness harder to verify precisely: \"an article from the Scientific American from January of this year,\" \"an article from the Los Angeles Times from December of 2018,\" and \"a final article, this time from the New York Times, from March of 2019\" all give only month/year \u2014 for a topic moving as fast as 2019 climate politics, the missing day means a judge cannot confirm whether the LA Times piece predates or postdates key GND developments that same month.\n2) The Politico citation is stretched beyond what it's described as proving \u2014 the speaker says it shows \"poll numbers are finally forcing Republicans to listen,\" but this is then used to support a much stronger claim (GND specifically caused Gaetz's and Alexander's bills) than the cited content, as described, actually establishes.\n3) The Vox citation on the Illinois bill is applied with a causation gap identical to the one flagged in Flaws in Reasoning \u2014 the article is cited for the bill's existence and provisions, but not for any stated connection between the bill and the Green New Deal itself, so the source supports the what but not the why.\n\n### Clarity - 6/10\n**What Worked:**\n1) Signposting is explicit and locatable throughout \u2014 \"This is the first way in which the Green New Deal will influence future environmental legislation,\" \"Secondly, we have to look more broadly,\" and \"Finally, and perhaps most importantly\" all let a judge without the transcript track exactly which point is active.\n2) Acronyms are defined on first use \u2014 \"GND, standing for the Green New Deal\" and the AOC/full-name pairing at the top mean no jargon is left unexplained for a lay judge.\n\n**Critical Flaws:**\n1) A stammered, doubled phrase creates genuine confusion: \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" \u2014 the repeated \"the that the\" should be cut to \"This shows that the Green New Deal is guiding future climate debate.\"\n2) An extended metaphor is confusingly literalized: \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic\" \u2014 \"Their dead face\" is a vague, grammatically mismatched pronoun (plural scientists, singular \"face\") that a live judge would likely have to replay mentally to parse; it should read \"their expressions were apathetic.\"\n3) The moon line lands as a non-sequitur rather than a closer: \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\" \u2014 the logical connection between the Apollo program and forced lunar relocation is never established, so the joke reads as filler rather than a purposeful closing image.\n4) Vague qualifier weakens a key claim: \"It will force some kind of bipartisan action on climate mitigation\" \u2014 \"some kind of\" hedges the exact claim (bipartisan action) that point one is supposed to prove decisively.\n5) A comparison is used as unearned characterization rather than clarified argument: \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" \u2014 vivid, but it obscures rather than clarifies what specific demographic claim is being made.\n\n**Verdict: MODERATELY CLEAR** \u2014 the skeleton and signposting are easy to follow, but repeated stammers, a mismatched pronoun, and a disconnected closing metaphor create real friction points a live judge would stumble on.\n\n**What You Could Have Done:**\n1) \"This **shows that** the Green New Deal is part of a way to guide future climate debate.\"\n2) \"...said, we're all going to die. **Their expressions were apathetic,** but it represents a global apathy towards sweeping climate change legislation.\"\n3) \"We landed a man on the moon \u2014 **proof that when we commit real resources to a hard problem, we solve it. That's exactly the commitment climate change now demands.**\"\n4) \"It will force **decisive** bipartisan action on climate mitigation.\"\n5) \"The climate movement **skews disproportionately white and affluent** \u2014 and that gap is exactly what environmental justice is designed to close.\"\n\n### Conclusion Strength - 5/8\n**What Worked:**\n1) The three points are accurately and concisely restated in parallel form \u2014 \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" mirrors the original preview closely enough for a judge to check off all three.\n2) The closing line delivers a genuine, planned echo of the AGD's specific device \u2014 \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" reuses the \"letters\" wordplay (AOC, GND) established in the opening rather than introducing a new unrelated closer.\n\n**Critical Flaws:**\n1) The conclusion offers no forward-looking call to action for the audience or policymakers \u2014 it ends on the \"Y-E-A\" pun rather than a stated next step (e.g., what should Congress, voters, or the judge themselves take away going forward).\n2) The \"so what\" is implied by the pun rather than stated outright \u2014 the speaker never explicitly articulates why the bedrock metaphor matters looking ahead; the wordplay substitutes for that final insight rather than delivering it.\n\n**What You Could Have Done:**\n1) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. **And whether or not Congress says yea on the resolution itself, the debate it forced is already reshaping every climate bill that follows it.**\"\n2) \"...leading to global universality. **So the next time a pundit fumbles AOC's name, remember: it won't matter, because the policy behind those three letters will already have outlived the argument over how to pronounce them.**\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 15/20\n**What Worked:**\n1) Volume sits at \"Adequate\" (-23.1 dBFS), comfortably within an audible, projected range for a live round, earning close to full marks on that sub-metric.\n2) Tone and pitch variety are rated \"High \u2014 expressive\" with 3,151 detected pitch shifts and an 81.6Hz standard deviation, indicating genuine vocal energy rather than a flat, robotic read \u2014 consistent with the speech's punchy, joke-driven style (\"Alessandra Oxycontin,\" \"moon\" bit).\n3) Pace at 160 WPM sits squarely in the \"Solid competitive pace\" range (150-175 WPM benchmark), and the 7 pauses averaging 1.05s suggest intentional breath points rather than rushed run-ons.\n4) Filler word count is genuinely low for a 470-second speech \u2014 only 1 \"actually\" and 3 \"like\" instances were auto-detected, several of which (\"much like yours,\" \"like a carbon tax\") function as legitimate simile connectors rather than verbal crutches.\n\n**Critical Flaws:**\n1) Emphasis placement is frequently random rather than rhetorical \u2014 of the sampled emphasized words, function words like \"THE,\" \"WAY,\" \"BUT,\" \"IF,\" and \"TO\" receive loudness spikes rather than the thesis-critical nouns (\"bedrock,\" \"bipartisan,\" \"environmental justice\") that should be landing the hardest; only a handful (\"NEW Deal,\" \"SOLVE,\" \"UNITED\") hit genuinely important content words.\n2) One stutter/repetition was detected and is audible in the transcript itself \u2014 \"This is a showing that the that the Green New Deal\" \u2014 a stammered restart that briefly disrupts fluency at a structurally important sentence (the transition sentence for point one).\n3) With only 20% of words carrying detectable emphasis, roughly four-fifths of the speech is delivered without vocal stress cues, meaning a listener relies heavily on content alone (rather than delivery) to catch which words matter most in dense evidence-heavy sentences like the Washington Post polling citation.\n\n**What You Could Have Done:**\n1) Practice marking thesis words, numbers, and signpost words (\"first,\" \"bipartisan,\" \"environmental justice,\" \"global paradigm,\" \"64%,\" \"45%\") in the script for deliberate emphasis, rather than letting stress fall on articles and conjunctions by habit.\n2) Slow fractionally on the point-one transition sentence and deliver \"This **shows** that the Green New Deal is guiding future climate debate\" as a single clean clause to eliminate the stammer.\n3) Use the existing 1.05s average pause length more deliberately right before key statistics (e.g., pause before \"64%\") rather than only between larger structural sections, so the pause itself signals \"important number incoming.\"\n\n### Total Composite Score: 68/100\n\n### Judge's Rank: 3/5\n\n### Rank Explanation: This speech would place 3rd against 5 other competitors on this question. The speaker's greatest strength is citation density and diversity \u2014 nearly ten distinct named sources (The Atlantic, Washington Post, Politico, The Guardian, Vox, LA Times, New York Times, National Interest) spread across all three points, paired with a genuinely creative, high-energy delivery style (81.6Hz pitch variety, the AOC/GND wordplay bookending the speech) that would keep a judge's attention through a dense policy topic. However, the speech is held back by real structural and reasoning soft spots: point one's central claim is hedged with \"some kind of bipartisan action\" rather than proven decisively, the point-one transition sentence stumbles into an audible stammer (\"the that the Green New Deal\"), and the conclusion never delivers an explicit forward-looking call to action, resolving instead on a pun. Against a flight where the top two speeches likely combine similarly strong evidence with cleaner transitions and a decisive closing insight, this speech's clarity friction and under-analyzed warrants place it solidly in the middle of the pack rather than at the top.\n\n### Actionable Drill for Next Round: Record a single practice run of just the point-one transition sentence and point-one thesis-support sentence (\"This shows that the Green New Deal is guiding future climate debate\" and \"It will force some kind of bipartisan action on climate mitigation\") ten times in a row, each time cutting all hedge language (\"some kind of\") and eliminating the stammer by slowing to a controlled 140 WPM on that single sentence before speeding back up \u2014 the goal is to make the point's core claim land as a clean, decisive, un-hedged assertion on the first attempt in the next round, rather than needing a second pass to self-correct mid-sentence.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal in November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, discusses the Green New Deal, noting its release in November 2018 as a 14-page resolution.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, mentions the Green New Deal's mixed reception, including 'immense popularity' and 'regret' from some, particularly within the Democratic party.\n\n[TRUE] The think tank New Consensus is working to transform the Green New Deal resolution into a sweeping policy agenda by 2020.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, states that the think tank New Consensus, founded by Saikat Chakrabarti and Rhiana Gunn-Wright, aimed to develop the Green New Deal into a detailed policy agenda.\n\n[UNVERIFIED] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (likely 2020)\n  A search for 'Scientific American January 2020 emissions rose 3.8%' did not yield a specific article confirming this exact statistic and attribution. While emissions trends are reported, the precise figure and source date combination could not be directly verified.\n\n[TRUE] Before 'innovation,' Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, discusses a shift in Republican rhetoric on climate change, moving from denial to emphasizing 'innovation' as a solution.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign saying he didn't know if humans caused climate change.\n  Cited source: The Washington Post, April 3, 2019 (implied continuation)\n  The Washington Post article from April 3, 2019, references Mitt Romney's shifting stance on climate change during his 2012 presidential campaign, noting his past expressions of doubt about human causation.\n\n[TRUE] Neither the 2011 nor 2016 Republican campaigns proposed any sweeping climate solution.\n  Cited source: The Washington Post, April 3, 2019 (implied continuation)\n  The Washington Post article from April 3, 2019, contrasts the lack of comprehensive climate solutions from past Republican campaigns with a more recent shift towards acknowledging the issue, even if solutions remain limited.\n\n[FALSE] 64% of Republicans now believe climate change is a severe threat to our future survival.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, cites a poll showing 64% of Republicans believe the government should do 'more' or 'a lot more' about climate change, not necessarily that 64% believe it's a 'severe threat to future survival.'\n\n[TRUE] 45% of all Americans believe we need immediate action on climate change.\n  Cited source: The Washington Post, April 3, 2019 (implied continuation)\n  The Washington Post article from April 3, 2019, references a poll indicating that 45% of Americans believe immediate action is needed to address climate change.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  A Politico article from March 26, 2019, discusses how the Green New Deal and shifting public opinion are pressuring Republicans to address climate change.\n\n[TRUE] Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019 (implied continuation)\n  The Politico article from March 26, 2019, mentions Senator Lamar Alexander's proposal for a 'New Manhattan Project for Clean Energy.'\n\n[TRUE] Matt Gaetz of Florida proposed a Green Real Deal, combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019 (implied continuation)\n  The Politico article from March 26, 2019, reports that Representative Matt Gaetz proposed a 'Green Real Deal' that included carbon capture and reduced oil drilling.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  The Guardian article from May 21, 2019, states that 1.6 million Americans live within three miles of a trash incinerator, linking these facilities to higher rates of asthma and other health issues.\n\n[UNVERIFIED] In New Jersey, the rate of asthma has doubled because of climate and motivations on these incinerators.\n  Cited source: The Guardian, May 21, 2019 (implied continuation)\n  While The Guardian article discusses the link between incinerators and asthma, it does not specifically state that asthma rates in New Jersey have 'doubled' due to these factors.\n\n[TRUE] In Illinois, an equity environmental Justice Bill was passed, aiming for 40 million solar panels by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  Vox reported on March 7, 2019, about Illinois' Clean Energy Jobs Act (CEJA) which aimed for 100% clean energy by 2050 and included provisions for solar panel installation and equitable job creation for marginalized communities.\n\n[TRUE] The most sweeping piece of climate legislation globally is the Paris Climate Accords, which proposes a 1.5 degrees Celsius heating goal without a mechanism.\n  Cited source: Los Angeles Times, December of 2018\n  The Los Angeles Times in December 2018, and other sources, confirm the Paris Agreement's goal of limiting global warming to 1.5 degrees Celsius, while also noting its reliance on voluntary national contributions rather than a strict enforcement mechanism.\n\n[TRUE] The Green New Deal originated in the UK before the US proposed it in 2018.\n  Cited source: The New York Times, March of 2019\n  The New York Times in March 2019, and other sources, confirm that the concept of a 'Green New Deal' originated in the UK in 2008 before being adopted and popularized in the US by AOC in 2018.\n\n[TRUE] Alexandria Ocasio-Cortez's accessibility made the Green New Deal a globally accessible source.\n  Cited source: The New York Times, March of 2019 (implied continuation)\n  The New York Times article from March 2019 discusses how AOC's advocacy significantly raised the profile and global awareness of the Green New Deal concept.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest article from June 4, 2019, discusses the global spread of the Green New Deal concept, mentioning its adoption by politicians and parties in countries like Spain, Canada, and others.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    deepseek: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n**What Worked:**\n1) The hook is genuinely creative and culturally relevant: \u201cCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful.\u201d The mangled-name examples (\u201cAlessandra Oxycontin,\u201d \u201cAlexandria Ocasio-Cortez\u201d) are funny, specific, and instantly recognizable to anyone following political media.\n2) The transition from the name-game to the topic is tight: \u201c\u2026there are three letters also attached to her name, GND, standing for the Green New Deal.\u201d This link is seamless\u2014names to initials to the deal\u2014and avoids forcing the hook.\n3) The thesis is explicit: \u201cThe answer simply is that it will serve as the bedrock for future environmental legislation.\u201d The preview then lists the three points in order, making the road map flowable.\n**Critical Flaws:**\n1) The thesis phrase \u201csimply is\u201d undercuts the complexity of a 14-page resolution; it reads as oversimplifying rather than confidently asserting. A more forceful verb would strengthen the stance.\n2) The preview\u2019s wording is slightly blurred: \u201cFirst, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\u201d The \u201cmore broadly by addressing\u2026\u201d lacks a clear signpost like \u201csecond,\u201d leaving the middle point structurally weaker.\n3) The hook never explicitly ties back to the thesis\u2019s \u201cbedrock\u201d metaphor\u2014a missed chance to unify the intro.\n**What You Could Have Done:**\n1) \u201cThe answer is that it will serve as the bedrock\u2026\u201d \u2192 \u201c\u2026The Green New Deal will fundamentally become the bedrock\u2026\u201d\n2) \u201c\u2026first, by forcing bipartisan action\u2026 more broadly by addressing\u2026 and finally\u2026\u201d \u2192 \u201c\u2026first, by forcing bipartisan action on climate mitigation; second, by addressing the critical concept of environmental justice; and finally, by leading to a new global paradigm\u2026\u201d\n3) \u201cSo today we\u2019ll answer\u2026 Just as AOC\u2019s name got butchered before people learned it, the Green New Deal will get clarity\u2014and then become the foundation everything else is built on.\u201d\n\n### Structure - 9/10\n**What Worked:**\n1) All required parts are present and correctly sequenced: a single AGD, a thesis, preview, three distinct body points, and a clear conclusion. No element is missing.\n2) The transitions are signposted. The move from body 1 to body 2 uses \u201cSecondly, we have to look more broadly to the question of environmental justice\u2026\u201d \u2014 a clean verbal marker. The shift into body 3 is equally explicit: \u201cFinally, and perhaps most importantly\u2026\u201d\n3) The conclusion returns to the name hook and thesis deftly: \u201cAOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\u201d This echo ties the speech into a satisfying arc.\n4) Timing breakdown, using the word-count method with the given 470-second recording:\n- Introduction: 165 words (approx. 20% \u2192 94s)\n- Body 1: 226 words (approx. 27% \u2192 127s)\n- Body 2: 187 words (approx. 22% \u2192 103s)\n- Body 3: 193 words (approx. 23% \u2192 108s)\n- Conclusion: 69 words (approx. 8% \u2192 38s)\nThe introduction runs a bit heavy (20% vs. the 14% benchmark) while body 2 is a touch light (22% vs. 26%), and body 3 also slightly under (23% vs. 26%). The conclusion is near perfect. This imbalance is minor but means the first point gets more airtime than the others, which could be tightened.\n5) Short callbacks to the AGD are present in body 2\u2014\u201cthe climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\u201d\u2014and the concluding Y-E-A line, so the throughline is maintained.\n**Critical Flaws:**\n1) The transition from body 1 to body 2, while signposted, is abrupt in content: \u201cThis is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions\u2026 Secondly, we have to look more broadly\u2026\u201d The splice between the end of point one and the start of point two includes a stutter and a fragmented sentence, weakening the seam.\n2) Body 1\u2019s internal structure meanders: the \u201cnickel for every time they said innovation\u201d joke lasts two sentences before getting to substance, costing precious seconds without advancing the argument.\n3) The conclusion\u2019s \u201cSo What?\u201d is implied but never stated outright; it ends on a clever line about letters but doesn\u2019t articulate why this bedrock matters for the audience beyond a slogan.\n**What You Could Have Done:**\n1) \u201cWe're not simply going to just pass this 14-page resolution. to come to bipartisan solutions\u2026\u201d \u2192 \u201c\u2026Instead, the Green New Deal forces bipartisan solutions\u2014such as a carbon tax\u2014 Secondly, we have to look\u2026\u201d\n2) Cut the nickel joke entirely: \u201cRepublicans have long claimed innovation is the answer without acting. But the Green New Deal changes that by making innovation unavoidable\u2014it\u2019s the first way it will shape future legislation.\u201d\n3) \u201cY-E-A. Thank you very much. And that \u2018yea\u2019 is not just a vote\u2014it\u2019s the foundation on which every future climate law will be built.\u201d\n\n### Strength of Argument & Analysis - 11/16\n**What Worked:**\n1) Point one\u2019s core claim\u2014the Green New Deal forces bipartisanship\u2014is supported with specific evidence: the shift from 2011 Romney denial to 64% Republican belief in climate threat, and concrete counter-proposals (Alexander\u2019s \u201cManhattan Project on Clean Energy,\u201d Gaetz\u2019s \u201cGreen Real Deal\u201d). The warrant is clear: popular pressure, catalyzed by the GND, compels Republican action.\n2) Point two argues that the GND advances environmental justice, linking the usual \u201csolar panels\u201d frame to the marginalization of minorities. The Guardian\u2019s data on trash incinerators, asthma rates, and Illinois\u2019s equity bill are concrete and tie directly to the claim.\n3) The \u201cSo What?\u201d in point two is explicitly delivered: \u201cWe're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that.\u201d This connects evidence to impact.\n**Critical Flaws:**\n1) Point one\u2019s analysis fails the \u201cSo What?\u201d test for its core statistic. The Politico article is cited to show Republicans are \u201cfinally forcing Republicans to listen,\u201d but the speaker drops the evidence without explaining *how* the GND\u2019s popularity directly caused Alexander\u2019s and Gaetz\u2019s proposals\u2014the causal chain is asserted, not demonstrated. The missing warrant: the speaker needed to say *why* the GND\u2019s poll numbers forced these specific Republicans to put forward their plans, perhaps by noting that vulnerable senators facing reelection in swing states cannot ignore such a shift in public opinion.\n2) Point three\u2019s global-paradigm argument is thin. It claims the GND is creating a \u201cunified platform\u201d across Spain, Sweden, Norway, and Canada, but never explains *how* a U.S. resolution actually influenced foreign candidates. The evidence\u2014that candidates \u201crun on a Green New Deal agenda\u201d\u2014shows correlation, not causation. The speaker assumed the GND as origin, ignoring that European green parties already had similar frameworks. The missing analysis: the speaker needed to connect AOC\u2019s accessibility to a *mechanism* of international diffusion, such as media coverage of the proposal inspiring transnational advocacy groups or giving a common name to existing movements.\n3) Point two\u2019s environmental-justice section makes an unsupported leap: \u201cwe're designing a new future where\u2026 everyone will be on an equal footing.\u201d This grand claim is not backed by any evidence about the Green New Deal\u2019s actual enforcement mechanisms or funding for equity goals. The Illinois bill is a state example, but it does not prove a nationwide paradigm shift. The argument thus remains aspirational, not analytical.\n4) The overall thesis\u2014that the GND will be \u201cthe bedrock\u201d\u2014needs to contend with the fact that the resolution itself is a non-binding statement of principles. The speaker never addresses the gap between a \u201c14-page white paper\u201d and binding legislation, which weakens the bedrock metaphor\u2019s plausibility.\nVerdict: MODERATE \u2013 the arguments are structurally sound and well-supported at a surface level, but the analysis frequently stops at asserting links without explaining the mechanisms, and the counterargument about the resolution\u2019s non-binding nature is entirely missing.\n\n### Flaws in Reasoning - 7/12\n**What Worked:**\n1) The speaker avoids sweeping slippery-slope claims; for instance, point one acknowledges Republican proposals, which prevents a straw-man portrayal of the opposition.\n2) The use of data in point one (64% of Republicans see climate as a threat) is logically linked to the need for bipartisan action, without overstating that all Republicans now support the GND.\n3) The environmental-justice argument in point two does not rely on false dilemmas; it rightly notes that climate legislation has historically overlooked equity, and frames the GND as a corrective.\n**Critical Flaws:**\n1) In point one, the speaker commits a *post hoc ergo propter hoc* fallacy: \u201cthe Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander\u2026 proposed his Manhattan Project\u2026 Matt Gaetz\u2026 proposed a Green Real Deal\u2026 Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate.\u201d The speaker asserts that the GND caused these proposals, yet no evidence establishes temporal or causal precedence. Gaetz has long advocated for a carbon-capture approach; Alexander\u2019s \u201cManhattan Project\u201d predates the GND\u2019s introduction (his proposal came in March 2019, but he has a multi-year history of clean-energy advocacy). The speaker\u2019s logic assumes the sequence implies causation.\n2) Point three contains a *hasty generalization*: \u201cthe candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform.\u201d Four countries\u2019 candidates mentioning the phrase does not demonstrate that the U.S. GND *created* a unified global paradigm. Many of these candidates may have been referencing domestic versions or the concept popularized by European think tanks. The move from a few instances to a worldwide shift is a leap.\n3) An *unproven assumption* undermines point two: \u201cThis is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing.\u201d The phrase \u201cequal footing\u201d assumes the Green New Deal will successfully address deep-rooted systemic inequities, yet the speaker provides no evidence that the resolution\u2019s jobs guarantees, healthcare, or subsidies will actually close racial or economic gaps. The assumption treats the policy\u2019s goals as achieved outcomes.\n4) A minor *circular reasoning* moment appears in the conclusion: \u201cthe answer is that it will serve as a fundamental bedrock\u201d reiterates the thesis without adding new justification; it simply restates the claim, which weakens the closing\u2019s argumentative force.\nSeverity: Flaw 1 (post hoc) weakens the entire bipartisan-action point, as the central causal claim is unsupported. Flaw 2 (hasty generalization) significantly damages the global-paradigm point, which relies on that leap. Flaw 3 is more of a soft spot, as the speaker could have hedged the \u201cequal footing\u201d goal as aspirational.\n\n### Strength of Evidence - 14/16\n**What Worked:**\n1) The speaker cites a robust variety of sources: The Atlantic (dated June 12, 2019), Scientific American (January of this year \u2013 2019), Washington Post (April 3, 2019), Politico (March 26, 2019), The Guardian (May 21, 2019), Vox (March 7, 2019), Los Angeles Times (December 2018), New York Times (March 2019), The National Interest (June 4, 2019). Nine unique outlets, all well-respected and topical.\n2) Every source is properly dated, allowing the judge to verify timeliness on a fast-moving policy topic. The most recent source (June 2019) is within a month of the recording, meeting the urgency of the question.\n3) The evidence directly supports the sub-claims: the Washington Post supplies the public-opinion shift; Politico provides the Republican senators\u2019 proposals; The Guardian gives the trash-incinerator and health data; Vox delivers the Illinois equity bill; the New York Times traces the GND\u2019s UK origins.\n4) The speaker ties evidence to the points without \u201cdrive-by citing.\u201d For instance, the Guardian statistic on 1.6 million Americans living near incinerators is immediately connected to asthma rates and environmental injustice.\n**Critical Flaws:**\n1) The speaker\u2019s citation of The New York Times in point three is vague: \u201cthe New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK\u2026\u201d The exact content is ambiguous\u2014did the Times report that the concept originated in the UK, or that a UK group proposed a similar plan? The speaker doesn\u2019t specify, making the evidence\u2019s authority slightly hazy.\n2) The Los Angeles Times source is used only to note a deficiency of the Paris Accords (goal with no mechanism), but the speaker doesn\u2019t connect that deficiency to how the GND solves it\u2014the evidence is applied negatively rather than positively, leaving the warrant hanging.\n3) The Scientific American statistic (\u201cemissions rose by 3.8%\u201d) is dropped in the intro without a date beyond \u201cJanuary of this year\u201d\u2014it\u2019s unclear whether this is a global or U.S. figure, and it\u2019s never revisited. While it sets urgency, it\u2019s orphaned evidence that could have been woven into a body point.\nOverall: The sourcing is unusually strong, but the missed opportunity to fully integrate all evidence keeps it from a perfect score.\n\n### Clarity - 8/10\n**What Worked:**\n1) The signposting is excellent: \u201cFirst, by forcing bipartisan action\u2026\u201d \u201cSecondly, we have to look more broadly\u2026\u201d \u201cFinally, and perhaps most importantly\u2026\u201d A listener can follow the structure effortlessly.\n2) The speaker defines key acronyms (AOC, GND) immediately and uses them consistently.\n3) The language is largely conversational and jargon-free; terms like \u201cenvironmental justice\u201d and \u201ccarbon tax\u201d are intuitively clear.\n4) The joke about the climate movement\u2019s appearance (\u201ccross between a Comic-Con convention and a Bernie Sanders rally\u201d) is vivid and accessible, helping embed the point about whiteness without needing academic language.\n**Critical Flaws:**\n1) Awkward phrasing: \u201cThis is a showing that the that the Green New Deal is part of a way to guide future climate debate.\u201d The stutter \u201cthe that the\u201d and the convoluted \u201cpart of a way to guide\u201d are unclear. Rephrase: \u201cThis shows the Green New Deal is already guiding the debate.\u201d\n2) Vague pronoun: \u201cWe're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions.\u201d The \u201cone\u201d refers to a carbon tax, but the sentence fragment \u201cto come to bipartisan solutions\u201d lacks a subject. Rephrase: \u201cWe won\u2019t just pass this resolution; we\u2019ll use it to push for bipartisan solutions, such as a carbon tax that grows the economy while cutting emissions.\u201d\n3) Filler/fluff: \u201creally\u201d appears nowhere in the transcript, but \u201cjust\u201d appears five times (\u201cjust have a world,\u201d \u201cjust pass,\u201d \u201cjust a greener world,\u201d etc.), often as verbal filler rather than precision. \u201cKind of\u201d is absent, \u201csort of\u201d absent, \u201clike\u201d used as filler in \u201clooks like a cross\u201d (though here \u201clike\u201d is grammatically appropriate), but no \u201cyou know\u201d or \u201cI think\u201d appear. The word \u201cvery\u201d appears three times (\u201cvery apathetically,\u201d \u201cvery white,\u201d \u201cvery different\u201d), which can be pruned.\n4) Conciseness: The intro\u2019s opening sentences\u2014\u201cCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful.\u201d\u2014could be tightened: \u201cCable pundits can\u2019t seem to pronounce Alexandria Ocasio-Cortez.\u201d Similarly, the \u201cnickel\u201d aside in body 1 consumes eight seconds of setup without adding analytical weight.\n5) Missing antecedent: \u201cat the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy\u2026\u201d The pronoun \u201cit\u201d in \u201cit represents\u201d could refer to the face, the statement, or the scientists\u2019 demeanor. Clarify: \u201cTheir deadpan delivery reflects the global apathy\u2026\u201d\nVerdict: CLEAR \u2013 The speech is highly understandable despite a few clunky phrases and filler words. The signposting and definitions push it into the clear category.\n\n### Conclusion Strength - 7/8\n**What Worked:**\n1) The conclusion accurately re-states all three points: \u201cfirst, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\u201d The summary is tight.\n2) The final callback to the hook is clever: \u201cAOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\u201d It returns to the names-and-letters theme and ends with a memorable, affirmative slogan.\n3) The pacing of the conclusion is strong; it does not dawdle or introduce new evidence, sticking to the summary-and-echo structure.\n**Critical Flaws:**\n1) The \u201cSo What?\u201d is underdeveloped. The speaker says \u201cY-E-A\u201d as a positive note, but never explains *why* that \u201cyea\u201d matters\u2014what future do we gain by making the GND the bedrock? The conclusion should have projected forward: \u201cThat \u2018yea\u2019 vote will mean cleaner air, more equitable jobs, and a planet that doesn\u2019t force us to relocate.\u201d\n2) The phrase \u201cwe have to return back to today's question\u201d is redundant (\u201creturn back\u201d); it\u2019s a small tic but mars polish.\n**What You Could Have Done:**\n1) \u201cY-E-A. Thank you very much. And that \u2018yea\u2019 is more than a vote\u2014it\u2019s the foundation for a world where your zip code doesn\u2019t determine your asthma rate, and where our grandkids don\u2019t have to read about the Green New Deal as a missed opportunity.\u201d\n2) \u201cwe have to return back to today's question\u201d \u2192 \u201clet\u2019s return to today\u2019s question\u201d\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 16/20\n**What Worked:**\n1) Filler-word audit: The auto-count detected only 4 crutch words (\u201cactually\u201d once, \u201clike\u201d three times), and a close read confirms an exceptionally clean delivery\u2014no \u201cum,\u201d \u201cuh,\u201d \u201cyou know,\u201d \u201cI mean,\u201d or throat-clearing. The speaker\u2019s fluency is outstanding.\n2) Tone and pitch variety: The metrics show a high pitch-shift count (3151 shifts) and a wide standard deviation (81.6 Hz), rated \u201cHigh \u2014 expressive.\u201d This indicates the speaker avoided a monotone and used natural pitch variation, which kept the speech lively.\n3) Pacing: 160 wpm over 470 seconds is right in the competitive sweet spot. The speech never sounds rushed or sluggish.\n4) Pauses: 7 pauses averaging 1.05 seconds each are well-distributed; they likely occur at major transition points, aiding clarity without becoming disruptive.\n**Critical Flaws:**\n1) Emphasis placement: The auto-transcript reveals many emphasized words land on prepositions, articles, and mundane words (e.g., \u201cTHE Atlantic,\u201d \u201cIN an article,\u201d \u201cTO transform,\u201d \u201cA sweeping policy,\u201d \u201cWILL the Green New Deal,\u201d \u201cIS the way\u201d). Of the 245 emphasized words, a substantial portion hit function words rather than content words like \u201cbipartisan,\u201d \u201cjustice,\u201d \u201cbedrock,\u201d or the source data. This random emphasis pattern undercuts the rhetorical punch\u2014a crucial number like \u201c3.8%\u201d or \u201c1.6 million\u201d should have been stressed more deliberately. The emphasis on \u201cCABLE,\u201d \u201cNEWS,\u201d \u201cPUNDITS,\u201d \u201cLOVE\u201d at the very start is theatrical but wastes early energy on setup rather than thesis.\n2) Stutter: The auto-count of 1 stutter/repetition appears in \u201cthe that the\u201d at the end of body 1, which is a clarity and fluency blemish. While only one, it coincides with a key transition and momentarily breaks the flow.\n3) Volume: At -23.1 dBFS, the volume is adequate but not commanding; the guidance suggests a subscore of 8/10 for volume. In a larger room, this level might be perceived as slightly under-projected, but it\u2019s within acceptable bounds for a competition recording. No penalty is severe, but it prevents a top-tier vocal score.\n**What You Could Have Done:**\n1) Emphasize key rhetorical words: instead of \u201cTHE Atlantic tells us\u2026\u201d stress \u201cAtlantic\u201d or the statistic itself. Specifically, \u201c1.6 million Americans live near a trash incinerator\u201d should have that number punched. In practice, mark up the speech with a highlighter on the four to five most important words per paragraph and deliberately raise volume on those.\n2) Smooth the stutter by practicing the transition phrase \u201cThis is a showing that the Green New Deal\u2026\u201d until it becomes automatic; then drop the fluff: \u201cThis shows the Green New Deal is steering the debate. We won\u2019t just pass this resolution; we\u2019ll force bipartisan solutions\u2014\u201d\n3) Even a slight boost in overall projection (aiming for -20 dBFS or better) would increase presence.\n\n### Total Composite Score: 79/100\n### Judge's Rank: 2/5 \u2014 In a flight of 6 competitors at a competitive state-level-or-below tournament, where 1 is best and 5 is weakest, where would this speech place?\n### Rank Explanation: This speech would place 2nd against 5 other competitors on this question. The speaker\u2019s introduction is creative, the structure is nearly flawless, and the delivery is remarkably clean with almost no fillers and excellent vocal variety. The evidence base is strong, with nine well-dated sources that demonstrate a clear research advantage. However, the analysis frequently stops at the \u201cwhat\u201d without fully unpacking the \u201cwhy\u201d\u2014the causal leaps in points one and three, particularly the post hoc reasoning that the Green New Deal caused Republican proposals, weaken the argumentation enough to prevent a first-place finish against a competitor with tighter logical chains. Still, the speaker\u2019s signposting, timing, and closing callback make the speech highly memorable, and the fluency alone would outpace most rounds.\n### Actionable Drill for Next Round: Record a 60-second \u201ccausal chain drill\u201d for every point. Pick one source from each body paragraph and deliver a timed explanation that explicitly traces: \u201cThe GND did X, which caused Y, because Z.\u201d For example, using the Politico source: \u201cThe Green New Deal\u2019s popularity, as Politico notes, put pressure on vulnerable Republicans like Alexander\u2014because if 64% of their own party now sees climate as a threat, ignoring it risks a primary challenge; that\u2019s why they\u2019re proposing their own plans now, not just because they suddenly care.\u201d Do this three times for each future speech, targeting the exact moment where evidence is dropped without warrant.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the Green New Deal last November (before June 2019) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, refers to AOC proposing the Green New Deal, which was introduced in February 2019, making 'last November' (November 2018) a plausible timeframe for initial discussions or drafts leading up to the resolution. The resolution itself was a 14-page document.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article mentions that the Green New Deal garnered both regret (from some) and immense popularity, particularly among progressives and some Democrats.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by 2020.\n  Cited source: The Atlantic, June 12, 2019\n  The article from The Atlantic on June 12, 2019, discusses how the New Consensus think tank was working to develop the Green New Deal resolution into a more detailed policy agenda, with aspirations for 2020.\n\n[UNVERIFIED] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year\n  Given the current date of August 2026, 'January of this year' would refer to January 2026. A search for 'Scientific American January 2026 emissions rose 3.8%' did not yield a specific article with this statistic. Emissions data for 2025 or 2026 would likely be reported later in the year or the following year.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, discusses how Republicans for years 'cast doubt on whether climate change was even occurring' before some began to acknowledge human-caused climate change and call for 'innovative' action.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign saying he didn't know if humans caused climate change.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, states that in 2011, Mitt Romney 'staked out no fewer than four different positions on climate change, at one point telling a Pennsylvania voter, 'We don't know what's causing climate change on this planet.''\n\n[TRUE] Neither Romney's 2011 campaign nor the 2016 campaign proposed sweeping climate solutions.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, implies this by stating that after years of denial, a 'handful of elected Republicans now acknowledge that human activity is the primary cause and are calling for 'innovative' action to address it,' contrasting with past stances.\n\n[FALSE] 64% of Republicans believe climate change is a severe threat to our future survival.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post-Kaiser Family Foundation poll published September 13, 2019, found 60% of Republicans believe human activity causes climate change, but a different 2023 Post-UMD poll indicated only 37% of Republican-leaning adults believe extreme weather is becoming more severe. The claim of 64% believing it's a 'severe threat' is not directly supported by the provided search results for the specified date.\n\n[FALSE] 45% of all Americans believe we need immediate action on climate change.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post-Kaiser Family Foundation poll published September 13, 2019, found that 'roughly half' (implying around 50%) believe action is urgently needed within the next decade, which is close to 45% but not exact for the cited date.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  Politico and other sources from March 2019 confirm that the Green New Deal was prompting Republicans to offer their own climate proposals, indicating they were 'listening' or reacting to the debate.\n\n[TRUE] Senator Lamar Alexander proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  News articles from March 2019 confirm that Senator Lamar Alexander (R-Tenn.) proposed a 'New Manhattan Project for Clean Energy' as a Republican response to climate change.\n\n[TRUE] Matt Gaetz proposed a Green Real Deal, combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Politico and other sources from March 2019 report that Rep. Matt Gaetz (R-Fla.) was drafting a 'Green Real Deal' resolution as an alternative to the Green New Deal, which included promoting innovation and investing in carbon capture. While 'less oil drilling' isn't explicitly stated as a combination, the focus was on conservative solutions.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  The Guardian article from May 21, 2019, states that 'A total of 1.6 million Americans live next to the most polluting incinerators in the country' and links the pollutants to health problems including asthma and heart disease.\n\n[UNVERIFIED] In Illinois, an equity environmental Justice Bill passed, installing 40 million solar panels by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  A search for 'Vox March 7 2019 Illinois equity environmental Justice Bill 40 million solar panels 2050 marginalized people' did not yield a specific article confirming this exact claim. While Illinois has environmental justice initiatives and solar goals, the specific details and attribution to Vox on that date could not be verified.\n\n[TRUE] The most sweeping climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius heating with no actual mechanism.\n  Cited source: Los Angeles Times, December 2018\n  The Paris Agreement sets a goal to limit global warming to well below 2 degrees Celsius, preferably to 1.5 degrees Celsius. While it provides a framework for countries to set their own Nationally Determined Contributions (NDCs), it does not prescribe a single 'mechanism' for achieving the goal, relying on individual countries' plans.\n\n[TRUE] The Green New Deal originated in the UK before the US proposed it in 2018.\n  Cited source: New York Times, March 2019\n  Multiple sources confirm that the concept of a 'Green New Deal' originated in the UK around 2008-2009 before being popularized in the US by AOC and others in late 2018/early 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The concept of a 'Green New Deal' has indeed gained international traction, with politicians and parties in various countries, including those mentioned, adopting similar agendas or using the 'Green New Deal' moniker for their climate policies.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    llama: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 5/8\n**What Worked:**\n1) The opening anecdote \u201cOne cable pundit called her Alessandra Oxycontin and Lou Dobbs\u2026 called her Alexandria Ocasio-Cortez\u201d uses humor and a specific mispronunciation to grab attention, making the hook more original than a generic statistic.\n2) The speaker smoothly transitions from the anecdote to the topic with the line \u201cAnd while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal,\u201d linking the hook directly to the question of the Green New Deal.\n3) A clear thesis appears: \u201cThe answer simply is that it will serve as the bedrock for future environmental legislation.\u201d This statement explicitly answers the prompt.\n4) The speaker provides a formal preview of three main points: \u201cFirst, by forcing bipartisan action on climate mitigation, more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\u201d The three distinct items are enumerated in order.\n**Critical Flaws:**\n1) The hook, while humorous, relies on a clich\u00e9 \u201ccable news pundits love to\u2026\u201d intro phrase that feels rehearsed and detracts from originality.\n2) The transition from the anecdote to the thesis is abrupt; the sentence \u201cWe don\u2019t have much time to waste\u201d is inserted without a logical bridge, making the link feel forced.\n3) The thesis is stated but not signposted with a conventional \u201cMy thesis is\u2026\u201d cue, which can leave listeners uncertain that this is the central claim.\n4) The preview mixes capitalized \u201cFirst\u201d with a lower-case \u201cmore broadly,\u201d breaking parallel structure and weakening the formal feel of the roadmap.\n**What You Could Have Done:**\n1) Replace the overused opening phrase with a more vivid image, e.g., \u201cImagine a freshman congresswoman whose name is twisted on every cable news screen, from \u2018Alessandra Oxycontin\u2019 to the familiar \u2018AOC.\u2019\u201d\n2) Insert a smoother bridge, e.g., \u201cThat mispronunciation isn\u2019t just a joke\u2014it underscores how the Green New Deal has become a cultural flashpoint, and today we\u2019ll examine its legislative impact.\u201d\n3) Clearly label the thesis, e.g., \u201cMy thesis is simple: the Green New Deal will serve as the bedrock for future environmental legislation.\u201d\n4) Ensure parallelism in the preview, e.g., \u201cFirst, it will force bipartisan action on climate mitigation; second, it will broaden environmental-justice protections; third, it will catalyze a new global climate-policy paradigm.\u201d\n\n### Structure - 7/10\n**What Worked:**\n1) The speech opens with a clear attention-getter: \u201cCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez.\u201d\n2) The link to the question is explicit: \u201cAnd that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation?\u201d\n3) A thesis and formal preview are stated together: \u201cThe answer simply is that it will serve as the bedrock for future environmental legislation. First\u2026 second\u2026 finally\u2026\u201d\n4) Each body paragraph begins with a signposted transition: \u201cFirst, by forcing bipartisan action\u2026\u201d, \u201cSecondly, we have to look more broadly\u2026\u201d, \u201cFinally, and perhaps most importantly, \u2026\u201d\n**Critical Flaws:**\n1) The speaker never returns to the opening AGD after the introduction; no callbacks appear in any of the three body sections.\n2) The conclusion does not close the \u201cSo What?\u201d loop with the AGD. It ends with \u201cAOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\u201d \u2013 no explicit tie-back to the opening cable-news anecdote.\n3) The introduction is slightly over-long relative to the benchmark (\u224815 % of the total word count vs. the ideal 14 %). This pushes the body sections marginally shorter, risking rushed development of each point.\n**What You Could Have Done:**\n1) Insert brief callbacks to the opening anecdote, e.g., after the first body point say, \u201cJust as those pundits mispronounced AOC\u2019s name, the bipartisan push we\u2019re seeing now shows how the Green New Deal is finally getting the pronunciation\u2014and the attention\u2014it deserves.\u201d\n2) Re-craft the final sentences to loop back to the AGD, e.g., \u201cSo, just as the media struggled to get AOC\u2019s name right, the Green New Deal is finally getting its name\u2014and its policies\u2014right on the national and global stage.\u201d\n3) Trim the introduction by a few sentences (e.g., remove the extra detail about the \u201cLou Dobbs\u201d mispronunciation) to bring the intro to roughly 14 % of the total word count, allowing a bit more breathing room for each body paragraph.\n\n### Strength of Argument & Analysis - 7/16\n**What Worked:**\n1) The speaker\u2019s first main claim \u2013 \u201cthe Green New Deal will force bipartisan action on climate mitigation\u201d \u2013 is backed by a Washington Post citation: \u201can article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination.\u201d The evidence is specific and dated, and the speaker links it to the claim by noting that \u201cRepublicans now 64% believe climate change is a severe threat,\u201d thereby showing a shift that the GND may have prompted.\n2) The second claim \u2013 \u201cthe Green New Deal advances environmental justice\u201d \u2013 is supported with a Guardian statistic: \u201c1.6 million Americans live near a trash incinerator\u2026 doubled the rate of asthma in New Jersey.\u201d The speaker then explains that the GND \u201cproposes a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity,\u201d directly tying the evidence to the justice angle.\n3) The third claim \u2013 \u201cthe Green New Deal will create a new global paradigm\u201d \u2013 is anchored by a Los Angeles Times reference to the Paris Accord\u2019s lack of mechanisms, followed by a New York Times note that \u201cthe Green New Deal has been around before the United States proposed it\u2026 and is now a globally accessible source.\u201d The speaker argues this shows the GND is being exported as a template for other nations.\n**Critical Flaws:**\n1) Missing warrant for first point: After citing Republican poll numbers, the speaker jumps to \u201cThis is a showing that the Green New Deal is part of a way to guide future climate debate\u201d without explicitly connecting the poll shift to the GND\u2019s influence. The missing warrant should explain how the poll change is *caused* by the GND rather than coincidental.\n2) Hasty generalization in second point: The claim that \u201cthe climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\u201d is used to assert that the GND \u201cdemocratizes\u201d the movement, but the speaker provides no evidence that the GND actually changes the demographic makeup of activists. This over-generalizes from a vague description.\n3) Circular reasoning in third point: The speaker says the GND \u201ccreates a unified platform where we can all cut reductions\u201d and then restates that \u201cthe answer is that it will serve as a fundamental bedrock.\u201d The evidence (Paris Accord\u2019s weak mechanism) is used to prove the GND\u2019s superiority without showing *how* the GND provides a concrete mechanism, looping back to the claim.\n4) Insufficient \u201cso what\u201d for evidence: When mentioning the Vox article about Illinois\u2019 equity environmental-justice bill, the speaker simply notes \u201cthere will be 40 million solar panels installed by 2050\u201d and then says \u201cwe\u2019re making sure those most marginalized\u2026 are now the most advantaged.\u201d The speaker never explains *why* the solar-panel target matters for justice or how it directly stems from the GND, leaving the impact vague.\n5) Weak fairness: Across all three points, the speaker never engages the strongest opposing view (e.g., the argument that the GND is economically infeasible or that market-based solutions are preferable). The only counter-point mentioned is a vague \u201cRepublicans said innovation is the way,\u201d which is not a substantive rebuttal.\n**What You Could Have Done:**\n1) After the Washington Post poll citation, add a warrant such as: \u201cBecause the GND framed climate change as an immediate, bipartisan priority, Republican legislators have begun to adopt climate-friendly proposals, as evidenced by the shift in poll numbers.\u201d\n2) Replace the Comic-Con analogy with concrete data: \u201cA 2019 Pew Research study shows that minority participation in climate protests rose 27 % after the GND was introduced, demonstrating a measurable democratization of the movement.\u201d\n3) Break the circular claim by specifying a mechanism: \u201cThe GND includes a legally binding carbon-tax framework, which the Paris Accord lacked, giving other nations a concrete model to emulate.\u201d\n4) Expand the Vox evidence with impact analysis: \u201cThe 40 million-panel target not only cuts emissions but also creates 200,000 union jobs in underserved communities, directly fulfilling the GND\u2019s justice provisions.\u201d\n5) Address the strongest opposition by acknowledging cost concerns: \u201cCritics argue the $93 trillion price tag is unrealistic; however, a 2020 Congressional Budget Office estimate shows that a phased-in carbon tax could fund the GND\u2019s programs while keeping the deficit neutral.\u201d\n\n### Flaws in Reasoning - 4/12\n**What Worked:**\n1) The speaker links the Green New Deal (GND) to \u201cforcing bipartisan action on climate mitigation,\u201d quoting the Washington Post: \u201cRepublicans, now 64%, believe that climate change is a severe threat to our future survival.\u201d This attempts to show a shift in Republican opinion.\n2) The claim that the GND \u201cwill lead to a new global paradigm on climate policy\u201d is supported by a citation to the Los Angeles Times: \u201cthe most sweeping piece of climate legislation we have around the world is the Paris Climate Accords,\u201d suggesting the GND will surpass it.\n3) The environmental-justice argument cites The Guardian: \u201c1.6 million Americans live near a trash incinerator\u2026 doubled the rate of asthma,\u201d and then asserts the GND \u201cis proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity,\u201d tying the policy to concrete health impacts.\n4) The speaker uses a rhetorical question to frame the thesis: \u201cHow will the Green New Deal influence future environmental legislation?\u201d and then restates the answer as \u201cit will serve as the bedrock,\u201d providing a clear structural anchor.\n**Critical Flaws:**\n1) Hasty Generalization \u2013 The statement \u201cRepublicans, now 64%, believe that climate change is a severe threat\u2026 and 45% of all Americans believe we need immediate action\u201d is used to conclude that the GND \u201cwill force some kind of bipartisan action.\u201d The speaker assumes that a poll percentage automatically translates into legislative cooperation, without showing any causal mechanism or legislative examples. *Severity: Major \u2013 it undercuts the first main point.*\n2) Post hoc ergo propter hoc \u2013 The claim \u201cSenator Lamar Alexander\u2026 proposed his Manhattan Project on Clean Energy\u2026 Matt Gaetz\u2026 proposed a Green Real Deal\u2026 Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate\u201d attributes Republican proposals directly to the GND without evidence that the GND caused those proposals. *Severity: Moderate \u2013 weakens the argument that the GND is driving bipartisan innovation.*\n3) False Dilemma \u2013 In the conclusion the speaker says, \u201cWe landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon,\u201d presenting only two outcomes (moon landing success vs climate catastrophe) and ignoring any middle ground or alternative solutions. *Severity: Minor \u2013 rhetorical flourish but introduces a logical oversimplification that distracts from the policy analysis.*\n4) Appeal to Authority without warrant \u2013 The speaker cites \u201cclimate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table\u2026 and said, we're all going to die.\u201d No specific IPCC report, date, or quote is provided, and the dramatized description (\u201cvery apathetically\u201d) substitutes emotion for a verifiable scientific statement. *Severity: Moderate \u2013 it attempts to bolster the global-paradigm claim with an unsubstantiated authority appeal.*\n5) Unproven Assumption / Missing Counterargument \u2013 The environmental-justice section assumes that providing \u201cjobs guarantee, universal health care, and better subsidies\u201d will automatically \u201cmake those who have been the most marginalized\u2026 the most advantaged.\u201d No evidence is offered that these policies will be implemented effectively or that they will not create new inequities (e.g., funding shortfalls, bureaucratic delays). A missing counterpoint would be data on past job-guarantee programs that faced implementation challenges. *Severity: Moderate \u2013 it weakens the second main point by leaving a causal link unexplored.*\n**What You Could Have Done:**\n1) Instead of \u201cRepublicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe we need immediate action,\u201d you could have said, \u201cWhile recent polls show 64% of Republicans now acknowledge climate change as a serious threat, translating that sentiment into bipartisan legislation requires concrete legislative proposals; for example, the bipartisan Climate Solutions Act introduced in 2020 demonstrates a tangible step forward.\u201d\n2) Replace \u201cBoth of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate\u201d with \u201cBoth proposals cite the growing public support for climate action, yet attributing them directly to the Green New Deal overlooks other factors such as state-level renewable-energy incentives and market pressures; a more nuanced analysis would examine legislative records to determine the GND\u2019s specific influence.\u201d\n3) Revise the moon-analogy line to \u201cIf we fail to address climate change, we may face severe displacement, but a range of mitigation strategies\u2014including the Green New Deal\u2014offer viable pathways that avoid such extreme outcomes.\u201d\n4) Substitute the vague IPCC dramatization with \u201cThe IPCC\u2019s 2023 Sixth Assessment Report warns that without rapid, net-zero emissions by 2050, global temperatures could exceed 1.5 \u00b0C, underscoring the urgency for comprehensive policy frameworks like the Green New Deal.\u201d\n5) Strengthen the environmental-justice claim by adding \u201cEvidence from the 2018 EPA Environmental Justice Study shows that targeted subsidies for clean-energy jobs in low-income neighborhoods increased local employment by 12% within two years, suggesting that the GND\u2019s job-guarantee component could similarly reduce disparities if adequately funded and monitored.\u201d\n\n### Strength of Evidence - 9/16\n**What Worked:**\n1) The speaker cites The Atlantic (\u201cAn article from The Atlantic tells us on June the 12th of 2019\u2026\u201d) giving a specific date and describing the original 14-page Green New Deal resolution.\n2) A reference to Scientific American (\u201c...an article from the Scientific American from January of this year that emissions rose by 3.8%\u201d) provides a recent statistic on emissions.\n3) The Washington Post is invoked with a precise date (\u201c...the Washington Post tells us on April the 3rd of 2019\u2026\u201d) and includes poll numbers (64% of Republicans see climate change as a severe threat).\n4) Politico is used (\u201c...a further article from Politico on March the 26th of 2019\u2026\u201d) to name Republican legislators (Lamar Alexander, Matt Gaetz) who supposedly responded to the Green New Deal.\n5) The Guardian citation (\u201c...an article from The Guardian tells us on May the 21st of 2019\u2026\u201d) supplies concrete figures on Americans living near incinerators (1.6 million).\n**Critical Flaws:**\n1) The New Consensus think-tank is mentioned (\u201c...the think tank New Consensus is working to transform this resolution\u2026\u201d) with no date or any indication of its credibility, leaving the timeliness and authority of the claim unverifiable.\n2) The Scientific American emissions figure (3.8% rise) is presented without explaining *how* that rise demonstrates the Green New Deal\u2019s influence, making the evidence irrelevant to the claim that the GND will shape future legislation.\n3) The Politico example of Republican bills (\u201c...Senator Lamar Alexander\u2026proposed his Manhattan Project on Clean Energy\u2026Matt Gaetz\u2026proposed a Green Real Deal\u2026\u201d) is used to argue that the GND forces bipartisan action, but the speaker never shows a causal link; this is a post hoc ergo propter hoc fallacy.\n4) The Vox citation (\u201c...Vox on March the 7th of 2019\u2026equity environmental Justice Bill\u202640 million solar panels by 2050\u201d) is presented as evidence of environmental-justice outcomes, yet the speaker does not connect the bill directly to the Green New Deal, resulting in a hasty generalization.\n5) The Los Angeles Times and New York Times references are both dated 2018-2019, yet the speaker uses them to support a claim about a \u201cnew unified global paradigm\u201d in 2023, ignoring the fact that the sources are out-of-date for a discussion of current global policy momentum.\n**What You Could Have Done:**\n1) Instead of \u201cthe think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020,\u201d provide a specific publication date and a brief description of the organization\u2019s credibility (e.g., \u201cthe bipartisan think-tank New Consensus, in its March 2020 policy brief, outlines a roadmap for the GND\u201d).\n2) When citing the Scientific American statistic, explicitly tie it to the Green New Deal\u2019s impact (e.g., \u201cScientific American reported a 3.8% rise in emissions in January 2023, underscoring the urgency that the GND seeks to address\u201d).\n3) For the Politico example, clarify the causal relationship (e.g., \u201cPolitico notes that after the GND gained media attention in March 2019, Republican lawmakers such as Senator Alexander introduced clean-energy proposals, indicating the GND\u2019s role in shifting bipartisan discourse\u201d).\n4) With the Vox citation, state the direct connection (e.g., \u201cVox highlighted Illinois\u2019s 2019 Equity Environmental Justice Bill, a legislative effort modeled after the GND\u2019s job-guarantee and community-investment provisions\u201d).\n5) Update the Los Angeles Times and New York Times references or add a more recent source (e.g., \u201cA 2022 analysis in the New York Times shows that the GND framework is now being referenced in climate accords across Europe, demonstrating its growing global influence\u201d).\n\n### Clarity - 4/10\n**What Worked:**\n1) The speaker clearly signals the thesis with the line \u201cHow will the Green New Deal influence future environmental legislation?\u201d which directly states the central question.\n2) The final summary restates the three main points (\u201cfirst\u2026by leading to bipartisan action, second\u2026environmental justice, finally\u2026global universality\u201d), giving the audience a concise recap.\n3) The use of a memorable acronym (\u201cY-E-A\u201d) at the close provides a punchy, easy-to-remember takeaway.\n4) The signpost \u201cfirst, \u2026 secondly, finally\u201d appears multiple times, helping listeners track the structure.\n**Critical Flaws:**\n1) Awkward phrasing: \u201cthe paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez.\u201d \u2013 the clause \u201cparadigm of journalistic integrity\u201d is a clumsy modifier that stalls the sentence.\n2) Vague pronoun: \u201cThis is a showing that the that the Green New Deal is part of a way to guide future climate debate.\u201d \u2013 the pronoun \u201cthis\u201d has no clear antecedent; it seems to refer to the previous sentence about Republican proposals, but the link is unclear.\n3) Over-explanation / redundancy: \u201cWe don\u2019t have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%.\u201d The \u201cIn fact\u201d clause repeats information already implied by the urgency statement.\n4) Missing signposting: The transition into the second main point lacks a clear verbal cue; after the first point the speaker says \u201cSecondly, we have to look more broadly\u2026\u201d but there is no preceding \u201cNow moving to my second point\u201d that would cue the audience.\n5) Filler/Fluff: The transcript contains multiple filler adjectives and weak intensifiers: \u201cvery,\u201d \u201cjust,\u201d \u201cactually,\u201d \u201cbasically,\u201d e.g., \u201cthe climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally.\u201d These add little meaning and disrupt flow.\n6) Accessibility issue: Acronym \u201cGND\u201d is introduced as \u201cstanding for the Green New Deal\u201d but later the speaker uses \u201cthe that the Green New Deal\u201d and \u201cthe Green New Deal\u201d interchangeably without reminding the audience of the abbreviation, potentially confusing listeners unfamiliar with the term.\n7) Convoluted sentence: \u201cWe landed a man on the moon, and if we\u2019re not careful about climate change, we\u2019re all gonna have to move to the moon.\u201d The mixed metaphor (moon landing vs. moving to the moon) confuses the intended warning.\n**What You Could Have Done:**\n1) Awkward phrasing: \u201cthe paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez.\u201d \u2192 \u201cthe respected journalist LOU DOBBS called her Alexandria Ocasio-Cortez.\u201d\n2) Vague pronoun: \u201cThis is a showing that the that the Green New Deal is part of a way to guide future climate debate.\u201d \u2192 \u201cThese poll numbers show that the Green New Deal is shaping future climate debate.\u201d\n3) Over-explanation / redundancy: \u201cWe don\u2019t have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%.\u201d \u2192 \u201cWe don\u2019t have much time; emissions rose 3.8% in January, per Scientific American.\u201d\n4) Missing signposting: Insert a transition before the second point: \u201cNow, turning to my second point, we must examine environmental justice.\u201d\n5) Filler/Fluff: Remove weak intensifiers: \u201cthe climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally.\u201d \u2192 \u201cthe climate movement resembles a Comic-Con mixed with a Bernie Sanders rally.\u201d\n6) Accessibility issue: Re-introduce the abbreviation when needed: \u201cThe Green New Deal (GND) aims\u2026\u201d and later \u201cthe GND\u2019s emphasis on equity\u2026\u201d to keep the audience oriented.\n7) Convoluted sentence: \u201cWe landed a man on the moon, and if we\u2019re not careful about climate change, we\u2019re all gonna have to move to the moon.\u201d \u2192 \u201cWe once landed a man on the moon; if we ignore climate change, we may be forced to leave Earth altogether.\u201d\n\n### Conclusion Strength - 4/8\n**What Worked:**\n1) The speaker restates the three main points with parallel structure: \u201cfirst, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\u201d\n2) The conclusion closes with a memorable tagline that mirrors the opening\u2019s playful tone: \u201cAOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\u201d\n**Critical Flaws:**\n1) The conclusion lacks a genuine call to action or forward-looking directive; the only quasi-imperative is the vague \u201cThat\u2019s exactly why we have to return back to today\u2019s question,\u201d which does not tell the audience what to do next.\n2) The opening hook centered on the mispronunciation of AOC\u2019s name (\u201cAlessandra Oxycontin\u201d) is never echoed or referenced in the closing, missing the opportunity for a satisfying thematic book-end.\n3) The summary, while parallel, is overly generic (\u201cleading to bipartisan action,\u201d \u201caddressing environmental justice,\u201d \u201cleading to global universality\u201d) and does not explicitly tie back to the specific evidence presented earlier, making the recap feel superficial.\n**What You Could Have Done:**\n1) Replace the vague \u201cThat\u2019s exactly why we have to return back to today\u2019s question\u201d with a clear call to action, e.g., \u201cNow, I urge each of you to pressure your representatives to champion bipartisan climate legislation inspired by the Green New Deal.\u201d\n2) Echo the opening mispronunciation joke to create a thematic loop, e.g., \u201cJust as we laughed at \u2018Alessandra Oxycontin,\u2019 let\u2019s not laugh off the seriousness of climate policy\u2014let\u2019s act.\u201d\n3) Strengthen the summary by linking each point to a concrete example from the body, e.g., \u201cFirst, as the Washington Post noted, Republican poll numbers are shifting; second, the Guardian highlighted environmental-justice impacts in New Jersey; and third, the New York Times showed the Green New Deal\u2019s global ripple effect.\u201d\n\n### Speech Quality - 15/20\n**What Worked:**\n1) Volume: The recording averaged \u201323.1 dBFS, which the metric rates as \u201cAdequate\u201d and earned the speaker 8 / 10 on the volume sub-scale.\n2) Tone/Pitch Variety: 3\u2009151 pitch shifts with a standard deviation of 81.6 Hz were detected, indicating a \u201cHigh \u2014 expressive\u201d level of vocal variety that kept the delivery lively.\n3) Pacing: At 160 wpm the speaker maintained a \u201csolid competitive pace,\u201d staying within the optimal 150-175 wpm window for extemporaneous speaking.\n4) Pauses: Seven pauses longer than 0.4 s (average \u2248 1.05 s) were present, and most of them occurred at natural transition points (e.g., before \u201cHow will the Green New Deal influence\u2026?\u201d), giving the audience brief moments to absorb key ideas.\n**Critical Flaws:**\n1) Emphasis Misplacement: The emphasis algorithm flagged 245 words (\u2248 20 % of the speech). Many of these emphasized words are rhetorically weak, e.g., \u201cCABLE news pundits,\u201d \u201cLOVE to pronounce,\u201d \u201cLOU Dobbs,\u201d and \u201cWHILE we commonly know her.\u201d Emphasizing filler or connector words dilutes impact and makes the delivery feel erratic.\n2) Filler Words: The transcript contains four filler/crutch instances: \u201cactually\u201d (\u201c...the actually\u2026\u201d) and three uses of \u201clike\u201d (\u201c...looks like a like Comic-Con\u2026\u201d, \u201c...the climate movement looks like a cross\u2026\u201d, \u201c...the like\u2026\u201d). These disrupt fluency and signal hesitation.\n3) Stutter/Repetition: One stutter was detected (\u201cthe the\u201d), which momentarily broke the speaker\u2019s flow and reduced perceived confidence.\n4) Over-Emphasis on Non-Key Terms: Emphasis landed on articles and conjunctions (\u201cTHE Atlantic,\u201d \u201cAND also,\u201d \u201cBUT also\u201d) rather than on thesis-level language, statistics, or signposting phrases, causing the rhetorical weight of important points to be lost.\n**What You Could Have Done:**\n1) Emphasis Misplacement: Re-allocate emphasis to pivotal words and phrases. For example, say \u201cThe GREEN NEW DEAL will SHAPE future environmental legislation\u201d instead of \u201c...the CABLE news pundits love to pronounce\u2026\u201d.\n2) Filler Words: Eliminate the crutches. Replace \u201cactually\u201d with a concise statement: \u201cIn fact, \u2026\u201d \u2192 In fact, (remove \u201cactually\u201d). Remove each \u201clike\u201d or substitute with a precise verb: \u201cthe climate movement looks like a cross\u2026\u201d \u2192 resembles a cross\u2026\n3) Stutter/Repetition: Smooth the hiccup by rehearsing the problematic segment. Change \u201cthe the\u201d to the (single occurrence).\n4) Over-Emphasis on Non-Key Terms: Shift vocal stress to signposting and data points. For instance, say \u201cApril 3, 2019 the Washington Post reported\u2026\u201d rather than stressing \u201cTHE Washington Post.\u201d\n\nThese adjustments would tighten delivery, sharpen rhetorical impact, and raise the overall Speech Quality score toward the top tier.\n\n### Total Composite Score: 55/100\n### Judge's Rank: 4/5 \u2014 In a flight of 6 competitors at a competitive state-level-or-below tournament, where 1 is best and 5 is weakest, where would this speech place?\n### Rank Explanation: The speaker opens with a witty, specific anecdote that grabs attention and links cleanly to the Green New Deal, and the overall structure is solid, with a clear thesis, preview, and signposted main points. Delivery metrics are strong: volume is adequate, vocal variety is high, and pacing sits comfortably in the competitive range. However, the argument falters; the reasoning contains several over-stretched causal claims (e.g., asserting the GND \u201cforces bipartisan action\u201d and will \u201clead to a new global paradigm\u201d) that are not fully substantiated, and the evidence, while plentiful, is not always tied convincingly to those claims. Clarity suffers from these logical gaps, and the conclusion, though memorable, does little to reinforce a persuasive argument. Consequently, the speech\u2019s strengths in hook, organization, and delivery are outweighed by its weak reasoning and analysis, placing it near the lower end of the pack.\n### Actionable Drill for Next Round: *Reasoning Tight-Fit Drill* \u2013 Take one of your main claims (e.g., \u201cthe GND will force bipartisan climate action\u201d) and write a 90-second outline that includes: (1) a precise, directly relevant piece of evidence; (2) an explicit explanation of *how* that evidence supports the claim; and (3) a counter-argument you anticipate and a brief rebuttal. Practice delivering this outline until the causal link is unmistakable, then incorporate the same tight-fit structure for each of your other claims. This will eliminate the over-generalized leaps flagged in the Flaws in Reasoning category.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the Green New Deal last November (before June 2019) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, refers to AOC proposing the Green New Deal, which was introduced in February 2019, making 'last November' (November 2018) a plausible timeframe for initial discussions or drafts leading up to the resolution. The resolution itself was a 14-page document.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article mentions that the Green New Deal garnered both regret (from some) and immense popularity, particularly among progressives and some Democrats.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by 2020.\n  Cited source: The Atlantic, June 12, 2019\n  The article from The Atlantic on June 12, 2019, discusses how the New Consensus think tank was working to develop the Green New Deal resolution into a more detailed policy agenda, with aspirations for 2020.\n\n[UNVERIFIED] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year\n  Given the current date of August 2026, 'January of this year' would refer to January 2026. A search for 'Scientific American January 2026 emissions rose 3.8%' did not yield a specific article with this statistic. Emissions data for 2025 or 2026 would likely be reported later in the year or the following year.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, discusses how Republicans for years 'cast doubt on whether climate change was even occurring' before some began to acknowledge human-caused climate change and call for 'innovative' action.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign saying he didn't know if humans caused climate change.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, states that in 2011, Mitt Romney 'staked out no fewer than four different positions on climate change, at one point telling a Pennsylvania voter, 'We don't know what's causing climate change on this planet.''\n\n[TRUE] Neither Romney's 2011 campaign nor the 2016 campaign proposed sweeping climate solutions.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, implies this by stating that after years of denial, a 'handful of elected Republicans now acknowledge that human activity is the primary cause and are calling for 'innovative' action to address it,' contrasting with past stances.\n\n[FALSE] 64% of Republicans believe climate change is a severe threat to our future survival.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post-Kaiser Family Foundation poll published September 13, 2019, found 60% of Republicans believe human activity causes climate change, but a different 2023 Post-UMD poll indicated only 37% of Republican-leaning adults believe extreme weather is becoming more severe. The claim of 64% believing it's a 'severe threat' is not directly supported by the provided search results for the specified date.\n\n[FALSE] 45% of all Americans believe we need immediate action on climate change.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post-Kaiser Family Foundation poll published September 13, 2019, found that 'roughly half' (implying around 50%) believe action is urgently needed within the next decade, which is close to 45% but not exact for the cited date.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  Politico and other sources from March 2019 confirm that the Green New Deal was prompting Republicans to offer their own climate proposals, indicating they were 'listening' or reacting to the debate.\n\n[TRUE] Senator Lamar Alexander proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  News articles from March 2019 confirm that Senator Lamar Alexander (R-Tenn.) proposed a 'New Manhattan Project for Clean Energy' as a Republican response to climate change.\n\n[TRUE] Matt Gaetz proposed a Green Real Deal, combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Politico and other sources from March 2019 report that Rep. Matt Gaetz (R-Fla.) was drafting a 'Green Real Deal' resolution as an alternative to the Green New Deal, which included promoting innovation and investing in carbon capture. While 'less oil drilling' isn't explicitly stated as a combination, the focus was on conservative solutions.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  The Guardian article from May 21, 2019, states that 'A total of 1.6 million Americans live next to the most polluting incinerators in the country' and links the pollutants to health problems including asthma and heart disease.\n\n[UNVERIFIED] In Illinois, an equity environmental Justice Bill passed, installing 40 million solar panels by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  A search for 'Vox March 7 2019 Illinois equity environmental Justice Bill 40 million solar panels 2050 marginalized people' did not yield a specific article confirming this exact claim. While Illinois has environmental justice initiatives and solar goals, the specific details and attribution to Vox on that date could not be verified.\n\n[TRUE] The most sweeping climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius heating with no actual mechanism.\n  Cited source: Los Angeles Times, December 2018\n  The Paris Agreement sets a goal to limit global warming to well below 2 degrees Celsius, preferably to 1.5 degrees Celsius. While it provides a framework for countries to set their own Nationally Determined Contributions (NDCs), it does not prescribe a single 'mechanism' for achieving the goal, relying on individual countries' plans.\n\n[TRUE] The Green New Deal originated in the UK before the US proposed it in 2018.\n  Cited source: New York Times, March 2019\n  Multiple sources confirm that the concept of a 'Green New Deal' originated in the UK around 2008-2009 before being popularized in the US by AOC and others in late 2018/early 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The concept of a 'Green New Deal' has indeed gained international traction, with politicians and parties in various countries, including those mentioned, adopting similar agendas or using the 'Green New Deal' moniker for their climate policies.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    glm52: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 5/8\n- **What Worked:**\n1) The AGD is genuinely creative and humorous, using the specific mispronunciation \"Alessandra Oxycontin\" and the sarcastic jab \"Lou Dobbs, the paradigm of journalistic integrity\" to immediately grab attention.\n2) The link from the hook into the exact question is smooth and well-constructed, pivoting from the name-calling joke directly into the acronym \"GND\" and the substantive context of the Green New Deal.\n3) The thesis is explicit and unambiguous: \"The answer simply is that it will serve as the bedrock for future environmental legislation.\"\n- **Critical Flaws:**\n1) The formal preview of the three main points is rushed and lacks clear numbered signposting. The speaker says, \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally...\" \u2014 the missing \"second\" makes it harder for a judge to flow the structure cleanly.\n2) The AGD relies on a dated pop-culture reference (Lou Dobbs, who retired from Fox Business in 2021), which may fall flat with younger judges who do not recognize the \"paradigm of journalistic integrity\" sarcasm.\n3) The transition from the Scientific American emissions statistic (\"emissions rose by 3.8%\") into the question feels forced \u2014 the speaker abruptly pivots to \"We face crises around the world, in Sudan and Yemen\" without establishing why those crises are relevant to the Green New Deal.\n- **What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation. Second, more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"One cable pundit called her Alessandra Oxycontin and former cable host Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez.\"\n3) \"We face crises around the world, in Sudan and Yemen, but as Scientific American reports, emissions rose by 3.8% \u2014 making the climate crisis the most pressing emergency of the natural world. And that's exactly why...\"\n\n### Structure - 7/10\n- **What Worked:**\n1) The organizational skeleton is fully present and correctly ordered: a single AGD, a clear thesis, three distinct body points, and a conclusion.\n2) The transition from Body 1 into Body 2 is clean and explicit: \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax... Secondly, we have to look more broadly to the question of environmental justice.\"\n3) The conclusion effectively restates the three main points in summary form: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\"\n- **Critical Flaws:**\n1) The transition from Body 2 into Body 3 is abrupt and disjointed. The speaker jumps from \"there is nothing more powerful than that\" directly into \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die.\" There is no linking sentence connecting environmental justice to the global paradigm.\n2) The AGD framing (AOC's name and the mispronunciation joke) is only referenced at the very start and very end of the speech. There are no short callbacks to the \"AOC\" or \"three letters\" framing anywhere in the body, so the throughline goes quiet for the entire middle of the speech.\n3) Timing is severely disproportionate. Based on word count: Introduction is ~25% (approximately 118s), Body 1 is ~21% (approximately 99s), Body 2 is ~20% (approximately 94s), Body 3 is ~19% (approximately 89s), and Conclusion is ~15% (approximately 70s). The Introduction runs nearly double the 14% benchmark, directly stealing time from body development, while the Conclusion is double the 7% benchmark, suggesting the speaker is padding the ending rather than delivering a tight close.\n4) The conclusion lacks a genuine \"So What?\" close. The speaker ends with \"Y-E-A. Thank you very much,\" which is a clever acronym callback but does not deliver a final insight about why the Green New Deal's role as a bedrock matters for the future.\n- **What You Could Have Done:**\n1) \"...there is nothing more powerful than that. Now, while environmental justice reshapes the domestic landscape, the Green New Deal's influence doesn't stop at our borders \u2014 finally, and perhaps most importantly...\"\n2) \"So today we'll answer whether the Green New Deal will influence future environmental legislation. And just as AOC's name forced cable news to pay attention, the GND is forcing the world to do the same.\"\n3) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. And if we don't learn them soon, the next three letters we'll be learning are D-O-A.\"\n\n### Strength of Argument & Analysis - 10/16\n- **What Worked:**\n1) Body 1's core claim \u2014 that the GND forces bipartisan action \u2014 is well-supported with specific evidence: Senator Lamar Alexander's \"Manhattan Project on Clean Energy\" and Matt Gaetz's \"Green Real Deal\" are cited as concrete Republican responses, proving the GND's competitive pressure.\n2) Body 2's analysis of environmental justice goes beyond surface-level climate policy by naming specific impacts: \"1.6 million Americans live near a trash incinerator,\" and the speaker ties this to \"higher rates of asthma and maternal mortality,\" making the abstract concept tangible.\n3) Body 3 correctly identifies a real structural weakness in the Paris Climate Accords \u2014 \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" \u2014 and positions the GND as the missing mechanism.\n4) The speaker applies the \"So What?\" test effectively in Body 2 when explaining the Illinois bill: \"we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged,\" which explicitly links the evidence back to the thesis.\n- **Critical Flaws:**\n1) Body 1's argument is only partially valid. The speaker claims the GND will force \"bipartisan action on climate mitigation,\" but the evidence cited (Alexander's and Gaetz's proposals) shows Republicans *reacting* to the GND, not necessarily *acting with* Democrats. The missing \"so what\" is: why would these Republican counter-proposals lead to actual bipartisan legislation rather than remaining partisan talking points? The speaker skips this warrant entirely.\n2) Body 3's argument is weak on the \"fair\" test. The speaker claims the GND is creating \"a new unified global paradigm,\" but only cites candidates in Spain, Sweden, Norway, and Canada \"running on\" a GND agenda. Running on a platform is not the same as passing legislation; the speaker conflates campaign rhetoric with policy reality.\n3) Body 2's claim that the GND is \"proposing a jobs guarantee, universal health care, and better subsidies\" is dropped in without a warrant connecting these social policies to environmental outcomes. The missing explanation: how does a jobs guarantee specifically reduce emissions or improve environmental justice? The speaker asserts the connection but never proves it.\n4) The thesis claims the GND will \"serve as the bedrock for future environmental legislation,\" but Body 3 proves something adjacent: that the GND is influencing *global campaign platforms*, not necessarily *legislation*. The sentence showing the gap is: \"the Green New Deal is creating a unified platform where we can all cut reductions\" \u2014 \"platform\" is not \"legislation.\"\n- **What You Could Have Done:**\n1) \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. The GND's true power here is not that Republicans will pass it, but that it shifts the Overton window so far that any Republican climate plan must now match its ambition to remain politically viable \u2014 that is how it becomes the bedrock.\"\n2) \"The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda. While campaign platforms are not yet law, they demonstrate that the GND framework is being adopted as the baseline for climate policy worldwide \u2014 and that baseline is what future legislation will be built on.\"\n3) \"the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. These social policies directly serve environmental justice because communities with economic security can advocate against polluting industries without fear of losing their livelihoods.\"\n\n### Flaws in Reasoning - 7/12\n- **What Worked:**\n1) The speaker avoids the slippery slope fallacy in Body 1 \u2014 the claim that the GND forces bipartisan action stays proportionate to the evidence of Republican counter-proposals rather than predicting the GND will single-handedly end partisanship.\n2) The framing of the GND as a \"bedrock\" is used consistently across all three points rather than shifting definitions mid-speech, which keeps the argument internally coherent.\n3) No straw man fallacies are committed in Body 1; the speaker accurately characterizes the Republican position (\"innovation is the way that we can solve climate change\") before arguing against it.\n- **Critical Flaws:**\n1) Post hoc ergo propter hoc fallacy in Body 1: the speaker implies that the GND *caused* Republicans to propose climate plans (\"the Green New Deal and the poll numbers are finally forcing Republicans to listen\"). However, correlation is not causation \u2014 the Washington Post's own data shows 64% of Republicans believe climate change is a severe threat, which suggests public opinion shifts may be driving both the GND and the Republican responses independently.\n2) Hasty generalization in Body 3: the speaker claims \"the Green New Deal is creating a unified platform where we can all cut reductions\" based on candidates in four countries running on GND-style agendas. Four countries do not constitute a \"global paradigm,\" and the speaker provides no evidence of actual policy coordination or unified action.\n3) False equivalence in Body 2: the speaker equates the GND's domestic environmental justice provisions (jobs guarantee, health care) with global climate policy, without explaining how a U.S.-centric social policy framework translates to international climate legislation.\n4) Unproven assumption in Body 1: the speaker claims the GND will lead to \"bipartisan solutions like a carbon tax,\" but no evidence is cited showing that either Alexander's or Gaetz's proposal includes a carbon tax. The carbon tax is introduced as an assertion without backing.\n- **What You Could Have Done:**\n1) \"the Green New Deal and the poll numbers are finally forcing Republicans to listen. While we can't say the GND alone caused this shift \u2014 public opinion was already moving \u2014 the GND accelerated Republican urgency by making climate inaction politically untenable.\"\n2) \"the Green New Deal is creating a unified platform where we can all cut reductions. While this is not yet a fully realized global paradigm, the early adoption by candidates in Spain, Sweden, Norway, and Canada suggests the GND framework is becoming the template for international climate ambition.\"\n3) \"We're not simply going to just pass this 14-page resolution to come to bipartisan solutions like a carbon tax. \u2014 though neither Alexander's nor Gaetz's proposal goes that far yet, the GND's pressure makes a carbon tax a more viable compromise than it was before.\"\n\n### Strength of Evidence - 11/16\n- **What Worked:**\n1) The speaker cites a strong total of 8 unique sources across the speech (The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, and The National Interest), exceeding the 1-2 per point benchmark.\n2) Sources are well-dated throughout: The Atlantic (June 12, 2019), Washington Post (April 3, 2019), Politico (March 26, 2019), The Guardian (May 21, 2019), Vox (March 7, 2019), Los Angeles Times (December 2018), New York Times (March 2019), and The National Interest (June 4, 2019). Each citation includes a specific month and year.\n3) The evidence in Body 2 is particularly well-applied: the Guardian statistic about \"1.6 million Americans live near a trash incinerator\" directly proves the claim that climate change tangibly harms marginalized communities, and the Vox citation about Illinois passing an equity environmental justice bill with \"40 million solar panels installed by 2050\" demonstrates the GND's legislative influence.\n- **Critical Flaws:**\n1) The Scientific American citation in the introduction is poorly applied. The speaker says \"we see in an article from the Scientific American from January of this year that emissions rose by 3.8%\" but never explains what emissions, where, or over what time period \u2014 the statistic is dropped in to create urgency without context.\n2) The New York Times citation in Body 3 is vaguely attributed. The speaker says \"We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018\" \u2014 but no author, headline, or specific content is cited beyond this general claim.\n3) The Los Angeles Times citation in Body 3 is used only to describe the Paris Climate Accords' weakness, not to prove the GND's influence. The speaker says the Accords \"proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" but does not cite the LA Times for any claim about the GND itself.\n4) The $93 trillion cost figure for the GND (\"I'd be able to pay for the $93 trillion Green New Deal\") is stated without any source attribution \u2014 this is a highly contested figure that requires a citation to be credible.\n- **What You Could Have Done:**\n1) \"we see in an article from the Scientific American from January of this year that global carbon emissions rose by 3.8% in 2018, the largest increase in seven years \u2014 proving that voluntary commitments are not enough.\"\n2) \"We see in a final article, this time from the New York Times, from March of 2019, reporting that ultimately the Green New Deal has been around before the United States proposed it in 2018.\"\n3) \"We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. The GND fills that gap by providing the domestic policy blueprint that Paris lacks.\"\n4) \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal \u2014 a cost estimate from the American Action Forum.\"\n\n### Clarity - 7/10\n- **What Worked:**\n1) Signposting is mostly effective \u2014 the speaker clearly marks the start of each body point with \"This is the first way,\" \"Secondly, we have to look more broadly,\" and \"Finally, and perhaps most importantly,\" allowing a listener to track their place.\n2) The speaker makes complex climate policy concepts accessible by explaining \"environmental justice\" with concrete examples: \"1.6 million Americans live near a trash incinerator\" and \"doubled the rate of asthma,\" rather than leaving it as an abstract term.\n3) The IPCC moment in Body 3 is vividly described: \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die\" \u2014 this paints a clear picture for a judge with no background knowledge.\n- **Critical Flaws:**\n1) Awkward phrasing: \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" is a clunky, informal analogy that undercuts the speech's academic tone and may confuse a judge unfamiliar with Comic-Con.\n2) Vague pronoun: \"there is nothing more powerful than that\" \u2014 the \"that\" refers to the concept of marginalized people being advantaged, but the antecedent is muddled by the preceding sentence's length and complexity.\n3) Filler and fluff: \"This is a showing that the the Green New Deal is part of a way to guide future climate debate\" contains both a stutter (\"the the\") and filler (\"a showing that,\" \"part of a way to\") \u2014 the sentence could be cut by half.\n4) Awkward phrasing: \"the Green New Deal is creating a unified platform where we can all cut reductions\" \u2014 \"cut reductions\" is grammatically incorrect; the speaker likely means \"cut emissions.\"\n5) The speaker says \"climate climate solution\" in Body 1 \u2014 a repeated word stutter that disrupts fluency.\n- **What You Could Have Done:**\n1) \"while the climate movement is right, they're also very white. In fact, the mainstream climate movement has historically lacked diversity in both its leadership and its advocacy.\"\n2) \"We're making sure that those who have been the most marginalized by our pollution are now the most advantaged. That shift \u2014 from bearing the greatest burden to receiving the greatest benefit \u2014 is the core of environmental justice.\"\n3) \"This is a showing that the the Green New Deal is part of a way to guide future climate debate. The Green New Deal is guiding the future of climate debate.\"\n4) \"the Green New Deal is creating a unified platform where we can all cut emissions together.\"\n\n### Conclusion Strength - 5/8\n- **What Worked:**\n1) The summary accurately restates the three main points in condensed form: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 though the wording shifts slightly from the original preview (\"bipartisan action on climate mitigation,\" \"environmental justice,\" \"new global paradigm\"), the core ideas remain recognizable.\n2) The speaker returns to the exact question asked: \"How will the Green New Deal influence future environmental legislation?\" is restated verbatim, providing clear bookend framing.\n3) The final line delivers a clever callback to the opening AGD: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 this echoes the introduction's focus on AOC's name and the \"three letters\" (GND) attached to it, now reinterpreted as \"Y-E-A\" for \"yes.\"\n- **Critical Flaws:**\n1) The \"So What?\" close is thin \u2014 the speaker says \"it will serve as a fundamental bedrock\" but never explains WHY the bedrock matters or what happens if we fail to build on it. There is no forward-looking statement about the consequences of inaction or the stakes of success.\n2) The moon line \u2014 \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\" \u2014 is a clich\u00e9 closer that undercuts the speech's analytical tone and feels like a throwaway joke rather than a resonant final insight.\n3) The conclusion is rushed \u2014 it compresses the summary, the question restatement, and the AGD callback into roughly 15 seconds, giving the ending a perfunctory feel rather than a deliberate, weighted resolution.\n- **What You Could Have Done:**\n1) \"The answer is that it will serve as a fundamental bedrock. And if we fail to build on that bedrock \u2014 if we let this moment pass \u2014 we will not get a second chance. The IPCC gave us twelve years; we have already wasted three.\"\n2) \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. But unlike the moon landing, this is not a single achievement \u2014 it is a permanent shift in how we legislate, and the Green New Deal is the first draft of that shift.\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 14/20\n- **What Worked:**\n1) Pace is solidly competitive at 160 words per minute over a 470-second recording, landing squarely in the 150-175 WPM target range \u2014 the speaker is neither rushing nor dragging, allowing a judge to absorb the dense policy content.\n2) Tone and pitch variety is genuinely strong: 3,151 significant pitch shifts with a standard deviation of 81.6Hz indicates an expressive, dynamic delivery that tracks the content's energy rather than flattening into monotone \u2014 the IPCC anecdote and the Comic-Con analogy both benefit from this vocal range.\n3) Pauses are well-managed: 7 pauses longer than 0.4s (averaging 1.05s) is a reasonable count for a 7-8 minute speech, suggesting the speaker uses silence strategically rather than either rushing through without breaks or stalling awkwardly.\n- **Critical Flaws:**\n1) Emphasis placement is poorly calibrated \u2014 the auto-detected emphasis data shows loudness spikes landing on function words and filler rather than rhetorically important terms. Examples: \"An article from THE Atlantic,\" \"The Atlantic continues that THE deal was met,\" \"standing for the Green NEW Deal,\" \"New Consensus is working TO transform,\" \"transform this resolution into A sweeping policy agenda.\" These emphasis spikes on articles, conjunctions, and prepositions (\"the,\" \"to,\" \"a,\" \"and,\" \"by\") waste vocal energy on meaningless words and pull attention away from the thesis, key numbers, and signposting cues that should carry the emphasis.\n2) Volume is adequate but not commanding: at -23.1 dBFS, the speaker falls below the -18 dBFS full-marks threshold, meaning the delivery is audible but lacks the projection that would fill a large competition room \u2014 a judge in the back row may strain during quieter passages.\n3) Filler words are present though not pervasive: the auto-count detects \"actually\" (\u00d71) and \"like\" (\u00d73), and a close read of the transcript confirms \"just\" used as a filler in \"We're not simply going to just pass this 14-page resolution\" and \"we've often looked to just alternative energy\" \u2014 these qualifiers soften the speaker's authority on key claims.\n4) The single detected stutter \u2014 \"the the Green New Deal\" in Body 1 \u2014 disrupts an otherwise fluent passage and occurs at a moment when the speaker is trying to establish the GND's role in guiding climate debate, slightly undercutting the point's authority.\n5) The emphasis pattern in the introduction is particularly scattered: the first several emphasized words are \"CABLE,\" \"NEWS,\" \"PUNDITS,\" \"LOVE\" \u2014 four consecutive words in the opening sentence each carrying a loudness spike, which creates a choppy, over-emphasized rhythm that sounds performative rather than natural before the speaker settles into the body.\n- **What You Could Have Done:**\n1) \"An article from THE ATLANTIC tells us on June the 12th of 2019 that AOC proposed the influential GREEN NEW DEAL last November\" \u2014 shift emphasis from the article \"THE\" to the source name and the key policy term.\n2) \"New Consensus is working TO TRANSFORM this resolution into a SWEEPING POLICY AGENDA by the year 2020\" \u2014 emphasize the action verb and the policy stakes rather than the preposition \"to\" and the article \"a.\"\n3) \"We're not simply going to just pass this 14-page resolution. We're going to use it to force bipartisan solutions like a carbon tax \u2014 one that allows us to grow our economy while cutting emissions.\" \u2014 remove \"just\" and tighten the claim.\n4) \"We've often looked to just alternative energy, but the Green New Deal expands the definition of climate legislation beyond energy alone.\" \u2014 remove \"just\" and add the contrast that gives the sentence purpose.\n\n### Total Composite Score: 63/100\n### Judge's Rank: 4/5\n### Rank Explanation:\nThis speech would place 4th against 5 other competitors on this question. The speaker has a genuinely creative hook, a well-sourced argument with nine dated citations, and strong vocal variety that keeps the delivery engaging. However, the argument suffers from a critical causal gap in Body 1 \u2014 the speaker asserts that the GND \"forced\" Republican climate proposals without proving the GND caused them rather than general public opinion shifts \u2014 and the emphasis placement is scattered across function words rather than landing on thesis terms and key evidence. The Comic-Con analogy and the moon closer undercut the academic register the speech otherwise reaches, and the conclusion's \"So What?\" is thin. A competitor with tighter causal reasoning and more disciplined vocal emphasis would outrank this speaker; the breadth of sourcing and the environmental justice point keep it from placing last.\n\n### Actionable Drill for Next Round:\n**Emphasis Redirection Drill:** Record yourself reading the first 90 seconds of this speech. Then, go through the transcript and circle every noun, number, and signposting word (\"Atlantic,\" \"Green New Deal,\" \"first,\" \"second,\" \"14-page,\" \"bipartisan\") and cross out every article, preposition, and conjunction (\"the,\" \"a,\" \"to,\" \"and,\" \"but\"). Re-record the same 90 seconds, deliberately placing loudness spikes only on the circled words and flattening your pitch on the crossed-out words. Listen to both recordings back-to-back. The difference in rhetorical punch will be immediately audible \u2014 and it will train you to stop wasting emphasis on function words. Repeat this drill with the body paragraphs until emphasis on meaningful content words becomes automatic.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the Green New Deal in November (prior to June 2019) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Green New Deal resolution, a 14-page document, was introduced by Alexandria Ocasio-Cortez and Ed Markey on February 7, 2019, which is prior to June 2019. The Atlantic article from June 12, 2019, discusses the Green New Deal and its origins.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific Atlantic article isn't directly found, other sources from around the same time indicate the Green New Deal generated both significant opposition/criticism (regret) and strong public support for its underlying policies (popularity).\n\n[UNVERIFIED] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  While New Consensus is a think tank associated with the Green New Deal, and the Atlantic article from June 2019 mentions the Green New Deal, a specific claim about them transforming the resolution into a sweeping policy agenda by 2020 within that article or other easily verifiable sources was not found.\n\n[UNVERIFIED] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (2026)\n  The speech context suggests 'this year' refers to 2019 or early 2020. Searching for 'Scientific American January 2019/2020 emissions rose 3.8%' did not yield a direct match for this specific statistic and source. The current time is 2026, so 'January of this year' would be January 2026, which is unlikely to be the intended reference given the other dates in the transcript.\n\n[TRUE] The Green New Deal costs $93 trillion.\n  Cited source: (no source given)\n  A study by the American Action Forum in February/March 2019 estimated the Green New Deal's 10-year cost to be between $51 trillion and $93 trillion, with the higher figure frequently cited by opponents.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post article from April 3, 2019, discusses how Republicans for years doubted climate change, with some now acknowledging human-caused climate change, suggesting a shift from previous denial.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his 2011 nor 2016 campaign did Republicans propose any sweeping climate solution.\n  Cited source: The Washington Post, April 3, 2019\n  The Washington Post article from April 3, 2019, confirms that in 2011, Mitt Romney stated, 'We don't know what's causing climate change on this planet.' Other sources corroborate his shifting stance on climate change during his political career, and generally, Republicans did not propose sweeping climate solutions in those campaigns.\n\n[FALSE] 64% of Republicans believe that climate change is a severe threat to our future survival, and 45% of all Americans believe we need immediate action.\n  Cited source: The Washington Post (implied continuation from previous citation, likely April 3, 2019, or a related Washington Post poll)\n  A Washington Post-KFF poll from September 2019 found that 60% of Republicans believe human activity causes climate change, but only 11% of Republicans nationally described climate change as a 'very big' problem in an October 2018 Pew Research Center poll. A Washington Post-UMD poll from August 2023 found 35% of Republicans believe climate change is a major factor in hot days. The 64% figure for Republicans believing it's a severe threat is not supported by these polls from around the cited time.\n\n[TRUE] The Green New Deal and poll numbers are finally forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  A Politico article from March 26, 2019, indicates that the Green New Deal has helped force a discussion on climate change among Republicans, with some beginning to acknowledge the issue.\n\n[TRUE] Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  Multiple sources from March 2019 confirm that Senator Lamar Alexander (R-Tenn.) proposed a 'New Manhattan Project for Clean Energy' as a response to climate change, distinct from the Green New Deal.\n\n[TRUE] Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Politico articles from March 2019 report that Rep. Matt Gaetz (R-Fla.) was circulating and later released a 'Green Real Deal' resolution as an alternative to the Green New Deal, which included promoting innovation to reduce emissions and keeping options open for all energy production, including carbon capture.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, states that 1.6 million Americans live near the most polluting incinerators, and that these pollutants are linked to health problems including asthma and heart disease. The article also highlights that these incinerators are disproportionately located near low-income and minority neighborhoods.\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, where 40 million solar panels will be installed by 2050 with a focus on inviting and hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act), a specific 'equity environmental Justice Bill' passed by March 7, 2019, with the exact details of '40 million solar panels by 2050' and a focus on marginalized people was not found in the provided search results from Vox or other sources for that date. The Climate and Equitable Jobs Act (CEJA) was passed in 2021, which includes provisions for solar development and equitable hiring, but this is after the cited date.\n\n[TRUE] The Paris Climate Accords propose a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  The Paris Agreement sets a goal of limiting global warming to well below 2 degrees Celsius above pre-industrial levels, and pursuing efforts to limit it to 1.5 degrees Celsius. However, it relies on countries' self-determined contributions (NDCs) rather than a binding enforcement mechanism, which has been noted as a weakness in achieving the goals.\n\n[TRUE] The Green New Deal originated in the UK, but Alexandria Ocasio-Cortez's accessibility has made it a globally accessible source.\n  Cited source: The New York Times, March 2019\n  The concept of a 'Green New Deal' did originate in the UK in the late 2000s. While the New York Times article from March 2019 isn't explicitly found in the results, other sources confirm the UK origin and that AOC's proposal in the US significantly boosted its global prominence.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The Wikipedia entry for 'Green New Deal' mentions that proposals for a 'Green New Deal' have arisen in Europe, the United States, and other parts of the world since 2019, and specifically notes the European Green Deal was launched in 2019. While the specific National Interest article isn't found, the broader claim of global adoption is supported.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.\n",
  };

  const aiCompareToggle = document.getElementById('aiCompareToggle');
  const aiCompareBackBtn  = document.getElementById('aiCompareBackBtn');
  const aiCompareBackBtn2 = document.getElementById('aiCompareBackBtn2');
  let aiCompareOpen = false;
  let viewBeforeAiCompare = null;
  function openAiComparePanel(){
    aiCompareOpen = true;
    aiCompareToggle.classList.add('active');
    viewBeforeAiCompare = [viewRecord, viewReview, viewProcessing, viewResults].find(v => !v.classList.contains('hidden')) || viewRecord;
    showView(viewAiCompare);
    // Animate the quality/cost bars in on a rAF tick (same pattern as the
    // "Trends Across N Ballots" summary bars in My History) so the width
    // transition actually fires instead of snapping straight to full width.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewAiCompare.querySelectorAll('.ai-bar-fill').forEach(bar => { bar.style.width = bar.dataset.w + '%'; });
      });
    });
  }
  function closeAiComparePanel(){
    aiCompareOpen = false;
    aiCompareToggle.classList.remove('active');
    if(typeof closeAiExamplePanel === 'function') closeAiExamplePanel();
    showView(viewBeforeAiCompare || viewRecord);
  }
  if(aiCompareToggle && viewAiCompare){
    aiCompareToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if(aiCompareOpen) closeAiComparePanel(); else openAiComparePanel();
    });
    if(aiCompareBackBtn) aiCompareBackBtn.addEventListener('click', closeAiComparePanel);
    if(aiCompareBackBtn2) aiCompareBackBtn2.addEventListener('click', closeAiComparePanel);
  }

  // Clicking a row for a model we have a real sample ballot for expands a
  // panel right underneath it showing that ballot in full, so the quality
  // difference between models is something you can actually read rather
  // than just a quality/cost bar. One shared panel gets moved to sit after
  // whichever row is open (accordion -- opening a new one closes the last).
  // Renders a raw ballot string with the exact same category-card markup
  // used by the real Results view and the built-in Example Ballot tab
  // (score circle, What Worked / Critical Flaws / What You Could Have Done
  // rows, Composite Score + Rank stamps) rather than plain text, by
  // reusing the app's own parseBallot() on it.
  // The AI_MODEL_EXAMPLE_BALLOTS strings are raw .txt-export text (see
  // downloadBallotTxt), which appends the fact-check section as plain
  // text after "--- EVIDENCE FACT-CHECK ---" and the transcript after
  // "--- TRANSCRIPT ---". parseBallot only splits on "### " headers, so
  // without this split first, that whole trailing chunk (including the
  // full transcript) gets silently swallowed into the "Actionable Drill"
  // body and rendered as an unstyled wall of text inside the Feedback
  // box. Strip both off before parsing so Feedback stays just the drill,
  // and hand the fact-check text to parseFactCheckPlainText below so it
  // renders with the same styled cards real rounds get.
  function splitOffFactCheckAndTranscript(feedback){
    const idx = feedback.indexOf('--- EVIDENCE FACT-CHECK');
    if(idx === -1) return { ballotText: feedback, factCheckText: null };
    const ballotText = feedback.slice(0, idx).trim();
    const rest = feedback.slice(idx);
    const transcriptIdx = rest.indexOf('--- TRANSCRIPT ---');
    const factCheckText = (transcriptIdx === -1 ? rest : rest.slice(0, transcriptIdx)).trim();
    return { ballotText, factCheckText };
  }

  // Reverses factCheckPlainText's format back into the {claim, source,
  // verdict, explanation, sourceUrl} shape buildFactCheckHtml expects, so
  // sample ballots on the LLM Model Rankings page render the fact-check
  // section as the same styled TRUE/FALSE/UNVERIFIED cards a live round
  // gets, not as unstyled plain text.
  function parseFactCheckPlainText(text){
    const body = text.replace(/^---\s*EVIDENCE FACT-CHECK[^\n]*---\s*/i, '').trim();
    if(!body) return [];
    const blocks = body.split(/\n\n(?=\[)/);
    const claims = [];
    blocks.forEach(block => {
      const head = block.match(/^\[(TRUE|FALSE|UNVERIFIED)\]\s*([^\n]+)/i);
      if(!head) return;
      const verdict = head[1].toLowerCase();
      const claim = head[2].trim();
      const lines = block.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
      let source = '', sourceUrl = '';
      const explanationLines = [];
      lines.forEach(line => {
        if(/^Cited source:/i.test(line)) source = line.replace(/^Cited source:\s*/i, '').trim();
        else if(/^https?:\/\//i.test(line)) sourceUrl = line;
        else explanationLines.push(line);
      });
      claims.push({ claim, source, verdict, explanation: explanationLines.join(' '), sourceUrl });
    });
    return claims;
  }

  function buildBallotCardsHtml(feedback){
    const { ballotText, factCheckText } = splitOffFactCheckAndTranscript(feedback);
    const parsed = parseBallot(ballotText);
    let html = scoreKeyHtml();
    parsed.categories.forEach(cat => {
      const band = bandClass(cat.score, cat.max);
      html += `
        <div class="category">
          <div class="badge-wrap" style="--bc:${band}">
            <svg viewBox="0 0 64 64"><path d="${CIRCLE_PATH}" fill="none" stroke-width="2.5"/></svg>
            <div class="score">${cat.score}<small>/${cat.max||10}</small></div>
          </div>
          <div>
            <h3 class="cat-name">${escHtml(cat.name)}</h3>
            ${cat.whatWorked?`<div class="cat-row worked"><span class="tag">What Worked</span>${inlineMd(cat.whatWorked)}</div>`:''}
            ${cat.criticalFlaws?`<div class="cat-row flaws"><span class="tag">Critical Flaws</span>${inlineMd(cat.criticalFlaws)}</div>`:''}
            ${cat.evidence?`<div class="cat-row evidence"><span class="tag">What You Could Have Done</span>${inlineMd(cat.evidence)}</div>`:''}
          </div>
        </div>`;
    });
    if(parsed.total !== null){
      html += `
      <div class="stamp-row">
        <div class="verdict-stamp">
          <div class="label">Composite Score</div>
          <div class="num">${parsed.total}<small>/100</small></div>
        </div>`;
      if(parsed.rank !== null) html += `
        <div class="rank-stamp">
          <div class="label">Judge's Rank</div>
          <div class="num">${ordinal(parsed.rank)}</div>
        </div>`;
      html += `
      </div>`;
    }
    if(parsed.rankExplanation) html += `
      <div class="rank-explanation">${inlineMd(parsed.rankExplanation)}</div>`;
    if(parsed.drill) html += `
      <div class="drill">
        <span class="tag" style="font-size:16px;font-weight:800;">Feedback</span>
        <p>${inlineMd(parsed.drill)}</p>
      </div>`;
    if(factCheckText) html += buildFactCheckHtml(parseFactCheckPlainText(factCheckText));
    return html;
  }

  const aiExamplePanel = document.getElementById('aiCompareExamplePanel');
  const aiExampleBody  = document.getElementById('aiCompareExampleBody');
  const aiExampleClose = document.getElementById('aiCompareExampleCloseBtn');
  let aiExampleOpenKey = null;
  function closeAiExamplePanel(){
    aiExampleOpenKey = null;
    if(aiExamplePanel) aiExamplePanel.classList.add('hidden');
    viewAiCompare.querySelectorAll('.ai-compare-row.has-example').forEach(r => r.classList.remove('example-open'));
  }
  if(aiExamplePanel && aiExampleBody){
    viewAiCompare.querySelectorAll('.ai-compare-row[data-example]').forEach(row => {
      row.classList.add('has-example');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      const openThisRow = () => {
        const key = row.dataset.example;
        const text = AI_MODEL_EXAMPLE_BALLOTS[key];
        if(!text) return;
        if(aiExampleOpenKey === key){ closeAiExamplePanel(); return; }
        aiExampleOpenKey = key;
        aiExampleBody.innerHTML = buildBallotCardsHtml(text);
        row.insertAdjacentElement('afterend', aiExamplePanel);
        aiExamplePanel.classList.remove('hidden');
        viewAiCompare.querySelectorAll('.ai-compare-row.has-example').forEach(r => r.classList.toggle('example-open', r === row));
        aiExamplePanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      row.addEventListener('click', openThisRow);
      row.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openThisRow(); }
      });
    });
    if(aiExampleClose) aiExampleClose.addEventListener('click', (e) => { e.stopPropagation(); closeAiExamplePanel(); });
  }

  // The rubric icon only makes sense on the paper for Home/Record, My Ballot
  // History, the Example Ballot, and the post-submission Feedback/Results
  // view, hide it everywhere else (Review, Processing, Streak, Briefing,
  // Citation Checker) by hooking into showView().
  const RUBRIC_VISIBLE_VIEWS = [viewRecord, viewResults, viewExample, viewHistory];
  // The ballot header itself (title/Event/Round/Speaker/Judge/mode label)
  // only makes sense for a single round in progress or on display, Home
  // and a finished Results ballot. It's hidden everywhere else (My Ballot
  // History's multi-round list, Streak Calendar, Tournament Briefing,
  // Citation Checker, Review, Processing, and the sample Example ballot,
  // which has its own "Example Ballot" page heading instead) so stale
  // "Round 1 / Regular Practice" framing doesn't linger on unrelated pages.
  const BALLOT_HEAD_VISIBLE_VIEWS = [viewRecord, viewResults];
  const ballotHeadEl = document.querySelector('.ballot-head');
  let currentViewEl = viewRecord;
  const _showViewForRubric = showView;
  showView = function(v){
    _showViewForRubric(v);
    currentViewEl = v;
    const shouldShow = RUBRIC_VISIBLE_VIEWS.includes(v);
    rubricToggle.classList.toggle('hidden', !shouldShow);
    if(!shouldShow && rubricOpen) closeRubricPanel();
    if(aiCompareToggle){
      aiCompareToggle.classList.toggle('hidden', !shouldShow);
      if(!shouldShow && aiCompareOpen && v !== viewAiCompare) closeAiComparePanel();
    }
    if(ballotHeadEl) ballotHeadEl.classList.toggle('hidden', !BALLOT_HEAD_VISIBLE_VIEWS.includes(v));
  };
  rubricToggle.classList.toggle('hidden', !RUBRIC_VISIBLE_VIEWS.includes(viewRecord));
  if(aiCompareToggle) aiCompareToggle.classList.toggle('hidden', !RUBRIC_VISIBLE_VIEWS.includes(viewRecord));
  if(ballotHeadEl) ballotHeadEl.classList.toggle('hidden', !BALLOT_HEAD_VISIBLE_VIEWS.includes(viewRecord));

  // ===== Hamburger nav menu (semi-transparent drawer, shown by default) =====
  // The drawer now stays open/visible at all times by default so the moving
  // wall background is always visible through it. Clicking the hamburger no
  // longer opens/closes a backdrop-dimmed overlay, it just minimizes
  // (slides away) or restores the drawer in place. The hamburger button
  // itself sits at the top of the left-side menu, doing double duty as
  // both the toggle and the drawer's visual "head" (no separate close X).
  const navMenuToggle   = document.getElementById('navMenuToggle');
  const navMenuPanel    = document.getElementById('navMenuPanel');
  const navMenuPersistentToggle = document.getElementById('navMenuPersistentToggle');
  let navMenuOpenState = true;
  function openNavMenu(){
    if(typeof shortcutsOpen !== 'undefined' && shortcutsOpen) closeShortcutsPanel();
    if(typeof settingsOpen !== 'undefined' && settingsOpen){
      settingsOpen = false;
      settingsPanel.classList.add('hidden');
      settingsToggle.classList.remove('active');
    }
    if(typeof timerOpen !== 'undefined' && timerOpen){
      timerOpen = false;
      timerPanel.classList.add('hidden');
      timerToggle.classList.remove('active');
    }
    navMenuOpenState = true;
    navMenuPanel.classList.remove('nav-drawer-collapsed');
    navMenuToggle.setAttribute('aria-expanded', 'true');
    navMenuPersistentToggle?.classList.add('hidden');
  }
  function closeNavMenu(){
    navMenuOpenState = false;
    navMenuPanel.classList.add('nav-drawer-collapsed');
    navMenuToggle.setAttribute('aria-expanded', 'false');
    navMenuPersistentToggle?.classList.remove('hidden');
  }
  navMenuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(navMenuOpenState) closeNavMenu(); else openNavMenu();
  });
  navMenuPersistentToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    openNavMenu();
  });
  // "Home" returns to the default Official Practice Ballot view, closing
  // whatever overlay view (History, Briefing, Citation Checker, Example
  // Ballot) is currently open, same effect as each view's own Back button.
  document.getElementById('navHomeBtn').addEventListener('click', () => {
    showView(viewRecord);
  });
  // Every other menu item just triggers the click of the header icon it
  // mirrors, so it always stays perfectly in sync with that button's own
  // open/close/toggle logic, nothing to duplicate or fall out of date.
  navMenuPanel.querySelectorAll('.nav-menu-item[data-target]').forEach(item => {
    item.addEventListener('click', (e) => {
      // Without this, the original click event keeps bubbling up to
      // document AFTER targetBtn.click() below has already opened the
      // panel, and the document-level "click outside closes the panel"
      // listeners (for settings/timer/shortcuts) see that bubbling click
      // (whose target is this menu item, i.e. outside the panel) and
      // immediately close the panel that was just opened. Stopping
      // propagation here keeps that original click from ever reaching
      // those document listeners.
      e.stopPropagation();
      const targetId = item.getAttribute('data-target');
      const targetBtn = document.getElementById(targetId);
      if(targetBtn) targetBtn.click();
    });
  });

  // Keeps each sidebar row's blue "currently open" highlight in sync with
  // its mirrored header button's own .active class, whatever toggles that
  // class (this file already adds/removes .active on open/close for every
  // button below except themeToggle, which isn't a page/panel that stays
  // "open"). A MutationObserver means the sidebar never has to duplicate
  // any open/close logic, it just reflects whatever's already true.
  navMenuPanel.querySelectorAll('.nav-menu-item[data-target]').forEach(item => {
    const targetId = item.getAttribute('data-target');
    if(targetId === 'themeToggle') return;
    const targetBtn = document.getElementById(targetId);
    if(!targetBtn) return;
    const syncActive = () => item.classList.toggle('active', targetBtn.classList.contains('active'));
    syncActive();
    new MutationObserver(syncActive).observe(targetBtn, { attributes:true, attributeFilter:['class'] });
  });
  // My Ballot History and Home are full view swaps (not buttons with their
  // own .active class), so their sidebar rows are driven directly off
  // showView() instead of the MutationObserver above.

  // ===== Light / dark theme toggle =====
  const themeToggle = document.getElementById('themeToggle');
  const themeIconMoon = document.getElementById('themeIconMoon');
  const themeIconSun  = document.getElementById('themeIconSun');
  const navThemeIconMoon = document.getElementById('navThemeIconMoon');
  const navThemeIconSun  = document.getElementById('navThemeIconSun');
  const navThemeLabel = document.getElementById('navThemeLabel');
  function applyTheme(theme){
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if(theme === 'light'){
      document.documentElement.setAttribute('data-theme', 'light');
      themeIconMoon.classList.add('hidden');
      themeIconSun.classList.remove('hidden');
      navThemeIconMoon?.classList.add('hidden');
      navThemeIconSun?.classList.remove('hidden');
      // Label names the mode a click will switch TO, not the current one.
      if(navThemeLabel) navThemeLabel.textContent = 'Dark Mode';
      if(metaTheme) metaTheme.setAttribute('content', '#e9edf1');
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeIconMoon.classList.remove('hidden');
      themeIconSun.classList.add('hidden');
      navThemeIconMoon?.classList.remove('hidden');
      navThemeIconSun?.classList.add('hidden');
      if(navThemeLabel) navThemeLabel.textContent = 'Light Mode';
      if(metaTheme) metaTheme.setAttribute('content', '#0a1c30');
    }
  }
  (function initTheme(){
    let saved = null;
    try{ saved = localStorage.getItem('extemplary-theme'); }catch(e){}
    applyTheme(saved === 'light' ? 'light' : 'dark');
  })();
  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    applyTheme(next);
    try{ localStorage.setItem('extemplary-theme', next); }catch(e){}
  });

  // ===== Global keyboard shortcuts =====
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
    if(e.key === 'Escape'){
      closeShortcutsPanel();
      if(typeof closeNavMenu === 'function') closeNavMenu();
      if(typeof closeAllExportMenus === 'function') closeAllExportMenus();
      if(typeof settingsOpen !== 'undefined' && settingsOpen){ settingsPanel.classList.add('hidden'); settingsToggle.classList.remove('active'); settingsOpen = false; }
      if(typeof timerOpen !== 'undefined' && timerOpen){ timerPanel.classList.add('hidden'); timerToggle.classList.remove('active'); timerOpen = false; }
      if(typeof closeYoutubePopover === 'function') closeYoutubePopover();
      if(typeof closeBriefingView === 'function' && typeof briefingOpen !== 'undefined' && briefingOpen) closeBriefingView();
      if(typeof closeCitationView === 'function' && typeof citationOpen !== 'undefined' && citationOpen) closeCitationView();
      return;
    }
    if(typing) return;
    if(e.key === '?'){
      e.preventDefault();
      if(shortcutsOpen) closeShortcutsPanel(); else openShortcutsPanel();
      return;
    }
    if(e.key === 't' || e.key === 'T'){
      e.preventDefault();
      timerToggle.click();
      return;
    }
    if(e.key === 's' || e.key === 'S'){
      e.preventDefault();
      settingsToggle.click();
      return;
    }
    if(e.key === 'd' || e.key === 'D'){
      e.preventDefault();
      themeToggle.click();
      return;
    }
    if(e.key === 'h' || e.key === 'H'){
      e.preventDefault();
      helpToggle.click();
      return;
    }
    if(e.code === 'Space' || e.key === ' '){
      e.preventDefault();
      // Space is context-aware: while reviewing a results/example video it
      // plays/pauses (stops) that video instantly; only while actually on
      // the record screen does it start/stop recording.
      if(!viewExample.classList.contains('hidden')){
        examplePbPlayBtn.click();
      } else if(!viewResults.classList.contains('hidden')){
        pbPlayBtn.click();
      } else if(recBtn && !recBtn.disabled){
        recBtn.click();
      }
    }
  });

  // ===== PWA install support =====
  (function setupPWA(){
    const manifest = {
      name: 'Extemplary',
      short_name: 'Extemplary',
      start_url: '.',
      display: 'standalone',
      background_color: '#0a1c30',
      theme_color: '#0a1c30',
      icons: [{
        src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230a1c30'/%3E%3Ctext x='32' y='46' font-family='Georgia, serif' font-size='40' font-weight='900' fill='%232f79c9' text-anchor='middle'%3EE%3C/text%3E%3C/svg%3E",
        sizes: '64x64', type: 'image/svg+xml'
      }]
    };
    try{
      const blob = new Blob([JSON.stringify(manifest)], {type:'application/json'});
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = URL.createObjectURL(blob);
      document.head.appendChild(link);
    }catch(e){}
    if('serviceWorker' in navigator){
      try{
        const swCode = "self.addEventListener('install', e => self.skipWaiting());" +
          "self.addEventListener('activate', e => self.clients.claim());" +
          "self.addEventListener('fetch', e => {});";
        const swBlob = new Blob([swCode], {type:'text/javascript'});
        navigator.serviceWorker.register(URL.createObjectURL(swBlob)).catch(()=>{});
      }catch(e){}
    }
  })();

  // ===== Make a popover panel draggable by its header (mouse + touch) =====
  let suppressPanelClose = false;
  function makeDraggablePanel(panelEl, handleEl){
    if(!panelEl || !handleEl) return;
    handleEl.style.cursor = 'grab';
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    function onDown(e){
      // Ignore drags starting on interactive controls inside the header (none currently, but future-proof).
      if(e.target.closest('button, a, input')) return;
      const point = e.touches ? e.touches[0] : e;
      const rect = panelEl.getBoundingClientRect();
      dragging = true;
      startX = point.clientX; startY = point.clientY;
      startLeft = rect.left; startTop = rect.top;
      panelEl.style.left = startLeft + 'px';
      panelEl.style.top = startTop + 'px';
      panelEl.style.right = 'auto';
      handleEl.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('touchmove', onMove, { passive:false });
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchend', onUp);
      e.preventDefault();
    }
    let moved = false;
    function onMove(e){
      if(!dragging) return;
      moved = true;
      const point = e.touches ? e.touches[0] : e;
      const dx = point.clientX - startX, dy = point.clientY - startY;
      const rect = panelEl.getBoundingClientRect();
      let left = startLeft + dx, top = startTop + dy;
      left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - 40));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
      if(e.cancelable) e.preventDefault();
    }
    function onUp(){
      dragging = false;
      if(moved){
        suppressPanelClose = true;
        setTimeout(() => { suppressPanelClose = false; }, 0);
      }
      moved = false;
      handleEl.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
    }
    handleEl.addEventListener('mousedown', onDown);
    handleEl.addEventListener('touchstart', onDown, { passive:false });
  }
  makeDraggablePanel(settingsPanel, settingsPanel.querySelector('.sp-head'));
  makeDraggablePanel(timerPanel, timerPanel.querySelector('.sp-head'));

  const PREP_TIME_SECONDS = 30 * 60;
  let prepSecondsLeft = PREP_TIME_SECONDS;
  let prepInterval = null;
  let prepRunning = false;

  function fmtPrep(s){
    const m = Math.floor(s/60), sec = s%60;
    return m + ':' + String(sec).padStart(2,'0');
  }
  function renderPrepTimer(){
    const str = fmtPrep(prepSecondsLeft);
    timerDisplay.textContent = str;
    const low = prepSecondsLeft <= 60 && prepSecondsLeft > 0;
    timerDisplay.classList.toggle('warn', low);
    if(!prepRunning && prepSecondsLeft < PREP_TIME_SECONDS){
      timerBadge.textContent = str;
      timerBadge.classList.remove('hidden');
      timerBadge.classList.toggle('running', prepRunning);
      timerBadge.classList.toggle('warn', low);
    }else{
      timerBadge.classList.add('hidden');
    }
    timerToggle.classList.toggle('ticking', prepRunning);
  }
  function setPrepButtons(){
    timerStartBtn.classList.toggle('hidden', prepRunning || prepSecondsLeft !== PREP_TIME_SECONDS);
    timerResumeBtn.classList.toggle('hidden', prepRunning || prepSecondsLeft === PREP_TIME_SECONDS || prepSecondsLeft === 0);
    timerPauseBtn.classList.toggle('hidden', !prepRunning);
    timerResetBtn.classList.toggle('hidden', prepSecondsLeft === PREP_TIME_SECONDS);
    timerStateTag.textContent = prepSecondsLeft === 0 ? "Time's up" : prepRunning ? 'Running' : (prepSecondsLeft === PREP_TIME_SECONDS ? 'Ready' : 'Paused');
  }
  function startPrepTimer(){
    if(prepRunning || prepSecondsLeft <= 0) return;
    prepRunning = true;
    clearInterval(prepInterval);
    prepInterval = setInterval(() => {
      prepSecondsLeft = Math.max(0, prepSecondsLeft - 1);
      renderPrepTimer();
      if(prepSecondsLeft === 0){
        pausePrepTimer();
        fireSignalOverlay("⏰ Prep Time's Up", '0:00', 'Your 30 minutes of prep time have ended.', '', '#a3322a');
      }
      setPrepButtons();
    }, 1000);
    renderPrepTimer();
    setPrepButtons();
  }
  function pausePrepTimer(){
    prepRunning = false;
    clearInterval(prepInterval);
    renderPrepTimer();
    setPrepButtons();
  }
  function resetPrepTimer(){
    prepRunning = false;
    clearInterval(prepInterval);
    prepSecondsLeft = PREP_TIME_SECONDS;
    renderPrepTimer();
    setPrepButtons();
  }
  timerStartBtn.addEventListener('click', startPrepTimer);
  timerResumeBtn.addEventListener('click', startPrepTimer);
  timerPauseBtn.addEventListener('click', pausePrepTimer);
  timerResetBtn.addEventListener('click', resetPrepTimer);
  renderPrepTimer();
  setPrepButtons();

  let timerOpen = false;
  let timerPositioned = false;
  timerToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    timerOpen = !timerOpen;
    if(timerOpen && !timerPositioned){
      positionTimerPanel();
      timerPositioned = true;
    }
    timerPanel.classList.toggle('hidden', !timerOpen);
    timerToggle.classList.toggle('active', timerOpen);
  });
  document.addEventListener('click', (e) => {
    if(suppressPanelClose) return;
    if(timerOpen && !e.target.closest('#timerPanel') && !e.target.closest('#timerToggle')){
      timerOpen = false;
      timerPanel.classList.add('hidden');
      timerToggle.classList.remove('active');
    }
  });
  window.addEventListener('resize', () => { if(timerOpen) positionTimerPanel(); });

  // The single "Start Timer" button next to the practice mode switch. It
  // never fires on its own, the user has to press it, and which timer it
  // kicks off depends entirely on the practice mode currently selected.
  // Each mode gets its own full-screen takeover modal (not the small
  // gear-icon timer panel), color-matched to that mode: Regular Practice
  // opens a 30-minute modal, Rapid Drill: Introduction opens a 5-minute
  // modal, and Rapid Drill: Body opens a 10-minute modal.
  function startSelectedTimer(){
    if(!questionInput.value.trim()){
      requireQuestion();
      return;
    }
    if(introDrillMode){
      if(introPrepModal.classList.contains('hidden')) openIntroPrepModal();
    }else if(bodyDrillMode){
      if(bodyPrepModal.classList.contains('hidden')) openBodyPrepModal();
    }else if(roughDraftMode){
      if(roughDraftPrepModal.classList.contains('hidden')) openRoughDraftPrepModal();
    }else{
      if(regularPrepModal.classList.contains('hidden')) openRegularPrepModal();
    }
  }
  startTimerBtn.addEventListener('click', startSelectedTimer);

  function renderSignalList(){
    const sorted = [...timeSignals].sort((a,b)=>a.seconds-b.seconds);
    timeSignals = sorted;
    signalList.innerHTML = '';
    sorted.forEach((sig, i) => {
      const li = document.createElement('li');
      li.className = 'signal-row';
      li.style.setProperty('--sig-color', sig.color);
      li.innerHTML = `
        <span class="sig-time">${fmt(sig.seconds)}</span>
        <span class="sig-label">${escHtml(sig.label)}</span>
        <button class="sig-edit" data-i="${i}" title="Edit" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
        <button class="sig-del" data-i="${i}" title="Delete" type="button">✕</button>
      `;
      signalList.appendChild(li);
    });
    signalList.querySelectorAll('.sig-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.i);
        timeSignals.splice(idx, 1);
        renderSignalList();
      });
    });
    signalList.querySelectorAll('.sig-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.i);
        const sig = timeSignals[idx];
        sigMin.value = Math.floor(sig.seconds / 60);
        sigSec.value = sig.seconds % 60;
        sigLabel.value = sig.label;
        sigColor.value = sig.color;
        editingIndex = idx;
        document.getElementById('addSignalBtn').textContent = '✓ Save';
      });
    });
    if(signalCount) signalCount.textContent = sorted.length + (sorted.length === 1 ? ' signal' : ' signals');
  }

  document.getElementById('addSignalBtn').addEventListener('click', () => {
    const m = parseInt(sigMin.value) || 0;
    const s = parseInt(sigSec.value) || 0;
    const totalSec = m * 60 + s;
    const lbl = sigLabel.value.trim() || fmt(totalSec);
    const col = sigColor.value;
    if(totalSec <= 0 || totalSec > 449){
      sigMin.style.outline = '2px solid var(--crimson)';
      setTimeout(() => sigMin.style.outline = '', 1500);
      return;
    }
    if(editingIndex >= 0){
      timeSignals[editingIndex] = { seconds: totalSec, label: lbl, color: col };
      editingIndex = -1;
      document.getElementById('addSignalBtn').textContent = '+ Add';
    }else{
      // check duplicate
      if(!timeSignals.find(s2 => s2.seconds === totalSec)){
        timeSignals.push({ seconds: totalSec, label: lbl, color: col });
      }
    }
    sigLabel.value = '';
    sigMin.value = 1;
    sigSec.value = 0;
    renderSignalList();
  });

  document.getElementById('resetSignalsBtn').addEventListener('click', () => {
    timeSignals = JSON.parse(JSON.stringify(DEFAULT_SIGNALS));
    editingIndex = -1;
    document.getElementById('addSignalBtn').textContent = '+ Add';
    renderSignalList();
  });

  renderSignalList();

  // ===== SIGNAL PRESETS =====
  // "N down" = judge signals every minute starting when N minutes remain.
  // 7-min speech: signal at elapsed seconds where (7:00 - elapsed) = N, N-1, ...
  // e.g. 5 down: signals at 2:00, 3:00, 4:00, 5:00, 6:00
  const SIGNAL_PRESETS = DATA.SIGNAL_PRESETS;

  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = SIGNAL_PRESETS[btn.dataset.preset];
      if(!preset) return;
      // Replace all current signals with the preset
      timeSignals = preset.map(s => ({ ...s }));
      editingIndex = -1;
      document.getElementById('addSignalBtn').textContent = '+ Add';
      renderSignalList();
    });
  });

  // ===== SUBMISSION =====
  // Real provider API keys no longer live in this file, they're Supabase
  // secrets on the `groq-chat` / `groq-transcribe` edge functions. Anything
  // typed into Settings ("API key override") is just forwarded to those
  // functions as `overrideKey` and tried first; if omitted, the functions
  // fall back to their own server-side keys automatically.

  // Wraps fetch() with a hard timeout so a hung/unresponsive request (bad
  // network, stalled connection, etc.) fails with a clear error instead of
  // leaving the pipeline waiting forever with no feedback to the user.
  async function fetchWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try{
      return await fetch(url, { ...options, signal: controller.signal });
    }catch(err){
      if(err.name === 'AbortError') throw new Error('timeout:The model took too long to respond ('+Math.round(timeoutMs/1000)+'s) — it may be overloaded. Try again.');
      throw err;
    }finally{
      clearTimeout(timer);
    }
  }

  document.getElementById('submitBtn').addEventListener('click', () => {
    runPipeline(null, null, null);
  });

  // ===== ROUGH DRAFT SUBMISSION =====
  // Collects the 11 plaintext fields from the Rough Draft form, validates
  // none are blank, assembles them into one labeled "transcript" (so the
  // existing parseBallot/renderResults/history plumbing can treat it just
  // like a spoken transcript), and kicks off runPipeline the same way the
  // video submitBtn does above — runPipeline's roughDraftMode branch then
  // skips straight to judging instead of decoding/transcribing audio.
  const ROUGHDRAFT_FIELD_IDS = [
    'rdQuestion','rdAgd','rdContentions',
    'rdBody1Contention','rdBody1Card1','rdBody1Card1Date','rdBody1Card1Source','rdBody1Card2','rdBody1Card2Date','rdBody1Card2Source','rdBody1Analysis','rdBody1Link',
    'rdBody2Contention','rdBody2Card1','rdBody2Card1Date','rdBody2Card1Source','rdBody2Card2','rdBody2Card2Date','rdBody2Card2Source','rdBody2Analysis','rdBody2Link',
    'rdBody3Contention','rdBody3Card1','rdBody3Card1Date','rdBody3Card1Source','rdBody3Card2','rdBody3Card2Date','rdBody3Card2Source','rdBody3Analysis','rdBody3Link',
    'rdConclusionRestate','rdConclusionSoWhat'
  ];
  const rdFormError = document.getElementById('rdFormError');
  const rdSubmitBtn = document.getElementById('rdSubmitBtn');
  const rdQuestion = document.getElementById('rdQuestion');
  // The Rough Draft form's own Question box is never typed into directly;
  // it mirrors whatever's currently in the shared question box above
  // (extempQuestion) — whether the user typed a custom question or
  // confirmed a generated one — so the speaker never has to retype the
  // question they already entered/selected elsewhere in the app.
  function syncRoughDraftQuestion(){
    if(rdQuestion) rdQuestion.value = questionInput.value;
  }
  questionInput.addEventListener('input', syncRoughDraftQuestion);
  function collectRoughDraftFields(){
    const vals = {};
    let firstEmptyEl = null;
    ROUGHDRAFT_FIELD_IDS.forEach(id => {
      const el = document.getElementById(id);
      const v = el ? el.value.trim() : '';
      vals[id] = v;
      if(!v){
        if(el) el.classList.add('error');
        if(!firstEmptyEl) firstEmptyEl = el;
      }else if(el){
        el.classList.remove('error');
      }
    });
    return { vals, firstEmptyEl };
  }
  function buildRoughDraftTranscript(vals){
    return [
      'INTRO',
      `Question: ${vals.rdQuestion}`,
      `AGD: ${vals.rdAgd}`,
      `3 Contentions: ${vals.rdContentions}`,
      '',
      'BODY 1',
      `Contention 1: ${vals.rdBody1Contention}`,
      `Card 1 (${vals.rdBody1Card1Source}, ${vals.rdBody1Card1Date}): ${vals.rdBody1Card1}`,
      `Card 2 (${vals.rdBody1Card2Source}, ${vals.rdBody1Card2Date}): ${vals.rdBody1Card2}`,
      `Card Analysis: ${vals.rdBody1Analysis}`,
      `Link to AGD: ${vals.rdBody1Link}`,
      '',
      'BODY 2',
      `Contention 2: ${vals.rdBody2Contention}`,
      `Card 1 (${vals.rdBody2Card1Source}, ${vals.rdBody2Card1Date}): ${vals.rdBody2Card1}`,
      `Card 2 (${vals.rdBody2Card2Source}, ${vals.rdBody2Card2Date}): ${vals.rdBody2Card2}`,
      `Card Analysis: ${vals.rdBody2Analysis}`,
      `Link to AGD: ${vals.rdBody2Link}`,
      '',
      'BODY 3',
      `Contention 3: ${vals.rdBody3Contention}`,
      `Card 1 (${vals.rdBody3Card1Source}, ${vals.rdBody3Card1Date}): ${vals.rdBody3Card1}`,
      `Card 2 (${vals.rdBody3Card2Source}, ${vals.rdBody3Card2Date}): ${vals.rdBody3Card2}`,
      `Card Analysis: ${vals.rdBody3Analysis}`,
      `Link to AGD: ${vals.rdBody3Link}`,
      '',
      'CONCLUSION',
      `Restate 3 Contentions: ${vals.rdConclusionRestate}`,
      `So What: ${vals.rdConclusionSoWhat}`
    ].join('\n');
  }
  rdSubmitBtn.addEventListener('click', () => {
    const q = requireQuestion();
    if(!q){ if(recordQuestionError) recordQuestionError.style.display = 'block'; return; }
    if(recordQuestionError) recordQuestionError.style.display = 'none';
    const { vals, firstEmptyEl } = collectRoughDraftFields();
    if(firstEmptyEl){
      rdFormError.style.display = 'block';
      firstEmptyEl.focus();
      return;
    }
    rdFormError.style.display = 'none';
    lastQuestion = q;
    recordedBlob = null;
    roughDraftTranscriptText = buildRoughDraftTranscript(vals);
    runPipeline(null, null, null);
  });

  document.getElementById('backToReviewBtn').addEventListener('click', () => showView(viewReview));

  function extFromMime(mime){ return mime.includes('mp4') ? 'mp4' : 'webm'; }

  // ===== VOCAL DELIVERY ANALYSIS (client-side audio signal processing) =====
  function computeRMS(buf){
    let sum = 0;
    for(let i=0;i<buf.length;i++) sum += buf[i]*buf[i];
    return Math.sqrt(sum/buf.length);
  }
  function average(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
  function median(arr){
    if(!arr.length) return 0;
    const s = arr.slice().sort((a,b)=>a-b);
    const mid = Math.floor(s.length/2);
    return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
  }
  function stddev(arr){
    if(arr.length<2) return 0;
    const m = average(arr);
    return Math.sqrt(average(arr.map(v=>(v-m)*(v-m))));
  }
  function mixDownToMono(audioBuffer){
    if(audioBuffer.numberOfChannels===1) return audioBuffer.getChannelData(0);
    const ch0 = audioBuffer.getChannelData(0), ch1 = audioBuffer.getChannelData(1);
    const out = new Float32Array(ch0.length);
    for(let i=0;i<ch0.length;i++) out[i] = (ch0[i]+ch1[i])/2;
    return out;
  }
  // Lightweight autocorrelation pitch detector, good enough to track relative
  // pitch movement (tone changes) frame to frame, not lab-grade Hz accuracy.
  function estimatePitch(buf, sampleRate){
    const SIZE = buf.length;
    let rms = computeRMS(buf);
    if(rms < 0.012) return -1; // too quiet / silence, no reliable pitch
    let r1=0, r2=SIZE-1;
    const thres = 0.2;
    for(let i=0;i<SIZE/2;i++){ if(Math.abs(buf[i])<thres){ r1=i; break; } }
    for(let i=1;i<SIZE/2;i++){ if(Math.abs(buf[SIZE-i])<thres){ r2=SIZE-i; break; } }
    const trimmed = buf.slice(r1, r2);
    const SIZE2 = trimmed.length;
    if(SIZE2 < 8) return -1;
    const c = new Float32Array(SIZE2);
    for(let i=0;i<SIZE2;i++){
      let sum = 0;
      for(let j=0;j<SIZE2-i;j++) sum += trimmed[j]*trimmed[j+i];
      c[i] = sum;
    }
    let d = 0; while(d<SIZE2-1 && c[d] > c[d+1]) d++;
    let maxVal=-1, maxPos=-1;
    for(let i=d;i<SIZE2;i++){ if(c[i] > maxVal){ maxVal=c[i]; maxPos=i; } }
    if(maxPos<=0) return -1;
    const pitch = sampleRate / maxPos;
    return (pitch>60 && pitch<500) ? pitch : -1; // restrict to plausible human voice range
  }

  // Returns a metrics object (or null on failure). Takes an already-decoded
  // AudioBuffer so the recording only ever needs to be decoded once.
  async function analyzeAudioDelivery(audioBuffer, words){
    try{
      const sampleRate = audioBuffer.sampleRate;
      const channelData = mixDownToMono(audioBuffer);

      const frameSize = Math.round(sampleRate*0.03);   // 30ms analysis window
      const hopSize    = Math.round(sampleRate*0.015);  // 15ms hop
      const frames = [];
      for(let i=0; i+frameSize<=channelData.length; i+=hopSize){
        const slice = channelData.subarray(i, i+frameSize);
        frames.push({ t: i/sampleRate, rms: computeRMS(slice), pitch: estimatePitch(slice, sampleRate) });
      }
      if(!frames.length) return null;

      // ---- volume ----
      const sortedRms = frames.map(f=>f.rms).sort((a,b)=>a-b);
      const noiseFloor = sortedRms[Math.floor(sortedRms.length*0.1)] || 0.0001;
      const voiced = frames.filter(f=>f.rms > noiseFloor*2.5);
      const avgRms = average(voiced.map(f=>f.rms)) || 0.0001;
      const avgDb = 20*Math.log10(avgRms);
      let volumeScore;
      if(avgDb >= -18) volumeScore = 10;
      else if(avgDb <= -42) volumeScore = 1;
      else volumeScore = Math.round(1 + ((avgDb+42)/24)*9);
      const volumeLabel = avgDb>=-18 ? 'Strong & Confident' : avgDb>=-26 ? 'Adequate' : avgDb>=-34 ? 'Quiet — projection needed' : 'Too Quiet';

      // ---- emphasis (per word loudness spikes) ----
      const baselineRms = median(voiced.map(f=>f.rms)) || avgRms;
      const wordList = words || [];
      const wordStats = wordList.map(w=>{
        const wFrames = frames.filter(f=>f.t>=w.start && f.t<=w.end);
        const wRms = wFrames.length ? average(wFrames.map(f=>f.rms)) : 0;
        return { word:(w.word||'').trim(), start:w.start, end:w.end, rms:wRms, emphasized: wRms > baselineRms*1.55 && wRms > noiseFloor*3 };
      });
      const emphasizedWords = wordStats.filter(w=>w.emphasized);
      const emphasisContexts = emphasizedWords.slice(0,40).map(ew=>{
        const idx = wordStats.indexOf(ew);
        const start = Math.max(0, idx-4), end = Math.min(wordStats.length, idx+5);
        return wordStats.slice(start,end).map((w,k)=> (start+k===idx) ? ('**'+w.word.toUpperCase()+'**') : w.word).join(' ');
      });

      // ---- tone / pitch variety ----
      const pitchSeries = frames.map(f=>f.pitch).filter(p=>p>0);
      let toneChanges = 0, lastPitch = null;
      pitchSeries.forEach(p=>{
        if(lastPitch!==null && Math.abs(p-lastPitch)/lastPitch > 0.12) toneChanges++;
        lastPitch = p;
      });
      const pitchStdDev = stddev(pitchSeries);
      const pitchVarietyLabel = pitchStdDev>32 ? 'High — expressive' : pitchStdDev>14 ? 'Moderate' : 'Low — monotone risk';

      // ---- pauses & pace ----
      let pauseCount=0; const pauseDurations=[];
      for(let i=1;i<wordList.length;i++){
        const gap = wordList[i].start - wordList[i-1].end;
        if(gap > 0.4){ pauseCount++; pauseDurations.push(gap); }
      }
      const totalDuration = audioBuffer.duration;
      const wpm = (totalDuration>0 && wordList.length) ? Math.round(wordList.length/(totalDuration/60)) : 0;
      const paceLabel = wpm===0 ? 'Unknown' : wpm<120 ? 'Slow — could lose energy' : wpm<=175 ? 'Solid competitive pace' : 'Fast — risk of rushing';

      return {
        avgDb: Math.round(avgDb*10)/10, volumeScore, volumeLabel,
        emphasizedCount: emphasizedWords.length, totalWords: wordList.length,
        emphasisRatio: wordList.length ? Math.round((emphasizedWords.length/wordList.length)*100) : 0,
        emphasisContexts,
        toneChanges, pitchStdDev: Math.round(pitchStdDev*10)/10, pitchVarietyLabel,
        pauseCount, avgPauseLen: pauseDurations.length ? Math.round(average(pauseDurations)*100)/100 : 0,
        wpm, paceLabel, durationSec: Math.round(totalDuration)
      };
    }catch(e){
      return null;
    }
  }

  // ===== AUDIO EXTRACTION & COMPRESSION (fixes "Request Entity Too Large") =====
  // Groq's transcription endpoint caps upload size (~25MB), but the request
  // can also get rejected earlier by the Supabase Edge Function/CDN in front
  // of it at a smaller size than that. We stay well under both by using a
  // conservative chunk-size budget, and if a chunk still comes back 413 for
  // any reason, we automatically halve it and retry rather than giving up.
  // A multi-minute recording is a video+audio container and can blow past that
  // easily. Whisper only needs the audio anyway, so we decode the recording
  // once, strip the video, downsample to 16kHz mono, and re-encode as a
  // compact WAV, typically a 10-20x size reduction over the raw recording.
  // If a single speech is still too long even after compression, we split
  // the audio into multiple chunks and transcribe them one at a time,
  // stitching the text and word timestamps back together.
  // GROQ_UPLOAD_SAFE_BYTES was 8MB, but a normal FIXED_CHUNK_SECONDS chunk
  // (60s of 16kHz/16-bit mono WAV) is only ~1.9MB — nowhere near that
  // budget — so the pre-emptive split check below almost never actually
  // fired, and every chunk went straight to a real upload attempt first.
  // Lowered to 2MB so a chunk that's likely to hit a real proxy/edge-
  // function body-size limit gets split proactively instead of only
  // reactively, after already eating a failed round-trip.
  const GROQ_UPLOAD_SAFE_BYTES = 2 * 1024 * 1024;
  // GROQ_UPLOAD_MIN_BYTES was 512KB, which combined with the halving step
  // meant the *reactive* 413 self-heal in transcribeChunkResilient below
  // gave up after a single halving (60s -> 30s, ~938KB) — nowhere near a
  // size any real API or gateway should plausibly reject as "too large".
  // That's what was producing "still too large even after compression and
  // splitting" well before the audio was actually anywhere near large.
  // Lowered by 8x so a genuinely stricter-than-expected limit still has
  // real room to be found by halving further, down to a few seconds of
  // audio, before giving up for real.
  const GROQ_UPLOAD_MIN_BYTES  = 64 * 1024;

  async function decodeAudioFromBlob(blob){
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try{
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      return audioBuffer;
    } finally {
      try{ audioCtx.close(); }catch(e){}
    }
  }

  // Resamples (and mixes down to mono) an AudioBuffer to a target sample rate
  // using an OfflineAudioContext, which the browser does for us automatically.
  async function resampleMono(audioBuffer, targetSampleRate){
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1, Math.ceil(audioBuffer.duration*targetSampleRate), targetSampleRate
    );
    const src = offlineCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offlineCtx.destination);
    src.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0); // already mono since the offline context has 1 channel
  }

  // Encodes mono Float32 PCM samples as a 16-bit PCM WAV Blob.
  function encodeWavFromFloat32(samples, sampleRate){
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const byteRate = sampleRate*blockAlign;
    const dataSize = samples.length*bytesPerSample;
    const buf = new ArrayBuffer(44+dataSize);
    const view = new DataView(buf);
    function writeStr(off, s){ for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); }
    writeStr(0,'RIFF'); view.setUint32(4, 36+dataSize, true); writeStr(8,'WAVE');
    writeStr(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
    view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,byteRate,true); view.setUint16(32,blockAlign,true); view.setUint16(34,16,true);
    writeStr(36,'data'); view.setUint32(40,dataSize,true);
    let off = 44;
    for(let i=0;i<samples.length;i++,off+=2){
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s<0 ? s*0x8000 : s*0x7FFF, true);
    }
    return new Blob([view], {type:'audio/wav'});
  }

  // Produces a compact 16kHz mono WAV Blob for a slice [startSec,endSec) of an
  // already-decoded AudioBuffer (or the whole thing if no range is given).
  async function audioBufferSliceToWav(audioBuffer, startSec, endSec){
    const sr = audioBuffer.sampleRate;
    const s = Math.max(0, Math.floor((startSec||0)*sr));
    const e = Math.min(audioBuffer.length, Math.ceil((endSec==null?audioBuffer.duration:endSec)*sr));
    const length = Math.max(1, e-s);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Build a small AudioBuffer containing just the requested slice so resampleMono can work on it.
    const slice = ctx.createBuffer(audioBuffer.numberOfChannels, length, sr);
    for(let ch=0; ch<audioBuffer.numberOfChannels; ch++){
      slice.copyToChannel(audioBuffer.getChannelData(ch).subarray(s, e), ch, 0);
    }
    try{ ctx.close(); }catch(err){}
    const targetRate = 16000;
    const mono = await resampleMono(slice, targetRate);
    return encodeWavFromFloat32(mono, targetRate);
  }

  // Tries an async call with each supplied override key in turn (falling
  // back to a final "no override" attempt so the edge function's own
  // server-side Groq keys still get tried), fully transparent, no user
  // action required. Transient-looking failures (rate limits, momentary
  // network blips, 5xx from Groq) get a couple of short-backoff retries on
  // the SAME key before moving on to the next one, since those usually
  // resolve on their own within a second or two.
  function isTransientError(err){
    const s = String(err && err.message || err);
    // 529 = Anthropic's own "Overloaded" status (see their API error docs).
    // Hack Club proxies it straight through for Claude-family models, and
    // it was missing here — meaning Opus/Sonnet 529s were treated as
    // permanent failures with zero backoff, so withKeyFallback's 4
    // "attempts" (key, key2, key3, null — none of which actually change
    // anything for hackclub-chat; see the overrideKey comment where this
    // is called) fired back-to-back in under 50ms total, hammering an
    // already-overloaded endpoint instead of giving it a moment to
    // recover. That's the real cause of the instant repeated failures.
    return /:429:|:500:|:502:|:503:|:504:|:529:/.test(s) || /rate.?limit/i.test(s) || /overloaded/i.test(s) || s.includes('Failed to fetch');
  }
  async function withKeyFallback(fn, ...keys){
    const list = [...new Set(keys)];
    if(!list.some(k => !k)) list.push(null); // guarantee a no-override attempt
    let lastErr = null;
    for(const k of list){
      for(let attempt = 0; attempt < 3; attempt++){
        try{
          return await fn(k);
        }catch(err){
          lastErr = err;
          if(err.rateLimited) throw err; // our own daily cap — retrying only burns more of it
          if(attempt < 2 && isTransientError(err)){
            // A 429 specifically usually means a real rate limit (ours or
            // an upstream shared one) that needs real wall-clock time to
            // clear — the previous 600ms/1200ms backoff was nowhere near
            // enough for a per-minute limit, so those retries were just
            // re-triggering the same 429 immediately. Other transient
            // errors (momentary 5xx/network blips) still get the original
            // short backoff, since those usually really do resolve within
            // a second or two.
            const isRateLimit429 = /:429:/.test(String(err && err.message || err));
            const delayMs = isRateLimit429 ? 4000 * (attempt + 1) : 600 * (attempt + 1);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          break;
        }
      }
    }
    throw lastErr || new Error('withKeyFallback_no_keys');
  }

  async function transcribeBlob(blob, key, filename){
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('filename', filename);
    form.append('category', 'ballot_feedback');
    if(key) form.append('overrideKey', key);
    const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/groq-transcribe`,{
      method:'POST',
      headers:{
        'Authorization':'Bearer '+(await getAuthToken()),
        'apikey': SUPABASE_ANON_KEY
      },
      body:form
    }, 75000);
    if(res.status === 429){
      const { info, isRealQuotaBlock, fallback } = await readRateLimitInfo(res, 'ballot_feedback');
      if(window.RateLimitUI) window.RateLimitUI.refresh();
      if(isRealQuotaBlock){
        const err = new Error('rate_limited');
        err.rateLimited = true; err.category = info.category || 'ballot_feedback';
        err.count = info.currentCount ?? fallback.count; err.limit = info.usageLimit ?? fallback.limit;
        throw err;
      }
      throw new Error('platform_rate_limited:429:'+JSON.stringify(info).slice(0,200));
    }
    if(window.RateLimitUI) window.RateLimitUI.refresh();
    if(!res.ok) throw new Error('transcription_failed:'+res.status+':'+await safeErrText(res));
    const json = await res.json();
    return { text:(json.text||'').trim(), words: Array.isArray(json.words) ? json.words : [] };
  }

  // Transcribes a single chunk; if Groq/the upload path still rejects it as
  // too large (413) even at our conservative budget, halves the chunk and
  // retries each half recursively instead of failing outright. Returns
  // {text, words} with word timestamps already offset to absolute time.
  async function transcribeChunkResilient(audioBuffer, startSec, endSec, keys, labelPrefix, onProgress){
    const wav = await audioBufferSliceToWav(audioBuffer, startSec, endSec);
    if(wav.size > GROQ_UPLOAD_SAFE_BYTES && (endSec - startSec) > 20 && wav.size/2 > GROQ_UPLOAD_MIN_BYTES){
      // Pre-emptively split before even trying, no point uploading something
      // we already know is over budget.
      const mid = startSec + (endSec - startSec) / 2;
      const [a, b] = await Promise.all([
        transcribeChunkResilient(audioBuffer, startSec, mid, keys, labelPrefix+'a', onProgress),
        transcribeChunkResilient(audioBuffer, mid, endSec, keys, labelPrefix+'b', onProgress)
      ]);
      return { text: (a.text+' '+b.text).trim(), words: a.words.concat(b.words) };
    }
    try{
      const r = await withKeyFallback(k => transcribeBlob(wav, k, 'speech_'+labelPrefix+'.wav'), ...keys);
      onProgress && onProgress();
      return { text: r.text, words: r.words.map(w => ({ ...w, start: w.start+startSec, end: w.end+startSec })) };
    }catch(err){
      const s = String(err.message || err);
      const isTooLarge = s.includes(':413:') || s.toLowerCase().includes('request entity too large');
      if(isTooLarge && (endSec - startSec) > 5 && wav.size/2 > GROQ_UPLOAD_MIN_BYTES){
        // Still rejected even under our budget (a stricter real-world limit
        // than we assumed), self-heal by halving and retrying each half.
        const mid = startSec + (endSec - startSec) / 2;
        const [a, b] = await Promise.all([
          transcribeChunkResilient(audioBuffer, startSec, mid, keys, labelPrefix+'a', onProgress),
          transcribeChunkResilient(audioBuffer, mid, endSec, keys, labelPrefix+'b', onProgress)
        ]);
        return { text: (a.text+' '+b.text).trim(), words: a.words.concat(b.words) };
      }
      throw err;
    }
  }

  // Transcribes a (possibly long) decoded AudioBuffer. Always compresses to
  // 16kHz mono WAV and splits it into small, FIXED-duration chunks (60s each
  //about 1.9MB apiece at 16kHz/16-bit mono, far under any plausible
  // upload limit) rather than trying to estimate a safe chunk size from
  // measured bytes, a fixed duration can never be wrong the way a size
  // estimate can. Chunks are transcribed by a pool of workers, one per
  // available API key, running in parallel. If one key hits a rate limit or
  // any other error on its chunk, that request falls back through the other
  // available keys automatically; the other workers keep making progress on
  // their own chunks the whole time, so one key stalling out never blocks
  // the rest of the transcription. Any chunk that somehow still comes back
  // "too large" is self-healed by being recursively split further (see
  // transcribeChunkResilient above), so this should never fail purely on
  // size for a normal-length speech. Results are stitched back together
  // with correct absolute timestamps.
  const FIXED_CHUNK_SECONDS = 60; // ≈1.9MB per chunk at 16kHz/16-bit mono, small enough for any realistic limit
  async function transcribeLongAudio(audioBuffer, keysIn, onStatus){
    const keys = [...new Set((keysIn || []).filter(Boolean))];
    if(!keys.length) keys.push(null); // fall through to the edge function's own server-side keys

    const duration = audioBuffer.duration;
    if(duration <= FIXED_CHUNK_SECONDS * 1.25){
      // Short enough to send as one piece (transcribeChunkResilient will
      // still self-heal and split it further if it's somehow rejected).
      onStatus && onStatus('Transcribing testimony', '', 0.92);
      return await transcribeChunkResilient(audioBuffer, 0, duration, keys, 'full', null);
    }

    const chunkRanges = [];
    for(let t=0; t<duration; t+=FIXED_CHUNK_SECONDS){
      chunkRanges.push([t, Math.min(duration, t+FIXED_CHUNK_SECONDS)]);
    }

    const results = new Array(chunkRanges.length);
    let nextIdx = 0, completed = 0;

    async function worker(myKey){
      while(nextIdx < chunkRanges.length){
        const myIdx = nextIdx++;
        const [s,e] = chunkRanges[myIdx];
        onStatus && onStatus(
          'Transcribing testimony',
          '',
          completed / chunkRanges.length
        );
        // Try this worker's own key first, then fall back through every
        // other available key (in order) if it fails for any reason, 
        // rate limit, auth, transient error, etc.
        const orderedKeys = [myKey, ...keys.filter(k => k !== myKey)];
        const r = await transcribeChunkResilient(audioBuffer, s, e, orderedKeys, 'part'+myIdx, null);
        results[myIdx] = r;
        completed++;
      }
    }
    await Promise.all(keys.map(k => worker(k)));

    const text = results.map(r=>r.text).join(' ').trim();
    const words = results.reduce((acc,r)=>acc.concat(r.words), []);
    return { text, words };
  }

  function buildDeliveryMetricsBlock(m, fs){
    const fillerLine = fs
      ? `- Filler Words (auto-counted from transcript text): ${fs.fillerCount} total filler/crutch words detected${fs.fillerCount ? ' (' + Object.entries(fs.fillerBreakdown).map(([w,c])=>`"${w}"×${c}`).join(', ') + ')' : ''}. Treat this as a starting count — still do your own close read of the transcript for fillers this simple word-list scan may have missed or miscounted in context.`
      : '';
    const stutterLine = fs
      ? `- Stutters/Repetitions (auto-counted): ${fs.stutterCount} instances of an immediately repeated word or stammered word-fragment detected (e.g. "the the", "I-I-I", "wh-what"). Weigh a high count as a fluency/confidence flaw in the Speech Quality category.`
      : '';
    if(!m) return [
      'AUDIO DELIVERY METRICS: Unavailable for this recording (the browser could not decode the audio waveform). Score the Speech Quality category using filler words, stutters, and general fluency cues from the transcript text only — do not penalize for missing volume/tone/emphasis data.',
      fillerLine, stutterLine
    ].filter(Boolean).join('\n');
    const lines = [];
    lines.push('AUDIO DELIVERY METRICS (auto-detected via client-side waveform/pitch analysis of the actual recording — treat these as ground truth measurements and weigh them heavily in the Speech Quality category, alongside the filler-word and stutter counts):');
    lines.push(`- Volume: average ${m.avgDb} dBFS → "${m.volumeLabel}". Scoring guidance: ≥ -18 dBFS = full marks for volume; ≤ -42 dBFS = near-zero; deduct proportionally if quieter, this speaker's raw volume-based subscore is ${m.volumeScore}/10.`);
    lines.push(`- Emphasis: ${m.emphasizedCount} of ${m.totalWords} words (${m.emphasisRatio}%) carried a clear loudness spike relative to the speaker's own baseline. Emphasized word contexts, in spoken order (emphasized word shown in CAPS):`);
    if(m.emphasisContexts.length) m.emphasisContexts.forEach(c=>lines.push('    "...'+c+'..."'));
    else lines.push('    (No clear emphasis spikes detected — delivery sounded flat/monotone in volume throughout.)');
    lines.push('  → Judge whether these emphasized words land on rhetorically important terms (thesis words, numbers, key nouns, signposting/transition cues) versus random or filler words. Well-placed emphasis on important words = higher score. Emphasis landing on meaningless words, or no emphasis at all (totally flat delivery), should be penalized.');
    lines.push(`- Tone/Pitch Variety: ${m.toneChanges} significant pitch shifts detected across the speech; pitch std-dev ${m.pitchStdDev}Hz → vocal variety rated "${m.pitchVarietyLabel}". Low variety reads as monotone/robotic and should be penalized; healthy variety that tracks the content's energy should be rewarded.`);
    lines.push(`- Pauses: ${m.pauseCount} pauses longer than 0.4s detected, averaging ${m.avgPauseLen}s. Reward strategic, well-placed pauses used for emphasis or signposting; penalize excessive, awkward, or filler-disguising pauses.`);
    lines.push(`- Pace: ${m.wpm} words per minute over a ${m.durationSec}s recording → "${m.paceLabel}" (competitive extemp target is roughly 150-175 wpm). Note if pacing is too rushed to follow or too slow/draggy.`);
    if(fillerLine) lines.push(fillerLine);
    if(stutterLine) lines.push(stutterLine);
    return lines.join('\n');
  }

  // ---- Text-based filler word + stutter/repetition counter ----
  // Runs client-side against the raw transcript text (no audio needed) so the
  // Vocal Delivery panel always has hard numbers, even if waveform analysis
  // fails. These are an approximate, deterministic word-list scan, the AI
  // judge is told to treat them as a starting point and still do its own read.
  const FILLER_SINGLE_WORDS = DATA.FILLER_SINGLE_WORDS;
  const FILLER_PHRASES = DATA.FILLER_PHRASES;

  function countFillersAndStutters(transcript){
    const rawWords = (transcript.match(/[a-zA-Z']+|[a-zA-Z']+-/g) || []);
    const cleanWords = rawWords.map(w => w.toLowerCase().replace(/[^a-z']/g,''));

    let fillerCount = 0;
    const fillerBreakdown = {};
    const fillerSet = new Set(FILLER_SINGLE_WORDS);
    cleanWords.forEach(w=>{
      if(fillerSet.has(w)){ fillerCount++; fillerBreakdown[w] = (fillerBreakdown[w]||0) + 1; }
    });
    FILLER_PHRASES.forEach(([a,b])=>{
      for(let i=0;i<cleanWords.length-1;i++){
        if(cleanWords[i]===a && cleanWords[i+1]===b){
          fillerCount++;
          const key = a+' '+b;
          fillerBreakdown[key] = (fillerBreakdown[key]||0) + 1;
        }
      }
    });

    // Stutters: an immediately repeated identical word ("the the", "I I think"),
    // or a short hyphenated word-fragment stammer as Whisper sometimes
    // transcribes it ("wh- what", "I- I- I").
    let stutterCount = 0;
    for(let i=1;i<cleanWords.length;i++){
      if(cleanWords[i] && cleanWords[i]===cleanWords[i-1]) stutterCount++;
    }
    const fragmentMatches = transcript.match(/\b[a-zA-Z]{1,3}-\s+[a-zA-Z]/g);
    if(fragmentMatches) stutterCount += fragmentMatches.length;

    return { fillerCount, fillerBreakdown, stutterCount };
  }

  const SPECTRUM_STOPS = DATA.SPECTRUM_STOPS;
  function colorFromRatio(ratio){
    ratio = Math.max(0, Math.min(1, isFinite(ratio) ? ratio : 0));
    for(let i=0;i<SPECTRUM_STOPS.length-1;i++){
      const a = SPECTRUM_STOPS[i], b = SPECTRUM_STOPS[i+1];
      if(ratio>=a.r && ratio<=b.r){
        const t = (b.r===a.r) ? 0 : (ratio-a.r)/(b.r-a.r);
        const rgb = [0,1,2].map(j=>Math.round(a.c[j]+(b.c[j]-a.c[j])*t));
        return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      }
    }
    const last = SPECTRUM_STOPS[SPECTRUM_STOPS.length-1].c;
    return `rgb(${last[0]},${last[1]},${last[2]})`;
  }
  function dvBand(score10){ return colorFromRatio(score10/10); }
  function bandFromRatio(ratio){ return colorFromRatio(ratio); }


  const ANN_COLORS = DATA.ANN_COLORS;
  const ANN_LABELS = DATA.ANN_LABELS;

  // Renders the transcript. If `ann` ({sections, comments}) is present, locates
  // each AI-quoted phrase inside the real, untouched transcript text and layers
  // on section-labeled paragraph blocks + clickable color-coded comment spans
  // (Google-Docs-style). Any individual quote that can't be located is simply
  // skipped, never breaks the rest of the rendering. Falls back to plain text
  // if no annotations are available at all.
  // Tokenizes plainTranscript into word-like substrings (in document order,
  // with their character offsets) and zips them 1:1 against the word-level
  // timestamps returned by the transcription API (also in spoken order).
  // Whisper/Groq's word list and the joined transcript text are built from
  // the same underlying words, so positional zipping lines them up reliably
  // even though punctuation isn't identical between the two. Any leftover
  // tokens beyond the shorter list are simply left without timestamps.
  function buildWordTokenSpans(text, wordTimestamps){
    const spans = [];
    if(!Array.isArray(wordTimestamps) || !wordTimestamps.length) return spans;
    const re = /[A-Za-z0-9']+/g;
    let m, i = 0;
    while((m = re.exec(text)) !== null){
      if(i >= wordTimestamps.length) break;
      const wt = wordTimestamps[i];
      if(wt && typeof wt.start === 'number' && typeof wt.end === 'number'){
        spans.push({ s:m.index, e:m.index + m[0].length, ts:wt.start, te:wt.end });
      }
      i++;
    }
    return spans;
  }

  // Renders text.slice(start,end) as escaped HTML, wrapping each word token
  // that falls in range with a clickable/highlightable span carrying its
  // start/end time (in seconds into the recording) so it can be synced with
  // the video player. Falls back to plain escaped text when no timestamps
  // are available for a given stretch.
  function escWithWords(text, start, end){
    if(!wordTokenSpans.length) return escHtml(text.slice(start, end));
    let html = '', cursor = start;
    for(let i = 0; i < wordTokenSpans.length; i++){
      const tk = wordTokenSpans[i];
      if(tk.e <= start) continue;
      if(tk.s >= end) break;
      const s = Math.max(tk.s, start), e = Math.min(tk.e, end);
      if(s < cursor) continue;
      if(s > cursor) html += escHtml(text.slice(cursor, s));
      html += `<span class="tw" data-ts="${tk.ts}" data-te="${tk.te}">${escHtml(text.slice(s, e))}</span>`;
      cursor = e;
    }
    if(cursor < end) html += escHtml(text.slice(cursor, end));
    return html;
  }

  // Finds the playback time (seconds) of the first word token starting at or
  // after the given character offset, used to seek the video when a
  // judge's-note span is clicked.
  function timeForCharOffset(charOffset){
    for(let i = 0; i < wordTokenSpans.length; i++){
      if(wordTokenSpans[i].e > charOffset) return wordTokenSpans[i].ts;
    }
    return null;
  }

  function renderTranscript(plainTranscript, ann){
    const legend = document.getElementById('annLegend');
    const hasSections = ann && Array.isArray(ann.sections) && ann.sections.length;
    const hasComments = ann && Array.isArray(ann.comments) && ann.comments.length;

    wordTokenSpans = buildWordTokenSpans(plainTranscript, lastWordTimestamps);

    if(!ann || (!hasSections && !hasComments)){
      transcriptBody.innerHTML = `<div class="ts-section-text">${escWithWords(plainTranscript, 0, plainTranscript.length)}</div>`;
      if(legend) legend.classList.add('hidden');
      cacheTranscriptWordEls();
      return;
    }

    const normMap = buildNormalizedMap(plainTranscript);

    // Locate section breakpoints (search progressively forward so repeated
    // wording earlier in the speech doesn't get matched twice). If a quote
    // can't be found after the previous section's cursor, e.g. the AI's
    // quoted phrase slightly overlaps the previous section, retry from the
    // very start of the transcript so one bad match doesn't silently delete
    // an entire section from the breakdown (this is what was causing Body 1
    // to occasionally vanish into the Introduction).
    const sectionPoints = [];
    let searchFrom = 0, lastAcceptedPos = -1;
    (ann.sections||[]).forEach(s=>{
      if(!s || !s.label || !s.quote) return;
      let loc = locateQuote(s.quote, normMap, searchFrom);
      if(!loc){
        const retry = locateQuote(s.quote, normMap, 0);
        if(retry && retry.start > lastAcceptedPos) loc = retry;
      }
      if(loc){
        sectionPoints.push({ pos: loc.start, label: String(s.label).trim() });
        searchFrom = loc.normEnd;
        lastAcceptedPos = loc.start;
      }
    });
    sectionPoints.sort((a,b)=>a.pos-b.pos);

    // Locate comment spans, skipping ones that can't be found or that overlap
    // an already-accepted comment span.
    const rawSpans = [];
    let commentSearchFrom = 0;
    (ann.comments||[]).forEach(c=>{
      if(!c || !c.quote || !c.color || !ANN_COLORS.includes(c.color)) return;
      const loc = locateQuote(c.quote, normMap, 0); // comments may appear anywhere/any order
      if(loc) rawSpans.push({ start:loc.start, end:loc.end, color:c.color, comment:String(c.comment||'').trim() });
    });
    rawSpans.sort((a,b)=>a.start-b.start);
    const spans = [];
    let lastEnd = -1;
    rawSpans.forEach(sp=>{
      if(sp.start >= lastEnd){ spans.push(sp); lastEnd = sp.end; }
    });

    let html = '';
    if(sectionPoints.length === 0){
      html = `<div class="ts-section-text">${annotateRange(plainTranscript, 0, plainTranscript.length, spans)}</div>`;
    }else{
      if(sectionPoints[0].pos > 0){
        html += `<div class="ts-section-text">${annotateRange(plainTranscript, 0, sectionPoints[0].pos, spans)}</div>`;
      }
      for(let i=0;i<sectionPoints.length;i++){
        const start = sectionPoints[i].pos;
        const end = (i+1<sectionPoints.length) ? sectionPoints[i+1].pos : plainTranscript.length;
        if(end <= start) continue;
        html += `<div class="ts-section">
          <div class="ts-section-label">${escHtml(sectionPoints[i].label)}</div>
          <div class="ts-section-text">${annotateRange(plainTranscript, start, end, spans)}</div>
        </div>`;
      }
    }

    transcriptBody.innerHTML = html;
    if(legend) legend.classList.toggle('hidden', spans.length === 0);
    attachCommentListeners();
    cacheTranscriptWordEls();
  }

  // Caches the rendered .tw word elements (in the same order as
  // wordTokenSpans) so the video timeupdate handler can highlight the
  // current word without re-querying the DOM on every tick.
  let transcriptWordEls = [];
  function cacheTranscriptWordEls(){
    transcriptWordEls = Array.from(transcriptBody.querySelectorAll('.tw'));
  }

  // ===== SYNCED VIDEO PLAYBACK (results view) =====
  function fmtPb(s){
    if(!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  }

  // Loads the just-recorded clip into the results-view player. Called each
  // time a new set of results is rendered.
  function setupResultsPlayback(){
    if(resultsVideoURL){ URL.revokeObjectURL(resultsVideoURL); resultsVideoURL = null; }
    if(!recordedBlob){
      playbackSection.classList.add('hidden');
      resultsVideo.removeAttribute('src');
      return;
    }
    resultsVideoURL = URL.createObjectURL(recordedBlob);
    resultsVideo.src = resultsVideoURL;
    resultsVideo.currentTime = 0;
    pbPlayBtn.classList.remove('pb-playing');
    pbScrub.value = 0;
    pbTimeCur.textContent = '0:00';
    pbTimeDur.textContent = '0:00';
    playbackSection.classList.remove('hidden');
  }

  function seekResultsVideo(t){
    if(!resultsVideo.src || isNaN(t)) return;
    resultsVideo.currentTime = Math.max(0, t);
    resultsVideo.play().catch(()=>{});
  }

  pbPlayBtn.addEventListener('click', ()=>{
    if(!resultsVideo.src) return;
    if(resultsVideo.paused) resultsVideo.play().catch(()=>{});
    else resultsVideo.pause();
  });
  resultsVideo.addEventListener('play', ()=> pbPlayBtn.classList.add('pb-playing'));
  resultsVideo.addEventListener('pause', ()=> pbPlayBtn.classList.remove('pb-playing'));
  resultsVideo.addEventListener('ended', ()=> pbPlayBtn.classList.remove('pb-playing'));
  resultsVideo.addEventListener('loadedmetadata', ()=>{
    pbScrub.max = String(resultsVideo.duration || 0);
    pbTimeDur.textContent = fmtPb(resultsVideo.duration);
  });

  let pbScrubbing = false;
  pbScrub.addEventListener('input', ()=>{
    pbScrubbing = true;
    if(resultsVideo.src) resultsVideo.currentTime = parseFloat(pbScrub.value) || 0;
  });
  pbScrub.addEventListener('change', ()=>{ pbScrubbing = false; });

  // Binary search over any ascending-by-ts word span array: the last word
  // whose start time is <= t. Generic so both the real results player and
  // the example ballot's YouTube player can share the same logic.
  function findActiveWordIndex(spans, t){
    let lo = 0, hi = spans.length - 1, ans = -1;
    while(lo <= hi){
      const mid = (lo+hi) >> 1;
      if(spans[mid].ts <= t){ ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  // Advances the highlighted word for a given (spans, els, currentActiveEl, t)
  // and returns the new active element (caller stores it back into its own
  // state var, since results + example each track their own).
  function syncActiveWord(spans, els, currentActiveEl, t){
    if(!spans.length || !els.length) return currentActiveEl;
    const idx = findActiveWordIndex(spans, t);
    const inRange = idx >= 0 && t <= spans[idx].te + 0.35;
    const newEl = inRange ? els[idx] : null;
    if(newEl === currentActiveEl) return currentActiveEl;
    if(currentActiveEl) currentActiveEl.classList.remove('tw-active');
    if(newEl){
      newEl.classList.add('tw-active');
      // Only auto-scroll the page to follow the highlighted word if the
      // user hasn't manually scrolled away, otherwise this would yank
      // the viewport back and trap them on the highlighted word,
      // preventing them from scrolling up to reach the pause/stop
      // controls or anything else on the page.
      if(autoScrollToWordEnabled){
        lastProgrammaticScrollAt = Date.now();
        newEl.scrollIntoView({ block:'nearest', behavior:'smooth' });
      }
    }
    return newEl;
  }

  resultsVideo.addEventListener('timeupdate', ()=>{
    const t = resultsVideo.currentTime;
    if(!pbScrubbing){
      pbScrub.value = String(t);
      pbTimeCur.textContent = fmtPb(t);
    }
    activeWordSpanEl = syncActiveWord(wordTokenSpans, transcriptWordEls, activeWordSpanEl, t);
  });

  // ===== EXAMPLE BALLOT SYNCED PLAYBACK (embedded YouTube) =====
  // The example uses a real YouTube video rather than a locally recorded
  // blob, so it can't get real Whisper word timestamps automatically.
  // Instead, EXAMPLE_WORD_TIMESTAMPS below was derived directly from the
  // actual speech audio: a copy of this clip was analyzed for real speech
  // vs. pause activity (silence/voice-activity detection), and each of the
  // transcript's 1114 words was placed at its proportional position within
  // the actual spoken (non-pause) time, so the highlight now tracks real
  // pauses and pacing changes in the speech, not a flat assumed rate. Values
  // are seconds elapsed since the speech began (0:20 in the source video).
  // The playback/highlight/click-to-seek mechanics are otherwise identical
  // to a real round's results. The speech itself runs from 0:20 to 8:18 in
  // the source video (everything outside that range is intro/other
  // content, not the speech), so playback is clamped to that window.
  const EXAMPLE_YT_VIDEO_ID = DATA.EXAMPLE_YT_VIDEO_ID;
  const EXAMPLE_WORD_TIMESTAMPS = DATA.EXAMPLE_WORD_TIMESTAMPS;
  const EXAMPLE_SPEECH_START = DATA.EXAMPLE_SPEECH_START;   // 0:20
  const EXAMPLE_SPEECH_END = DATA.EXAMPLE_SPEECH_END;    // 8:18

  let exampleWordSpans = [];
  let exampleWordEls = [];
  let exampleActiveWordEl = null;
  let ytApiReady = false;
  let ytPlayerReady = false;
  let ytPollTimer = null;

  // Manifest V3 extension pages can only load scripts from 'self', so the
  // real https://www.youtube.com/iframe_api script can never run in our own
  // pages (Chrome blocks it regardless of CSP). Loading it in a sandboxed
  // page doesn't work either: Chrome forbids the 'allow-same-origin' token
  // on extension sandbox pages (it would let the page escape the sandbox),
  // and without it YouTube's own script can't use Cache Storage and throws.
  //
  // So instead of loading any script at all, we embed a plain YouTube
  // "embed" iframe (with enablejsapi=1) and drive it with the same raw
  // postMessage protocol the official API script itself uses internally.
  // This needs no script loading in any of our pages, so no CSP directive
  // ever comes into play. ytPlayer below exposes the same method names the
  // rest of this file already expects (getCurrentTime/getPlayerState/
  // seekTo/playVideo/pauseVideo), backed by a small cache kept fresh by the
  // iframe's periodic "infoDelivery" messages, so no other code below needs
  // to change.
  const YT_STATE_PLAYING = 1; // matches YouTube's own PlayerState.PLAYING value

  let ytFrame = null;
  let ytCachedTime = 0;
  let ytCachedState = -1;
  let ytListenTimer = null;

  function loadYouTubeIframeAPI(){
    ytApiReady = true; // nothing to load, the raw postMessage protocol needs no script
  }

  function ytPostCommand(func, args){
    if(!ytFrame || !ytFrame.contentWindow) return;
    ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*');
  }

  function ensureYtFrame(){
    if(ytFrame) return ytFrame;
    const container = document.getElementById('exampleYtPlayer');
    ytFrame = document.createElement('iframe');
    const params = new URLSearchParams({
      start: EXAMPLE_SPEECH_START, end: EXAMPLE_SPEECH_END,
      controls: 0, modestbranding: 1, rel: 0, playsinline: 1,
      enablejsapi: 1, origin: location.origin
    });
    ytFrame.src = `https://www.youtube.com/embed/${EXAMPLE_YT_VIDEO_ID}?${params.toString()}`;
    ytFrame.style.width = '100%';
    ytFrame.style.height = '100%';
    ytFrame.style.border = '0';
    ytFrame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
    container.innerHTML = '';
    container.appendChild(ytFrame);

    window.addEventListener('message', (e) => {
      if(!ytFrame || e.source !== ytFrame.contentWindow) return;
      let data = e.data;
      if(typeof data === 'string'){
        try { data = JSON.parse(data); } catch(err) { return; }
      }
      if(!data || typeof data !== 'object') return;

      if(data.event === 'onError'){
        onExamplePlayerError({ data: data.info });
        return;
      }
      if(data.event === 'onReady' || data.event === 'initialDelivery'){
        ytPlayerReady = true;
      }
      if(data.event === 'onStateChange' && typeof data.info === 'number'){
        ytCachedState = data.info;
        onExamplePlayerStateChange({ data: data.info });
      }
      // Periodic status pushed once we've sent the "listening" handshake below.
      if(data.info && typeof data.info === 'object'){
        if(typeof data.info.currentTime === 'number') ytCachedTime = data.info.currentTime;
        if(typeof data.info.playerState === 'number') ytCachedState = data.info.playerState;
      }
    });

    ytFrame.addEventListener('load', () => {
      // Handshake YouTube's embed listens for to start pushing periodic
      // "infoDelivery" status messages and start/ready/error events. Sent a
      // few times since the very first one can arrive before the embedded
      // player has finished wiring up its own listener.
      let attempts = 0;
      ytListenTimer = setInterval(() => {
        attempts++;
        if(!ytFrame || !ytFrame.contentWindow) return;
        ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: EXAMPLE_YT_VIDEO_ID }), '*');
        ytPostCommand('addEventListener', ['onReady']);
        ytPostCommand('addEventListener', ['onStateChange']);
        ytPostCommand('addEventListener', ['onError']);
        if(attempts >= 5 && ytListenTimer){ clearInterval(ytListenTimer); ytListenTimer = null; }
      }, 300);
    });

    return ytFrame;
  }

  const ytPlayer = {
    getCurrentTime: () => ytCachedTime,
    getPlayerState: () => ytCachedState,
    seekTo: (t) => {
      ytCachedTime = t;
      ensureYtFrame();
      ytPostCommand('seekTo', [t, true]);
    },
    playVideo: () => { ensureYtFrame(); ytPostCommand('playVideo'); },
    pauseVideo: () => { ensureYtFrame(); ytPostCommand('pauseVideo'); }
  };



  // Walks a rendered DOM subtree and wraps every word-like run of text in a
  // clickable/highlightable .tw span, assigning each one a synthetic,
  // evenly-paced timestamp. Returns the spans in document order.
  function wrapWordsInDom(container, startTime, secPerWord){
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while((node = walker.nextNode())) textNodes.push(node);
    let wordIdx = 0;
    const out = [];
    textNodes.forEach(tn=>{
      const text = tn.nodeValue;
      const re = /[A-Za-z0-9']+/g;
      let m, cursor = 0, matched = false;
      const frag = document.createDocumentFragment();
      while((m = re.exec(text)) !== null){
        matched = true;
        if(m.index > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.index)));
        const ts = startTime + wordIdx * secPerWord;
        const te = ts + secPerWord * 0.92;
        const span = document.createElement('span');
        span.className = 'tw';
        span.dataset.ts = ts.toFixed(2);
        span.dataset.te = te.toFixed(2);
        span.textContent = m[0];
        frag.appendChild(span);
        out.push({ el: span, ts, te });
        cursor = m.index + m[0].length;
        wordIdx++;
      }
      if(!matched) return;
      if(cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
      tn.parentNode.replaceChild(frag, tn);
    });
    return out;
  }

  function initExamplePlayer(){
    ensureYtFrame();
  }

  function onExamplePlayerError(e){
    // Embedding blocked/disallowed by the video owner, or another player
    // fault (codes: 2 invalid param, 5 HTML5 error, 100 not found,
    // 101/150 embedding disabled). Fall back gracefully to the plain link
    // rather than leaving a broken player + dead controls on screen.
    const frame = examplePbPlayBtn.closest('.playback-frame');
    if(frame){
      frame.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f8f6f0;font-family:var(--font-mono);font-size:12.5px;text-align:center;padding:20px;">
        This video can't be embedded here.<br/>
        <a href="https://www.youtube.com/watch?v=${EXAMPLE_YT_VIDEO_ID}&t=${EXAMPLE_SPEECH_START}s" target="_blank" rel="noopener noreferrer" style="color:var(--brass);margin-top:6px;display:inline-block;">Watch it on YouTube ↗</a>
      </div>`;
    }
    stopExamplePolling();
  }

  function onExamplePlayerStateChange(e){
    if(e.data === YT_STATE_PLAYING){
      examplePbPlayBtn.classList.add('pb-playing');
      startExamplePolling();
    }else{
      examplePbPlayBtn.classList.remove('pb-playing');
      stopExamplePolling();
    }
  }

  function startExamplePolling(){
    stopExamplePolling();
    ytPollTimer = setInterval(()=>{
      if(!ytPlayer || !ytPlayer.getCurrentTime) return;
      const rawTime = ytPlayer.getCurrentTime();
      // Clamp to the actual speech window (0:20–8:18), everything outside
      // it is intro/other content, not the speech itself.
      if(rawTime >= EXAMPLE_SPEECH_END){
        ytPlayer.pauseVideo();
        examplePbPlayBtn.classList.remove('pb-playing');
        stopExamplePolling();
        return;
      }
      const t = rawTime - EXAMPLE_SPEECH_START;
      if(!examplePbScrubbing){
        examplePbScrub.value = String(Math.max(0, t));
        examplePbTimeCur.textContent = fmtPb(t);
      }
      exampleActiveWordEl = syncActiveWord(exampleWordSpans, exampleWordEls, exampleActiveWordEl, t + EXAMPLE_SPEECH_START);
    }, 200);
  }
  function stopExamplePolling(){
    if(ytPollTimer){ clearInterval(ytPollTimer); ytPollTimer = null; }
  }

  function seekExampleVideo(t){
    if(!ytPlayer || !ytPlayer.seekTo) return;
    const clamped = Math.min(Math.max(t, EXAMPLE_SPEECH_START), EXAMPLE_SPEECH_END);
    ytPlayer.seekTo(clamped, true);
    ytPlayer.playVideo();
  }

  const examplePbPlayBtn  = document.getElementById('examplePbPlayBtn');
  const examplePbScrub    = document.getElementById('examplePbScrub');
  const examplePbTimeCur  = document.getElementById('examplePbTimeCur');
  const examplePbTimeDur  = document.getElementById('examplePbTimeDur');
  let examplePbScrubbing = false;

  examplePbPlayBtn.addEventListener('click', ()=>{
    if(!ytPlayer || !ytPlayerReady) return;
    const state = ytPlayer.getPlayerState();
    if(state === YT_STATE_PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
  });
  examplePbScrub.addEventListener('input', ()=>{
    examplePbScrubbing = true;
    const target = Math.min(EXAMPLE_SPEECH_START + (parseFloat(examplePbScrub.value) || 0), EXAMPLE_SPEECH_END);
    if(ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(target, true);
  });
  examplePbScrub.addEventListener('change', ()=>{ examplePbScrubbing = false; });

  document.getElementById('exampleTranscriptBody').addEventListener('click', (e)=>{
    const wordEl = e.target.closest('.tw');
    if(!wordEl) return;
    const ts = parseFloat(wordEl.dataset.ts);
    if(!isNaN(ts)){
      autoScrollToWordEnabled = true; // user asked to jump/follow here explicitly
      seekExampleVideo(ts);
    }
  });

  // Renders plainTranscript.slice(rangeStart, rangeEnd) as escaped HTML, with
  // any comment spans that fall inside that range wrapped in clickable marks.
  function annotateRange(plainTranscript, rangeStart, rangeEnd, spans){
    let html = '', cursor = rangeStart;
    spans.forEach(sp=>{
      if(sp.end <= rangeStart || sp.start >= rangeEnd) return; // outside this range
      const s = Math.max(sp.start, rangeStart), e = Math.min(sp.end, rangeEnd);
      if(s < cursor) return;
      html += escWithWords(plainTranscript, cursor, s);
      const seekTs = timeForCharOffset(s);
      const tsAttr = (seekTs !== null) ? ` data-ts="${seekTs}"` : '';
      html += `<span class="ann-comment ann-${sp.color}" data-color="${sp.color}" data-comment="${escAttr(sp.comment)}"${tsAttr}>${escWithWords(plainTranscript, s, e)}</span>`;
      cursor = e;
    });
    html += escWithWords(plainTranscript, cursor, rangeEnd);
    return html;
  }

  function escAttr(s){ return escHtml(s).replace(/"/g,'&quot;'); }

  function attachCommentListeners(container, seekFn){
    const root = container || transcriptBody;
    const seek = seekFn || seekResultsVideo;
    root.querySelectorAll('.ann-comment').forEach(el=>{
      el.addEventListener('click', (e)=>{
        e.stopPropagation();
        showCommentPopover(el);
        let ts = el.dataset.ts !== undefined ? parseFloat(el.dataset.ts) : NaN;
        if(isNaN(ts)){
          const firstWord = el.querySelector('.tw');
          if(firstWord) ts = parseFloat(firstWord.dataset.ts);
        }
        if(!isNaN(ts)) seek(ts);
      });
    });
  }

  // Delegated click handler for plain (non-comment) transcript words, clicks
  // on words wrapped inside an .ann-comment span are handled by the comment
  // listener above instead (it stops propagation before this ever fires).
  transcriptBody.addEventListener('click', (e)=>{
    const wordEl = e.target.closest('.tw');
    if(!wordEl) return;
    const ts = parseFloat(wordEl.dataset.ts);
    if(!isNaN(ts)){
      autoScrollToWordEnabled = true; // user asked to jump/follow here explicitly
      seekResultsVideo(ts);
    }
  });

  let activeCommentEl = null;
  function showCommentPopover(el){
    if(activeCommentEl) activeCommentEl.classList.remove('ann-active');
    activeCommentEl = el;
    el.classList.add('ann-active');
    const color = el.dataset.color;
    cpTag.textContent = ANN_LABELS[color] || 'Comment';
    cpTag.className = 'cp-tag tag-' + color;
    cpText.textContent = el.dataset.comment || '';
    commentPopover.classList.remove('hidden');

    // Reset any leftover inline left/top from a previous show before
    // measuring, so the natural (unclamped) width/position is read fresh.
    commentPopover.style.left = '0px';
    commentPopover.style.top = '0px';

    // Measure the popover's REAL rendered width. The CSS only sets
    // max-width:300px (not a fixed width), so short comments render a
    // narrower bubble, using a hardcoded 300 here was the bug: it clamped
    // position and placed the arrow as if every popover were exactly 300px
    // wide, so on narrower bubbles the arrow landed outside the actual
    // bubble, floating over the transcript text instead of on the comment.
    const popW = commentPopover.getBoundingClientRect().width || 300;

    // Position fixed to the viewport, anchored directly under the clicked span.
    const elRect = el.getBoundingClientRect();
    const margin = 12;
    let left = elRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
    let top = elRect.bottom + 10;

    commentPopover.style.left = left + 'px';
    commentPopover.style.top = top + 'px';

    // If the popover would run off the bottom of the viewport, flip it above the span instead.
    const popRect = commentPopover.getBoundingClientRect();
    if(popRect.bottom > window.innerHeight - margin){
      top = elRect.top - popRect.height - 10;
      commentPopover.style.top = Math.max(margin, top) + 'px';
      commentPopover.classList.add('cp-flip');
    }else{
      commentPopover.classList.remove('cp-flip');
    }

    // Point the little arrow at the clicked span, using the popover's real
    // measured width (popW above) rather than an assumed fixed width.
    const arrowLeft = Math.max(10, Math.min(elRect.left + elRect.width/2 - left, popW - 20));
    const arrowEl = commentPopover.querySelector('.cp-arrow');
    if(arrowEl) arrowEl.style.left = arrowLeft + 'px';
  }
  function hideCommentPopover(){
    if(activeCommentEl){ activeCommentEl.classList.remove('ann-active'); activeCommentEl = null; }
    commentPopover.classList.add('hidden');
  }
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.comment-popover') && !e.target.closest('.ann-comment')) hideCommentPopover();
  });
  window.addEventListener('scroll', hideCommentPopover, true);
  window.addEventListener('resize', hideCommentPopover);

  function computeDeliveryCards(m){
    const cards = [];
    if(!m || m.audioUnavailable) return cards;
    cards.push(
      { label:'Volume', val:m.avgDb+' dBFS', sub:m.volumeLabel, band:dvBand(m.volumeScore) },
      { label:'Emphasis', val:m.emphasisRatio+'%', sub:m.emphasizedCount+' of '+m.totalWords+' words stressed', band:dvBand(m.emphasisRatio>=8&&m.emphasisRatio<=35?9:m.emphasisRatio===0?2:5) },
      { label:'Tone Variety', val:m.pitchVarietyLabel.split(' —')[0], sub:m.toneChanges+' pitch shifts detected', band:dvBand(m.pitchVarietyLabel.startsWith('High')?9:m.pitchVarietyLabel.startsWith('Moderate')?5.5:2) },
      { label:'Pace', val:m.wpm+' wpm', sub:m.paceLabel, band:dvBand((m.wpm>=120&&m.wpm<=175)?9:(m.wpm>=100&&m.wpm<=195)?6:(m.wpm>=80&&m.wpm<=220)?3.5:1.5) },
      { label:'Pauses', val:m.pauseCount, sub:'avg '+m.avgPauseLen+'s each', band:dvBand((m.avgPauseLen>=0.4&&m.avgPauseLen<=2.5)?8:(m.avgPauseLen<0.2||m.avgPauseLen>4)?2:5) }
    );
    if(typeof m.fillerCount === 'number'){
      cards.push({
        label:'Filler Words', val:m.fillerCount,
        sub: m.fillerCount ? Object.entries(m.fillerBreakdown).slice(0,3).map(([w,c])=>`"${w}"×${c}`).join(', ') : 'None detected',
        band: dvBand(m.fillerCount===0?10:m.fillerCount<=2?7:m.fillerCount<=5?5:m.fillerCount<=8?3:1)
      });
    }
    if(typeof m.stutterCount === 'number'){
      cards.push({
        label:'Stutters', val:m.stutterCount,
        sub: m.stutterCount ? 'repeated words / stammered fragments' : 'None detected',
        band: dvBand(m.stutterCount===0?10:m.stutterCount<=1?7:m.stutterCount<=3?4:1)
      });
    }
    return cards;
  }

  function renderDeliveryMetrics(m){
    if(!m){
      deliverySection.classList.add('hidden');
      return;
    }
    const cards = computeDeliveryCards(m);
    deliveryGrid.innerHTML = cards.map(c=>`
      <div class="delivery-stat" style="--bc:${c.band}">
        <span class="dv-label">${c.label}</span>
        <div class="dv-val">${c.val}</div>
        <div class="dv-sub">${escHtml(String(c.sub))}</div>
      </div>`).join('');
    deliveryNote.textContent = m.audioUnavailable
      ? 'Volume/tone/pacing could not be measured for this recording, but filler words and stutters are still auto-counted from the transcript text.'
      : 'These figures are measured straight from the audio waveform and word timing, then handed to the AI judge to inform the Speech Quality score below.';
    deliverySection.classList.remove('hidden');
  }

  // ===== EXAMPLE BALLOT (static, shown via the "?" help button) =====
  // Built directly from a real round (Afghanistan war question) so a new
  // user can see exactly what a finished ballot looks like before recording
  // their first speech. No network calls, everything below is hardcoded.
  const EXAMPLE_CATEGORIES = DATA.EXAMPLE_CATEGORIES;
  const EXAMPLE_TOTAL = EXAMPLE_CATEGORIES.reduce((s,c)=>s+c.score,0);
  const EXAMPLE_RANK = DATA.EXAMPLE_RANK;
  const EXAMPLE_RANK_EXPLANATION = DATA.EXAMPLE_RANK_EXPLANATION;
  const EXAMPLE_DRILL = DATA.EXAMPLE_DRILL;
  const EXAMPLE_FACT_CHECK = DATA.EXAMPLE_FACT_CHECK || [];

  function renderExampleBallot(){
    autoScrollToWordEnabled = true; // fresh view of the example: follow along by default again
    if(typeof setExampleSyncArmed === 'function') setExampleSyncArmed(false);
    let html = scoreKeyHtml();
    EXAMPLE_CATEGORIES.forEach(cat => {
      const band = bandClass(cat.score, cat.max);
      html += `
        <div class="category">
          <div class="badge-wrap" style="--bc:${band}">
            <svg viewBox="0 0 64 64"><path d="${CIRCLE_PATH}" fill="none" stroke-width="2.5"/></svg>
            <div class="score">${cat.score}<small>/${cat.max}</small></div>
          </div>
          <div>
            <h3 class="cat-name">${escHtml(cat.name)}</h3>
            <div class="cat-row worked"><span class="tag">What Worked</span>${inlineMd(cat.whatWorked)}</div>
            <div class="cat-row flaws"><span class="tag">Critical Flaws</span>${inlineMd(cat.criticalFlaws)}</div>
            <div class="cat-row evidence"><span class="tag">What You Could Have Done</span>${inlineMd(cat.evidence)}</div>
          </div>
        </div>`;
    });
    html += `
      <div class="stamp-row">
        <div class="verdict-stamp">
          <div class="label">Composite Score</div>
          <div class="num">${EXAMPLE_TOTAL}<small>/100</small></div>
        </div>
        <div class="rank-stamp">
          <div class="label">Judge's Rank</div>
          <div class="num">${ordinal(EXAMPLE_RANK)}</div>
        </div>
      </div>
      <div class="rank-explanation">${inlineMd(EXAMPLE_RANK_EXPLANATION)}</div>
      <div class="drill">
        <span class="tag" style="font-size:16px;font-weight:800;">Feedback</span>
        <p>${inlineMd(EXAMPLE_DRILL)}</p>
      </div>`;
    html += buildFactCheckHtml(EXAMPLE_FACT_CHECK);
    document.getElementById('exampleResultsContent').innerHTML = html;

    document.getElementById('exampleDeliveryGrid').innerHTML = [
      { label:'Volume', val:'-22.9 dBFS', sub:'Adequate', band:colorFromRatio(0.5) },
      { label:'Emphasis', val:'26%', sub:'284 of 1078 words stressed', band:colorFromRatio(0.86) },
      { label:'Tone Variety', val:'High', sub:'3469 pitch shifts detected', band:colorFromRatio(0.92) },
      { label:'Pace', val:'152 wpm', sub:'Solid competitive pace', band:colorFromRatio(1.0) },
      { label:'Pauses', val:7, sub:'avg 1.93s each', band:colorFromRatio(0.68) },
      { label:'Filler Words', val:5, sub:'"literally"×1, "actually"×2, "like"×2', band:colorFromRatio(0.46) },
      { label:'Stutters', val:0, sub:'None detected', band:colorFromRatio(1.0) }
    ].map(c => `
      <div class="delivery-stat" style="--bc:${c.band}">
        <span class="dv-label">${c.label}</span>
        <div class="dv-val">${c.val}</div>
        <div class="dv-sub">${escHtml(String(c.sub))}</div>
      </div>`).join('');

    // Transcript with color-coded, clickable judge comments, same markup/
    // classes the real annotated transcript view uses (ann-comment + colors).
    const T = EXAMPLE_TRANSCRIPT_HTML;
    const body = document.getElementById('exampleTranscriptBody');
    body.innerHTML = T;

    // Lay the real, audio-derived word timestamps over the transcript (see
    // EXAMPLE_WORD_TIMESTAMPS note above EXAMPLE_YT_VIDEO_ID) so the same
    // click-to-seek and live-highlight mechanics as a real round work here
    // too, but tracking actual pauses/pacing in the speech this time.
    exampleActiveWordEl = null;
    exampleWordSpans = wrapWordsInDom(body, EXAMPLE_SPEECH_START, 1); // placeholder pace, overwritten below
    exampleWordEls = exampleWordSpans.map(s => s.el);
    attachCommentListeners(body, seekExampleVideo);

    exampleWordSpans.forEach((s, i) => {
      const offset = EXAMPLE_WORD_TIMESTAMPS[i] ?? (i * 0.4); // fallback in case word count ever drifts from the data
      const nextOffset = EXAMPLE_WORD_TIMESTAMPS[i + 1] ?? (offset + 0.4);
      s.ts = EXAMPLE_SPEECH_START + offset;
      s.te = EXAMPLE_SPEECH_START + Math.min(nextOffset, offset + 0.6);
      s.el.dataset.ts = s.ts.toFixed(2);
      s.el.dataset.te = s.te.toFixed(2);
    });

    const windowDuration = EXAMPLE_SPEECH_END - EXAMPLE_SPEECH_START;
    const totalDuration = windowDuration;
    examplePbScrub.max = String(totalDuration);
    examplePbScrub.value = '0';
    examplePbTimeCur.textContent = '0:00';
    examplePbTimeDur.textContent = fmtPb(totalDuration);
    examplePbPlayBtn.classList.remove('pb-playing');

    loadYouTubeIframeAPI();
    initExamplePlayer();
    if(ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(EXAMPLE_SPEECH_START, true);
  }

  // Hand-placed annotations on the real transcript text, using the same
  // ann-red/ann-blue/ann-green/ann-yellow color coding as a live session.
  const EXAMPLE_TRANSCRIPT_HTML = DATA.EXAMPLE_TRANSCRIPT_HTML;

  let exampleOpen = false;
  const helpToggle = document.getElementById('helpToggle');
  function closeExampleBallot(){
    exampleOpen = false;
    helpToggle.classList.remove('active');
    if(ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    stopExamplePolling();
    if(exampleOpenedFromLanding && !currentUser){
      exampleOpenedFromLanding = false;
      document.body.classList.remove('previewing-example');
      window.location.href = 'landingsite.html';
      return;
    }
    showView(viewBeforeExample || viewRecord);
  }
  helpToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if(exampleOpen){
      closeExampleBallot();
      return;
    }
    if(settingsOpen){
      settingsOpen = false;
      settingsPanel.classList.add('hidden');
      settingsToggle.classList.remove('active');
    }
    if(typeof timerOpen !== 'undefined' && timerOpen){
      timerOpen = false;
      timerPanel.classList.add('hidden');
      timerToggle.classList.remove('active');
    }
    exampleOpen = true;
    helpToggle.classList.add('active');
    viewBeforeExample = [viewRecord, viewReview, viewProcessing, viewResults].find(v => !v.classList.contains('hidden')) || viewRecord;
    renderExampleBallot();
    showView(viewExample);
  });
  document.getElementById('exampleBackBtn').addEventListener('click', closeExampleBallot);

  async function runPipeline(key, key2, key3){
    showView(viewProcessing);
    processError.classList.add('hidden');
    processErrorActions.classList.add('hidden');
    setProcStep(null); // reset checklist to all-pending before this run's stages fire
    const phrases = introDrillMode ? INTRO_PIPELINE_PHRASES : bodyDrillMode ? BODY_PIPELINE_PHRASES : roughDraftMode ? ROUGHDRAFT_PIPELINE_PHRASES : PIPELINE_PHRASES;
    try{
      // ---- Rough Draft: no recording at all, so skip straight past the
      // audio/transcribe/delivery stages below and go directly to judging
      // the plaintext draft the user typed in (see roughDraftTranscriptText,
      // assembled by the "Submit Rough Draft to Judge" handler). ----
      let transcript;
      if(roughDraftMode){
        transcript = roughDraftTranscriptText;
        if(!transcript){ pipelineProgress.stop(); showProcessError("Your rough draft looks empty. Fill in every field and try again.", true); return; }
        lastTranscript = transcript;
        lastWordTimestamps = [];
        lastDeliveryMetrics = { isRoughDraft:true, audioUnavailable:true };
        statusText.textContent = 'The panel is reading your draft';
        statusSub.textContent = 'Weighing your ideas and analysis against the content-only rubric.';
        pipelineProgress.start(phrases.judging, 55);
        setProcStep('judging');
      }else{
        statusText.textContent = 'Reading audio track';
        statusSub.textContent = 'Decoding and compressing the recording before upload.';
        pipelineProgress.start(phrases.audio, 8);
        setProcStep('audio');
        let audioBuffer;
        try{
          audioBuffer = await decodeAudioFromBlob(recordedBlob);
        }catch(e){
          throw new Error('decode_failed::Could not decode the recording\'s audio track in this browser.');
        }

        pipelineProgress.setStage(12, phrases.transcribe);
        setProcStep('transcribe');
        const transcribeResult = await transcribeLongAudio(
          audioBuffer, [key, key2, key3],
          (main, sub, frac)=>{
            statusText.textContent = main; statusSub.textContent = sub;
            // frac (0-1), when provided, reflects progress through multi-part
            // transcription, map it onto the 12%-40% band for this stage.
            const pct = (typeof frac === 'number') ? 12 + frac * 28 : 40;
            pipelineProgress.setStage(pct);
            if(typeof frac === 'number') setProcStep('transcribe', `${Math.round(frac * 100)}%`);
          }
        );
        transcript = transcribeResult.text;
        const wordTimestamps = transcribeResult.words;
        if(!transcript){ pipelineProgress.stop(); showProcessError("Didn't catch any speech — check your mic isn't muted and try again.", true); return; }
        lastTranscript = transcript;
        lastWordTimestamps = Array.isArray(wordTimestamps) ? wordTimestamps : [];

        statusText.textContent = 'Analyzing vocal delivery';
        statusSub.textContent = 'Measuring volume, emphasis, tone shifts, and pacing from the waveform.';
        pipelineProgress.setStage(55, phrases.delivery);
        setProcStep('delivery');
        const deliveryMetrics = await analyzeAudioDelivery(audioBuffer, wordTimestamps);
        const fillerStutterStats = countFillersAndStutters(transcript);
        lastDeliveryMetrics = deliveryMetrics
          ? Object.assign(deliveryMetrics, fillerStutterStats)
          : Object.assign({ audioUnavailable:true }, fillerStutterStats);
      }

      const JUDGE_MODEL_LABELS = {
        llama: 'GPT-OSS 120B',
        opus5: 'Claude Opus 5',
        kimik3: 'Kimi K3',
        sonnet5: 'Claude Sonnet 5',
        deepseekv4pro: 'DeepSeek V4 Pro',
        qwen38: 'Qwen3.8 2.4T A95B',
        gemini37flash: 'Gemini 3.7 Flash',
        glm52: 'GLM 5.2'
      };
      const judgeModelLabel = JUDGE_MODEL_LABELS[judgeModelValue] || 'GPT-OSS 120B';
      statusText.textContent = 'The panel is deliberating';
      statusSub.textContent = introDrillMode
        ? `${judgeModelLabel} is scoring your introduction against the intro-drill rubric.`
        : bodyDrillMode
        ? `${judgeModelLabel} is scoring your body point against the body-drill rubric.`
        : roughDraftMode
        ? `${judgeModelLabel} is scoring your rough draft against the content-only rubric.`
        : `${judgeModelLabel} is scoring your speech against the rubric.`;
      pipelineProgress.setStage(88, phrases.judging);
      setProcStep('judging');

      // Rough Draft has no recording, so there's no delivery-metrics block
      // to append to the judging prompt — the AI is told plainly this is a
      // written draft with no delivery data (see ROUGHDRAFT_RUBRIC_PROMPT).
      // lastDeliveryMetrics already merges the raw waveform metrics with the
      // filler/stutter counts (see the else-branch above), so it can stand
      // in for both the "m" and "fs" params buildDeliveryMetricsBlock expects.
      const metricsBlock = roughDraftMode ? '' : buildDeliveryMetricsBlock(lastDeliveryMetrics.audioUnavailable ? null : lastDeliveryMetrics, lastDeliveryMetrics);
      let judgeChoice = getJudgeModelChoice();
      let judgeWeightKey = judgeModelValue;
      // Runs the actual judging request against whichever edge function/model
      // `choice` points to. Kept as its own function so we can retry once
      // against the default Llama/groq-chat judge below if the person's
      // chosen AI (Hack Club AI models) is unavailable — e.g. the
      // hackclub-chat edge function isn't deployed yet, rejects the model
      // id, or returns a differently-shaped response — instead of just
      // failing the whole round silently.
      // Appended to whichever rubric prompt is in play so the judging
      // model doesn't spend time/tokens trying to verify evidence itself
      // — that job now belongs entirely to the independent post-ballot
      // fact-check pass (see runFactCheckPass), which never affects the
      // score. Applies to all three rubric modes; harmless on the intro
      // drill rubric, which has no evidence category to begin with.
      const EVIDENCE_TRUTH_ASSUMPTION_NOTE = '\n\nEVIDENCE ACCURACY ASSUMPTION (this overrides anything above that implies otherwise): Do not attempt to fact-check, verify, or research whether any statistic, quote, or cited source in this transcript is actually true, accurate, or was really said/reported as claimed. Treat every citation exactly as the speaker delivered it and assume it is 100% factually accurate. This is intentional — a separate, independent automated fact-checking pass runs after this ballot and is not part of your job here, so spending any effort verifying claims only wastes time and tokens. Score "Strength of Evidence" (or the equivalent evidence criteria) purely on citation PRACTICE: how well the evidence is logically applied to the claim, how reputable the named source sounds by reputation, how well-dated and diverse the citations are, and whether the speaker explains why it matters — never on whether the underlying fact is real.';
      const runJudging = async (choice, weightKey) => withKeyFallback(async (k) => {
        const baseMessages = [
          {role:'system', content: (introDrillMode ? INTRO_RUBRIC_PROMPT : bodyDrillMode ? BODY_RUBRIC_PROMPT : roughDraftMode ? ROUGHDRAFT_RUBRIC_PROMPT : RUBRIC_PROMPT) + EVIDENCE_TRUTH_ASSUMPTION_NOTE},
          {role:'user', content:'TRANSCRIPT:\n\n'+transcript+'\n\n'+metricsBlock}
        ];
        // Runs one HTTP round against choice.fn for the given message
        // list. Kept separate from the continuation loop below so a
        // single round's error handling (429 / non-ok) stays identical
        // to how every other call in this file works — throw, and let
        // withKeyFallback's existing retry logic take over.
        const doFetch = async (messages, maxTokensOverride, weightOverride) => {
          const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/${choice.fn}`,{
            method:'POST',
            headers:{
              'Authorization':'Bearer '+(await getAuthToken()),
              'apikey': SUPABASE_ANON_KEY,
              'Content-Type':'application/json'
            },
            body: JSON.stringify({
              // Groq/GPT-OSS writes the rubric feedback directly (once
              // reasoning_effort is dialed down below), so 3000 tokens is
              // plenty. The Hack Club AI models (Claude, Kimi) and the
              // NVIDIA-hosted DeepSeek appear to spend part of their budget
              // on internal reasoning before writing the actual answer, so
              // give those a much bigger per-round ceiling. Each round is
              // now capped in time (by that function's own TIME_BUDGET_MS),
              // not just tokens, and runHackClubChatToCompletion below
              // chains rounds together, so 32000 just needs to be enough
              // for one ~128s round's worth of output, not the whole ballot.
              // maxTokensOverride lets runGptOssSplitJudging below request a
              // smaller budget per split call than the flat 3000 default.
              model: choice.model, temperature:0.4, max_tokens: maxTokensOverride || (STREAMING_JUDGE_FNS.has(choice.fn) ? 32000 : 3000),
              // Kimi K3 defaults to reasoning effort "max" on Hack Club AI
              // (deep, slow thinking meant for hard agentic/coding tasks),
              // which is overkill for writing a rubric-formatted ballot and
              // was likely contributing to it timing/round-budget out.
              // Dial it down for this use case; harmless to send for models
              // that don't support the param, since hackclub-chat/OpenRouter
              // just ignores unsupported fields.
              ...(choice.model === 'moonshotai/kimi-k3' ? { reasoning: { effort: 'low' } } : {}),
              // GPT-OSS 120B defaults to reasoning_effort "medium" on Groq,
              // which writes hidden chain-of-thought into a separate
              // `reasoning` field before the actual answer — but that
              // reasoning still consumes real generation budget out of the
              // same 3000 max_tokens above. Unlike the Hack Club models,
              // groq-chat isn't in STREAMING_JUDGE_FNS and never chains
              // continuation rounds, so a truncated single shot here means
              // a truncated ballot, full stop. Force 'low' explicitly
              // rather than relying on Groq's default, so this model
              // spends its whole budget on the visible ballot the same way
              // plain Llama 3.3 used to.
              ...(choice.model === 'openai/gpt-oss-120b' ? { reasoning_effort: 'low' } : {}),
              messages,
              overrideKey: choice.fn === 'groq-chat' ? (k || undefined) : undefined,
              category: 'ballot_feedback',
              // How many units of the daily cap this call should cost —
              // mirrors BALLOT_FEEDBACK_MODEL_WEIGHTS above so pricier
              // models (Opus 5) drain the cap faster than cheaper ones
              // (Llama/DeepSeek). Enforced server-side in groq-chat /
              // hackclub-chat; see those files for the p_amount plumbing.
              // weightOverride lets runGptOssSplitJudging below charge a
              // small explicit amount per call instead of the flat
              // per-model weight above — see the note on the llama entry
              // for why that path can't just reuse this lookup directly.
              weight: weightOverride != null ? weightOverride : (BALLOT_FEEDBACK_MODEL_WEIGHTS[weightKey] || 1)
            })
          // Groq's LPU inference is genuinely fast — GPT-OSS 120B via
          // groq-chat comfortably finishes well inside 60s. hackclub-chat
          // now self-limits each round to ~128s server-side (see
          // TIME_BUDGET_MS) and hands back a "please continue" sentinel
          // instead of running long, so the client-side timeout here only
          // needs enough margin above that, not the full observed
          // generation time (280s+) like before.
          }, STREAMING_JUDGE_FNS.has(choice.fn) ? 150000 : 60000);
          if(res.status === 429){
            const { info, isRealQuotaBlock, fallback } = await readRateLimitInfo(res, 'ballot_feedback');
            if(window.RateLimitUI) window.RateLimitUI.refresh();
            if(isRealQuotaBlock){
              const err = new Error('rate_limited');
              err.rateLimited = true; err.category = info.category || 'ballot_feedback';
              err.count = info.currentCount ?? fallback.count; err.limit = info.usageLimit ?? fallback.limit;
              throw err;
            }
            // Not a real quota block — almost certainly Supabase's own
            // platform-level rate limit tripping because the continuation
            // loop can fire several hackclub-chat calls in quick
            // succession (see readRateLimitInfo above). Throw a plain
            // transient error so withKeyFallback retries with backoff
            // instead of this surfacing as a fake "you hit your daily
            // limit" toast with a made-up count.
            throw new Error('platform_rate_limited:429:'+JSON.stringify(info).slice(0,200));
          }
          if(window.RateLimitUI) window.RateLimitUI.refresh();
          if(!res.ok) throw new Error('judging_failed:'+res.status+':'+await safeErrText(res));
          return res;
        };
        // GPT-OSS 120B's free/on-demand Groq tier enforces only 8,000
        // tokens-per-minute (TPM) — the lowest of any model in this app,
        // and lower than a single Regular Practice ballot request needs
        // even before Groq generates a single output token (the 8-category
        // rubric prompt alone is ~6,300 tokens; add a real transcript and
        // a normal single-shot request routinely needs 11,000+ TPM, which
        // is exactly the 413 this was hitting). Splitting the *rubric*
        // doesn't reduce per-request cost below the cap on its own — it
        // has to be paired with real wall-clock pacing between calls,
        // since TPM is a rolling 60-second window: two ~6,500-token calls
        // sent back-to-back still sum to ~13,000 in that same window.
        // Only used for the Regular Practice (8-category) rubric — Intro
        // Drill/Body Drill/Rough Draft's rubrics are already small enough
        // (3-6 categories) to fit one call comfortably under 8,000 TPM.
        // (Previously this was split 2 categories per call; that still
        // truncated on an unusually long/dense transcript, so it's now
        // split 1 category per call — see the GPT_OSS_RUBRIC_CAT* comment
        // above for why.)
        const GPT_OSS_TPM_LIMIT = 8000;
        // len/3.5 rather than the more common len/4 — deliberately
        // conservative, since underestimating here is what produced a
        // max_tokens budget too small to finish 4 categories (a flat 1800
        // regardless of actual prompt size silently truncated mid-category
        // on a perfectly normal ~1250-word speech). Overestimating by a
        // bit just means a slightly smaller output budget, not a 413.
        const estimateTokens = (str) => Math.ceil((str||'').length / 3.5);
        // Picks max_tokens as "whatever's actually left in the 8,000 TPM
        // budget after this call's real system+user prompt", instead of a
        // flat guess — clamped to a floor (so a pathological case doesn't
        // request an unusably tiny budget) and a ceiling (no need to ask
        // for more than a genuinely long response would use anyway).
        const budgetOutputTokens = (systemContent, userContent, ceiling) => {
          const promptTokens = estimateTokens(systemContent) + estimateTokens(userContent);
          const SAFETY_MARGIN = 300; // slack for estimation error + response_format overhead
          return Math.max(900, Math.min(ceiling, GPT_OSS_TPM_LIMIT - promptTokens - SAFETY_MARGIN));
        };
        // Ceiling for each single-category pass. This is deliberately
        // LOWER than a single call's true available headroom (which can
        // run up toward ~3700 once the transcript is subtracted out) —
        // capping it here is what keeps the *synthesis* pass solvent.
        // Each category pass's own output becomes part of the synthesis
        // pass's input, so if every one of the 8 passes were allowed to
        // use the full per-call ceiling, synthesis could receive up to
        // ~8x that much text, leaving too little of its own 8,000 TPM
        // budget for its output (exactly what caused "GPT-OSS 120B's
        // synthesis pass got cut off before finishing the composite score
        // and rank"). 1700 keeps 8 passes' combined output in the same
        // ballpark the old 2-per-call version produced across its 4
        // passes, so synthesis's input size — and therefore its own
        // output headroom — doesn't regress.
        const GPT_OSS_CATEGORY_CEILING = 1700;
        // Ceiling for the synthesis pass. Its input is now kept in check
        // by GPT_OSS_CATEGORY_CEILING above, so it can safely use most of
        // whatever headroom budgetOutputTokens computes for it.
        const GPT_OSS_SYNTHESIS_CEILING = 3200;
        // A part's response is only usable if it actually contains all of
        // the category headers it was asked for — a response that's
        // merely non-empty but cut off mid-category (exactly what was
        // happening at earlier, too-small token budgets) is not "done",
        // and shipping it as though it were produces a ballot silently
        // missing whole categories with no clear signal to the speaker
        // why.
        const hasAllCategoryHeaders = (text, categoryNames) =>
          categoryNames.every(name => text.includes('### '+name));
        const GPT_OSS_GROUPS = [
          { prompt: GPT_OSS_RUBRIC_CAT1, categories: ['Creative Hook & Intro'] },
          { prompt: GPT_OSS_RUBRIC_CAT2, categories: ['Structure'] },
          { prompt: GPT_OSS_RUBRIC_CAT3, categories: ['Strength of Argument & Analysis'] },
          { prompt: GPT_OSS_RUBRIC_CAT4, categories: ['Flaws in Reasoning'] },
          { prompt: GPT_OSS_RUBRIC_CAT5, categories: ['Strength of Evidence'] },
          { prompt: GPT_OSS_RUBRIC_CAT6, categories: ['Clarity'] },
          { prompt: GPT_OSS_RUBRIC_CAT7, categories: ['Conclusion Strength'] },
          { prompt: GPT_OSS_RUBRIC_CAT8, categories: ['Speech Quality'] }
        ];
        // Daily-cap cost for a full Regular Practice round on GPT-OSS
        // 120B: 8 category calls at weight 1 each + 1 synthesis call at
        // weight 2 (it does more work — combining 8 passes' findings into
        // a rank — so it's weighted slightly higher) = 10 total. Each
        // weight is passed explicitly as doFetch's third argument rather
        // than falling back to BALLOT_FEEDBACK_MODEL_WEIGHTS.llama, which
        // is scoped to the single-call path used by Intro/Body Drill and
        // Rough Draft. Passing the per-model weight (llama: 1) through 9
        // real HTTP calls would have summed to 9, not 10 — close, but
        // this makes the total an explicit, intentional number instead of
        // an accident of how many calls the split happens to need.
        //
        // Honest caveat: 10 is the cost of the COMMON case, not a hard
        // guarantee. The retry logic below (added after confirming via
        // server-side logs that GPT-OSS 120B's hidden reasoning can
        // stochastically consume an entire call's token budget and leave
        // zero visible content) means an unlucky call that needs a retry
        // bills that call's weight again — e.g. one retried category call
        // makes the round cost 11, not 10. This is intentional: silently
        // eating a real, separately-billed API call's cost to preserve a
        // clean round number would be less honest than a total that can
        // occasionally run a little over on bad luck.
        async function runGptOssSplitJudging(){
          const userMsg = 'TRANSCRIPT:\n\n'+transcript+'\n\n'+metricsBlock;
          const parts = [];
          for(let i = 0; i < GPT_OSS_GROUPS.length; i++){
            const group = GPT_OSS_GROUPS[i];
            const sysContent = group.prompt + EVIDENCE_TRUTH_ASSUMPTION_NOTE;
            const msgs = [{role:'system', content: sysContent}, {role:'user', content: userMsg}];
            // Retries here address a real, confirmed failure mode, not a
            // guess: server-side diagnostic logging on groq-chat caught a
            // live case where GPT-OSS 120B's hidden reasoning (Groq
            // returns this as a separate completion_tokens_details.
            // reasoning_tokens count) consumed 1311 of a 1313-token
            // budget on a single category pass, leaving 0 characters of
            // actual visible content — finish_reason: "length" with an
            // entirely empty message.content. reasoning_effort: 'low'
            // (set above) reduces the ODDS of this but doesn't cap
            // reasoning length outright — it's stochastic per call, so
            // raising the ceiling only shrinks the chance without ever
            // eliminating it, and this exact category succeeded fine on
            // other runs with far fewer reasoning tokens. A retry gets an
            // entirely fresh, independent roll of that same stochastic
            // process, so it's the correct fix for a transient/unlucky
            // generation rather than a fixed budget problem.
            const MAX_ATTEMPTS = 3;
            let part = null, lastFailureWasEmpty = false;
            for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
              setProcStep('judging', `Step ${i+1} of ${GPT_OSS_GROUPS.length+1}`+(attempt>1 ? ` (retry ${attempt-1})` : ''));
              const p = extractChatContent(await (await doFetch(msgs, budgetOutputTokens(sysContent, userMsg, GPT_OSS_CATEGORY_CEILING), 1)).json());
              if(p){ part = p; lastFailureWasEmpty = false; break; }
              lastFailureWasEmpty = true;
              if(attempt < MAX_ATTEMPTS){
                setProcStep('judging', `Step ${i+1} of ${GPT_OSS_GROUPS.length+1} — retrying after empty response…`);
                await new Promise(r => setTimeout(r, 5000));
              }
            }
            if(!part){
              if(lastFailureWasEmpty)
                throw new Error(`judging_failed:GPT-OSS 120B's pass covering "${group.categories.join(' and ')}" spent its entire token budget on hidden reasoning ${MAX_ATTEMPTS} times in a row and never wrote any visible ballot text. This is a real (if rare) failure mode on Groq's end, not a bug on ours — try again.`);
              throw new Error('judging_failed:unrecognized_response_shape');
            }
            if(!hasAllCategoryHeaders(part, group.categories))
              throw new Error(`judging_failed:truncated:GPT-OSS 120B's pass covering "${group.categories.join(' and ')}" got cut off before finishing, even after budgeting the maximum safe output size under its 8,000 TPM limit — the transcript itself may just be unusually long for this model.`);
            parts.push(part);
            // Real pacing, not just a UI nicety: TPM is a rolling 60-second
            // window, so firing the next call before this one's tokens have
            // aged out risks stacking on top of it and tripping the same
            // 413 again. Skipped after the very last category pass, since
            // the synthesis call right after needs the same gap too — that
            // wait happens below instead.
            if(i < GPT_OSS_GROUPS.length - 1){
              setProcStep('judging', 'Pacing for rate limit (~1 min)…');
              await new Promise(r => setTimeout(r, 65000));
            }
          }

          setProcStep('judging', 'Pacing for rate limit (~1 min)…');
          await new Promise(r => setTimeout(r, 65000));

          // The synthesis pass gets every category pass's own findings,
          // not the transcript again — a ninth full transcript read would
          // risk blowing the TPM budget yet again for no real benefit,
          // since composite score/rank/drill only need to reason over what
          // the category passes already found, not re-derive it from
          // scratch.
          //
          // Two further trims, added after synthesis itself started
          // getting cut off ("...got cut off before finishing the
          // composite score and rank"): concatenating all 8 category
          // passes' FULL text (including each one's verbose "What You
          // Could Have Done" rewrite) routinely put synthesis's own input
          // well past 8,000 tokens before it had written a single word of
          // output — chunking the category calls more finely never
          // shrank the total volume of text synthesis has to ingest, only
          // how it was produced. So:
          //   1. The composite score is summed here in code from each
          //      category's own "- [Score]/[cap]" header, not asked of
          //      the model at all — arithmetic over 8 known integers
          //      needs no LLM call and can't be the thing that gets cut
          //      off.
          //   2. Each category's "What You Could Have Done" section is
          //      stripped before building synthesis's input — synthesis
          //      only needs the scores and the What Worked/Critical Flaws
          //      bullets to justify a rank, not the full rewritten
          //      paragraphs (those stay in the final ballot; they're just
          //      not sent to this call).
          setProcStep('judging', `Step ${GPT_OSS_GROUPS.length+1} of ${GPT_OSS_GROUPS.length+1}`);
          // Loosely matched on purpose: model output header formatting
          // can drift slightly (em dash vs hyphen, extra bolding around
          // the category name, double spaces) even when it still
          // satisfies hasAllCategoryHeaders' plainer "### CategoryName"
          // check above. An earlier stricter version of this regex threw
          // an opaque "Judging failed:" with no detail whenever real
          // output didn't match its exact assumed spacing/dash.
          const SCORE_HEADER_RE = /^###\s*.+?[-–—]\s*(\d+)\s*\/\s*(\d+)/m;
          let compositeScore = 0, compositeCap = 0;
          for(const p of parts){
            const m = SCORE_HEADER_RE.exec(p);
            if(!m) throw new Error('judging_failed:Could not find a "- score/cap" header in one of GPT-OSS 120B\'s category passes to compute the composite score from. That pass\'s output may not have followed the expected format — try again.');
            compositeScore += parseInt(m[1], 10);
            compositeCap += parseInt(m[2], 10);
          }
          // stripRewrite alone wasn't enough: it bounds input size only
          // as tightly as GPT_OSS_CATEGORY_CEILING bounds each category
          // pass's OWN output, and that ceiling is a max_tokens cap the
          // model can legitimately use most of when it has 2-5 What
          // Worked bullets and 2-5 Critical Flaws bullets to write with
          // quotes — 8 categories doing that simultaneously kept landing
          // synthesis's prompt close enough to 8,000 tokens that Groq's
          // TPM window left too little real completion room, cutting
          // synthesis off before it even finished the rank line. Trusting
          // an upstream max_tokens ceiling to indirectly bound a
          // downstream call's input is exactly the fragile pattern that
          // produced this bug twice already (2-per-call → 1-per-call →
          // per-category ceiling), so this now hard-caps the actual
          // character count sent per category, deterministically, no
          // matter how verbose any individual pass's real output was.
          const CATEGORY_SYNTHESIS_CHAR_CAP = 700; // ~200 tokens/category
          const stripAndCapForSynthesis = (p) => {
            const stripped = p.replace(/\n- \*\*What You Could Have Done:\*\*[\s\S]*$/, '').trim();
            if(stripped.length <= CATEGORY_SYNTHESIS_CHAR_CAP) return stripped;
            const cut = stripped.slice(0, CATEGORY_SYNTHESIS_CHAR_CAP);
            const lastBreak = Math.max(cut.lastIndexOf('\n- '), cut.lastIndexOf('. '));
            return (lastBreak > 100 ? cut.slice(0, lastBreak+1) : cut) + '\n*(truncated for length)*';
          };
          const userC = 'TOTAL COMPOSITE SCORE: '+compositeScore+'/'+compositeCap+
            '\n\nCATEGORY RESULTS:\n\n'+parts.map(stripAndCapForSynthesis).join('\n\n');
          const msgsC = [{role:'system', content: GPT_OSS_RUBRIC_SYNTHESIS}, {role:'user', content: userC}];
          // Same retry protection as the category loop above, and for the
          // same confirmed reason: hidden reasoning can stochastically eat
          // an entire call's token budget and leave zero visible content,
          // independent of how well-bounded the input is.
          let rawPartC = null;
          for(let attempt = 1; attempt <= 3; attempt++){
            if(attempt > 1){
              setProcStep('judging', `Step ${GPT_OSS_GROUPS.length+1} of ${GPT_OSS_GROUPS.length+1} — retrying after empty response…`);
              await new Promise(r => setTimeout(r, 5000));
            }
            rawPartC = extractChatContent(await (await doFetch(msgsC, budgetOutputTokens(GPT_OSS_RUBRIC_SYNTHESIS, userC, GPT_OSS_SYNTHESIS_CEILING), 2)).json());
            if(rawPartC) break;
          }
          if(!rawPartC) throw new Error('judging_failed:GPT-OSS 120B\'s synthesis pass returned an unrecognized response shape.');
          // Server-side diagnostic logging (see groq-chat's diag output)
          // proved this was NEVER a truncation bug: every synthesis call
          // logged was finish_reason: "stop", using a fraction of its
          // token budget, with full valid content. The real mismatch was
          // formatting decoration — the model wrote **Judge's Rank:**
          // (bold) instead of the requested ### Judge's Rank: (a markdown
          // heading). That's not just cosmetic: parseBallot() below
          // identifies every section of the final ballot (rank, rank
          // explanation, drill, each category) by scanning for lines that
          // start with "### " — a bolded-but-not-headinged line is
          // invisible to it and gets silently swallowed into whatever
          // "### " section came before it. So even once the truncation
          // check below is fixed to stop rejecting valid bolded output,
          // the rank/explanation/drill would still never appear in the
          // actual displayed ballot without this: normalize the model's
          // bold labels into real ### headings before using this text for
          // anything downstream, rather than just loosening what the
          // check accepts.
          const partC = rawPartC.replace(
            /^\*{0,2}\s*(Judge.?s Rank|Rank Explanation|Actionable Drill(?: for Next Round)?)\s*:?\s*\*{0,2}\s*:?\s*/gim,
            (_m, label) => '### '+label+': '
          );
          // The check below now works on the normalized text and just
          // needs to confirm the rank is present at all — the ### form is
          // guaranteed by the normalization above regardless of what
          // decoration the model originally chose.
          if(!/Judge.?s\s*Rank/i.test(partC))
            throw new Error('judging_failed:truncated:GPT-OSS 120B\'s synthesis pass got cut off before finishing the rank.');
          const scoreLine = '### Total Composite Score: '+compositeScore+'/'+compositeCap;

          return (parts.join('\n\n')+'\n\n'+scoreLine+'\n'+partC).trim();
        }
        const isGptOssSplitEligible = choice.model === 'openai/gpt-oss-120b'
          && !introDrillMode && !bodyDrillMode && !roughDraftMode;
        // hackclub-chat streams its response as SSE and may span several
        // chained rounds (see runHackClubChatToCompletion); groq-chat
        // still returns one buffered JSON object in a single round, since
        // Llama via Groq comfortably finishes well inside the wall-clock
        // limit and never needed any of this — GPT-OSS 120B on the
        // Regular Practice rubric is the one exception, handled above.
        const content = isGptOssSplitEligible
          ? await runGptOssSplitJudging()
          : STREAMING_JUDGE_FNS.has(choice.fn)
          ? await runHackClubChatToCompletion(doFetch, baseMessages, (round) => {
              // Live "Wave N" indicator on the Panel Deliberating step —
              // only meaningful for the streaming/continuation-capable
              // functions, since Llama/Groq finishes in one buffered call
              // and never enters this loop.
              setProcStep('judging', round > 1 ? `Wave ${round}` : '');
            })
          : extractChatContent(await (await doFetch(baseMessages)).json());
        // The HTTP call itself succeeded (the model billed real tokens),
        // but if we can't find text in any shape we recognize, treat it
        // the same as a failed call so the caller can fall back to Llama
        // instead of surfacing an opaque "no content" error.
        if(!content){
          const err = new Error('judging_failed:unrecognized_response_shape');
          throw err;
        }
        return content;
      }, key, key2, key3);

      let feedback;
      try{
        feedback = await runJudging(judgeChoice, judgeWeightKey);
      }catch(err){
        // Only fall back for genuine failures of a *non-default* judge model
        // (missing/misconfigured Hack Club AI endpoint, unsupported model
        // id, unrecognized response shape, etc.) — never mask our own rate
        // limiting, and never loop if Llama itself was already the one that
        // failed.
        if(err.rateLimited || judgeChoice.fn === 'groq-chat') throw err;
        console.error('Judge model failed, falling back to Llama:', judgeChoice.model, err);
        // Surface the *actual* failure reason instead of a generic message —
        // err.message is either "judging_failed:<http status>:<error text
        // from Hack Club>" or "judging_failed:unrecognized_response_shape".
        // Showing the real status (404 = model id not recognized upstream,
        // 429/503 = rate-limited or temporarily overloaded, 500 = server
        // error, etc.) means a failure can be diagnosed from the toast alone
        // next time, without having to reopen DevTools.
        let reason = '';
        const msg = String(err && err.message || '');
        const statusMatch = msg.match(/^judging_failed:(\d{3}):(.*)$/s);
        // Was previously only recognizing "judging_failed:<status>:..." —
        // missed the separate "platform_rate_limited:<status>:..." shape
        // thrown above when Hack Club's own upstream 429s us (their shared
        // server key hitting its own rate limit — NOT our per-user daily
        // cap, which is handled entirely separately via err.rateLimited).
        // That meant this whole failure mode silently fell through to the
        // fully generic "isn't available right now" toast with no detail
        // at all, which is exactly what was being seen.
        const platformRateMatch = msg.match(/^platform_rate_limited:(\d{3}):/);
        if(statusMatch){
          const status = statusMatch[1];
          const detail = statusMatch[2].trim().slice(0, 120);
          reason = ` (HTTP ${status}${detail ? ': '+detail : ''})`;
        } else if(platformRateMatch){
          reason = ' (Hack Club AI\'s shared server key hit its own rate limit for this model - try again in a minute)';
        } else if(/unrecognized_response_shape/.test(msg)){
          reason = ' (model responded, but in an unexpected format)';
        } else if(/^timeout:/.test(msg)){
          reason = ' (timed out — model was still generating)';
        }
        try{ showCopyConfirmToast(`${judgeModelLabel} is unavailable right now${reason} - falling back to GPT-OSS 120B.`); }catch(e){}
        judgeChoice = JUDGE_MODELS.llama;
        judgeWeightKey = 'llama';
        setProcStep('judging'); // clear any stale "Wave N" left from the failed attempt above
        feedback = await runJudging(judgeChoice, judgeWeightKey);
      }
      if(!feedback) throw new Error('judging_failed:empty:No content returned.');
      lastRawFeedback = feedback;
      // The judging call is the real cost driver for Ballot Feedback, so
      // this is where we log weighted usage against whichever model
      // actually ended up answering (post-fallback, if any).
      if(window.RateLimitUI) window.RateLimitUI.addBallotFeedbackUsage(judgeWeightKey);

      // Rough Draft skips the transcript-annotation pass (built around
      // spoken-delivery/signposting cues that don't apply to a typed
      // outline) and the independent evidence fact-check pass (the quote
      // "evidence" here is rough-draft shorthand, not citable claims worth
      // an automated web fact-check) — go straight to results.
      if(roughDraftMode){
        lastTranscriptAnnotations = null;
        lastFactCheck = null;
        pipelineProgress.finish();
        finishProcSteps();
        renderResults(feedback, transcript);
        return;
      }

      statusText.textContent = 'Marking up the transcript';
      statusSub.textContent = 'Adding inline judge comments and paragraph structure.';
      pipelineProgress.setStage(95, phrases.annotate);
      setProcStep('annotate');
      lastTranscriptAnnotations = await fetchTranscriptAnnotations(transcript, key, key2, key3);

      statusText.textContent = 'Fact-checking your citations';
      statusSub.textContent = 'Independently verifying your evidence against the live web - this never affects your score.';
      pipelineProgress.setStage(98, DATA.CC_PHRASES);
      setProcStep('factcheck');
      lastFactCheck = await runFactCheckPass(transcript);

      pipelineProgress.finish();
      finishProcSteps();
      renderResults(feedback, transcript);
    }catch(err){ pipelineProgress.stop(); handlePipelineError(err); }
  }

  // Makes a second, best-effort Groq call to get structural section labels and
  // inline comment quotes for the transcript, as JSON. Never throws, returns
  // null on any failure, and the UI gracefully falls back to a plain transcript.
  async function fetchTranscriptAnnotations(transcript, key, key2, key3){
    try{
      const chatJson = await withKeyFallback(async (k) => {
        const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/groq-chat`,{
          method:'POST',
          headers:{
            'Authorization':'Bearer '+(await getAuthToken()),
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type':'application/json'
          },
          body: JSON.stringify({
            model:'openai/gpt-oss-120b', temperature:0.3, max_tokens:3800,
            // Same reasoning-budget issue as the main judging call above:
            // GPT-OSS 120B defaults to reasoning_effort "medium" on Groq,
            // and this call has no continuation chaining either, so
            // uncontrolled reasoning tokens eating into max_tokens here
            // risks truncating the JSON before it's valid, silently
            // losing the annotation pass (this function already catches
            // that and falls back to a plain transcript, but forcing
            // 'low' avoids throwing away the budget in the first place).
            reasoning_effort: 'low',
            response_format:{ type:'json_object' },
            messages:[
              {role:'system', content: introDrillMode ? INTRO_ANNOTATION_PROMPT : bodyDrillMode ? BODY_ANNOTATION_PROMPT : ANNOTATION_PROMPT},
              {role:'user', content:'TRANSCRIPT:\n\n'+transcript}
            ],
            overrideKey: k || undefined,
            category: 'ballot_feedback'
          })
        }, 45000);
        if(window.RateLimitUI) window.RateLimitUI.refresh();
        if(!res.ok) throw new Error('annotation_failed:'+res.status);
        return await res.json();
      }, key, key2, key3);
      const raw = extractChatContent(chatJson);
      if(!raw) return null;
      let cleaned = raw.trim();
      // Strip stray code fences in case the model adds them despite instructions.
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const data = JSON.parse(cleaned);
      if(!data || (!Array.isArray(data.sections) && !Array.isArray(data.comments))) return null;
      return {
        sections: Array.isArray(data.sections) ? data.sections : [],
        comments: Array.isArray(data.comments) ? data.comments : []
      };
    }catch(e){
      console.warn('Transcript annotation unavailable:', e);
      return null; // annotation is a bonus feature, never block the ballot on it
    }
  }

  // Builds a {norm, map} pair: `norm` is a lowercased, punctuation-stripped,
  // whitespace-collapsed version of `original`, and `map[i]` gives the index
  // in `original` that corresponds to norm[i]. Lets us fuzzy-locate an AI's
  // quoted phrase (which may differ slightly in punctuation/case) inside the
  // real transcript and recover the EXACT original character offsets.
  function buildNormalizedMap(original){
    let norm = '';
    const map = [];
    for(let i=0;i<original.length;i++){
      const ch = original[i];
      const lower = ch.toLowerCase();
      if(/[a-z0-9]/.test(lower)){
        norm += lower;
        map.push(i);
      }else if(/\s/.test(ch)){
        if(norm.length && norm[norm.length-1] !== ' '){
          norm += ' ';
          map.push(i);
        }
      }
    }
    return { norm, map };
  }

  function normalizeQuote(q){
    return String(q||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  }

  // Finds the exact [start, end) character range in `original` matching `quote`,
  // searching only after `fromNormIdx` in the normalized text. Returns null if
  // no match is found (the AI's quote simply gets skipped, graceful degrade).
  function locateQuote(quote, normMap, fromNormIdx){
    const nq = normalizeQuote(quote);
    if(!nq) return null;
    const idx = normMap.norm.indexOf(nq, fromNormIdx || 0);
    if(idx === -1) return null;
    const startOrig = normMap.map[idx];
    const endNormIdx = idx + nq.length - 1;
    const endOrig = normMap.map[Math.min(endNormIdx, normMap.map.length-1)] + 1;
    return { start: startOrig, end: endOrig, normEnd: idx + nq.length };
  }

  async function safeErrText(res){
    try{
      const j = await res.json();
      // j.error.message is usually a plain string (OpenAI-style errors),
      // but AIHubMix's error responses can nest an object here instead
      // (e.g. {error:{message:{detail:...}}}). Returning that object
      // directly used to silently become the literal text "[object
      // Object]" the moment it landed in a template literal upstream —
      // which is exactly the unhelpful "HTTP 400: [object Object]" toast
      // this was producing, hiding the real reason for the 400. Only
      // return it as-is when it's actually a string; otherwise dig for a
      // readable field or fall back to a bounded JSON dump so the real
      // error text is never lost like that again.
      if(typeof j.error?.message === 'string') return j.error.message;
      if(j.error?.message && typeof j.error.message === 'object'){
        const inner = j.error.message;
        const readable = inner.detail || inner.title || inner.error || inner.reason;
        return readable ? String(readable) : JSON.stringify(inner).slice(0, 200);
      }
      // Our own edge functions (hackclub-chat, groq-chat) all return
      // {"error": "<fn>_failed:<status>:<raw upstream body>"}
      // — a plain STRING, not an {message} object, so the check above
      // always missed it and fell through to re-stringifying the WHOLE
      // response (double-encoding any JSON the upstream provider had
      // already embedded in there, which is what produced the unreadable
      // {\"type\":\"about:blank\",\"title\":\"Gone\"...} dump). Unwrap it
      // properly instead: pull any embedded JSON out of the tail and
      // surface just its human-readable detail/title/message field.
      if(typeof j.error === 'string'){
        const tailMatch = j.error.match(/^\w+_failed:\d+:(.*)$/s);
        const tail = tailMatch ? tailMatch[1] : j.error;
        try{
          const inner = JSON.parse(tail);
          const readable = inner.detail || inner.title || inner.message || inner.error;
          if(readable) return String(readable);
        }catch(e){ /* tail wasn't JSON — just a plain error string, use as-is */ }
        return tail;
      }
      return JSON.stringify(j).slice(0,200);
    }catch(e){ return res.statusText || 'Unknown error'; }
  }

  function handlePipelineError(err){
    let msg = 'Something went wrong talking to Groq.';
    const s = String(err.message || err);
    // detailAfterPrefix() replaces the old `s.split(':').slice(2).join(':')`
    // pattern, which silently assumed EVERY failure used the 3-part
    // "stage_failed:tag:detail" shape (e.g. "judging_failed:429:rate
    // limited") and threw away everything past the first colon otherwise.
    // Several judging_failed throws only ever had a 2-part shape —
    // "judging_failed:unrecognized_response_shape", or the newer
    // descriptive messages like "judging_failed:Could not find a
    // \"- score/cap\" header..." — so slice(2) silently returned an empty
    // string for all of them, producing the bare "Judging failed:" with
    // no detail the user kept seeing, no matter how much more specific
    // the underlying thrown message actually was. This instead strips
    // ONLY a recognized tag (a 3-digit HTTP status, "truncated", or
    // "empty") if one is actually present right after the stage prefix,
    // and otherwise keeps everything after the prefix intact.
    const detailAfterPrefix = (str, prefix) => {
      const raw = str.slice(prefix.length);
      return raw.replace(/^(?:\d{3}|truncated|empty):/, '');
    };
    if(err.rateLimited)
      msg = `You've hit today's Ballot Feedback limit (${err.count||'?'}/${err.limit||'?'}). It resets tomorrow - check the usage button in the bottom-left corner.`;
    else if(s.includes('Failed to fetch')||err instanceof TypeError)
      msg = "Couldn't reach Groq's API — open this file directly in your browser (not an embedded preview) and check your internet connection.";
    else if(s.includes(':401:')||s.toLowerCase().includes('invalid api key'))
      msg = 'Groq rejected the API key (401). Double-check you pasted the correct key.';
    // The stage-specific prefixes (transcription_failed / judging_failed /
    // decode_failed) are checked BEFORE the generic :413: text match below,
    // not after — a 413 can come from either the transcription upload
    // (groq-transcribe, an actually-large audio payload) or the judging
    // call (groq-chat, a small JSON payload where "too large" almost
    // certainly means something else, like a token/context limit rather
    // than literal byte size). Checking :413: first collapsed both into
    // the same "recording was too large" message even when the failing
    // request was groq-chat with a 1KB body — actively misleading, since
    // recording a shorter speech does nothing for a judging-stage failure.
    else if(s.startsWith('transcription_failed')){
      const detail = detailAfterPrefix(s, 'transcription_failed:');
      msg = (s.includes(':413:') || detail.toLowerCase().includes('request entity too large'))
        ? 'The recording was still too large to upload even after automatic compression and splitting. Try recording a shorter speech, or check your internet connection and try again.'
        : 'Transcription failed: '+detail;
    }
    else if(s.startsWith('decode_failed'))
      msg = detailAfterPrefix(s, 'decode_failed:') || "Couldn't read the recording's audio track.";
    else if(s.startsWith('judging_failed')){
      const detail = detailAfterPrefix(s, 'judging_failed:');
      msg = (s.includes(':413:') || detail.toLowerCase().includes('request entity too large'))
        ? `The judge model rejected the request as too large (413): ${detail || 'no further detail from Groq'}. This is very unlikely to be about your recording's length — it's more likely the transcript plus rubric prompt exceeded a limit on Groq's side. Try a different judge model, or try again.`
        : 'Judging failed: '+detail;
    }
    else if(s.includes(':413:')||s.toLowerCase().includes('request entity too large'))
      msg = 'The recording was still too large to upload even after automatic compression and splitting. Try recording a shorter speech, or check your internet connection and try again.';
    showProcessError(msg, true);
  }

  function showProcessError(msg, goBack){
    processError.textContent = msg;
    processError.classList.remove('hidden');
    if(goBack) processErrorActions.classList.remove('hidden');
  }

  // ===== PARSING =====
  function parseBallot(raw){
    const text = raw.replace(/\r\n/g,'\n');
    const headerRe = /^###\s+(.+)$/gm;
    const marks = [];
    let m;
    while((m = headerRe.exec(text)) !== null)
      marks.push({title:m[1].trim(), start:m.index, bodyStart:headerRe.lastIndex});
    const out = {categories:[], total:null, rank:null, rankExplanation:'', drill:''};
    for(let i=0;i<marks.length;i++){
      const bodyEnd = (i+1<marks.length) ? marks[i+1].start : text.length;
      const body = text.slice(marks[i].bodyStart, bodyEnd).trim();
      const title = marks[i].title;
      const catMatch   = title.match(/^(.*?)[\s:–—-]*\(?\[?(\d+(?:\.\d+)?)\]?\)?\s*\/\s*(\d+)(?!\d)/i);
      const totalMatch = title.match(/Total Composite Score[:\s]*\(?\[?(\d+(?:\.\d+)?)\]?\)?\s*\/\s*100/i);
      const rankMatch  = title.match(/Judge'?s Rank[:\s]*\(?\[?(\d+(?:\.\d+)?)\]?\)?\s*\/\s*5/i);
      const rankExplMatch = /Rank Explanation/i.test(title);
      const drillMatch = /Actionable Drill/i.test(title);
      if(totalMatch) out.total = parseFloat(totalMatch[1]);
      else if(rankMatch){
        out.rank = parseFloat(rankMatch[1]);
        // Some models fold the explanation directly under this header instead of a separate one
        if(body) out.rankExplanation = body;
      }
      else if(rankExplMatch) out.rankExplanation = (title.replace(/Rank Explanation:?/i,'').trim()+' '+body).trim();
      else if(drillMatch) out.drill = (title.replace(/Actionable Drill for Next Round:?/i,'').trim()+' '+body).trim();
      else if(catMatch && !totalMatch && !rankMatch){
        let whatWorked = extractField(body,'What Worked');
        // Fallback: some models (seen with Opus 5) sometimes drop the literal
        // "**What Worked:**" label and just start straight into the numbered
        // list. Per the prompt's own field ordering, "What Worked" is always
        // first, so if the labeled extraction comes up empty, grab everything
        // from the top of the body up to whichever known label appears first
        // (Critical Flaws / What You Could Have Done) instead of silently
        // dropping the content.
        if(!whatWorked){
          const stopAlternation = BALLOT_FIELD_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
          const leadRe = new RegExp('^([\\s\\S]*?)(?=\\n{0,2}-?\\s*\\*\\*(?:'+stopAlternation+'):?\\*\\*|$)', 'i');
          const leadMatch = body.match(leadRe);
          const candidate = leadMatch ? leadMatch[1].trim() : '';
          // Only use this fallback if it actually looks like content (not a
          // stray blank), and don't reuse it if it's identical to a field
          // we already extracted elsewhere in this category.
          if(candidate) whatWorked = candidate;
        }
        out.categories.push({
          name: catMatch[1].replace(/[-–—:\s]+$/,'').trim(),
          score: parseFloat(catMatch[2]),
          max: parseInt(catMatch[3],10),
          whatWorked,
          criticalFlaws: extractField(body,'Critical Flaws'),
          evidence:    extractField(body,'What You Could Have Done')
        });
      }
    }
    return out;
  }

  const BALLOT_FIELD_LABELS = DATA.BALLOT_FIELD_LABELS;
  function extractField(body, label){
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Stop as soon as we hit ANY of the three known field labels again (the
    // model sometimes writes them as a plain "**Label**" header and
    // sometimes as a "- **Label**" list item), or a new "###" category
    // header, or the end of the body. Without this, a field with no
    // dash-prefixed label after it would otherwise swallow every section
    // that follows it too.
    const stopAlternation = BALLOT_FIELD_LABELS.map(esc).join('|');
    const re = new RegExp(
      '\\*\\*'+esc(label)+':?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n{0,2}-?\\s*\\*\\*(?:'+stopAlternation+'):?\\*\\*|\\n###|$)',
      'i'
    );
    const found = body.match(re);
    return found ? found[1].trim() : '';
  }

  function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function inlineMd(s){ return escHtml(s).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>'); }
  function basicMarkdown(t){
    return escHtml(t)
      .replace(/^### (.*)$/gm,'<h4>$1</h4>').replace(/^## (.*)$/gm,'<h3>$1</h3>').replace(/^# (.*)$/gm,'<h2>$1</h2>')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/^- (.*)$/gm,'<li>$1</li>')
      .replace(/\n{2,}/g,'<br><br>').replace(/\n/g,'<br>');
  }
  function bandClass(score, max){
    const ratio = (max ? score/max : score/10);
    return colorFromRatio(ratio);
  }
  function scoreKeyHtml(){
    return `
      <div class="score-key">
        <span class="score-key-label">0%</span>
        <div class="score-key-bar"></div>
        <span class="score-key-label">100%</span>
      </div>`;
  }
  function ordinal(n){
    n = Math.round(n);
    const s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v-20)%10] || s[v] || s[0]);
  }

  // ---- shared ballot-formatting builders (used by My History so saved
  // ballots render exactly like the live results view, scored category
  // cards, stamps, delivery metrics, and the color-coded annotated
  // transcript, instead of a plain text dump) ----
  function buildBallotBodyHtml(parsed, rawFeedback, factCheck){
    let html = '';
    // Previously this required >=3 categories AND a parsed composite
    // total before showing the styled cards at all — anything short of
    // a fully complete ballot (e.g. a response cut off mid-stream by an
    // upstream/network issue) silently fell back to a plain unstyled
    // text dump, which reads as broken even when most of the ballot
    // parsed fine. Now: show styled cards for whatever categories did
    // parse, and only fall back to the raw dump if we got essentially
    // nothing usable out of it.
    if(parsed.categories.length >= 1){
      html += scoreKeyHtml();
      parsed.categories.forEach(cat => {
        const band = bandClass(cat.score, cat.max);
        html += `
          <div class="category">
            <div class="badge-wrap" style="--bc:${band}">
              <svg viewBox="0 0 64 64"><path d="${CIRCLE_PATH}" fill="none" stroke-width="2.5"/></svg>
              <div class="score">${cat.score}<small>/${cat.max||10}</small></div>
            </div>
            <div>
              <h3 class="cat-name">${escHtml(cat.name)}</h3>
              ${cat.whatWorked?`<div class="cat-row worked"><span class="tag">What Worked</span>${inlineMd(cat.whatWorked)}</div>`:''}
              ${cat.criticalFlaws?`<div class="cat-row flaws"><span class="tag">Critical Flaws</span>${inlineMd(cat.criticalFlaws)}</div>`:''}
              ${cat.evidence?`<div class="cat-row evidence"><span class="tag">What You Could Have Done</span>${inlineMd(cat.evidence)}</div>`:''}
            </div>
          </div>`;
      });
      if(parsed.total !== null){
        html += `
        <div class="stamp-row">
          <div class="verdict-stamp">
            <div class="label">Composite Score</div>
            <div class="num">${parsed.total}<small>/100</small></div>
          </div>`;
        if(parsed.rank !== null) html += `
          <div class="rank-stamp">
            <div class="label">Judge's Rank</div>
            <div class="num">${ordinal(parsed.rank)}</div>
          </div>`;
        html += `
        </div>`;
      }else{
        // The ballot stopped before ever reaching a Composite Score —
        // almost always means the response got cut off partway through
        // (network hiccup or the judge model's connection dropping),
        // not that anything is wrong with the categories that did come
        // through. Say so plainly instead of just quietly omitting the
        // score, which otherwise looks like a rendering bug.
        html += `
        <div class="raw-fallback" style="margin-top:12px">
          <strong>This ballot looks like it was cut off before finishing</strong> — no Composite Score came through, so some categories below may be missing entirely. Try running judging again for the full ballot.
        </div>`;
      }
      if(parsed.rankExplanation) html += `
        <div class="rank-explanation">${inlineMd(parsed.rankExplanation)}</div>`;
      if(parsed.drill) html += `
        <div class="drill">
          <span class="tag" style="font-size:16px;font-weight:800;">Feedback</span>
          <p>${inlineMd(parsed.drill)}</p>
        </div>`;
    }else{
      html += `<div class="raw-fallback">${basicMarkdown(rawFeedback)}</div>`;
    }
    html += buildFactCheckHtml(factCheck);
    return html;
  }

  function buildDeliveryGridHtml(m){
    if(!m) return '';
    const cards = computeDeliveryCards(m);
    if(!cards.length) return '';
    return `
      <div class="delivery-section">
        <div class="ts-head">Vocal Delivery Analysis</div>
        <div class="ts-meta">Measured directly from the audio waveform · independent of the AI's reading of the text</div>
        <div class="delivery-grid">
          ${cards.map(c=>`
            <div class="delivery-stat" style="--bc:${c.band}">
              <span class="dv-label">${c.label}</span>
              <div class="dv-val">${c.val}</div>
              <div class="dv-sub">${escHtml(String(c.sub))}</div>
            </div>`).join('')}
        </div>
        <div class="delivery-note">${m.audioUnavailable
          ? 'Volume/tone/pacing could not be measured for this recording, but filler words and stutters are still auto-counted from the transcript text.'
          : "These figures were measured straight from the audio waveform and word timing, then handed to the AI judge to inform the Speech Quality score above."}</div>
      </div>`;
  }

  // Builds the same section-labeled, color-coded-comment transcript markup
  // as the live results view, but as a standalone HTML string targeting an
  // arbitrary container (used inside each My History card). Temporarily
  // clears the shared wordTokenSpans state so escWithWords degrades to
  // plain escaped text, history entries don't have per-word timestamps
  // saved, so there's nothing to sync a video to here, just the
  // color-coded comments and section labels themselves.
  function buildAnnotatedTranscriptHtml(plainTranscript, ann){
    if(!plainTranscript) return { html: '<div class="ts-section-text">(no transcript saved)</div>', hasComments:false };
    const hasSections = ann && Array.isArray(ann.sections) && ann.sections.length;
    const hasComments = ann && Array.isArray(ann.comments) && ann.comments.length;
    const savedSpans = wordTokenSpans;
    wordTokenSpans = [];
    let html = '', spansCount = 0;
    try{
      if(!ann || (!hasSections && !hasComments)){
        html = `<div class="ts-section-text">${escWithWords(plainTranscript, 0, plainTranscript.length)}</div>`;
      }else{
        const normMap = buildNormalizedMap(plainTranscript);
        const sectionPoints = [];
        let searchFrom = 0, lastAcceptedPos = -1;
        (ann.sections||[]).forEach(s=>{
          if(!s || !s.label || !s.quote) return;
          let loc = locateQuote(s.quote, normMap, searchFrom);
          if(!loc){
            const retry = locateQuote(s.quote, normMap, 0);
            if(retry && retry.start > lastAcceptedPos) loc = retry;
          }
          if(loc){
            sectionPoints.push({ pos: loc.start, label: String(s.label).trim() });
            searchFrom = loc.normEnd;
            lastAcceptedPos = loc.start;
          }
        });
        sectionPoints.sort((a,b)=>a.pos-b.pos);

        const rawSpans = [];
        (ann.comments||[]).forEach(c=>{
          if(!c || !c.quote || !c.color || !ANN_COLORS.includes(c.color)) return;
          const loc = locateQuote(c.quote, normMap, 0);
          if(loc) rawSpans.push({ start:loc.start, end:loc.end, color:c.color, comment:String(c.comment||'').trim() });
        });
        rawSpans.sort((a,b)=>a.start-b.start);
        const spans = [];
        let lastEnd = -1;
        rawSpans.forEach(sp=>{ if(sp.start >= lastEnd){ spans.push(sp); lastEnd = sp.end; } });
        spansCount = spans.length;

        if(sectionPoints.length === 0){
          html = `<div class="ts-section-text">${annotateRange(plainTranscript, 0, plainTranscript.length, spans)}</div>`;
        }else{
          if(sectionPoints[0].pos > 0){
            html += `<div class="ts-section-text">${annotateRange(plainTranscript, 0, sectionPoints[0].pos, spans)}</div>`;
          }
          for(let i=0;i<sectionPoints.length;i++){
            const start = sectionPoints[i].pos;
            const end = (i+1<sectionPoints.length) ? sectionPoints[i+1].pos : plainTranscript.length;
            if(end <= start) continue;
            html += `<div class="ts-section">
              <div class="ts-section-label">${escHtml(sectionPoints[i].label)}</div>
              <div class="ts-section-text">${annotateRange(plainTranscript, start, end, spans)}</div>
            </div>`;
          }
        }
      }
    } finally {
      wordTokenSpans = savedSpans;
    }
    return { html, hasComments: spansCount > 0 };
  }

  function buildTranscriptSectionHtml(plainTranscript, ann){
    const { html, hasComments } = buildAnnotatedTranscriptHtml(plainTranscript, ann);
    const legend = hasComments ? `
      <div class="ann-legend">
        <span class="ann-legend-item"><i class="ann-swatch ann-red"></i>Important suggestion / big mistake</span>
        <span class="ann-legend-item"><i class="ann-swatch ann-blue"></i>Misc. comment</span>
        <span class="ann-legend-item"><i class="ann-swatch ann-green"></i>Brilliant move</span>
        <span class="ann-legend-item"><i class="ann-swatch ann-yellow"></i>Minor error</span>
      </div>` : '';
    return `
      <div class="delivery-section">
        <div class="ts-head">Full Transcript</div>
        ${legend}
        <div class="hc-transcript-body">${html}</div>
      </div>`;
  }

  function renderResults(feedback, transcript){
    autoScrollToWordEnabled = true; // fresh results view: follow along by default again
    const parsed = parseBallot(feedback);
    let html = '';

    // Show the drawn question at the top
    const resultQuestion = document.getElementById('resultQuestion');
    const resultQuestionText = document.getElementById('resultQuestionText');
    if(lastQuestion){
      resultQuestionText.textContent = lastQuestion;
      resultQuestion.classList.remove('hidden');
    }else{
      resultQuestion.classList.add('hidden');
    }

    // lastFactCheck is populated (or left null on failure) by runFactCheckPass
    // in the pipeline, right before this function is called.
    html += buildBallotBodyHtml(parsed, feedback, lastFactCheck);

    resultsContent.innerHTML = html;

    // Vocal delivery analysis panel (measured client-side, independent of the AI)
    renderDeliveryMetrics(lastDeliveryMetrics);

    // Synced video playback panel, load the just-recorded clip
    setupResultsPlayback();

    // Full inline transcript, annotated with section labels + clickable comments when available
    renderTranscript(transcript, lastTranscriptAnnotations);
    tsMeta_round.textContent = roundNo;

    if(parsed.total !== null) flightHistory.push({round:roundNo, total:parsed.total});
    renderFlightStrips();
    recordBallotToHistory(parsed, feedback, transcript, lastQuestion, roundNo, recordedBlob, lastTranscriptAnnotations, lastDeliveryMetrics, captureMode, introDrillMode, bodyDrillMode, lastFactCheck, roughDraftMode);
    showView(viewResults);
  }

  function renderFlightStrips(){
    // Round-history chips ("R1: 73/100", etc.) removed from the ballot
    // feedback view per request — keep flightHistory tracking intact
    // (still used elsewhere) but never render/show the chip strip.
    if(flightStripResults) flightStripResults.classList.add('hidden');
  }

  function resetHomeView(){
    // Blank the question box back to its initial "choose a method" state
    questionMode = null;
    introPrepStartedForCurrentQuestion = false;
    bodyPrepStartedForCurrentQuestion = false;
    roughDraftPrepStartedForCurrentQuestion = false;
    stopIntroPrepTimer();
    introPrepModal.classList.add('hidden');
    stopBodyPrepTimer();
    bodyPrepModal.classList.add('hidden');
    stopRoughDraftPrepTimer();
    roughDraftPrepModal.classList.add('hidden');
    if(rdFormError) rdFormError.style.display = 'none';
    ROUGHDRAFT_FIELD_IDS.forEach(id => { const el = document.getElementById(id); if(el){ el.classList.remove('error'); el.value=''; } });
    qModeCustomBtn.classList.remove('active');
    qModeReceiveBtn.classList.remove('active');
    customQuestionBlock.classList.add('hidden');
    generatedQuestionBlock.classList.add('hidden');
    questionInput.value = '';
    questionInput.classList.remove('error');
    qConfirmedText.textContent = '';
    resetGeneratedSteps();
    qModeError.style.display = 'none';
    questionError.style.display = 'none';
    if(recordQuestionError) recordQuestionError.style.display = 'none';
    if(youtubeQuestionError) youtubeQuestionError.style.display = 'none';
    lastQuestion = '';

    // Reset the recording timer back to 0:00
    clockPill.textContent = '00:00';
    clockPill.classList.remove('warn','over');
    clockPill.classList.add('hidden');
  }

  document.getElementById('homeBtn').addEventListener('click', () => {
    recordedBlob = null;
    revertToCamera();
    resetHomeView();
    showView(viewRecord);
  });

  // Plain-text rendering of the independent fact-check pass, for the .txt
  // export (mirrors buildFactCheckHtml, just without markup).
  function factCheckPlainText(factCheck){
    if(!factCheck) return '';
    const normalized = Array.isArray(factCheck) ? { claims: factCheck, failed: false } : factCheck;
    const claims = normalized.claims || [];
    if(normalized.failed){
      return `\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\nThis automated check couldn't complete for this round${normalized.reason ? ` (${normalized.reason})` : ''} — your score above is unaffected.`;
    }
    if(!claims.length){
      return `\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\nNo independently checkable, attributed claims were detected in this transcript.`;
    }
    const verdictLabel = v => v === 'true' ? 'TRUE' : v === 'false' ? 'FALSE' : 'UNVERIFIED';
    const lines = claims.map(c => {
      let s = `[${verdictLabel(c.verdict)}] ${c.claim}`;
      if(c.source) s += `\n  Cited source: ${c.source}`;
      if(c.explanation) s += `\n  ${c.explanation}`;
      if(c.sourceUrl) s += `\n  ${c.sourceUrl}`;
      return s;
    });
    return '\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n' + lines.join('\n\n');
  }

  function downloadBallotTxt(){
    const blob = new Blob([
      'EXTEMPLARY — OFFICIAL PRACTICE BALLOT\nRound '+roundNo+'\n',
      lastQuestion ? 'QUESTION: '+lastQuestion+'\n\n' : '\n',
      lastRawFeedback,
      factCheckPlainText(lastFactCheck),
      '\n\n--- TRANSCRIPT ---\n\n',
      lastTranscript
    ],{type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extemp-ballot-round-'+roundNo+'.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Ballot downloaded');
  }

  const dlModal = document.getElementById('dlModal');

  document.getElementById('downloadBtn').addEventListener('click', () => {
    dlModal.classList.remove('hidden');
  });
  document.getElementById('downloadTranscriptBtn').addEventListener('click', () => {
    if(!lastTranscript){ alert('No transcript available yet.'); return; }
    downloadTranscriptTxt();
  });
  document.getElementById('dlModalCancel').addEventListener('click', () => {
    dlModal.classList.add('hidden');
  });
  dlModal.addEventListener('click', (e) => {
    if(e.target === dlModal) dlModal.classList.add('hidden');
  });
  document.getElementById('dlChooseTxt').addEventListener('click', () => {
    dlModal.classList.add('hidden');
    downloadBallotTxt();
  });
  document.getElementById('dlChoosePdf').addEventListener('click', () => {
    dlModal.classList.add('hidden');
    downloadBallotPdf();
  });

  function downloadTranscriptTxt(){
    const lines = [
      'EXTEMPLARY — SPEECH TRANSCRIPT',
      'Round ' + roundNo,
      lastQuestion ? 'Question: ' + lastQuestion : '',
      '',
      lastTranscript
    ].join('\n');
    const blob = new Blob([lines], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extemp-transcript-round-' + roundNo + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Transcript downloaded');
  }

  function stripMdInline(s){
    return String(s||'').replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1');
  }

  // Builds a multi-page PDF containing the full Official Practice Ballot
  // (judge feedback + the stenographer's transcript), using jsPDF (loaded via
  // CDN). Falls back to an alert if the library failed to load (e.g. offline).
  function downloadBallotPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){
      alert("Couldn't load the PDF library — check your internet connection and try again, or use the .txt option instead.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'pt', format:'letter' });
    const marginX = 54, marginTop = 56, marginBottom = 56;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - marginX*2;
    let y = marginTop;

    function ensureSpace(lineHeight){
      if(y + lineHeight > pageHeight - marginBottom){ doc.addPage(); y = marginTop; }
    }
    function addHeading(text, size){
      doc.setFont('helvetica','bold'); doc.setFontSize(size);
      ensureSpace(size + 10);
      doc.text(text, marginX, y);
      y += size + 10;
      doc.setFont('helvetica','normal');
    }
    function addParagraph(text, size, lineGap){
      doc.setFontSize(size);
      const wrapped = doc.splitTextToSize(text, usableWidth);
      wrapped.forEach(line=>{
        ensureSpace(lineGap);
        doc.text(line, marginX, y);
        y += lineGap;
      });
    }
    function addRule(){
      ensureSpace(14);
      doc.setDrawColor(180,170,140);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 14;
    }
    function renderFeedbackBody(feedback){
      const lines = String(feedback||'').split('\n');
      lines.forEach(raw=>{
        const line = raw.trim();
        if(!line){ y += 6; return; }
        const headingMatch = line.match(/^#{1,6}\s*(.*)$/);
        if(headingMatch){
          addHeading(stripMdInline(headingMatch[1]), 12);
        }else{
          addParagraph(stripMdInline(line), 10, 13.5);
        }
      });
    }

    addHeading('EXTEMPLARY — OFFICIAL PRACTICE BALLOT', 16);
    addParagraph('Round ' + roundNo, 10.5, 14);
    if(lastQuestion) addParagraph('Question: ' + lastQuestion, 10.5, 14);
    y += 6;
    addRule();

    addHeading('Judge Feedback', 13);
    renderFeedbackBody(lastRawFeedback || '(No feedback available for this round.)');
    y += 10;
    addRule();

    addHeading('Vocal Delivery Analysis', 13);
    addParagraph("Measured directly from the audio waveform, independent of the AI's reading of the text.", 9.5, 13);
    y += 4;
    const dvCards = computeDeliveryCards(lastDeliveryMetrics);
    if(dvCards.length){
      dvCards.forEach(c => {
        doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
        ensureSpace(14);
        doc.text(String(c.label) + ':', marginX, y);
        const labelWidth = doc.getTextWidth(String(c.label) + ':  ');
        doc.setFont('helvetica','normal');
        doc.text(String(c.val) + '  —  ' + String(c.sub), marginX + labelWidth, y);
        y += 15;
      });
    }else{
      addParagraph('(Vocal delivery data was unavailable for this recording.)', 10, 13.5);
    }
    y += 6;
    addRule();

    addHeading("Stenographer's Transcript", 13);
    addParagraph(lastTranscript || '(No transcript available for this round.)', 10, 13.5);

    doc.save('extemp-ballot-round-' + roundNo + '.pdf');
  }

  // ===== Toast notifications =====
  const toastContainer = document.getElementById('toastContainer');
  function showToast(message){
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-69"></use></svg><span></span>';
    t.querySelector('span').textContent = message;
    toastContainer.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  // ===== First-visit keyboard shortcut hint =====
  (function firstVisitHint(){
    const hint = document.getElementById('firstVisitHint');
    const closeBtn = document.getElementById('firstVisitHintClose');
    let seen = null;
    try{ seen = localStorage.getItem('extemplary-seen-hint'); }catch(e){}
    if(!seen){
      setTimeout(() => hint.classList.remove('hidden'), 1200);
    }
    function dismiss(){
      hint.classList.add('hidden');
      try{ localStorage.setItem('extemplary-seen-hint', '1'); }catch(e){}
    }
    closeBtn.addEventListener('click', dismiss);
    setTimeout(dismiss, 9000);
  })();

  // ===== Copy transcript to clipboard =====
  document.getElementById('copyTranscriptBtn').addEventListener('click', async () => {
    if(!lastTranscript){ showToast('No transcript available yet'); return; }
    const lines = [
      'EXTEMPLARY — SPEECH TRANSCRIPT',
      'Round ' + roundNo,
      lastQuestion ? 'Question: ' + lastQuestion : '',
      '',
      lastTranscript
    ].join('\n');
    try{
      await navigator.clipboard.writeText(lines);
      showToast('Transcript copied to clipboard');
    }catch(e){
      showToast('Could not copy — try Download instead');
    }
  });

  document.getElementById('downloadVideoBtn').addEventListener('click', () => {
    if(!recordedBlob){ alert('No video recording available.'); return; }
    const t = recordedBlob.type || '';
    const ext = t.includes('webm') ? 'webm' : t.includes('mp4') ? 'mp4' : t.includes('quicktime') ? 'mov' : t.includes('ogg') ? 'ogv' : (recordedBlob.name && recordedBlob.name.split('.').pop()) || 'webm';
    const url = URL.createObjectURL(recordedBlob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extemp-speech-round-' + roundNo + '.' + ext;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Video downloaded');
  });

  document.getElementById('printBallotBtn').addEventListener('click', () => {
    closeAllExportMenus();
    window.print();
  });

  // ===== Share a round (Web Share API, with a real fallback instead of hiding the button) =====
  async function shareBallot({ title, text, filename, fileText }){
    let file = null;
    try{ file = new File([fileText], filename, {type:'text/plain'}); }catch(e){}
    const shareData = file ? { title, text, files: [file] } : { title, text };
    try{
      if(navigator.share){
        if(file && navigator.canShare && navigator.canShare(shareData)){
          await navigator.share(shareData);
        } else {
          await navigator.share({ title, text });
        }
        showToast('Shared');
        return;
      }
      throw new Error('no-share-api');
    }catch(e){
      if(e && e.name === 'AbortError') return; // user cancelled, no message needed
      // Fallback: copy a shareable summary to the clipboard instead
      try{
        await navigator.clipboard.writeText(text + '\n\n' + fileText);
        showToast('Sharing isn\'t supported here — copied to clipboard instead');
      }catch(e2){
        showToast('Could not share — try Download instead');
      }
    }
  }

  document.getElementById('shareRoundBtn').addEventListener('click', () => {
    closeAllExportMenus();
    const fileText = 'EXTEMPLARY — OFFICIAL PRACTICE BALLOT\nRound ' + roundNo + '\n' +
      (lastQuestion ? 'QUESTION: ' + lastQuestion + '\n\n' : '\n') +
      lastRawFeedback + factCheckPlainText(lastFactCheck) + '\n\n--- TRANSCRIPT ---\n\n' + lastTranscript;
    shareBallot({
      title: 'Extemplary — Round ' + roundNo,
      text: lastQuestion ? 'My extemp practice round: ' + lastQuestion : 'My extemp practice round',
      filename: 'extemp-ballot-round-' + roundNo + '.txt',
      fileText
    });
  });

  // ===== Example ballot: same export actions, using the example's static content =====
  function getExampleFeedbackText(){
    const el = document.getElementById('exampleResultsContent');
    return el ? el.innerText.trim() : '';
  }
  function getExampleTranscriptText(){
    const el = document.getElementById('exampleTranscriptBody');
    return el ? el.innerText.trim() : '';
  }
  const EXAMPLE_QUESTION = DATA.EXAMPLE_QUESTION;

  document.getElementById('exampleDownloadBtn').addEventListener('click', () => {
    closeAllExportMenus();
    const blob = new Blob([
      'EXTEMPLARY — OFFICIAL PRACTICE BALLOT (Example)\n',
      'QUESTION: ' + EXAMPLE_QUESTION + '\n\n',
      getExampleFeedbackText(),
      '\n\n--- TRANSCRIPT ---\n\n',
      getExampleTranscriptText()
    ], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extemp-ballot-EXAMPLE.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Ballot downloaded');
  });

  document.getElementById('exampleDownloadTranscriptBtn').addEventListener('click', () => {
    closeAllExportMenus();
    const blob = new Blob([getExampleTranscriptText()], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extemp-transcript-EXAMPLE.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Transcript downloaded');
  });

  document.getElementById('exampleCopyTranscriptBtn').addEventListener('click', async () => {
    closeAllExportMenus();
    const text = getExampleTranscriptText();
    if(!text){ showToast('No transcript available'); return; }
    try{
      await navigator.clipboard.writeText('EXTEMPLARY — SPEECH TRANSCRIPT (Example)\nQuestion: ' + EXAMPLE_QUESTION + '\n\n' + text);
      showToast('Transcript copied to clipboard');
    }catch(e){
      showToast('Could not copy — try Download instead');
    }
  });

  document.getElementById('exampleDownloadVideoBtn').addEventListener('click', () => {
    closeAllExportMenus();
    showToast('This is a sample round — opening the source video on YouTube');
    window.open('https://www.youtube.com/watch?v=lzoUu1fDmWE&t=20s', '_blank', 'noopener,noreferrer');
  });

  document.getElementById('exampleShareRoundBtn').addEventListener('click', () => {
    closeAllExportMenus();
    shareBallot({
      title: 'Extemplary — Example Ballot',
      text: 'A sample extemp practice round: ' + EXAMPLE_QUESTION,
      filename: 'extemp-ballot-EXAMPLE.txt',
      fileText: getExampleFeedbackText() + '\n\n--- TRANSCRIPT ---\n\n' + getExampleTranscriptText()
    });
  });

  document.getElementById('exampleExportPrintBtn').addEventListener('click', () => {
    closeAllExportMenus();
    window.print();
  });

  // ===== Export dropdown menus (round results + example) =====
  function setupExportMenu(btnId, panelId){
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if(!btn || !panel) return null;
    document.body.appendChild(panel); // escape .ballot's overflow:hidden clipping
    let open = false;
    function position(){
      const rect = btn.getBoundingClientRect();
      const width = Math.min(230, window.innerWidth - 24);
      panel.style.width = width + 'px';
      let left = rect.left;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      panel.style.left = left + 'px';
      let top = rect.bottom + 8;
      const estHeight = panel.offsetHeight || 260;
      if(top + estHeight > window.innerHeight - 12){
        top = Math.max(12, rect.top - estHeight - 8);
      }
      panel.style.top = top + 'px';
    }
    function show(){
      open = true;
      panel.classList.remove('hidden');
      position();
      btn.setAttribute('aria-expanded', 'true');
    }
    function hide(){
      open = false;
      panel.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if(open) hide(); else { closeAllExportMenus(); show(); }
    });
    document.addEventListener('click', (e) => {
      if(open && !e.target.closest('#' + panelId) && !e.target.closest('#' + btnId)){
        hide();
      }
    });
    window.addEventListener('resize', () => { if(open) position(); });
    window.addEventListener('scroll', () => { if(open) position(); }, true);
    return { hide, isOpen: () => open };
  }
  const exportMenus = [
    setupExportMenu('exportMenuBtn', 'exportMenuPanel'),
    setupExportMenu('exampleExportMenuBtn', 'exampleExportMenuPanel')
  ].filter(Boolean);
  function closeAllExportMenus(){
    exportMenus.forEach(m => m.hide());
  }

})();