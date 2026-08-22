const DATA = window.APP_DATA;
(function(){

  const SUPABASE_URL = 'https://iiehhmelfotwkdqxplug.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpZWhobWVsZm90d2tkcXhwbHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDYxMzEsImV4cCI6MjA5ODkyMjEzMX0.8QzN1LJmr70Sidxp2RsOq-z3S_NX5lN9QWTr45CSaHo';
  const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

  const supabaseClient = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  window.ExtemplarySupabase = supabaseClient;
  const VIDEO_BUCKET = 'ballot-videos';

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

  const RATE_CATEGORIES = [
    { key: 'ballot_feedback',   label: 'Ballot Feedback',              limit: 100 },
    { key: 'citation_checker',  label: 'Citation Checker',             limit: 40 },
    { key: 'question_generator',label: 'Practice Question Generator',  limit: 40 },
    { key: 'current_events',    label: 'Current Events Summary',       limit: 15 }
  ];
  const BALLOT_FEEDBACK_MODEL_WEIGHTS = {
    llama:      1,
    deepseekv4pro: 1,
    qwen38:     1,
    gemini37flash: 1,
    glm52:      1,
    kimik3:     3,
    opus5:      5
  };
  const BALLOT_FEEDBACK_USAGE_KEY = 'extemplary_bf_weighted_usage';
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function rateLimitFallback(category){
    const cat = RATE_CATEGORIES.find(c => c.key === category);
    const limit = cat ? cat.limit : null;
    const count = category === 'ballot_feedback' ? getWeightedBallotFeedbackUnits() : null;
    return { count, limit };
  }
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

  let currentUser = null;

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
      recordSource: (row.delivery_metrics && row.delivery_metrics.recordSource) || 'camera',
      isIntroDrill: !!(row.delivery_metrics && row.delivery_metrics.isIntroDrill),
      isBodyDrill: !!(row.delivery_metrics && row.delivery_metrics.isBodyDrill),
      isRoughDraft: !!(row.delivery_metrics && row.delivery_metrics.isRoughDraft),
      factCheck: (row.delivery_metrics && row.delivery_metrics.factCheck) || null
    }));
  }

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
    const deliveryMetricsWithSource = Object.assign({}, deliveryMetrics || {}, { recordSource: recordSource || 'camera', isIntroDrill: !!isIntroDrill, isBodyDrill: !!isBodyDrill, isRoughDraft: !!isRoughDraft, factCheck: factCheck || null });
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

  const GOAL_CATEGORIES = DATA.GOAL_CATEGORIES;
  function canonicalGoalCategory(rawName){
    if(!rawName) return null;
    const norm = s => s.toLowerCase().replace(/^\s*\d+[\.\)]\s*/, '').replace(/[—–-]/g,'-').replace(/\s+/g,' ').trim();
    const target = norm(rawName);
    const match = GOAL_CATEGORIES.find(c => norm(c) === target);
    return match || null;
  }
  const STREAK_MILESTONES = DATA.STREAK_MILESTONES;

  function dateKey(d){
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function keyToLocalDate(key){
    const [y,m,d] = key.split('-').map(Number);
    return new Date(y, m-1, d);
  }
  function activeDaysByDay(list, goals, events){
    const map = {};
    list.forEach(e => { map[dateKey(new Date(e.ts))] = true; });
    (goals||[]).forEach(g => {
      if(g.created_at) map[dateKey(new Date(g.created_at))] = true;
    });
    const anyGoalCompleteNow = (goals||[]).some(g => {
      if(g.type === 'streak') return false;
      return goalProgress(g, list, { current:0, best:0 }, events||[]).done;
    });
    if(anyGoalCompleteNow) map[dateKey(new Date())] = true;
    return map;
  }
  function computeStreak(list, goals, events){
    const byDay = activeDaysByDay(list, goals, events);
    const today = new Date(); today.setHours(0,0,0,0);
    let cursor = new Date(today);
    if(!byDay[dateKey(cursor)]) cursor.setDate(cursor.getDate()-1);
    let streak = 0;
    while(byDay[dateKey(cursor)]){
      streak++;
      cursor.setDate(cursor.getDate()-1);
    }
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
  function goalProgress(g, list, streakInfo, events){
    if(g.type === 'streak'){
      const cur = Math.min(streakInfo.current, g.params.days);
      return { current: streakInfo.current, target: g.params.days, pct: Math.min(100, cur/g.params.days*100), done: streakInfo.current >= g.params.days };
    }
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
        if(g.type === 'rounds') return true;
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

  function computeSuggestedGoals(list, goals, events){
    if(!list.length) return [];
    const rows = computeTrends(list);
    if(!rows.length) return [];
    const totals = list.map(e=>e.total).filter(t=>t!==null&&t!==undefined);
    const avgTotal = totals.length ? totals.reduce((a,b)=>a+b,0)/totals.length : 0;
    const bestTotal = totals.length ? Math.max(...totals) : 0;
    const streakInfo = computeStreak(list, goals, events);

    const bestPctByCategory = {};
    list.forEach(e => (e.categories||[]).forEach(c => {
      const pct = (c.score/(c.max||10))*100;
      const canon = canonicalGoalCategory(c.name);
      if(!canon) return;
      if(!(canon in bestPctByCategory) || pct > bestPctByCategory[canon]) bestPctByCategory[canon] = pct;
    }));

    const existingCategoryGoals = new Set(
      goals.filter(g => g.type === 'category' && g.params).map(g => g.params.category)
    );
    const canonicalRows = rows
      .map(r => ({ ...r, canonicalName: canonicalGoalCategory(r.name) }))
      .filter(r => r.canonicalName && !existingCategoryGoals.has(r.canonicalName));
    const weakest = canonicalRows[canonicalRows.length-1];
    const secondWeakest = canonicalRows.length > 1 ? canonicalRows[canonicalRows.length-2] : null;

    function categorySuggestion(row){
      const bestPct = bestPctByCategory[row.canonicalName] || row.avgPct;
      const threshold = Math.min(95, Math.max(Math.round(row.avgPct + 15), Math.round(bestPct) + 5));
      return {
        type:'category', params:{ category: row.canonicalName, threshold },
        why: `Your weakest area across your ballots is ${row.canonicalName} (avg ${row.avgPct.toFixed(0)}%, best ${bestPct.toFixed(0)}%). This target is above your personal best there.`
      };
    }

    const candidates = [];

    if(weakest) candidates.push(categorySuggestion(weakest));

    const existingScoreThresholds = goals.filter(g => g.type === 'score' && g.params).map(g => g.params.threshold);
    const maxExistingScoreThreshold = existingScoreThresholds.length ? Math.max(...existingScoreThresholds) : 0;
    const scoreThreshold = Math.min(100, Math.max(Math.round(avgTotal/5)*5 + 10, Math.round(bestTotal) + 5, maxExistingScoreThreshold + 5));
    if(scoreThreshold <= 100 && scoreThreshold > bestTotal){
      candidates.push({
        type:'score', params:{ threshold: scoreThreshold },
        why: `Your average overall score is ${avgTotal.toFixed(0)}/100 and your best is ${bestTotal.toFixed(0)}/100. This pushes past your personal best.`
      });
    }

    const existingStreakDays = goals.filter(g => g.type === 'streak' && g.params).map(g => g.params.days);
    const maxExistingStreakDays = existingStreakDays.length ? Math.max(...existingStreakDays) : 0;
    const nextMilestone = STREAK_MILESTONES.find(m => m > Math.max(streakInfo.current, maxExistingStreakDays));
    if(nextMilestone){
      candidates.push({
        type:'streak', params:{ days: nextMilestone },
        why: streakInfo.current > 0
          ? `You're on a ${streakInfo.current}-day streak already, keep it going.`
          : `Building a short streak, recording a ballot, setting a goal, or hitting one, is the fastest way to build the habit.`
      });
    }

    const now = new Date();
    const roundsThisMonth = list.filter(e => {
      const d = new Date(e.ts);
      return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
    }).length;
    const existingRoundsCounts = goals.filter(g => g.type === 'rounds' && g.params).map(g => g.params.count);
    const maxExistingRoundsCount = existingRoundsCounts.length ? Math.max(...existingRoundsCounts) : 0;
    const roundsTarget = Math.max(roundsThisMonth + 3, maxExistingRoundsCount + 3, 5);
    candidates.push({
      type:'rounds', params:{ count: roundsTarget },
      why: `You've completed ${roundsThisMonth} practice round${roundsThisMonth===1?'':'s'} this month. This builds a more consistent habit.`
    });

    if(secondWeakest){
      const s = categorySuggestion(secondWeakest);
      s.why = `${secondWeakest.canonicalName} is also trending as a recurring weak spot (avg ${secondWeakest.avgPct.toFixed(0)}%).`;
      candidates.push(s);
    }

    const chosen = [];
    const usedTypes = new Set();
    candidates.forEach(c => {
      if(chosen.length < 3 && !usedTypes.has(c.type)){ chosen.push(c); usedTypes.add(c.type); }
    });
    if(chosen.length < 3){
      candidates.forEach(c => { if(chosen.length < 3 && !chosen.includes(c)) chosen.push(c); });
    }
    return chosen;
  }

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
    const MAX_X_LABELS = 10;
    const labelStep = Math.max(1, Math.ceil(n / MAX_X_LABELS));
    const xGrid = xLabels.map((r,i) => {
      const x = xForI(i);
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

  let historyTrendsMode = 'all';
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

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.querySelectorAll('.trend-bar').forEach(bar => { bar.style.width = bar.dataset.w + '%'; });
        });
      });

      const modeSel = document.getElementById('historyModeFilter');
      if(modeSel){
        modeSel.addEventListener('change', () => { historyTrendsMode = modeSel.value; paintPanel(); });
      }

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
  async function refreshOverallFeedback(listDesc){
    if(!currentUser || !supabaseClient || !listDesc.length) { renderOverallFeedbackBox(null); return; }
    const asc = [...listDesc].sort((a,b) => a.ts - b.ts);
    const n = asc.length;
    let existing = null;
    try{ existing = await loadOverallFeedback(); }catch(e){  }
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
            attachCommentListeners(t, ()=>{});
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
    window.location.href = 'landingsite.html';
  }

  (async function initAuth(){
    const params = new URLSearchParams(window.location.search);
    const previewRequested = params.get('preview') === 'example';

    if(!supabaseClient){
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

  (function setupSideWords(){
    const leftInner  = document.getElementById('sideWordsLeftInner');
    const rightInner = document.getElementById('sideWordsRightInner');
    const leftGlowInner  = document.getElementById('sideWordsLeftGlowInner');
    const rightGlowInner = document.getElementById('sideWordsRightGlowInner');
    const leftGlow  = document.getElementById('sideWordsLeftGlow');
    const rightGlow = document.getElementById('sideWordsRightGlow');
    if(!leftInner || !rightInner) return;
    const WORDS = DATA.WORDS;

    function randomLineText(wordList){
      const count = 2 + Math.floor(Math.random() * 3);
      const pool = wordList.slice();
      const picked = [];
      for(let k = 0; k < count && pool.length; k++){
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(idx, 1)[0]);
      }
      return picked.join('\u00A0\u00A0\u00A0');
    }

    function fillColumn(container, glowContainer, wordList, spacing){
      const totalHeight = container.offsetHeight || (window.innerHeight * 4);
      const count = Math.ceil(totalHeight / spacing);
      for(let i=0;i<count;i++){
        const span = document.createElement('div');
        span.className = 'side-word';
        const text = randomLineText(wordList);
        span.textContent = text;
        span.style.top = (i * spacing + 40) + 'px';

        const direction = (i % 2 === 0) ? 'alternate' : 'alternate-reverse';
        const duration = 18 + (i % 5) * 3;
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
  const GPT_OSS_RUBRIC_CAT1 = DATA.GPT_OSS_RUBRIC_CAT1;
  const GPT_OSS_RUBRIC_CAT2 = DATA.GPT_OSS_RUBRIC_CAT2;
  const GPT_OSS_RUBRIC_CAT3 = DATA.GPT_OSS_RUBRIC_CAT3;
  const GPT_OSS_RUBRIC_CAT4 = DATA.GPT_OSS_RUBRIC_CAT4;
  const GPT_OSS_RUBRIC_CAT5 = DATA.GPT_OSS_RUBRIC_CAT5;
  const GPT_OSS_RUBRIC_CAT6 = DATA.GPT_OSS_RUBRIC_CAT6;
  const GPT_OSS_RUBRIC_CAT7 = DATA.GPT_OSS_RUBRIC_CAT7;
  const GPT_OSS_RUBRIC_CAT8 = DATA.GPT_OSS_RUBRIC_CAT8;
  const GPT_OSS_RUBRIC_SYNTHESIS = DATA.GPT_OSS_RUBRIC_SYNTHESIS;
  const ROUGHDRAFT_PIPELINE_PHRASES = DATA.ROUGHDRAFT_PIPELINE_PHRASES || { judging: [] };

  const ANNOTATION_PROMPT = DATA.ANNOTATION_PROMPT;
  const INTRO_ANNOTATION_PROMPT = DATA.INTRO_ANNOTATION_PROMPT;
  const BODY_ANNOTATION_PROMPT = DATA.BODY_ANNOTATION_PROMPT;

  const CIRCLE_PATH = DATA.CIRCLE_PATH;

  const DEFAULT_SIGNALS = DATA.DEFAULT_SIGNALS;

  let stream = null;
  let cameraStream = null;
  let captureStream = null;
  let captureMode = 'camera';
  let recorder = null;
  let chunks = [];
  let recordedBlob = null;
  let recordedMime = 'video/webm';
  let timerInterval = null;
  let elapsedSeconds = 0;
  let roundNo = 1;
  let flightHistory = [];
  let lastTranscript = '';
  let pipelineAbortController = null;
  let lastTranscriptAnnotations = null;
  let lastFactCheck = null;
  let lastRawFeedback = '';
  let lastQuestion = '';
  let lastDeliveryMetrics = null;
  let roughDraftTranscriptText = '';
  let lastWordTimestamps = [];
  let wordTokenSpans = [];
  let resultsVideoURL = null;
  let activeWordSpanEl = null;
  let autoScrollToWordEnabled = true;
  let lastProgrammaticScrollAt = 0;
  function suspendAutoScrollToWord(){
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
  let editingIndex = -1;

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

  function createProgressController(fillEl, phraseEl, colorFn){
    let target = 0, current = 0, raf = null, phraseTimer = null, phrases = [], phraseIdx = 0;
    function paint(){
      fillEl.style.width = current.toFixed(1) + '%';
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
      setStage(pct, stagePhrases){
        if(Number.isFinite(pct)) target = Math.max(target, pct);
        if(stagePhrases){
          phrases = stagePhrases;
          phraseIdx = 0;
          showPhrase(0);
        }
      },
      finish(){
        target = 100; current = 100; paint();
        if(raf) cancelAnimationFrame(raf);
        if(phraseTimer) clearInterval(phraseTimer);
      },
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

  const PROC_STEP_ORDER = ['audio', 'transcribe', 'delivery', 'judging', 'annotate', 'factcheck'];
  const PROC_STEP_DEFAULT_LABELS = {
    audio: 'Audio', transcribe: 'Transcription', delivery: 'Delivery',
    judging: 'Judging', annotate: 'Notes', factcheck: 'Verify'
  };
  const PROC_STEP_PHASE_NAMES = {
    audio: 'Prepping Audio', transcribe: 'Transcribing Testimony', delivery: 'Analyzing Vocal Delivery',
    judging: 'Panel Deliberating', annotate: 'Annotating Transcript', factcheck: 'Verifying Evidence'
  };
  const procTimeline = document.getElementById('procTimeline');
  const procPhaseLabel = document.getElementById('procPhaseLabel');
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
  const cancelBallotBtn = document.getElementById('cancelBallotBtn');
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
  const sessionDateLabel = document.getElementById('sessionDateLabel');
  if(sessionDateLabel){
    sessionDateLabel.textContent = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  }
  const flightStripResults = document.getElementById('flightStripResults');
  const resultsContent = document.getElementById('resultsContent');
  const transcriptBody = document.getElementById('transcriptBody');
  const commentPopover = document.getElementById('commentPopover');
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
  const modelPicker      = document.getElementById('modelPicker');
  const modelPickerBtn   = document.getElementById('modelPickerBtn');
  const modelPickerLabel = document.getElementById('modelPickerLabel');
  const modelPickerMenu  = document.getElementById('modelPickerMenu');
  const JUDGE_MODEL_KEY = 'extemplary_judge_model';
  const TIER_PROFILES = {
    fast:    { reasoningEffort: 'low', maxRounds: 4,  maxTokensPerRound: 24000, roundDelayMs: 500 },
    verbose: { reasoningEffort: 'low', maxRounds: 10, maxTokensPerRound: 32000, roundDelayMs: 600 },
    premium: { reasoningEffort: null,  maxRounds: 12, maxTokensPerRound: 32000, roundDelayMs: 1000 },
  };
  const JUDGE_MODELS = {
    llama:    { fn: 'groq-chat',     model: 'openai/gpt-oss-120b',       label: 'GPT-OSS 120B' },
    opus5:    { fn: 'hackclub-chat', model: 'anthropic/claude-opus-5',   label: 'Claude Opus 5', tier: 'premium' },
    kimik3:   { fn: 'hackclub-chat', model: 'moonshotai/kimi-k3',        label: 'Kimi K3', tier: 'fast' },
    deepseekv4pro: { fn: 'hackclub-chat', model: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', tier: 'verbose' },
    qwen38:   { fn: 'hackclub-chat', model: 'qwen/qwen3.8-2.4t-a95b',     label: 'Qwen3.8 2.4T A95B', tier: 'fast' },
    gemini37flash: { fn: 'gemini-generate', model: 'gemini-3.7-flash',   label: 'Gemini 3.7 Flash', tier: 'fast' },
    glm52:    { fn: 'nvidia-chat',   model: 'z-ai/glm-5.2',              label: 'GLM 5.2', tier: 'fast' }
  };
  const STREAMING_JUDGE_FNS = new Set(['hackclub-chat', 'nvidia-chat']);
  let judgeModelValue = 'llama';
  function extractChatContent(json){
    if(!json) return '';
    const asText = (v) => {
      if(typeof v === 'string') return v.trim();
      if(Array.isArray(v)){
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
  function extractGeminiContent(json){
    if(!json) return '';
    const candidate = json.candidates?.[0];
    if(!candidate) return '';
    return (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
  }
  async function readHackClubStream(res){
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let needsContinuation = false;
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
        if(typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      }
    };
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n');
      buffer = lines.pop();
      consumeLines(lines.join('\n'));
    }
    buffer += decoder.decode();
    if(buffer) consumeLines(buffer);
    return { text: text.trim(), reasoning: reasoning.trim(), needsContinuation };
  }
  const RUBRIC_CATEGORY_NAMES = [
    'Creative Hook & Intro','Structure','Strength of Argument & Analysis',
    'Flaws in Reasoning','Strength of Evidence','Clarity',
    'Conclusion Strength','Speech Quality'
  ];
  const CONTINUATION_TAIL_CHARS = 6000;
  async function runHackClubChatToCompletion(doFetch, messages, onRound, tierProfile){
    const MAX_ROUNDS = (tierProfile && tierProfile.maxRounds) || 6;
    const ROUND_DELAY_MS = (tierProfile && tierProfile.roundDelayMs) != null ? tierProfile.roundDelayMs : 800;
    let fullText = '';
    let fullReasoning = '';
    let currentMessages = messages;
    for(let round = 0; round < MAX_ROUNDS; round++){
      if(typeof onRound === 'function'){ try{ onRound(round + 1); }catch(e){} }
      if(round > 0) await new Promise(r => setTimeout(r, ROUND_DELAY_MS));
      const res = await doFetch(currentMessages);
      const { text, reasoning, needsContinuation } = await readHackClubStream(res);
      const prevEndsWithBlankLine = /\n\s*\n\s*$/.test(fullText) || fullText === '';
      const nextLooksLikeHeaderStart = /^\s*(#{1,6}\s|\*\*[A-Z0-9])/.test(text);
      fullText += (fullText && !prevEndsWithBlankLine && nextLooksLikeHeaderStart) ? ('\n\n' + text) : text;
      fullReasoning += reasoning;
      const looksComplete = /composite score/i.test(fullText);
      if(!needsContinuation && looksComplete) return fullText.trim() || fullReasoning.trim();
      if(!needsContinuation && round === MAX_ROUNDS - 1) return fullText.trim() || fullReasoning.trim();
      const covered = RUBRIC_CATEGORY_NAMES.filter(name => fullText.includes(name));
      const tail = fullText.length > CONTINUATION_TAIL_CHARS
        ? '…(earlier categories omitted here to save tokens — see the "already covered" list above; they are already complete, do not rewrite them)…\n\n' + fullText.slice(-CONTINUATION_TAIL_CHARS)
        : fullText;
      currentMessages = [
        messages[0],
        { role:'user', content:
          messages[1].content
          + '\n\n---\n\nYou already began writing this ballot below but stopped before it was actually finished. Continue writing IMMEDIATELY after the partial content shown below, in the exact same format. Do NOT repeat, restate, quote, or re-include any of the partial content shown below in your reply — your reply should contain ONLY new content that picks up exactly where the partial content stops (mid-sentence if needed), through to the fully finished ballot (including the Composite Score, Judge\'s Rank, and Feedback section). If the partial content cuts off mid-sentence or mid-word, your reply must begin with the rest of that exact sentence/word — plain continuation text, NOT a new "### Header" or "**Bold Label:**" line. Only start a new "### Category Name" header if the partial content already ended cleanly at the close of a full category (i.e. right after that category\'s "What You Could Have Done" section) — never place a header directly against trailing text with no blank line before it.'
          + (covered.length ? ('\n\nCategories already fully covered in earlier rounds (do not redo these): ' + covered.join(', ') + '.') : '')
          + '\n\n=== PARTIAL BALLOT ALREADY WRITTEN (do not repeat any of this) ===\n' + tail
        }
      ];
    }
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
    if(v !== viewAiCompare && typeof aiCompareOpen !== 'undefined' && aiCompareOpen){
      aiCompareOpen = false;
      document.getElementById('aiCompareToggle')?.classList.remove('active');
    }
    document.getElementById('streakToggle')?.classList.toggle('active', v === viewStreak);
    document.querySelector('.nav-menu-item[data-target="historyToggle"]')?.classList.toggle('active', v === viewHistory);
    document.getElementById('navHomeBtn')?.classList.toggle('active', v === viewRecord);
  }

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

  function fmt(s){
    return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
  }

  function tickTimer(){
    elapsedSeconds++;
    clockPill.textContent = fmt(elapsedSeconds);
    clockPill.classList.remove('warn','over');

    if(introDrillMode){
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
      stopRecording();
      return;
    }

    if(elapsedSeconds >= 420){
      clockPill.classList.add('over');
      if(elapsedSeconds === 420) fireSignalOverlay('⚠ Overtime Warning', fmt(elapsedSeconds), '7 Minutes — Hard stop in 30 seconds', '', '#a3322a');
    } else if(elapsedSeconds >= 360){
      clockPill.classList.add('warn');
    }

    if(elapsedSeconds === 450){
      fireSignalOverlay('⏹ Time Expired', '7:30', 'Recording stopped automatically', '', '#a3322a');
    }

    timeSignals.forEach(sig => {
      if(elapsedSeconds === sig.seconds){
        fireSignalOverlay('Time Signal', fmt(sig.seconds), sig.label, '', sig.color);
      }
    });
  }

  function fireSignalOverlay(label, timeStr, sub, warn, color){
    clearTimeout(overlayTimeout);
    overlayLabel.textContent = label;
    overlayTime.textContent = timeStr;
    overlayTime.style.color = color || '#fff';
    overlaySub.textContent = sub;
    overlayWarn.textContent = warn;
    overlayCard.style.borderColor = color || '#fff';
    signalOverlay.classList.add('visible');
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

  const uploadVideoBtn   = document.getElementById('uploadVideoBtn');
  const uploadVideoInput = document.getElementById('uploadVideoInput');
  const uploadError      = document.getElementById('uploadError');

  let questionMode = null;
  let lastGenCategory = null;

  let practiceMode = 'regular';
  let introDrillMode = false;
  let bodyDrillMode = false;
  let roughDraftMode = false;
  const INTRO_PREP_SECONDS = 5 * 60;
  const INTRO_RECORD_CAP_SECONDS = 65;
  const BODY_PREP_SECONDS = 10 * 60;
  const BODY_RECORD_CAP_SECONDS = 125;
  const REGULAR_PREP_SECONDS = 30 * 60;
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
    if(recorder && recorder.state === 'recording') return;
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
    roughDraftPrepPhrase.classList.add('hidden');
    roughDraftPrepModal.classList.remove('hidden');
  }

  const QUESTION_EXAMPLES = DATA.QUESTION_EXAMPLES;
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

  ['qModeChangeFromCustom','qModeChangeFromCat','qModeChangeFromPick','qModeChangeFromConfirmed'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', (e) => { e.preventDefault(); setQuestionMode(null); });
  });

  document.querySelectorAll('.q-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if(qGenBusy) return;
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
    if(qGenBusy) return;
    if(lastGenCategory) generateQuestions(lastGenCategory, lastGenDifficultyIdx);
  });

  let qGenBusy = false;
  const Q_GEN_COOLDOWN_MS = 20000;

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
      qGenBusy = true;
      btns.forEach(b => { if(b){ b.style.pointerEvents = 'none'; b.style.opacity = '0.5'; } });
      setTimeout(() => setQGenBusy(false, 0), cooldownMs);
    }
  }

  const GEMINI_MODEL = 'gemini-3.7-flash';

  function geminiKeyList(){
    return [];
  }

  async function callGeminiWithKey(prompt, apiKey, maxOutputTokens, category){
    const extSignal = pipelineAbortController && pipelineAbortController.signal;
    if(extSignal && extSignal.aborted){
      const cancelErr = new Error('pipeline_cancelled');
      cancelErr.name = 'AbortError';
      cancelErr.pipelineCancelled = true;
      throw cancelErr;
    }
    let res;
    try{
      res = await fetch(`${SUPABASE_FUNCTIONS_URL}/gemini-generate`, {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':'Bearer '+(await getAuthToken()),
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ prompt, maxOutputTokens: maxOutputTokens||1024, overrideKey: apiKey || undefined, category }),
        signal: extSignal || undefined
      });
    }catch(err){
      if(err.name === 'AbortError'){
        const cancelErr = new Error('pipeline_cancelled');
        cancelErr.name = 'AbortError';
        cancelErr.pipelineCancelled = true;
        throw cancelErr;
      }
      throw err;
    }
    if(res.status === 429){
      const { info, isRealQuotaBlock, fallback } = await readRateLimitInfo(res, category);
      if(window.RateLimitUI) window.RateLimitUI.refresh();
      if(isRealQuotaBlock){
        const err = new Error('rate_limited');
        err.rateLimited = true; err.category = info.category || category;
        err.count = info.currentCount ?? fallback.count; err.limit = info.usageLimit ?? fallback.limit;
        throw err;
      }
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

  let bfTiming = null;
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

  async function runFactCheckPass(transcript){
    if(!transcript || !transcript.trim()) return { claims: [], failed: false };
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      try{
        const candidate = await callGemini(buildFactCheckPrompt(transcript), 6000, 'citation_checker');
        return { claims: extractFactCheckClaims(candidate), failed: false };
      }catch(e){
        lastErr = e;
        if(e && e.pipelineCancelled) throw e;
        if(e && e.rateLimited) break;
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
    const q = requireQuestion();
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
    uploadVideoInput.value = '';
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
    const q = requireQuestion();
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
      const vTrack = captureStream.getVideoTracks()[0];
      if(vTrack) vTrack.addEventListener('ended', revertToCamera);
    }catch(e){
      captureError.textContent = 'Tab/screen sharing was cancelled or blocked — allow the share prompt to capture the video.';
      captureError.classList.remove('hidden');
    }
  });

  stopCaptureBtn.addEventListener('click', revertToCamera);

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

  const shortcutsToggle = document.getElementById('shortcutsToggle');
  const shortcutsPanel  = document.getElementById('shortcutsPanel');
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

  const AI_MODEL_EXAMPLE_BALLOTS = {
    opus5: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n**What Worked:**\n1) The AGD is genuinely original rather than a recycled quote or statistic \u2014 the mispronunciation runner (\"One cable pundit called her Alessandra Oxycontin\") is memorable and topical, and the Lou Dobbs aside (\"the paradigm of journalistic integrity\") lands sarcasm without editorializing at length.\n2) The link is one of the tightest I've heard from an AGD of this type: the pivot from \"we commonly know her as AOC\" to \"there are three letters also attached to her name, GND\" converts the joke's own mechanic \u2014 letters and names \u2014 into the topic. That's a structural link, not a bolted-on one.\n3) The thesis is explicit and flowable: \"The answer simply is that it will serve as the bedrock for future environmental legislation.\" A judge can write that down in one line.\n4) The intro establishes genuine background stakes with dated evidence rather than asserting urgency \u2014 The Atlantic, June 12, 2019 on the \"14-page white paper congressional resolution,\" plus the New Consensus policy-agenda-by-2020 detail, gives the round real orientation.\n**Critical Flaws:**\n1) The preview breaks its own numbering. You say \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally...\" \u2014 the second point is marked with \"more broadly,\" not \"second,\" which forces a judge to guess whether that's a new main point or a subpoint of point one.\n2) The intro is severely bloated at ~23% of the speech (see Structure timing) largely because of a digression that does no work: \"We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world.\" Sudan and Yemen are never mentioned again, and the sentence implies a hierarchy of suffering you neither defend nor need.\n3) The Scientific American statistic is orphaned: \"emissions rose by 3.8%\" \u2014 over what period, in what country, from what baseline? As delivered, a judge cannot tell whether that's global 2018 CO2 or U.S. power-sector emissions, which drains the number of impact.\n**What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation. Second, by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. ~~We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world.~~ And that's exactly why for everyone in this room, we have to ask today's question.\"\n3) \"...that U.S. carbon emissions rose by 3.8% in 2018 alone \u2014 the sharpest single-year jump in eight years, and all of it after we walked away from Paris.\"\n\n### Structure - 8/10\n**What Worked:**\n1) Every skeletal element is present and correctly sequenced: single AGD, link, thesis, three-point preview, three bodies, conclusion. Nothing is blurred or missing.\n2) Each body point opens with its own mini-attention-getter before the signpost \u2014 the nickel joke (\"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\"), the \"the climate movement is right, they're also very white\" line, and the IPCC deadpan (\"sat very apathetically at a table much like yours and said, we're all going to die\"). This is an advanced stylistic pattern that keeps energy from sagging at each seam.\n3) The body 2\u2192body 3 transition is explicitly signposted and hierarchical: \"Finally, and perhaps most importantly,\" which matches the preview's own language and tells the judge exactly where they are.\n4) The conclusion does more than summarize \u2014 the \"Y-E-A\" close is a deliberate echo of the AGD's three-letters mechanic, not a generic restatement.\n**Critical Flaws:**\n1) The body 1\u2192body 2 transition signposts position but supplies no logical bridge: \"Secondly, we have to look more broadly to the question of environmental justice.\" Nothing connects Republican counterproposals to justice \u2014 the two points sit adjacent rather than building.\n2) The AGD's throughline goes silent through the entire middle of the speech. The AOC framing resurfaces once in body 3 (\"Alexandria Ocasio-Cortez's accessibility with it\"), but the mispronunciation gag \u2014 the actual hook \u2014 never returns until the final ten seconds, so the callback structure is start-and-end only.\n3) TIMING BREAKDOWN (word-count-based, mapped onto the 470s recording): Introduction: ~23%, approximately 109s. Body 1: ~26%, approximately 122s. Body 2: ~24%, approximately 114s. Body 3: ~20%, approximately 95s. Conclusion: ~6%, approximately 30s. Against the 14/26/26/26/7 benchmark, the intro runs nearly 9 points hot (~45 extra seconds of background) while body 3 runs 6 points light. The competitive cost is directly visible: body 3 is where you needed to argue that the GND supplies the mechanism Paris lacks, and you never had the time to do it.\n4) The conclusion's \"So What?\" is a joke, not a resolution. \"AOC might have a complicated name, but there are only three letters we need to learn... Y-E-A\" is charming, but it delivers no final insight about why a bedrock resolution matters to the judge in the room.\n**What You Could Have Done:**\n1) \"Secondly, we have to look more broadly to the question of environmental justice \u2014 because forcing Republicans to the table only matters if what's on the table reaches the people already breathing the consequences.\"\n2) \"...but Alexandria Ocasio-Cortez's accessibility with it is the point: the same name cable news can't pronounce is now the name European candidates campaign on.\"\n3) Move roughly 40 seconds from the intro's Paris/New Consensus background into body 3, and add: \"The problem with Paris is it proposes a goal... with no actual mechanism on how to get there. The Green New Deal's answer is the mechanism itself \u2014 binding federal procurement, jobs, and infrastructure spending to the target, which is precisely what the candidates in Spain and Sweden are borrowing.\"\n4) \"...there are only three letters we need to learn about the Green New Deal. Y-E-A. Because a resolution that never becomes law can still become the floor every future bill is measured against \u2014 and that floor is the difference between a goal and a plan.\"\n\n### Strength of Argument & Analysis - 11/16\n**What Worked:**\n1) Point 1's core claim \u2014 that the GND forces bipartisan action \u2014 is the best-argued of the three because it uses the strongest available proof type: not opinion, but Republican counterproposals. \"Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal\" is exactly the observable behavioral evidence the claim requires.\n2) Point 1 traces a complete Evidence \u2192 Warrant \u2192 Impact chain. Evidence: Romney's 2011 agnosticism and the absence of any GOP climate plan in 2016. Warrant: the WaPo polling shift (64% / 45%) plus Politico's \"finally forcing Republicans to listen.\" Impact: GOP counter-bills exist now. That's a real argument, and the before/after contrast structure is what makes it land.\n3) Point 2's analysis does clear the \"So What?\" bar in one specific place. After the Guardian's 1.6 million-near-an-incinerator figure, you don't drop and run \u2014 you explain the legislative consequence: \"In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies.\" That's the mechanism connecting harm to policy design.\n4) Point 3 correctly identifies the right gap in the international status quo \u2014 \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there.\" Diagnosing Paris as aspiration-without-enforcement is a sophisticated framing that sets up a strong point.\n**Critical Flaws:**\n1) Point 1 sabotages its own warrant and never repairs it. You concede \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal.\" You have just admitted the confound \u2014 public opinion \u2014 and then asserted GND causation with the word \"also\" doing all the analytical work. The missing \"So What?\" is a disentangling mechanism: you needed to note that Gaetz named his bill the \"Green Real Deal,\" a direct rhetorical derivative, and that Alexander framed his Manhattan Project explicitly as an alternative to the Green New Deal, meaning the resolution is functioning as the agenda-setting document even for its opponents. Without that step, the point proves \"Republicans are responding to polling\" \u2014 which is a claim about public opinion, not about the GND's influence.\n2) Point 2 proves something adjacent to the thesis, not the thesis. The claim is that the GND democratizes environmental legislation through environmental justice. But the Guardian evidence \u2014 \"1.6 million Americans live near a trash incinerator... higher rates of asthma and maternal mortality\" \u2014 establishes that harm exists, not that the GND changed how legislation gets written. The Illinois bill is then asserted as downstream of the GND with the phrase \"in the state of Illinois this led to an equity environmental Justice Bill being passed,\" where \"this\" carries the entire causal burden and no mechanism is offered. The missing warrant: that Illinois legislators explicitly modeled the equity-hiring provisions on the GND's justice language, which is what would make it influence rather than coincidence.\n3) Point 3's own evidence undercuts its claim. You argue the GND creates \"a new unified global paradigm,\" then cite the New York Times to say \"the Green New Deal has been around before the United States proposed it in 2018. It came from the UK.\" That concession means the global paradigm predates AOC's resolution, so the U.S. document is a follower, not the origin \u2014 and you never resolve it beyond the assertion that her \"accessibility with it\" globalized it. Additionally, \"candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" is evidence about campaign platforms, not enacted or drafted legislation, so it does not touch the question's word \"legislation.\"\n4) The strongest opposing argument is raised as a punchline and then abandoned. \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\" is the only acknowledgment of the cost objection in the entire speech, and it is played for laughs. The fairness test fails: the serious opposing view is that the GND's price tag and its non-environmental riders (jobs guarantee, universal health care) are precisely what make it unusable as a bipartisan template \u2014 the 57-0 Senate procedural vote is the obvious counter-datum. You needed to answer that, especially since point 1's whole claim is bipartisanship.\n5) The impact statement in point 2 is an assertion where an analysis belongs. \"Those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that\" substitutes superlative for reasoning. Nothing in the Vox evidence shows marginalized communities becoming \"the most advantaged\" \u2014 it shows a hiring focus in a solar buildout. The missing step: explaining that once equity-hiring language is written into a state statute, it becomes a drafting precedent other states copy, which is the actual influence-on-future-legislation link.\n**Verdict: MODERATE.** Point 1 is genuinely strong; points 2 and 3 are rhetorically vivid but each proves an adjacent claim rather than the thesis.\n**What You Could Have Done:**\n1) \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal \u2014 and you can see the fingerprints: Gaetz didn't name his bill the Clean Future Act, he named it the Green Real Deal, and Alexander pitched his Manhattan Project as the conservative answer to it. Republicans are now drafting in the Green New Deal's vocabulary.\"\n2) \"...in the state of Illinois this led to an equity environmental Justice Bill being passed \u2014 and Vox notes the sponsors lifted the equity-hiring language directly from the resolution's justice provisions, which is how a non-binding federal document ends up as binding state text.\"\n3) \"It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it the standardized version \u2014 the UK had the idea, the U.S. resolution gave the world the 14-page template, and that's why Spanish and Swedish parties are drafting from it rather than reinventing it.\"\n4) \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. And yes, that number is why the Senate killed it 57 to nothing \u2014 but resolutions aren't priced, they're borrowed from, and Republicans borrowing from it while voting against it is exactly the influence we're measuring.\"\n5) \"...those who have been the most marginalized by our pollution are now written into the statute rather than mentioned in the preamble \u2014 and once equity-hiring language survives one state legislature, it becomes the drafting default for the next twenty.\"\n\n### Flaws in Reasoning - 8/12\n**What Worked:**\n1) The Paris critique is a legitimately valid inference rather than a rhetorical leap: \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" identifies a structural defect (aspiration without enforcement) and does not overclaim beyond it.\n2) You resist the slippery-slope temptation that dominates climate extemp. The before/after GOP framing \u2014 Romney's 2011 agnosticism versus Alexander's and Gaetz's 2019 bills \u2014 stays proportionate to the cited polling and never escalates into \"and therefore the GND will pass.\"\n3) The internal terminology holds steady: \"bedrock for future environmental legislation\" is the thesis in the intro, is restated as \"part of a way to guide future climate debate\" in body 1, and returns as \"fundamental bedrock\" in the conclusion. No mid-speech definition shift.\n**Critical Flaws:**\n1) Correlation asserted as causation, self-admitted \u2014 the speech's most damaging flaw. \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal.\" You name the rival explanation (popularity) and then dismiss it with \"also.\" Worse, your own Washington Post data supplies the confound: if \"Republicans, now 64%, believe that climate change is a severe threat,\" then GOP legislators had constituent pressure to respond regardless of the GND. Severity: undermines the whole of point 1, which is otherwise your best point.\n2) Equivocation between air pollution and climate change. \"1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality... In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators.\" Incinerator particulates cause asthma; greenhouse warming does not double local asthma rates. You are treating two distinct harms as one to make the climate frame reach the health data. Severity: undermines the evidentiary basis of point 2, because the entire justice argument rests on climate policy being the correct instrument for that harm.\n3) Post hoc ergo propter hoc on the Illinois bill. \"in the state of Illinois this led to an equity environmental Justice Bill being passed.\" The resolution appeared in November 2018; the Vox article is March 2019; temporal sequence is doing the work of causal proof, with no sponsor statement, no borrowed language, no legislative history. Severity: undermines the only piece of point 2 that actually speaks to \"future legislation.\"\n4) Straw man of the IPCC. \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die.\" No IPCC report says that; you have replaced a probabilistic finding with a cartoon so the \"global apathy\" framing has something to sit on. It is also uncited, which compounds it. Severity: moderate soft spot \u2014 it damages credibility at the top of point 3 without breaking the point's logic.\n5) Internal contradiction between points 1 and 2. Point 1 argues the GND's value is that it drags Republicans toward \"bipartisan solutions like a carbon tax.\" Point 2 then celebrates the GND for containing \"a jobs guarantee, universal health care.\" Those are the exact provisions that make the resolution non-negotiable for the Gaetz/Alexander wing you just credited it with recruiting. You never reconcile the two, so the speech simultaneously praises the GND for being palatable and for being maximalist. Severity: significant \u2014 a strong opposing speaker exploits this in cross-examination-style rebuttal instantly.\n6) Hyperbole substituting for impact. \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\" and \"a world where we're not swimming all the time\" replace a real magnitude claim with a gag. Severity: minor, but it costs you the conclusion's payload.\n**What You Could Have Done:**\n1) \"Both of these solutions are certainly influenced by popularity, and popularity alone would explain a vague statement of concern \u2014 it doesn't explain why both men drafted actual bills, in the resolution's own framing, within four months of it dropping. That timing and that vocabulary is the Green New Deal, not the polling.\"\n2) \"1.6 million Americans live near a trash incinerator... and that's the point environmental legislation has always missed: our bills regulated the carbon in the atmosphere and ignored the particulates in the neighborhood. In my home state of New Jersey, that's a doubled asthma rate because of these incinerators.\"\n3) \"...in the state of Illinois legislators passed an equity environmental Justice Bill four months after the resolution \u2014 and Vox reports the sponsors cited it by name in committee, where there will be 40 million solar panels installed by 2050...\"\n4) \"...climate scientists with the Intergovernmental Panel on Climate Change gave us twelve years to halve global emissions, and the world's response was a shrug. Their report wasn't apathetic \u2014 ours was.\"\n5) \"...this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies \u2014 and yes, those are exactly the provisions Republicans will strip out. That's fine. Bedrock isn't what passes intact; it's what sets the terms, and even the stripped-down Green Real Deal now has to answer for who its clean energy actually employs.\"\n6) \"We landed a man on the moon with a deadline and a budget line \u2014 the Green New Deal is the first climate document to ask for both.\"\n\n### Strength of Evidence - 12/16\n**What Worked:**\n1) Nine unique sources across three points \u2014 The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, and The National Interest \u2014 comfortably above the 1-2-per-point benchmark, and all are mainstream-credible outlets with The National Interest adding a foreign-policy-specific voice for the international point.\n2) Date discipline is above average for a high school round. Full day/month/year attached to five citations: \"The Atlantic tells us on June the 12th of 2019,\" \"the Washington Post tells us on April the 3rd of 2019,\" \"Politico on March the 26th of 2019,\" \"The Guardian tells us on May the 21st of 2019,\" \"Vox on March the 7th of 2019,\" and \"The national interest tells us on June the 4th of 2019.\" For a question about future legislation on a fast-moving 2019 story, that recency is exactly right.\n3) The Politico citation is applied, not decorative. It is used to license a specific inferential step \u2014 \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" \u2014 and is immediately followed by the two named counterproposals it predicts. Source and claim are doing the same job.\n4) The Washington Post is double-mined rather than dropped once: first for the historical baseline (Romney's 2011 agnosticism, no GOP plan in 2016) and then for the polling shift (64%, 45%). Extracting two functionally different pieces of evidence from one article is efficient citation practice.\n**Critical Flaws:**\n1) The $93 trillion figure is uncited. \"I'd be able to pay for the $93 trillion Green New Deal\" \u2014 that number originates from a contested partisan estimate, it is the single most damaging figure in the debate, and you attach no outlet and no date to it. Timeliness and provenance cannot be verified at all, and by delivering it unsourced you concede the opposition's number for free.\n2) The New Jersey asthma claim is uncited and is your only personal-stake evidence. \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators.\" No outlet, no date, no agency. This is the emotional center of point 2 and it is the least verifiable sentence in the speech.\n3) The IPCC anecdote has no citation or date whatsoever \u2014 \"at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table\" \u2014 and \"at the beginning of this year\" is not a date. The actual report you're gesturing at is the October 2018 SR15; naming it would have cost three words and bought you real authority.\n4) Two citations carry month-only dating on a topic where the month matters. \"the Los Angeles Times from December of 2018\" and \"the New York Times, from March of 2019,\" plus \"the Scientific American from January of this year.\" \"January of this year\" is the weakest of the three \u2014 a judge cannot flow a year they have to infer.\n5) The LA Times citation is spent on a claim that needs no source, and the NYT citation argues against you. Using a full outlet-and-date attribution to establish that \"the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords\" is a wasted citation slot on common knowledge, while the NYT is deployed to establish UK provenance \u2014 evidence that weakens the paradigm-shift claim it was brought in to support.\n**What You Could Have Done:**\n1) \"I'd be able to pay for the Green New Deal \u2014 which the American Action Forum priced at $93 trillion in February of 2019, a number worth naming precisely because it's an estimate of a resolution that has no spending text in it.\"\n2) \"In my home state of New Jersey, the New Jersey Department of Environmental Protection reported in 2019 that it's doubled the rate of asthma because of the siting of these incinerators.\"\n3) \"...climate scientists with the Intergovernmental Panel on Climate Change released their Special Report on 1.5 Degrees in October of 2018 and sat very apathetically at a table much like yours...\"\n4) \"We see in an article from the Scientific American from January the 8th of 2019 that emissions rose by 3.8%,\" and \"an article from the Los Angeles Times from December the 15th of 2018.\"\n5) Drop the LA Times attribution for the Paris claim and redeploy that slot: \"The Los Angeles Times reported in December of 2018 that COP24 delegates left Katowice without an enforcement rulebook \u2014 a goal with no mechanism, 1.5 degrees Celsius of heating and no way to get there.\"\n\n### Clarity - 6/10\n**What Worked:**\n1) The signposting is verbally explicit at all three body-point openings and matches the preview's ordinal language \u2014 \"This is the first way in which the Green New Deal will influence future environmental legislation,\" \"Secondly, we have to look more broadly,\" \"Finally, and perhaps most importantly.\" A judge without a transcript always knows their location in the speech.\n2) The thesis is stated in one short, flowable sentence: \"The answer simply is that it will serve as the bedrock for future environmental legislation.\" No qualifier clutter, no hedging.\n3) Technical material is translated rather than assumed in one place: the Paris critique is rendered as \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there,\" which is accessible to a lay judge without background in climate governance.\n**Critical Flaws:**\n1) Multiple garbled or broken sentences a live judge would stumble over. In order of severity: (a) \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" \u2014 \"is a showing that\" plus a stutter plus \"is part of a way to\" is three layers of hedge around a simple claim; (b) \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions\" \u2014 this is a fragment with the connecting clause missing entirely, and it lands on your most important policy example; (c) \"This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice\" \u2014 an audible self-correction (\"that we can change that\") inside your own signpost, the worst possible place for it; (d) \"because of climate and motivations on these incinerators\" \u2014 this phrase does not parse in any reading.\n2) Vague pronouns at four load-bearing moments. \"In my home state of New Jersey, it's doubled the rate of asthma\" \u2014 \"it's\" should be \"incinerator siting,\" not the ambiguous chain back to \"our industrial complex.\" \"in the state of Illinois this led to\" \u2014 \"this\" should be \"the Green New Deal's justice framing.\" \"Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source\" \u2014 two different referents for the same pronoun in one clause, and \"source\" is the wrong noun for a policy framework. \"The problem with it is it proposes a goal\" \u2014 recoverable, but a third consecutive sentence relying on the same unnamed antecedent.\n3) Word-choice errors that change the meaning. \"the deal was met with regret, but also immense popularity\" \u2014 \"regret\" is a malapropism; you needed \"derision\" or \"resistance,\" because as delivered it says the deal's supporters regretted it. And \"In climate legislation, we've often looked to just alternative energy\" reduces decades of policy to a shrug.\n4) Two comic images actively obscure the argument. \"we're designing a new future where we won't just have a world where we're not swimming all the time\" is a double negative wrapped in a joke \u2014 a judge parsing that sentence misses the equity claim that follows it. And \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" is a joke whose referent is never explained \u2014 a judge who doesn't read it as \"young, white, male\" gets nothing from it, and it sits directly in front of the demographic claim it was supposed to set up.\n5) Throat-clearing padding in the transitions and the conclusion. \"Secondly, we have to look more broadly to the question of environmental justice\" restates the preview verbatim before adding anything new; \"That's exactly why we have to return back to today's question\" contains a redundancy (\"return back\") and re-announces a move the audience can already hear; and \"This is great because we're designing a new future\" is an empty evaluative clause where an impact sentence belongs.\n**What You Could Have Done:**\n1) (a) \"The Green New Deal is already setting the terms of the next climate debate.\" (b) \"We're not simply going to pass this 14-page resolution \u2014 we're going to use it as the floor for negotiating bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions.\" (c) \"Second, the Green New Deal is influencing future environmental legislation by democratizing it through environmental justice.\" (d) \"because of where these incinerators were sited.\"\n2) \"In my home state of New Jersey, incinerator siting has doubled the rate of asthma\"; \"in the state of Illinois that same equity framing led to\"; \"Alexandria Ocasio-Cortez's visibility has made the framework globally recognizable\"; \"The problem with the Accords is that they propose a goal.\"\n3) \"the deal was met with derision, but also immense popularity\"; \"In climate legislation, we've historically legislated only on the supply side \u2014 tax credits and alternative energy.\"\n4) \"we're designing a new future where the coastline stays where it is, and everyone will be on an equal footing\"; \"the climate movement is right, but it's also very white \u2014 its leadership is overwhelmingly young, white, and college-educated, while the people living next to the incinerators are not.\"\n5) Cut \"This is great because,\" cut \"return back to,\" and replace with impact: \"By 2050 Illinois will have hired the people its pollution hurt first \u2014 that's what democratizing climate policy actually looks like.\"\n\n### Conclusion Strength - 6/8\n**What Worked:**\n1) The three-point summary is accurate and compressed into flowable ordinal language that matches the preview almost word-for-word \u2014 \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\" A judge flowing the intro can check every box in under five seconds.\n2) The AGD echo is genuinely intentional and structurally clever, not decorative: the speech opened on pundits butchering AOC's name and closed with \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\" Spelling out a floor vote as a three-letter answer to the intro's three-letter motif (AOC \u2192 GND \u2192 YEA) is the single best-executed moment in the speech.\n3) The thesis is restated in the same words used in the intro \u2014 \"it will serve as a fundamental bedrock\" \u2014 so the argumentative claim doesn't drift between the top and the bottom of the round.\n**Critical Flaws:**\n1) The moon line is a non sequitur that wastes the conclusion's strongest position. \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon.\" Nothing in the body was about American technical capacity or space, and the punchline undercuts the urgency it's trying to sell \u2014 it invites a laugh at the exact second you need the room to feel stakes. It also sits before the return to the question, so the transition into the conclusion is a joke rather than a signpost.\n2) \"Y-E-A\" is an implied call to action, not an actual one, and it aims at the wrong actor. The body's own argument was that the resolution won't pass and instead reshapes the negotiation \u2014 \"We're not simply going to just pass this 14-page resolution.\" Ending on \"vote yea\" therefore contradicts your own point 1, and it asks a room of high schoolers to cast a congressional vote they cannot cast.\n3) The conclusion contains no forward-looking date or mechanism despite the intro handing you one. The intro set up \"the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020\" and \"We don't have much time to waste.\" That clock is never picked back up, so the close summarizes what the Green New Deal has done rather than resolving what happens next.\n4) The \"so what\" is asserted rather than delivered. \"The answer is that it will serve as a fundamental bedrock\" is a restatement of the thesis, not an insight about why bedrock status matters \u2014 the final significance of the speech is left for the judge to infer.\n**What You Could Have Done:**\n1) Cut the moon line entirely and signpost cleanly: \"Republicans are writing climate bills, Illinois is hiring the people it poisoned, and four countries are running on the same platform. That's exactly why we have to return to today's question.\"\n2) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A \u2014 not because this resolution will pass, but because every bill that does pass from here will be measured against it.\"\n3) \"The answer is that it will serve as a fundamental bedrock \u2014 and New Consensus turns that white paper into a legislative agenda this year, which means the ceiling for climate policy in 2020 is being set right now.\"\n4) \"Lou Dobbs will keep getting her name wrong. He'll be reading her policy off a teleprompter anyway \u2014 thank you very much.\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 16/20\n**What Worked:**\n1) The filler-word audit is near-spotless, and the four auto-flagged words are almost all false positives on inspection. \"solutions like a carbon tax,\" \"a table much like yours,\" and \"a cross between a Comic-Con convention\" all use \"like\" as a preposition, and \"forcing Republicans to actually innovate\" uses \"actually\" as a genuine contrast with the word \"innovation\" you'd just interrogated. That is effectively zero crutch fillers across 1,253 words \u2014 no \"um,\" no \"you know,\" no \"I think,\" no \"basically.\" At 470 seconds that is championship-level fluency control.\n2) Pace is dead-center competitive and stable enough to carry dense citation strings. 160 wpm over 470s sits squarely in the 150-175 target, and it holds through the hardest passage to deliver \u2014 the Politico stack naming \"Senator Lamar Alexander of Tennessee,\" \"Manhattan Project on Clean Energy,\" and \"Matt Gaetz of Florida\" back to back \u2014 without the audible speed-up most speakers show when clearing evidence blocks.\n3) Vocal variety is genuinely expressive and appears to track content energy. 3,151 pitch shifts with a std-dev of 81.6Hz rates \"High \u2014 expressive,\" which is consistent with a speech built on tonal shifts: the deadpan of \"Lou Dobbs, the paradigm of journalistic integrity\" and the flat delivery of \"we're all going to die\" only land if pitch is doing work.\n4) Emphasis lands correctly on the intro's rhetorical machinery. SOLVE in \"attempted to SOLVE the ever-pressing emergency,\" DON'T in \"We DON'T have much time to waste,\" BROADLY in the second preview point, and WHAT in \"But WHAT exactly is innovation?\" are all spikes on the exact words carrying the argumentative turn.\n**Critical Flaws:**\n1) Volume is only adequate and costs you real points. -23.1 dBFS against a -18 dBFS full-marks threshold yields an 8/10 volume subscore. In a room where you are asking a judge to absorb \"$93 trillion,\" \"3.8%,\" \"1.6 million Americans,\" and \"64%,\" five decibels of additional projection is the cheapest available upgrade in this entire ballot.\n2) A large share of the measured emphasis lands on function words, which dilutes the spikes that matter. From the logged contexts: \"an article from THE Atlantic,\" \"New Consensus is working TO transform,\" \"into A sweeping policy agenda,\" \"we see IN an article,\" \"there ARE three letters,\" \"The answer simply is THAT it will serve.\" Six of the first forty spikes hit articles, prepositions, and auxiliaries. Meanwhile the numbers \u2014 3.8%, 64%, 45%, 1.6 million, $93 trillion, 40 million \u2014 do not appear once in the emphasized-word log. Emphasis on \"THE Atlantic\" instead of \"3.8%\" trains the judge to hear citation ritual rather than data.\n3) Only 7 pauses over 0.4s in a 470-second speech is far too few, and the punchlines are the casualties. \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\" and \"we're all going to die\" are both built to be followed by silence, and the pause data shows there is essentially none to spare \u2014 roughly one pause per 67 seconds. The 1.05s average length is fine; the frequency is the problem.\n4) The one detected stutter falls inside a signpost, which is the worst place for it. \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" \u2014 the repetition sits on the summary line of point 1, so the moment a judge is writing down your takeaway is the moment your fluency breaks. The near-miss \"any kind of sweeping climate climate solution\" is a second repetition in the same body point, suggesting the disfluency clusters where the Washington Post/Politico evidence density is highest rather than being random.\n5) Delivery gives no audible separation between the Illinois evidence and the impact that follows it. \"40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world\" \u2014 with no pause and no emphasis logged on \"40 million\" or \"2050,\" the statistic and the interpretation blur into one breath, and the strongest data point in point 2 passes without a landing.\n**What You Could Have Done:**\n1) Same words, more air: deliver \"1.6 million Americans live near a trash incinerator\" at the same projection you used on the Lou Dobbs joke \u2014 that line was clearly your loudest and it was your least important.\n2) Move the spikes off the citation frames and onto the payload: \"an article from the Guardian tells us on May the 21st of 2019 that 1.6 MILLION Americans live near a trash incinerator\" \u2014 deprioritize \"THE Atlantic\" and hit \"3.8%\" instead.\n3) Insert deliberate silence after both punchlines: \"I'd be able to pay for the $93 trillion Green New Deal. [1s]\" and \"said, we're all going to die. [1.5s] Their dead face was a little apathetic.\"\n4) Rehearse the point-1 summary line as a single clean unit: \"This is how the Green New Deal guides the future climate debate.\" One clause, no \"is a showing that,\" nothing to trip over.\n5) Break the Illinois number away from its analysis: \"40 million solar panels installed by 2050, [pause] with hiring targets for marginalized communities. [pause] So the impact isn't just a greener world.\"\n\n### Total Composite Score: 72/100\n\n### Judge's Rank: 2/5\n\n### Rank Explanation:\nThis speech would place 2nd against 5 other competitors on this question. It is the most polished delivery in the flight \u2014 effectively zero crutch fillers across 1,253 words, a 160-wpm pace that never buckles under citation density, and expressive pitch work that makes the deadpan Lou Dobbs and IPCC lines actually land \u2014 and the AOC/GND/Y-E-A architecture is the kind of intentional intro-to-conclusion motif most rounds never attempt, let alone execute. What keeps it out of the 1 slot is that the analysis is thinner than the packaging: the $93 trillion figure and the New Jersey asthma claim, both load-bearing, arrive with no attribution at all, the New York Times citation establishing UK provenance actively cuts against the paradigm-shift argument it was recruited to support, and point 1 quietly contradicts the conclusion by conceding the resolution won't pass before ending on \"vote yea.\" Clarity is the other drag \u2014 \"the deal was met with regret,\" \"because of climate and motivations on these incinerators,\" and the fragment at \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions\" are all moments a live judge stumbles on, and two of them sit on the speech's own signposts. A speaker with tighter warrants and dated sources beats this one on the flow; nobody in the flight beats it on the ear. Fix the uncited numbers and the garbled summary lines and this is a 1.\n\n### Actionable Drill for Next Round:\nThe Attribution Gate. Take this speech's script and mark every sentence containing a number: $93 trillion, 3.8%, 64%, 45%, 1.6 million, doubled asthma rate, 40 million panels, 1.5 degrees, 14 pages. For each one, write the full citation on an index card in the exact order source\u2013month\u2013day\u2013year\u2013claim (\"American Action Forum, February 2019, priced the resolution at $93 trillion\"). Then re-record the speech under one rule: you are not allowed to say a number out loud until you have said an outlet name and a date in the same breath. If you reach a number and no card exists \u2014 the New Jersey asthma line, the $93 trillion joke, the IPCC anecdote \u2014 you must either find the source or cut the number from the speech entirely. Run this three times, then run it a fourth time adding a full one-second stop immediately after every number, so the two worst habits in this ballot (unsourced data and un-landed statistics) get corrected by the same repetition.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the Green New Deal in November (prior to June 2019) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Atlantic article from June 12, 2019, mentions that the Green New Deal resolution was introduced in February 2019, following a 'white paper' release. While the article doesn't specify 'November' for the white paper, the resolution was indeed a 14-page document.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, (implied June 12, 2019)\n  The Atlantic article from June 12, 2019, discusses both the immense popularity and the challenges/regrets associated with the Green New Deal.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, (implied June 12, 2019)\n  The Atlantic article from June 12, 2019, states that the think tank New Consensus was working to develop the Green New Deal resolution into a comprehensive policy agenda.\n\n[UNVERIFIED] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year\n  A specific article from Scientific American in January (of any recent year) stating a 3.8% rise in emissions could not be found. Emissions data varies by year and source.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post article from April 2, 2019 (very close to April 3) discusses how Republicans for years cast doubt on climate change, but are now acknowledging it, implying a previous stance of skepticism or dismissal.\n\n[TRUE] In 2011, Mitt Romney's campaign questioned if humans caused climate change; Republicans in 2011 and 2016 offered no sweeping climate solutions.\n  Cited source: (no source given)\n  Mitt Romney did express uncertainty about the human contribution to climate change in 2011. Republicans generally did not propose sweeping climate solutions in 2011 or 2016.\n\n[FALSE] 64% of Republicans now believe climate change is a severe threat, and 45% of all Americans believe immediate action is needed.\n  Cited source: The Washington Post, (implied April 3, 2019)\n  A Washington Post-KFF poll from September 13, 2019, found 60% of Republicans believe human activity causes climate change, not that it's a 'severe threat' at 64%. The poll also showed 45% of Americans believe Trump is doing too little, not necessarily that 45% believe immediate action is needed.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  A Politico article from March 22, 2019 (close to March 26), indicates that the Green New Deal was prompting Republicans to acknowledge climate change and seek alternative approaches.\n\n[TRUE] Senator Lamar Alexander proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  Multiple sources, including Newsweek and Oil & Gas Journal from March 27, 2019, confirm Senator Lamar Alexander proposed a 'New Manhattan Project for Clean Energy' as a Republican response to climate change, around the time the Green New Deal was being debated.\n\n[TRUE] Matt Gaetz proposed a Green Real Deal, combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Politico (March 22, 2019) and other news outlets (April 3, 2019) reported that Rep. Matt Gaetz was circulating a 'Green Real Deal' resolution that included promoting innovation to reduce greenhouse gas emissions and investing in carbon capture.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, states that 1.6 million Americans live near the most polluting incinerators, and these pollutants are linked to health problems like asthma and heart disease. Other sources discuss links to birth defects and respiratory problems, which can impact maternal health.\n\n[UNVERIFIED] In Illinois, an equity environmental Justice Bill was passed, installing 40 million solar panels by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois passed significant clean energy legislation with environmental justice components, a Vox article from March 7, 2019, specifically detailing '40 million solar panels by 2050' and a direct link to an 'equity environmental Justice Bill' passed in Illinois by that date could not be precisely verified.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) stated that 'we're all going to die,' representing global apathy.\n  Cited source: (no source given)\n  The IPCC reports on the severe risks of climate change but does not use alarmist language like 'we're all going to die.' The claim mischaracterizes the scientific tone and purpose of IPCC reports. While there is discussion of climate apathy, it's not attributed to the IPCC in this manner.\n\n[TRUE] The Paris Climate Accords propose a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  A Los Angeles Times article from December 2, 2018, notes that the Paris Agreement set a goal of limiting warming to 1.5 degrees Celsius but left many details of how to achieve it to be firmed up later.\n\n[TRUE] The Green New Deal originated in the UK before the US proposed it in 2018, but AOC's accessibility made it globally accessible.\n  Cited source: New York Times, March 2019\n  The concept of a 'Green New Deal' did originate in the UK in 2008. While the New York Times article from March 2019 isn't directly found with this exact phrasing, it's widely acknowledged that AOC's promotion brought significant attention to the concept.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  A National Interest article from June 4, 2019, discusses how the Green New Deal has influenced political discourse and policy proposals in several countries, including Canada and European nations.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    deepseekv4pro: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n**What Worked:**\n1) The opening AGD is genuinely creative and memorable: the speaker immediately leans into the mispronunciation gag \u2014 \"One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" \u2014 which is a fresh, personality-driven hook rather than a clich\u00e9 quote or statistic.\n2) The link from the hook into the exact question drawn is smooth and explicit: \"And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal\" bridges the name joke directly into the policy topic without a jarring pivot.\n3) The thesis statement is unambiguous and flows naturally: \"The answer simply is that it will serve as the bedrock for future environmental legislation\" leaves no doubt about the speaker's stance.\n4) The formal preview of three distinct main points is clearly signposted: \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy\" \u2014 all three points are distinct, parallel, and easy to flow.\n**Critical Flaws:**\n1) The preview's second point begins with a lowercase \"more broadly\" mid-sentence, which is a minor grammatical stumble: \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice\" \u2014 the period before \"more broadly\" creates a fragment rather than a clean parallel structure.\n2) The hook's connection to the thesis is never explicitly tied back in the introduction itself \u2014 the speaker moves from the name joke to the GND acronym to the thesis, but never says something like \"just as her name gets mangled, the Green New Deal's actual substance gets mangled in public debate, and that's why its influence matters.\"\n**What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation. Second, more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"The answer simply is that it will serve as the bedrock for future environmental legislation. Just as pundits can't even get AOC's name right, they've also misread what the Green New Deal actually is \u2014 and that misreading is exactly why its real influence on future legislation matters.\"\n\n### Structure - 8/10\n**What Worked:**\n1) The organizational skeleton is fully present and correctly ordered: single AGD, clear thesis, formal three-point preview, exactly three body paragraphs, and a conclusion \u2014 no missing or blurred elements.\n2) The transition from Body 1 into Body 2 is explicit and signposted: \"Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white\" clearly marks the shift and even previews the point's content.\n3) The transition from Body 2 into Body 3 is also clean: \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die\" \u2014 though the hook is a bit jarring, the signpost \"Finally, and perhaps most importantly\" is unmistakable.\n4) Timing breakdown based on word counts (no audio duration provided for section-level split, so percentages only): Introduction ~18%, Body 1 ~27%, Body 2 ~26%, Body 3 ~21%, Conclusion ~8%. Body 1 and Body 2 are close to the 26% benchmark; the introduction runs slightly hot at 18% vs 14%, and Body 3 runs slightly light at 21% vs 26%, but the overall balance is within a reasonable competitive range.\n**Critical Flaws:**\n1) The transition from the introduction into Body 1 is abrupt: the speaker jumps straight from the preview into \"Republicans for years have said that innovation is the way that we can solve climate change\" with no linking sentence or callback to the hook \u2014 the seam is not signposted as clearly as the later transitions.\n2) The AGD (the mispronunciation gag) is never referenced again anywhere in the body \u2014 no short callbacks to the \"three letters\" or the pundit joke until the conclusion, so the throughline goes silent for the entire middle of the speech.\n3) Body 3 is underweighted at ~21% versus the 26% benchmark, while the introduction runs slightly hot at ~18% versus 14% \u2014 that imbalance likely explains why point three feels a bit rushed and less developed than points one and two; roughly 10-15 seconds should be reallocated from the intro into point three.\n4) The conclusion's \"So What?\" close does tie back to the AGD with \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 but this is a clever callback rather than a substantive final insight; it restates the thesis's optimism without resolving why that matters beyond the speech itself.\n**What You Could Have Done:**\n1) \"First, by forcing bipartisan action on climate mitigation... Now, let's start with that first point \u2014 Republicans for years have said that innovation is the way that we can solve climate change.\"\n2) \"This is the first way in which the Green New Deal will influence future environmental legislation. Just as pundits keep mangling AOC's name, Republicans have been mangling what 'innovation' actually means \u2014 and that's exactly the mangling the Green New Deal forces them to confront.\"\n3) \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists... \u2014 and just as those pundits couldn't even pronounce her name, the world has been unable to pronounce a unified climate policy, which is exactly what this third point addresses.\"\n4) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. And that 'yea' isn't just a vote \u2014 it's the first real chance we've had to say yes to a climate policy that actually matches the scale of the crisis, which is why this speech matters beyond this room.\"\n\n### Strength of Argument & Analysis - 11/16\n**What Worked:**\n1) Body 1's core claim \u2014 that the Green New Deal forces bipartisan action by shifting the Overton window on climate innovation \u2014 is valid and well-supported. The speaker traces a clear Evidence \u2192 Warrant \u2192 Impact chain: Washington Post poll data (64% of Republicans see climate as severe threat) \u2192 warrant that this popularity pressures Republicans to propose alternatives \u2192 impact that these alternatives are influenced by the GND's framing. The \"So What?\" is explicit: \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate.\"\n2) Body 2's core claim \u2014 that the GND addresses environmental justice and thereby democratizes climate legislation \u2014 is well-analyzed. The speaker moves from the Guardian's incinerator statistic to the specific mechanism (jobs guarantee, universal health care, subsidies) and then to the Illinois equity bill as concrete proof, explaining why that matters: \"We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that.\"\n3) Body 3's core claim \u2014 that the GND leads to a new global paradigm \u2014 is supported by a reasonable causal chain: the Paris Accords lack a mechanism, the GND provides one, and its accessibility (via AOC) makes it exportable to other countries. The speaker explicitly connects the evidence to the thesis: \"the Green New Deal is creating a unified platform where we can all cut reductions.\"\n4) The speaker consistently runs the \"So What?\" test on key evidence: after citing the 3.8% emissions rise, they immediately say \"We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world\" \u2014 tying the statistic to urgency rather than dropping it.\n**Critical Flaws:**\n1) Body 1's argument is only partially fair: the speaker characterizes Republican climate proposals (Lamar Alexander's Manhattan Project, Matt Gaetz's Green Real Deal) as purely reactive to GND popularity, but never engages the strongest opposing view \u2014 that these proposals might reflect genuine Republican policy evolution independent of the GND. The missing counterargument is: \"Republicans like Alexander and Gaetz may have been moving toward clean-energy innovation anyway, given market pressures and voter shifts; the GND may be accelerating rather than causing that shift.\" Without addressing that, the causal claim is weaker than it could be.\n2) Body 2's claim that \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" is an assertion with no evidence or warrant \u2014 it's a rhetorical jab, not an argument. The speaker never explains why that demographic makeup matters for the GND's influence, so the \"So What?\" is missing: the point should be that a movement perceived as white and nerdy lacks the political coalition to pass legislation, and the GND's justice provisions are what broaden that coalition.\n3) Body 3's argument that the GND creates a \"unified global paradigm\" is a hasty generalization from a handful of examples (Spain, Sweden, Norway, Canada). The speaker cites candidates \"running on a Green New Deal agenda\" but provides no evidence that this translates into actual legislative influence or a unified platform \u2014 the leap from \"candidates mention it\" to \"global paradigm shift\" skips the warrant.\n4) The thesis itself \u2014 that the GND will serve as \"the bedrock for future environmental legislation\" \u2014 is never tested against the strongest counterfactual: that the GND is a non-binding resolution with no legal force, and its influence may fade once the 2020 election cycle ends. The speaker never acknowledges this, which makes the argument feel one-sided.\n5) The evidence in Body 1 (the Washington Post poll showing 64% of Republicans see climate as a severe threat) is used to prove that Republicans are \"finally forced to listen,\" but the speaker never explains the mechanism by which a poll translates into legislative action \u2014 the warrant is asserted, not demonstrated. The missing \"so what\" is: \"When 64% of a party's own voters say climate is a severe threat, elected Republicans face electoral pressure to propose something, which is why Alexander and Gaetz felt compelled to act.\"\n**What You Could Have Done:**\n1) \"This is very different from the American popular opinion... Now, a skeptic might say these Republican proposals would have happened anyway, given market shifts toward clean energy. But the timing is telling: Alexander's Manhattan Project and Gaetz's Green Real Deal both emerged within months of the GND's introduction, not before \u2014 and both explicitly frame themselves as alternatives to the GND, which shows the GND set the terms of the debate.\"\n2) \"In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. That's not just a joke \u2014 it's a political problem. A movement that reads as white, young, and coastal cannot build the multiracial, working-class coalition needed to pass sweeping legislation, which is exactly why the GND's environmental justice provisions are the mechanism that broadens that coalition.\"\n3) \"The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda. Now, candidates running on a slogan isn't the same as a global paradigm shift \u2014 but the fact that the GND's specific policy framework, not just the phrase, is being adopted in multiple national contexts shows it's functioning as a template, not just a talking point.\"\n4) \"The answer simply is that it will serve as the bedrock for future environmental legislation. Of course, the GND is a non-binding resolution, and its influence could fade after 2020. But even non-binding resolutions can set the legislative agenda \u2014 the 1994 Contract with America did exactly that \u2014 and the GND's specificity gives it a staying power that vague aspirational goals lack.\"\n5) \"In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. When nearly two-thirds of a party's own voters say climate is a severe threat, elected Republicans face a direct electoral incentive to propose something \u2014 which is exactly why Alexander and Gaetz felt compelled to act within months of the GND's introduction.\"\n\n### Flaws in Reasoning - 8/12\n**What Worked:**\n1) The speaker largely avoids the most common Extemp fallacy (slippery slope) \u2014 no point escalates into worst-case predictions without proportional evidence; the moon joke at the end is clearly rhetorical, not a logical claim.\n2) The speaker does not commit a false dilemma: they acknowledge that Republican proposals like the Green Real Deal and Manhattan Project are real alternatives, not straw men, and engage with them as genuine responses rather than caricatures.\n3) The causal chain in Body 2 is internally consistent: the speaker links incinerator proximity \u2192 health disparities \u2192 need for justice provisions \u2192 Illinois equity bill as proof, without any obvious post hoc fallacy.\n**Critical Flaws:**\n1) The claim that \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" is a correlation-as-causation fallacy. The speaker observes that Republican proposals emerged after the GND and after poll shifts, but never rules out the possibility that both the GND and the Republican proposals are independent responses to the same underlying shift in public opinion. The exact sentence: \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" \u2014 this asserts causation without a mechanism.\n2) The line \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\" is a rhetorical hyperbole that substitutes for actual argument. The speaker never establishes that Republican use of \"innovation\" is empty rhetoric versus a genuine policy preference, so the jab does no logical work \u2014 it's a clich\u00e9 dressed as wit.\n3) In Body 3, the speaker commits a hasty generalization: from four countries (Spain, Sweden, Norway, Canada) where candidates \"have run on a Green New Deal agenda,\" they conclude that the GND is \"creating a unified platform where we can all cut reductions.\" Four examples, all from wealthy Western democracies, cannot support a claim about a \"global paradigm\" \u2014 the sample is too small and too homogeneous.\n4) The speaker asserts that \"the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords\" and then immediately dismisses it because it \"proposes a goal... with no actual mechanism.\" This is a false dilemma: the speaker implies that because the Paris Accords lack an enforcement mechanism, the only alternative is the GND's approach, ignoring other possible mechanisms (carbon pricing, regulatory standards, technology treaties) that could also fill the gap.\n5) The opening joke about Lou Dobbs calling her \"Alexandria Ocasio-Cortez\" is factually nonsensical \u2014 that is her actual name, so the joke's premise is unclear. This is not a logical fallacy per se, but it is an unforced error in reasoning: the speaker sets up a contrast between a wrong name and a right name, but both names are the same, which undercuts the hook's internal logic.\n**What You Could Have Done:**\n1) \"the Green New Deal and the poll numbers are finally forcing Republicans to listen. Now, to be clear, I'm not saying the GND caused those poll numbers \u2014 the polls shifted first. But the GND gave Republicans a specific target to respond to, and the timing of Alexander's and Gaetz's proposals, both within months of the GND's introduction, shows they were responding to the GND's framing, not just the polls.\"\n2) \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. But here's the thing: 'innovation' without a specific policy mechanism is just a word. The GND forces Republicans to define what innovation actually means \u2014 carbon capture? Nuclear? \u2014 and that definition is the real shift.\"\n3) \"the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda. Now, four countries isn't the whole world, but these are not fringe candidates \u2014 they're mainstream parties in wealthy democracies, and their adoption of the GND's specific framework, not just the slogan, shows the template is spreading beyond the U.S.\"\n4) \"The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. Now, that doesn't mean the only alternative is the GND \u2014 carbon pricing or regulatory standards could also work. But the GND is the first proposal to pair the goal with a concrete, multi-sector mechanism, which is why it's filling the gap the Paris Accords left open.\"\n5) \"One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. Now, Dobbs got her name right, which makes the joke a little confusing \u2014 but the point stands: pundits can't even agree on what to call her, let alone what her policy actually is.\"\n\n### Strength of Evidence - 12/16\n**What Worked:**\n1) The speaker cites 8 unique sources across the speech: The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, and The National Interest \u2014 that's 9 distinct outlets, well above the benchmark of 1-2 per point, and all are reputable mainstream or policy-focused publications.\n2) Every source is dated with at least a month and year, and most include a specific day: \"June the 12th of 2019\" (Atlantic), \"January of this year\" (Scientific American), \"April the 3rd of 2019\" (Washington Post), \"March the 26th of 2019\" (Politico), \"May the 21st of 2019\" (Guardian), \"March the 7th of 2019\" (Vox), \"December of 2018\" (LA Times), \"March of 2019\" (NYT), \"June the 4th of 2019\" (National Interest). All dates are within roughly 18 months of the speech's likely delivery (mid-2019), which is appropriate for a fast-moving climate policy topic.\n3) The speaker applies evidence to claims reasonably well in Body 2: the Guardian's incinerator statistic is directly tied to the environmental justice argument, and the Vox Illinois bill is used as concrete proof of the GND's influence on state-level legislation.\n4) The speaker explains why the Scientific American statistic matters: after citing the 3.8% emissions rise, they immediately connect it to urgency \u2014 \"We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world\" \u2014 rather than dropping the number and moving on.\n**Critical Flaws:**\n1) The Washington Post poll data is cited with specificity (\"64% believe that climate change is a severe threat\") but the speaker never explains the poll's methodology or sample size, which weakens its authority \u2014 a judge might wonder whether 64% of Republicans is a reliable figure or an outlier.\n2) The National Interest source is introduced mid-sentence without a clear citation structure: \"The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" \u2014 the speaker drops the outlet name in lowercase and never states the article title or author, which makes the citation feel less rigorous than the earlier ones.\n3) The Scientific American citation is vague: \"we see in an article from the Scientific American from January of this year that emissions rose by 3.8%\" \u2014 the speaker never specifies which emissions (global? U.S.? CO2? all greenhouse gases?), which makes the statistic harder to apply to the argument about U.S. environmental legislation.\n4) The speaker cites The Atlantic twice but never distinguishes between the two different Atlantic articles \u2014 the first is about the GND's white paper, the second about its popularity, but both are just \"an article from The Atlantic,\" which could confuse a judge trying to track sources.\n5) The Vox citation about Illinois' equity bill is strong, but the speaker never explains how the GND specifically influenced that bill \u2014 the causal link is asserted, not evidenced. The missing \"so what\" is: \"The Illinois bill's focus on hiring marginalized people mirrors the GND's jobs guarantee language, showing the GND's framework is already being copied at the state level.\"\n**What You Could Have Done:**\n1) \"In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival. That's according to a Washington Post-Kaiser Family Foundation poll of over 2,000 adults conducted in early 2019, which makes the 64% figure statistically reliable.\"\n2) \"An article in The National Interest from June the 4th of 2019 reports that the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\"\n3) \"we see in an article from the Scientific American from January of this year that global CO2 emissions rose by 3.8%.\"\n4) \"An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal... A separate Atlantic piece, also from 2019, reports that the deal was met with regret, but also immense popularity.\"\n5) \"We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed... The bill's explicit focus on hiring marginalized people for solar installation jobs directly mirrors the GND's jobs guarantee language, which shows the GND's framework is already being copied at the state level.\"\n\n### Clarity - 7/10\n**What Worked:**\n1) The speaker's signposting is strong: each body point opens with a clear verbal marker \u2014 \"First,\" \"Secondly,\" \"Finally, and perhaps most importantly\" \u2014 and the conclusion opens with \"That's exactly why we have to return back to today's question,\" so a listener without the transcript could easily track the speech's structure.\n2) The speaker avoids most vague pronoun errors: \"this\" and \"that\" generally have clear antecedents, such as \"This is the first way in which the Green New Deal will influence future environmental legislation\" where \"this\" clearly refers to the preceding point about innovation.\n3) The speaker explains acronyms and references on first use: \"GND, standing for the Green New Deal\" and \"AOC\" are both unpacked, so a judge with no background knowledge can follow.\n4) The speech is largely free of filler words in the text: the auto-count found only 4 total (\"actually\"\u00d71, \"like\"\u00d73), and a close read confirms the speaker does not pad with \"really,\" \"very,\" \"just,\" \"kind of,\" or \"basically\" in any significant way.\n**Critical Flaws:**\n1) The phrase \"the that the Green New Deal\" is a clear stutter/repetition: \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate.\" The extra \"the\" is a verbal stumble that a live judge would notice.\n2) The sentence \"we're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" has a grammatical break: the period after \"resolution\" creates a fragment, and the sentence should read \"we're not simply going to just pass this 14-page resolution to come to bipartisan solutions like a carbon tax.\"\n3) The phrase \"climate climate solution\" is a clear repetition: \"did Republicans propose any kind of sweeping climate climate solution.\" This is likely a stutter, but it reads as sloppy in the transcript.\n4) The opening joke's logic is unclear: \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" \u2014 that is her actual name, so the joke's premise is confusing. A listener might not understand why that's supposed to be funny, which undermines the hook's clarity.\n5) The phrase \"we're all gonna have to move to the moon\" is a colloquialism that slightly undercuts the speech's formal register, and the contraction \"gonna\" appears twice (\"we're all gonna have to move to the moon\" and \"we're all going to die\" earlier) \u2014 while not a major flaw, it's a minor tonal inconsistency in an otherwise polished extemp speech.\n6) The sentence \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" is awkwardly phrased: \"climate and motivations\" is unclear \u2014 the speaker likely means \"climate-motivated policies\" or \"the siting of these incinerators,\" but as delivered it's confusing.\n**What You Could Have Done:**\n1) \"This is a showing that the Green New Deal is part of a way to guide future climate debate.\"\n2) \"we're not simply going to just pass this 14-page resolution \u2014 we're going to use it to come to bipartisan solutions like a carbon tax.\"\n3) \"did Republicans propose any kind of sweeping climate solution.\"\n4) \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez \u2014 which, to be fair, is her actual name, but the point is that even the 'serious' pundits can't seem to take her seriously enough to get the substance right.\"\n5) \"we're all going to have to move to the moon.\"\n6) \"In my home state of New Jersey, it's doubled the rate of asthma because of the siting of these incinerators in low-income communities of color.\"\n\n### Conclusion Strength - 7/8\n**What Worked:**\n1) The conclusion accurately restates the three main points: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 a faithful summary of the speech's structure.\n2) The conclusion delivers a clear, intentional echo back to the opening hook: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\" This is a satisfying callback that ties the speech's beginning to its end.\n3) The conclusion includes a forward-looking statement: \"That's exactly why we have to return back to today's question\" and the final \"Y-E-A\" functions as an implicit call to action \u2014 a vote of support for the GND's influence.\n4) The moon callback (\"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\") provides a memorable, slightly humorous close that reinforces the stakes.\n**Critical Flaws:**\n1) The conclusion's \"So What?\" is underdeveloped: the speaker restates the thesis and the three points, but never explicitly explains why the GND serving as a \"bedrock\" matters beyond the speech itself \u2014 there's no final insight about what this means for the audience or for future policy beyond a vague \"we have to return back to today's question.\"\n2) The phrase \"global universality\" is slightly redundant \u2014 \"global\" and \"universality\" mean nearly the same thing, so the third point's restatement is less crisp than the first two.\n3) The final line \"Y-E-A\" is clever but potentially confusing: a listener might not immediately connect \"Y-E-A\" to \"yea\" as in a vote of support, and the speaker never spells out that connection explicitly.\n**What You Could Have Done:**\n1) \"That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. And that matters because for the first time in a generation, we have a climate proposal that isn't just a goal \u2014 it's a mechanism. It's not just a resolution \u2014 it's a roadmap. And if we don't follow that roadmap, the next time we ask this question, it won't be about influence; it'll be about survival.\"\n2) \"finally, by leading to global cooperation.\"\n3) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Yea, as in the vote we need to cast for a livable future.\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 16/20\n**What Worked:**\n1) Filler words are extremely low: the auto-count found only 4 total (\"actually\"\u00d71, \"like\"\u00d73), and a close read of the transcript confirms no significant \"um,\" \"uh,\" \"you know,\" or other verbal crutches. This is a clean, disciplined delivery.\n2) Volume is adequate: the audio metrics show average -23.1 dBFS, which is below the full-marks threshold of -18 dBFS but still clearly audible and projected \u2014 the raw volume subscore of 8/10 reflects a speaker who is not too quiet but could project slightly more.\n3) Tone and pitch variety are excellent: 3151 significant pitch shifts and a pitch std-dev of 81.6Hz indicate a highly expressive, non-monotone delivery that tracks the content's energy \u2014 this is a major strength.\n4) Pacing is solid: 160 words per minute over a 470-second recording falls squarely within the competitive extemp target of 150-175 wpm, so the speech is neither rushed nor dragging.\n5) Pauses are used strategically: 7 pauses longer than 0.4s, averaging 1.05s, is a healthy number \u2014 enough to create emphasis and signposting without becoming awkward or filler-disguising.\n**Critical Flaws:**\n1) Emphasis placement is inconsistent: of the 245 emphasized words (20% of total), many land on rhetorically unimportant words \u2014 for example, the opening sequence emphasizes \"CABLE,\" \"NEWS,\" \"PUNDITS,\" \"LOVE,\" \"LOU,\" \"CALLED,\" \"WHILE,\" \"ARE,\" \"STANDING,\" \"THE,\" \"SOLVE,\" \"UNITED,\" \"THE,\" \"MET,\" \"BUT,\" \"ALSO,\" \"NOW,\" \"TO,\" \"A,\" \"DON'T,\" \"IN,\" \"AND,\" \"WE,\" \"HAVE,\" \"WILL,\" \"THAT\" \u2014 a large proportion are articles, prepositions, and conjunctions, not thesis words, key numbers, or signposting cues. This suggests the speaker's emphasis is landing somewhat randomly rather than being deliberately placed on the most important terms.\n2) The single stutter/repetition detected (\"the that the Green New Deal\") is a minor fluency flaw, but it occurs at a rhetorically important moment \u2014 the transition into the thesis's first point \u2014 which makes it more noticeable than if it had happened in a less critical spot.\n3) The speaker's volume, while adequate, is not at the strong-projection threshold (-18 dBFS or above). In a large room or against a more forceful competitor, this speaker might be perceived as slightly underpowered, which could cost points on delivery.\n4) The pace, while solid, is at the slower end of the competitive range (160 wpm vs. the 175 upper bound). Combined with the 470-second total duration, this suggests the speaker may have had room to add more content or analysis without rushing \u2014 the speech feels slightly underfilled for a 7-minute extemp round.\n**What You Could Have Done:**\n1) Rehearse the speech with a deliberate emphasis map: mark only the thesis words (\"bedrock,\" \"bipartisan,\" \"environmental justice,\" \"global paradigm\"), key numbers (\"64%,\" \"3.8%,\" \"1.6 million\"), and signposting cues (\"First,\" \"Secondly,\" \"Finally\") for emphasis, and practice delivering the rest of the sentence at a more even volume so the spikes land on the right words.\n2) Slow down and repeat the phrase \"the Green New Deal\" cleanly in practice, focusing on eliminating the extra \"the\" \u2014 record yourself saying \"This is a showing that the Green New Deal is part of a way to guide future climate debate\" ten times without a stumble.\n3) Practice projecting from the diaphragm rather than the throat: stand with feet shoulder-width apart, take a deep breath before each main point, and aim for a volume level that feels slightly too loud in a small room \u2014 that's usually the right level for a large competition room.\n4) Use the extra 30-40 seconds available (470s vs. a 420s target) to add one more piece of analysis or a deeper warrant in Body 3, which was underweighted \u2014 this would both fill the time and strengthen the argument without rushing.\n\n---\n\n### Total Composite Score: 76/100\n\n### Judge's Rank: 3/5\n\n### Rank Explanation:\nThis speech would place 3rd against 5 other competitors on this question. The speaker has a genuinely creative hook, a clear thesis, and strong vocal variety, but the argumentation is uneven \u2014 Body 1 and Body 2 are well-developed, while Body 3 is thin and the causal claims throughout rely more on assertion than warrant. The evidence is plentiful and well-dated, but the speaker sometimes drops citations without explaining their significance, and the emphasis placement in delivery is noticeably random, undercutting the otherwise strong vocal energy. The speech is clean and fluent with almost no filler words, but the logical gaps and the underweighted third point keep it from ranking higher. Against a field of six, this would likely beat the speakers with weaker structure or more filler, but lose to those with tighter reasoning and more deliberate emphasis.\n\n### Actionable Drill for Next Round:\nThe single worst flaw is the inconsistent emphasis placement in delivery \u2014 20% of words are emphasized, but many are articles and prepositions, which dilutes the impact of the truly important terms. For the next round, take a printed copy of your speech and use a highlighter to mark only the 10-12 most rhetorically important words per minute (thesis words, key numbers, signposting cues, and the first word of each main point). Then record yourself delivering the speech while consciously de-emphasizing everything else \u2014 speak the non-highlighted words at a noticeably lower, more even volume. Listen back and check: did the emphasized words actually stand out, or did the emphasis still bleed onto filler words? Repeat until the contrast is sharp. This drill will force you to make deliberate choices about where your vocal energy goes, which will make your delivery sound more controlled and persuasive.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the Green New Deal in November (before June 2019) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  Alexandria Ocasio-Cortez and Senator Ed Markey introduced a 14-page resolution for the Green New Deal in February 2019. The Atlantic published an article on June 12, 2019, discussing the Green New Deal, consistent with the claim's timeline.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, (implied June 12, 2019)\n  While 'regret' is not explicitly mentioned, articles from early 2019 indicate the Green New Deal was popular among Democrats and activists, but also faced strong opposition and criticism from Republicans.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, (implied June 12, 2019)\n  New Consensus is a think tank that has been involved in developing the Green New Deal framework, aiming for a comprehensive policy agenda. Their website indicates their role in this.\n\n[UNVERIFIED] Emissions rose by 3.8% in January of 'this year' (assumed 2020 based on context).\n  Cited source: Scientific American, January of this year\n  A search for 'Scientific American January 2020 emissions rose 3.8%' or similar did not yield a specific article with this statistic. The context of 'this year' is ambiguous given the current date (2026) versus the likely speech date (2019/2020).\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post article from April 2, 2019, discusses how Republicans for years cast doubt on climate change, but some are now acknowledging it, consistent with the claim.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change.\n  Cited source: Mitt Romney 2011 campaign\n  In 2011, Mitt Romney made statements indicating he believed the world was getting warmer and humans contributed, but he was uncertain how much, and at one point said he didn't know what was causing it.\n\n[UNVERIFIED] 64% of Republicans now believe climate change is a severe threat to our future survival, and 45% of all Americans believe we need immediate action.\n  Cited source: The Washington Post, (implied April 3, 2019)\n  A Washington Post-Kaiser Family Foundation poll from September 2019 found 60% of Republicans believe human activity causes climate change and about half of all Americans believe action is urgently needed within the next decade. The specific numbers cited (64% Republicans, 45% all Americans for immediate action) were not found.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  Politico and other sources from March 2019 reported that the Green New Deal was indeed prompting Republicans to propose their own climate solutions, indicating it was changing the debate.\n\n[TRUE] Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  Senator Lamar Alexander proposed a 'New Manhattan Project for Clean Energy' in March 2019 as a Republican response to climate change and the Green New Deal.\n\n[TRUE] Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Representative Matt Gaetz proposed a 'Green Real Deal' in late March/early April 2019, which focused on innovation, carbon capture, and reducing regulations, though it did not explicitly call for 'less oil drilling' but rather keeping options open for all energy production.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators, and these pollutants are linked to health problems including asthma and heart disease.\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  A search for a Vox article from March 7, 2019, about an Illinois equity environmental justice bill with these specific details (40 million solar panels by 2050, focus on marginalized hiring) did not yield a direct match. While Illinois has passed environmental justice legislation and has solar initiatives, the specific numbers and direct attribution to Vox on that date for this claim could not be confirmed.\n\n[TRUE] The most sweeping piece of climate legislation worldwide is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  The Paris Agreement sets a goal to limit global warming to well below 2 degrees Celsius, preferably 1.5 degrees Celsius, but relies on voluntary national contributions rather than a central enforcement mechanism.\n\n[TRUE] The Green New Deal originated in the UK, but AOC's accessibility has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  The concept of a 'Green New Deal' has roots in the UK and other parts of the world before the US proposal. Alexandria Ocasio-Cortez's introduction of the resolution in 2019 significantly raised its profile globally.\n\n[UNVERIFIED] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  A search for 'The National Interest June 4 2019 Green New Deal agenda Spain Sweden Norway Canada' did not yield a direct article supporting this specific claim. While the Green New Deal concept has gained international traction, the specific attribution to The National Interest on that date for these countries is unverified.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    gemini37flash: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 6/8\n**What Worked:**\n1) The attention-getter uses a specific, humorous anecdote about cable news pundits mispronouncing Alexandria Ocasio-Cortez's name (\"Alessandra Oxycontin\" and \"Alexandria Ocasio-Cortez\" by Lou Dobbs), which is genuinely creative and avoids clich\u00e9.\n2) The link from the AGD to the topic is smooth and logical, connecting AOC's name to the \"GND\" (Green New Deal) and then directly to the question: \"And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation?\"\n3) The thesis statement is explicit and clear: \"The answer simply is that it will serve as the bedrock for future environmental legislation.\"\n**Critical Flaws:**\n1) The formal preview of the three main points is delivered as a single run-on sentence, lacking distinct verbal numbering or pauses to clearly delineate \"First,\" \"Second,\" and \"Third,\" making it harder for a judge to flow the structure.\n2) While the AGD is creative, the speaker does not explicitly state the larger significance or analogy of the name mispronunciation to the Green New Deal itself within the introduction, leaving the \"So What?\" of the hook somewhat implied rather than fully articulated.\n**What You Could Have Done:**\n1) \"...bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation; second, more broadly by addressing the critical concept of environmental justice; and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) \"...the Green New Deal. And just as pundits struggle to grasp the basics of AOC's name, many struggle to grasp the true influence of the Green New Deal. And that's exactly why for everyone in this room, we have to ask today's question.\"\n\n### Structure - 7/10\n**What Worked:**\n1) The organizational skeleton is fully present and correctly ordered, including a single AGD, a clear thesis, a formal preview, three distinct body points, and a conclusion, demonstrating a complete understanding of the speech structure.\n2) The transitions between Body 2 and Body 3 (\"Finally, and perhaps most importantly, at the beginning of this year...\") and from Body 3 to the Conclusion (\"That's exactly why we have to return back to today's question.\") are clearly signposted and effective.\n3) The conclusion delivers a satisfying echo back to the opening AGD by referencing AOC's \"complicated name\" and the \"three letters we need to learn,\" providing a cohesive bookend to the speech.\n**Critical Flaws:**\n1) The transition from the Introduction to Body 1 is somewhat abrupt, jumping from the preview directly into a rhetorical question about \"innovation\" without a clear linking sentence that explicitly bridges the thesis to the first point.\n2) There are no short callbacks to the opening AGD or the AOC name theme anywhere within the body paragraphs, causing the throughline established in the introduction to dissipate until the very end of the speech.\n3) Body 3 is significantly underweighted at ~19% of the total speech duration, falling short of the competitive benchmark of 26% and leading to a noticeably rushed feel compared to the other two points.\n4) The Introduction is slightly overweighted at ~20% of the total speech duration, exceeding the 14% benchmark, which contributes to the imbalance and could be trimmed to allow more time for the body points.\n**What You Could Have Done:**\n1) \"...action on climate mitigation. And this initial influence begins with changing how Republicans approach the climate debate. Republicans for years have said that innovation is the way that we can solve climate change.\"\n2) (After Body 1's discussion of Republican innovation) \"This shift in Republican rhetoric, much like the pundits finally learning AOC's name, shows the Green New Deal's power to force engagement. Secondly, we have to look more broadly to the question of environmental justice...\"\n3) (Reallocate ~20 seconds from the Introduction to Body 3).\n\n### Strength of Argument & Analysis - 10/16\n**What Worked:**\n1) Point 1 (Bipartisan Action): The argument that the Green New Deal forces bipartisan action is well-supported by citing specific Republican counter-proposals like Senator Lamar Alexander's \"Manhattan Project on Clean Energy\" and Matt Gaetz's \"Green Real Deal.\" This demonstrates the Green New Deal's influence on the political discourse.\n2) Point 2 (Environmental Justice): The core claim that the Green New Deal democratizes the climate movement by addressing environmental justice is clearly stated and supported by evidence of tangible harm to marginalized communities, such as the 1.6 million Americans living near trash incinerators and the doubled asthma rates in New Jersey.\n3) Point 2 (Analysis): The speaker effectively applies the \"So What?\" test to the environmental justice evidence by explaining that the Green New Deal proposes \"a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity,\" explicitly linking these provisions to the goal of \"making sure that those who have been the most marginalized by our pollution are now the most advantaged.\"\n4) Point 3 (Global Paradigm): The argument that the Green New Deal leads to a new global paradigm is supported by evidence that candidates in Spain, Sweden, Norway, and Canada have adopted a Green New Deal agenda, demonstrating its international influence beyond U.S. borders.\n**Critical Flaws:**\n1) Point 1 (Argument): The claim that the Green New Deal \"change innovation into forcing Republicans to actually innovate\" is an oversimplification and borders on a post hoc ergo propter hoc fallacy. While Republican proposals emerged after the GND, the speech doesn't sufficiently warrant that the GND solely or directly \"forced\" this innovation, rather than simply influencing or coinciding with a broader shift in public opinion.\n2) Point 1 (Analysis): The speaker states, \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions.\" This assertion lacks a clear warrant connecting how the Green New Deal specifically leads to the adoption of a carbon tax, leaving a gap in the causal chain.\n3) Point 2 (Argument): The opening statement \"while the climate movement is right, they're also very white\" is a hasty generalization. While the climate movement may have diversity challenges, asserting it looks \"like a cross between a Comic-Con convention and a Bernie Sanders rally\" is an unproven, potentially offensive, and unnecessary generalization that detracts from the point about environmental justice.\n4) Point 3 (Argument): The argument that the Paris Climate Accords have \"no actual mechanism on how to get there\" is an oversimplification. While the Paris Agreement sets national targets and relies on Nationally Determined Contributions (NDCs), it does include mechanisms for reporting, review, and capacity building, which are not acknowledged. This creates a straw man by attacking a simplified version of the Accords.\n**What You Could Have Done:**\n1) \"...to change innovation into forcing Republicans to actually innovate. Instead, the Green New Deal has provided a clear, ambitious benchmark that has compelled Republicans to offer their own, albeit different, solutions to climate change.\"\n2) \"...this 14-page resolution. Instead, the Green New Deal's broad popularity and ambitious scope create the political pressure necessary to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions.\"\n3) \"...they're also very white. While the climate movement has historically struggled with issues of representation and accessibility for marginalized communities, this is the second way that we can change that the Green New Deal is influencing future environmental legislation...\"\n4) \"...with no actual mechanism on how to get there. While the Paris Climate Accords establish a framework for national commitments and reporting, the Green New Deal offers a more comprehensive, integrated approach that could provide a clearer roadmap for achieving these goals.\"\n\n### Flaws in Reasoning - 7/12\n**What Worked:**\n1) The speech generally maintains a consistent logical flow within each point, avoiding abrupt shifts in argument or internal contradictions between the main claims.\n2) The speaker avoids common fallacies like slippery slope, as the predictions about the Green New Deal's influence remain proportionate to the evidence presented rather than escalating into exaggerated outcomes.\n**Critical Flaws:**\n1) The statement \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\" is an example of hyperbole substituting for actual logical connection. The cost of the Green New Deal is a complex economic issue, and this rhetorical flourish does not provide a reasoned argument for how \"innovation\" relates to its funding.\n2) In Point 1, the speaker asserts, \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate.\" This presents a correlation as causation. While the Green New Deal's emergence and Republican proposals are correlated, the speaker does not provide sufficient warrant to definitively claim the GND forced the innovation, rather than simply creating a new political context.\n3) In Point 2, the claim that the climate movement \"looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" is a hasty generalization. This sweeping statement about the demographic composition of the climate movement is based on anecdotal observation rather than specific, cited data, and is used to justify the need for environmental justice without robust evidence.\n4) In Point 3, the opening line \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic...\" is an appeal to emotion and a misrepresentation. It dramatizes the IPCC's findings with an unproven emotional state (\"apathetically,\" \"dead face\") rather than focusing on the scientific consensus and its implications, potentially undermining the credibility of the scientific body.\n**What You Could Have Done:**\n1) \"...I'd be able to pay for the $93 trillion Green New Deal. The scale of the Green New Deal's ambition highlights the inadequacy of vague calls for 'innovation' alone to address a crisis of this magnitude. This is the first way...\"\n2) \"...forcing Republicans to actually innovate. The Green New Deal has effectively shifted the political calculus, making inaction on climate change politically untenable for Republicans and thus compelling them to engage with concrete policy proposals.\"\n3) \"...they're also very white. Data from various climate organizations indicates a significant lack of diversity within leadership and participation in the mainstream climate movement, highlighting the urgent need for a focus on environmental justice.\"\n4) \"...said, we're all going to die. Their dead face was a little apathetic... The Intergovernmental Panel on Climate Change's stark warnings about the irreversible impacts of climate change underscore the urgent need for comprehensive global action, a challenge that the Green New Deal seeks to address.\"\n\n### Strength of Evidence - 12/16\n**What Worked:**\n1) The speaker uses a good number of unique sources (9 total: The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, The National Interest), providing a diverse range of perspectives.\n2) Most sources are reputable news organizations (e.g., The Atlantic, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, Scientific American, The National Interest), lending credibility to the claims.\n3) The speaker consistently provides dates for nearly all sources (e.g., \"The Atlantic tells us on June the 12th of 2019,\" \"Washington Post tells us on April the 3rd of 2019,\" \"Scientific American from January of this year\"), which is crucial for verifying timeliness.\n4) The evidence used in Point 2, such as the statistic about \"1.6 million Americans live near a trash incinerator\" and the doubled asthma rates in New Jersey, directly supports the claim about tangible harms and the need for environmental justice.\n**Critical Flaws:**\n1) While dates are provided, many sources are from 2018-2019 (e.g., The Atlantic June 2019, Washington Post April 2019, Politico March 2019, The Guardian May 2019, Vox March 2019, LA Times December 2018, NY Times March 2019, National Interest June 2019). Given the current date of August 2026, these sources are 7-8 years old, which is not recent enough for a rapidly evolving topic like environmental legislation and political discourse.\n2) In Point 1, the speaker cites the Washington Post for the statistic that \"Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action.\" While the source is good, the specific year of the poll is not provided, making it impossible to assess the timeliness of this crucial data point.\n3) The Scientific American article from \"January of this year\" (presumably January 2026) is cited for the statistic that \"emissions rose by 3.8%.\" While recent, the speaker does not specify which emissions (e.g., global, US, specific sector) or over what period, making the data less precise and its application less impactful.\n**What You Could Have Done:**\n1) (For all dated sources from 2018-2019) Replace with more recent articles (2024-2026) that reflect current political realities and legislative developments regarding the Green New Deal and environmental policy.\n2) \"...Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action according to a 2025 poll.\"\n3) \"...Scientific American from January of this year that global carbon emissions rose by 3.8% in 2025.\"\n\n### Clarity - 7/10\n**What Worked:**\n1) The overall structure of the speech is clearly signposted, with explicit statements for the thesis, preview, and transitions between body points, allowing a listener to easily follow the argument's progression.\n2) The speaker generally avoids overly academic jargon or unexplained acronyms, making the content accessible to a broad audience.\n3) The thesis statement and main points are articulated in straightforward language, ensuring the core message is easily understood.\n**Critical Flaws:**\n1) Awkward phrasing: The line \"the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" is clunky and attempts sarcasm that might not land clearly without vocal inflection.\n2) Vague pronoun: In Body 1, \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate.\" The repeated \"that the\" is a stutter, and \"this\" refers broadly to the preceding examples of Republican proposals without a clear, concise antecedent.\n3) Conciseness check: The phrase \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" is a run-on sentence that could be tightened.\n4) Filler/fluff audit: The phrase \"We're not simply going to just pass this 14-page resolution\" contains the filler word \"just,\" which could be removed without changing the meaning.\n5) Awkward phrasing: In Body 2, \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators.\" The phrase \"climate and motivations on these incinerators\" is unclear and grammatically awkward.\n**What You Could Have Done:**\n1) \"...the paradigm of journalistic integrity, ironically called her Alexandria Ocasio-Cortez.\"\n2) \"...This is a showing that the that the Green New Deal is part of a way to guide future climate debate. These Republican responses demonstrate that the Green New Deal is part of a way to guide future climate debate.\"\n3) \"We're not simply going to pass this 14-page resolution but rather use it to come to bipartisan solutions like a carbon tax...\"\n4) \"We're not simply going to pass this 14-page resolution.\"\n5) \"In my home state of New Jersey, it's doubled the rate of asthma because of the environmental impact of these incinerators.\"\n\n### Conclusion Strength - 6/8\n**What Worked:**\n1) The summary accurately restates the three main points, using slightly varied but clear language: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\"\n2) The conclusion provides a satisfying, intentional echo back to the exact hook used in the introduction by referencing AOC's \"complicated name\" and the \"three letters we need to learn about the Green New Deal.\"\n**Critical Flaws:**\n1) The conclusion lacks a genuine call to action or a forward-looking statement beyond summarizing the points and echoing the hook. The final \"Y-E-A\" feels more like a rhetorical flourish than a substantive call to engagement or a vision for the future.\n2) While the summary is accurate, it is quite brief and could benefit from slightly more elaboration on the significance of each point before moving to the final echo.\n**What You Could Have Done:**\n1) \"...by leading to global universality. The Green New Deal offers a comprehensive vision that demands our attention and active participation to shape a sustainable and equitable future. AOC might have a complicated name...\"\n2) \"...by leading to global universality. From shifting political discourse to empowering marginalized communities and inspiring international cooperation, the Green New Deal represents a pivotal moment for environmental policy. AOC might have a complicated name...\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 14/20\n**What Worked:**\n1) Tone/Pitch Variety: The speaker exhibits \"High \u2014 expressive\" vocal variety with 3151 significant pitch shifts and a standard deviation of 81.6Hz, which helps maintain listener engagement and prevents a monotone delivery.\n2) Pacing: The pace of 160 words per minute is \"Solid competitive pace,\" indicating the speaker delivers the information at a rate that is both understandable and efficient for an extemp speech.\n3) Pauses: The speaker uses pauses strategically, with 7 pauses longer than 0.4s, averaging 1.05s, which allows for emphasis and helps segment ideas effectively.\n**Critical Flaws:**\n1) Filler Words: The auto-count detected 4 filler words (\"actually\"\u00d71, \"like\"\u00d73), which is a low count, but a closer listen reveals additional instances of verbal crutches. For example, \"We're not simply going to just pass this 14-page resolution\" and \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax.\" (The auto-count likely missed the second \"just\" and counted \"like\" as grammatical). The presence of these, even if few, slightly detracts from fluency.\n2) Emphasis Placement: While 20% of words were emphasized, many of these emphasis points landed on less rhetorically important words, such as \"THE Atlantic,\" \"THE deal,\" \"MET with regret,\" \"BUT also,\" \"IN an article,\" and \"WE have.\" This inconsistent emphasis placement can make it harder for the listener to discern the truly critical points of the speech.\n3) Volume: The average volume of -23.1 dBFS is rated \"Adequate\" (subscore 8/10). While not critically low, it indicates there is room for stronger projection to ensure the speaker consistently commands the room and is easily heard, especially in a larger tournament setting.\n4) Stutters/Repetitions: There was 1 instance of a stutter (\"that the that the Green New Deal\"), which, while a low count, indicates a momentary lapse in fluency that could be polished.\n**What You Could Have Done:**\n1) (Practice removing filler words) \"We're not simply going to pass this 14-page resolution.\"\n2) (Practice emphasizing key terms) \"...article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November...\"\n3) (Practice projecting more consistently) Focus on maintaining a consistent, strong volume throughout the speech, especially during transitions and key arguments, aiming for an average closer to -18 dBFS.\n4) (Practice smooth delivery) \"This is a showing that the Green New Deal is part of a way to guide future climate debate.\"\n\n### Total Composite Score: 68/100\n\n### Judge's Rank: 3/5\n\n### Rank Explanation:\nThis speech would place 3rd against 5 other competitors on this question. The speaker demonstrates a solid understanding of extemp structure and delivers a creative, engaging introduction and conclusion. The arguments are generally well-supported by a good number of sources, and the vocal delivery is strong in terms of pace and variety. However, the speech is hampered by dated evidence, some instances of logical fallacies and awkward phrasing, and a noticeable imbalance in point timing. The lack of consistent callbacks to the AGD in the body also weakens the overall narrative coherence.\n\n### Actionable Drill for Next Round:\nDated Source Audit & Replacement Drill: Go through the entire speech transcript and highlight every source citation. For each highlighted source, specifically identify its date. Then, using a search engine, find three more recent (within the last 12-18 months) and equally reputable sources that could replace the outdated ones, focusing on current developments in environmental legislation and political discourse around the Green New Deal. Practice integrating these newer sources into the speech, ensuring the new dates are explicitly stated and the evidence is applied to the current context.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[FALSE] AOC proposed the influential Green New Deal in November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Green New Deal resolution was officially introduced by AOC and Senator Ed Markey in February 2019, not November 2018. While the concept might have been discussed earlier, the formal resolution was introduced in 2019. The Atlantic article from June 12, 2019, does not state that it was proposed in November as a 14-page white paper congressional resolution.\n\n[UNVERIFIED] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019 (implied)\n  While 'The Atlantic' likely covered the Green New Deal, a specific article from June 12, 2019, detailing it being met with both 'regret' and 'immense popularity' could not be definitively confirmed with the provided search results. Public opinion on the Green New Deal was mixed, with some polls showing support for its goals but concern over costs.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019 (implied)\n  New Consensus, a think tank, was indeed involved in developing the Green New Deal framework. Their website, active in February 2019, outlined the goals and vision for the Green New Deal as a transformative national project, consistent with working towards a policy agenda.\n\n[FALSE] Emissions rose by 3.8% in January of this year (referring to 2019 or 2020 based on context).\n  Cited source: Scientific American, January of this year\n  A Scientific American article from January 2019 discussed a 3.4% rise in U.S. greenhouse gas emissions in 2018, not 3.8%. A January 2020 report from Rhodium Group, as cited by Inside Climate News, indicated that U.S. emissions fell by 2% in 2019 after a 3% increase in 2018. No Scientific American article from January 2019 or 2020 reported a 3.8% rise.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post article from April 2, 2019 (published April 3 online), discusses how Republican rhetoric on climate change has shifted, noting that for years, Republicans cast doubt on whether climate change was even occurring, supporting the idea that they previously saw it as a 'figment of political imagination'.\n\n[TRUE] In 2011, Mitt Romney ran on a campaign saying he didn't know if humans caused climate change, and neither his nor the 2016 Republican campaign proposed sweeping climate solutions.\n  Cited source: (no source given)\n  Mitt Romney did express uncertainty about human causation of climate change during his 2012 presidential campaign. Additionally, the 2012 and 2016 Republican platforms generally did not propose sweeping climate solutions.\n\n[FALSE] 64% of Republicans believe climate change is a severe threat, and 45% of all Americans believe immediate action is needed.\n  Cited source: The Washington Post (implied April 3, 2019)\n  A Washington Post-Kaiser Family Foundation poll from September 2019 found that a majority of Republicans (60%) believed human activity causes climate change, but it did not state that 64% of Republicans see it as a severe threat. A 2023 Washington Post-University of Maryland poll indicated 55% of Republicans agree human activity causes climate change, and 37% believe their area will be affected by climate change in 20 years. The claim of 45% of all Americans needing immediate action is also not directly supported by the search results for the specified timeframe, though general concern for climate action is present.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen.\n  Cited source: Politico, March 26, 2019\n  A Politico article from March 22, 2019 (related to March 26 or April 3, 2019 content), and other sources from that period, indicate that the Green New Deal prompted Republicans to propose their own climate-related ideas, suggesting it influenced their engagement with the issue.\n\n[TRUE] Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy.\n  Cited source: Politico, March 26, 2019\n  Senator Lamar Alexander (R-Tenn.) did propose a 'New Manhattan Project for Clean Energy' as a Republican response to climate change, as reported by Oil & Gas Journal on March 27, 2019, and Newsweek on the same date, which aligns with the Politico date.\n\n[TRUE] Matt Gaetz of Florida proposed a Green Real Deal, combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  Representative Matt Gaetz (R-Fla.) did propose a 'Green Real Deal' resolution as an alternative to the Green New Deal. Politico reported on March 22, 2019, that he was circulating a draft, and on April 3, 2019, that he released it, calling for the government to cut greenhouse gases and promote clean energy, including investing in carbon-capture storage.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators in the US, disproportionately affecting low-income and minority communities, and these pollutants are linked to health problems like asthma and heart disease. While the article mentions health problems, it does not specifically link to 'maternal mortality' in the provided snippets.\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act in 2021) with a focus on equity and job creation, a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and a focus on hiring marginalized people could not be confirmed with the provided search results for that exact date and specific numbers.\n\n[TRUE] The most sweeping climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  The Paris Agreement, adopted in 2015, sets a long-term goal of limiting global warming to well below 2 degrees Celsius above pre-industrial levels, while pursuing efforts to limit the increase to 1.5 degrees Celsius. The agreement relies on Nationally Determined Contributions (NDCs) from each country, which are voluntary and do not inherently include a strict enforcement mechanism, leading to criticisms about the lack of concrete 'how-to' mechanisms. A December 2019 LA Times article mentions the 1.5-degree goal and that the talks fell short of demanding bolder emissions proposals.\n\n[TRUE] The Green New Deal originated in the UK, but Alexandria Ocasio-Cortez's accessibility with it has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  The concept of a 'Green New Deal' has roots in the UK and other parts of the world prior to the US proposal. Alexandria Ocasio-Cortez and Ed Markey's introduction of the Green New Deal resolution in the US in February 2019 significantly raised its profile and made it a prominent topic globally, as noted by various sources including Wikipedia.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  Wikipedia, citing various sources, confirms that proposals for a 'Green New Deal' have arisen in Europe, the United States, and other parts of the world, including Canada, since the 2000s and especially since 2019. In early May 2019, a coalition launched the Pact for a Green New Deal in Canada. The European Green Deal was launched in 2019 by President von der Leyen.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    qwen38: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n**What Worked:**\n1) The mispronunciation bit is a genuinely creative and humorous AGD \u2014 \"One cable pundit called her Alessandra Oxycontin\" is specific, funny, and immediately memorable, far superior to a generic quote or statistic opener.\n2) The three-letter pivot from AOC to GND is a clever structural device that links the hook directly into the topic: \"there are three letters also attached to her name, GND, standing for the Green New Deal\" \u2014 this makes the transition feel organic rather than forced.\n3) The thesis is explicit and unambiguous: \"The answer simply is that it will serve as the bedrock for future environmental legislation\" leaves no doubt about the speaker's position.\n4) The preview formally lists all three points with clear ordinal markers (\"First... more broadly... and finally, and perhaps most importantly\"), making it easy for a judge to flow.\n**Critical Flaws:**\n1) The introduction is severely bloated with background exposition \u2014 between the AGD and the thesis, the speaker crams in The Atlantic article, the Scientific American emissions statistic, the New Consensus think tank, and a reference to Sudan and Yemen. This dilutes the hook's impact and delays the thesis by roughly 200 words of context that could have been distributed into the body or cut entirely.\n2) The Lou Dobbs joke \u2014 \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" \u2014 relies on sarcasm that may not land for every judge, and the punchline (that he pronounced it correctly) is undercut because the audience has to parse the irony while also processing the setup.\n**What You Could Have Done:**\n1) After the GND pivot, cut directly to the thesis: \"there are three letters also attached to her name, GND, standing for the Green New Deal. And that's exactly why we have to ask today's question: How will the Green New Deal influence future environmental legislation?\" \u2014 move the Atlantic background, the Scientific American stat, and the New Consensus reference into Body 1 or Body 3 where they'd serve as supporting evidence rather than intro padding.\n2) \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez \u2014 which, ironically, is the correct pronunciation. The point isn't that they can't say her name; it's that they can't ignore her.\"\n\n### Structure - 7/10\n**What Worked:**\n1) The organizational skeleton is complete and correctly ordered: single AGD \u2192 link \u2192 thesis \u2192 formal preview \u2192 three distinct body points \u2192 conclusion with callback. No element is missing or blurred.\n2) The transition into Body 2 is functional and signposted: \"Secondly, we have to look more broadly to the question of environmental justice\" clearly marks the shift and echoes the preview language.\n3) The conclusion's \"Y-E-A\" callback to the three-letter motif introduced in the AGD (AOC \u2192 GND \u2192 YEA) is a satisfying structural bookend that rewards the audience for tracking the throughline.\n**Critical Flaws:**\n1) The transition from Body 1 to Body 2 is abrupt \u2014 the speaker ends Body 1 with \"to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions\" and then jumps directly to \"Secondly, we have to look more broadly...\" with no bridging sentence connecting bipartisan action to environmental justice. A single linking line explaining why bipartisanship alone is insufficient would smooth this seam.\n2) The AGD's mispronunciation/three-letter motif goes completely silent through all three body points \u2014 there is no mid-speech callback until the conclusion's \"Y-E-A.\" The throughline disappears for roughly 75% of the speech's duration.\n3) Timing breakdown (word-count-based, 470s total recording): Introduction ~25.4% (~119s), Body 1 ~24.6% (~116s), Body 2 ~23.8% (~112s), Body 3 ~18.3% (~86s), Conclusion ~7.9% (~37s). Against the competitive benchmark of 14/26/26/26/7: the Introduction is nearly double its target share, stealing roughly 50 seconds that should have gone to Body 3, which is severely underweighted at 18.3% versus the 26% benchmark. This directly explains why Point 3 feels rushed and underdeveloped compared to Points 1 and 2.\n4) The transition into Body 3 \u2014 \"Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours\" \u2014 launches into a narrative anecdote before signposting the point's claim, forcing the listener to wait several sentences before understanding where they are in the argument.\n**What You Could Have Done:**\n1) \"...one that allows us to grow our economy while cutting emissions. But bipartisanship alone won't solve this crisis if the solutions only protect certain communities \u2014 Secondly, we have to look more broadly to the question of environmental justice...\"\n2) In Body 2, after the Illinois bill example: \"In this way, we're considering an impact that isn't just a greener world. Just as AOC's name was too complicated for pundits to bother learning, the communities affected by these incinerators have been too easy for policymakers to ignore \u2014 We're making sure that those who have been the most marginalized...\"\n3) Reallocate roughly 40-50 seconds from the Introduction (cut the Scientific American stat, the New Consensus reference, and the Sudan/Yemen line) into Body 3, giving it space to develop the global-paradigm argument with the same depth as Points 1 and 2.\n4) \"Finally, and perhaps most importantly, the Green New Deal's influence won't stop at America's borders \u2014 it's already reshaping the global conversation. At the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change...\"\n\n### Strength of Argument & Analysis - 10/16\n**What Worked:**\n1) Body 2's argument is the strongest in the speech: the claim that GND democratizes climate policy is supported by a clear Evidence \u2192 Warrant \u2192 Impact chain. The Guardian's \"1.6 million Americans live near a trash incinerator\" provides concrete evidence; the warrant connects this to marginalized communities (\"higher rates of asthma and maternal mortality\"); and the impact ties back to the thesis by showing how GND's policy proposals (jobs guarantee, universal healthcare) address the equity gap that previous climate legislation ignored.\n2) The Vox citation on Illinois's equity environmental justice bill functions as a real-world proof-of-concept: \"40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people\" demonstrates that GND-style thinking is already producing legislation, not just remaining theoretical.\n3) Body 1's framing of the GND as a strategic \"Democratic ploy\" that reframes the innovation debate is an interesting analytical angle \u2014 it positions the GND not as policy to be passed but as a political weapon that forces opponents onto new ground.\n**Critical Flaws:**\n1) Body 3's core claim \u2014 that the GND will lead to \"a new unified global paradigm\" \u2014 is asserted far more than proven. The evidence (candidates in Spain, Sweden, Norway, and Canada running on GND agendas) shows correlation but the speaker never explains the causal mechanism: HOW does a U.S. congressional resolution create a \"unified platform\" abroad? The missing warrant is that the GND provides a specific policy template (unlike the Paris Accords' goal-only framework) that other nations can adapt \u2014 but the speaker never articulates this.\n2) Body 1 fails the \"So What?\" test on its final piece of evidence. After citing Lamar Alexander's \"Manhattan Project on Clean Energy\" and Matt Gaetz's \"Green Real Deal,\" the speaker says \"This is a showing that the that the Green New Deal is part of a way to guide future climate debate\" \u2014 but never explains what specific legislative outcome this will produce. The missing analysis: these Republican proposals, even if weaker, establish a negotiating baseline from which actual bipartisan legislation (like a carbon tax) can emerge, because both parties now have proposals on the table.\n3) The speaker's personal anecdote in Body 2 \u2014 \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" \u2014 is dropped without explanation of what \"climate and motivations\" means (likely a garbled phrase for \"climate change and industrial motivations\" or similar), and without connecting it back to the GND specifically. The personal touch could have been powerful but instead becomes confusing.\n4) Body 3's Paris Accords critique (\"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\") is a strong analytical point, but the speaker never explicitly contrasts this with what the GND does differently \u2014 the missing sentence is something like: \"The GND, by contrast, proposes specific mechanisms: a jobs guarantee, infrastructure investment, and emissions targets with timelines.\"\n5) The verdict across all three points: Point 2 is STRONG (clear evidence-warrant-impact chain), Point 1 is MODERATE (interesting framing but thin on the \"so what\"), and Point 3 is WEAK (assertion-heavy, mechanism missing). Overall: MODERATE.\n**What You Could Have Done:**\n1) After the National Interest citation in Body 3: \"the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda. This isn't coincidence \u2014 the GND provides what the Paris Accords never could: a specific, adaptable policy template with concrete mechanisms like jobs guarantees and infrastructure timelines that other nations can modify for their own contexts. That's what makes it a paradigm, not just a slogan.\"\n2) After citing Alexander and Gaetz in Body 1: \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. And here's why that matters legislatively: once both parties have proposals on the table, the negotiation shifts from whether to act to how to act \u2014 and that's the exact conditions under which a bipartisan carbon tax becomes politically viable.\"\n3) \"In my home state of New Jersey, industrial incinerators have doubled the rate of asthma in communities of color \u2014 and the Green New Deal's environmental justice provisions would directly target these same communities for remediation funding and clean-energy job placement.\"\n4) After the Paris Accords critique: \"The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. The Green New Deal flips this: instead of starting with a temperature target and hoping nations figure out the rest, it starts with specific policy mechanisms \u2014 a jobs guarantee, infrastructure investment, sector-by-sector emissions timelines \u2014 that other countries can adapt to their own economies.\"\n\n### Flaws in Reasoning - 7/12\n**What Worked:**\n1) Body 2 avoids the common extemp trap of treating environmental justice as purely moral suasion \u2014 instead, the speaker grounds it in a concrete legislative outcome (the Illinois bill), which gives the point a factual anchor rather than relying on emotional appeal alone.\n2) The overall three-point structure avoids the slippery slope fallacy \u2014 the speaker doesn't claim the GND will solve climate change entirely, but rather that it will \"influence\" future legislation, which is a proportionate and defensible claim.\n**Critical Flaws:**\n1) Post hoc ergo propter hoc in Body 1: \"the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy.\" The speaker assumes that because Republican proposals came after the GND, the GND caused them. But the Washington Post's own polling data (64% of Republicans see climate change as a threat) provides an alternative explanation: shifting public opinion alone could drive these proposals without the GND as the specific catalyst. The speaker conflates two possible causes.\n2) Straw man / hyperbole in Body 3's opening: \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die.\" The IPCC did not say \"we're all going to die\" \u2014 this is a fabricated quote presented as fact, used to set up a mocking tone (\"Their dead face was a little apathetic\"). This undermines the speaker's credibility on the very point where they need to be most precise.\n3) False analogy in the conclusion: \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon.\" This analogy implies that climate action is comparable in scope and feasibility to the Apollo program, but the two are fundamentally different \u2014 Apollo was a discrete engineering challenge with a clear endpoint; climate change is an ongoing, systemic problem requiring sustained behavioral and economic transformation. The analogy trivializes the complexity of the issue.\n4) Unproven assumption in Body 1: \"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal.\" This joke treats the $93 trillion figure as an absurd, self-evident cost \u2014 but it's actually a cumulative estimate over 10+ years that includes social programs (healthcare, housing) unrelated to climate spending. Using it as a punchline without context implicitly accepts a misleading framing of the GND's cost.\n5) Contradiction between Body 1 and Body 3: Body 1 argues the GND's value is in forcing bipartisan (i.e., domestically political) action, while Body 3 argues its value is in creating a global paradigm. The speaker never reconciles how a resolution that can't even pass the U.S. Senate is simultaneously reshaping policy in Spain, Sweden, Norway, and Canada. If the GND is a \"Democratic ploy\" domestically (Body 1's framing), how is it a genuine global policy template (Body 3's framing)? This tension goes unaddressed.\n**What You Could Have Done:**\n1) \"the Green New Deal and the poll numbers are finally forcing Republicans to listen. Now, it's true that shifting public opinion alone could explain this \u2014 but the GND accelerated the timeline by giving Republicans a specific target to respond to, rather than a vague scientific consensus they could ignore.\"\n2) \"at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change released a report warning that we have roughly a decade to halve global emissions or face catastrophic warming. The tone was measured, but the message was urgent \u2014 and the world's response has been anything but.\"\n3) \"We landed a man on the moon in eight years with a clear engineering target. Climate change is harder than that \u2014 it requires transforming entire economies, not just building one rocket. But the GND gives us something Apollo had: a specific, actionable plan rather than just a goal.\"\n4) \"If I had a nickel for every time they said innovation, I'd be able to pay for the portion of the $93 trillion Green New Deal that actually funds climate infrastructure \u2014 because that headline number includes healthcare, housing, and jobs programs that Republicans would fund separately anyway.\"\n5) Add a reconciliation sentence at the start of Body 3: \"You might wonder: if the GND is a domestic political weapon, as I argued in my first point, how can it also be a global template? The answer is that its domestic political success \u2014 the very fact that it forced Republicans to respond \u2014 is what gave it international credibility. Other nations saw a policy framework that actually moved the needle in the world's largest economy.\"\n\n### Strength of Evidence - 13/16\n**What Worked:**\n1) The source count is excellent: 9 unique sources across the speech (The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, LA Times, New York Times, National Interest), well above the 1-2 per point benchmark. This gives the speech a researched, authoritative feel.\n2) Every single source is dated with at least a month and year, and most include a specific day: \"June the 12th of 2019,\" \"April the 3rd of 2019,\" \"March the 26th of 2019,\" \"May the 21st of 2019,\" \"March the 7th of 2019,\" \"June the 4th of 2019.\" This is best-practice citation in extemp and allows the judge to verify timeliness.\n3) Source quality is consistently high \u2014 The Guardian, Washington Post, New York Times, Politico, and The Atlantic are all authoritative outlets appropriate for a policy question. No blog posts, no partisan think-tank-only citations.\n4) The Vox citation on the Illinois equity environmental justice bill is particularly well-applied: it provides a concrete, specific legislative outcome (40 million solar panels by 2050, focus on hiring marginalized people) that directly proves the point rather than merely gesturing at it.\n**Critical Flaws:**\n1) The Scientific American citation \u2014 \"emissions rose by 3.8%\" \u2014 is dropped into the introduction without context: 3.8% of what? U.S. emissions? Global emissions? In what year compared to what baseline? The statistic is too vague to be meaningful as delivered, and it's placed in the intro where it serves as background rather than supporting any specific argument.\n2) The National Interest citation (\"candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\") is the weakest source in the speech \u2014 National Interest is a foreign policy magazine with a realist/editorial bent, not a news outlet that would typically report on domestic climate platforms in four countries. The claim itself is also vague: \"run on a Green New Deal agenda\" could mean anything from explicitly endorsing the U.S. resolution to merely using similar rhetoric.\n3) The LA Times citation on the Paris Accords (\"the most sweeping piece of climate legislation we have around the world\") is from December 2018, making it roughly 6-7 months old by the time of this speech. For a point about the current global landscape, this is slightly dated \u2014 the speaker could have noted whether anything had changed in the interim.\n**What You Could Have Done:**\n1) \"we see in an article from the Scientific American from January of this year that U.S. carbon emissions rose by 3.8% in 2018 compared to 2017, reversing three consecutive years of decline.\"\n2) Replace or supplement the National Interest citation: \"The Guardian reported on May 21st that candidates in Spain, Sweden, Norway, and even Canada have explicitly cited the U.S. Green New Deal resolution as a model for their own climate platforms, with Spain's Unidas Podemos party adopting a nearly identical jobs-guarantee framework.\"\n3) \"We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. And in the six months since that article was published, not a single signatory nation has strengthened its commitments \u2014 confirming that the Accords remain a goal without a mechanism.\"\n\n### Clarity - 6/10\n**What Worked:**\n1) The three-point preview is clearly numbered and easy to flow: \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy.\"\n2) The Comic-Con/Bernie Sanders rally comparison in Body 2 \u2014 \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" \u2014 is vivid, specific, and immediately paints a picture for the audience without requiring background knowledge.\n3) Signposting at the start of each body point is present and consistent (\"This is the first way...\" / \"This is the second way...\" / \"And it's the final way...\"), allowing a listener to track their position.\n**Critical Flaws:**\n1) \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" \u2014 \"climate and motivations\" is garbled and meaningless as delivered. The listener cannot parse what causal mechanism is being described. This should likely read \"climate change and industrial motivations\" or \"the placement and operation of these incinerators.\"\n2) \"This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice\" \u2014 this sentence has two competing grammatical structures (\"we can change\" vs. \"the Green New Deal is influencing\") crammed together, making it nearly impossible to parse on first listen. The pronoun \"it\" is ambiguous (does it refer to \"the Green New Deal\" or \"future environmental legislation\"?).\n3) \"Their dead face was a little apathetic\" \u2014 \"dead face\" is not a phrase with clear meaning. The speaker appears to be describing the IPCC scientists' expressions, but \"dead face\" could mean expressionless, could be a malapropism for \"deadpan,\" or could be an accidental phrase. A listener would stumble here.\n4) \"we won't just have a world where we're not swimming all the time\" \u2014 this is presumably a reference to sea-level rise, but it's delivered as a throwaway joke without setup. A listener unfamiliar with the context would not understand what \"swimming\" refers to, and the casual tone undercuts the seriousness of the point.\n5) \"the Green New Deal is creating a unified platform where we can all cut reductions\" \u2014 \"cut reductions\" is a malapropism. You cut emissions or make reductions; you don't \"cut reductions\" (which would mean reducing the reductions, i.e., doing less). This is a logical error embedded in a clarity problem.\n6) Filler/qualifier audit: \"just\" appears 4 times (\"just pass this 14-page resolution,\" \"just alternative energy,\" \"just have a world,\" \"just a greener world\"); \"simply\" appears twice (\"The answer simply is,\" \"We're not simply going to\"); \"very\" appears 3 times (\"very different,\" \"very white,\" \"very apathetically\"). These qualifiers pad sentences without adding meaning.\n**Verdict: MODERATELY CLEAR** \u2014 the overall argument is followable, but multiple garbled phrases and malapropisms would cause a live judge to lose the thread at key moments.\n**What You Could Have Done:**\n1) \"In my home state of New Jersey, the concentration of industrial incinerators in low-income communities of color has doubled the rate of asthma.\"\n2) \"This is the second way the Green New Deal is influencing future environmental legislation: by democratizing climate policy through environmental justice.\"\n3) \"Their delivery was measured, almost understated \u2014 but it represents a global apathy towards sweeping climate change legislation.\"\n4) \"we won't just have a world where coastal cities aren't underwater, but also where everyone will be on an equal footing.\"\n5) \"the Green New Deal is creating a unified platform where we can all cut emissions.\"\n6) Replace \"The answer simply is\" with \"The answer is\"; replace \"We're not simply going to just pass\" with \"We're not going to pass\"; replace \"very white\" with \"predominantly white\" and \"very apathetically\" with a more precise descriptor.\n\n### Conclusion Strength - 6/8\n**What Worked:**\n1) The \"Y-E-A\" closer is a genuinely clever callback to the three-letter motif established in the AGD (AOC \u2192 GND \u2192 YEA). It rewards the audience for tracking the throughline and ends on a memorable, slightly humorous note that matches the speech's opening tone.\n2) The three points are restated clearly and in order: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\" \u2014 a judge could flow this without confusion.\n3) The conclusion explicitly returns to the question (\"That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation?\"), which is proper extemp form.\n**Critical Flaws:**\n1) The moon analogy \u2014 \"We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon\" \u2014 is a forced joke that doesn't logically connect to the speech's argument. The speech never discussed space, exploration, or engineering parallels; this line appears out of nowhere and undercuts the seriousness of the \"bedrock\" thesis.\n2) The conclusion doesn't deliver a genuine \"So What?\" close \u2014 it restates the thesis and points but never explains why the audience should care beyond the room. There's no forward-looking statement about what happens if the GND succeeds or fails, no call to action, no final insight that elevates the speech beyond summary.\n3) \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\" \u2014 while clever, \"Y-E-A\" is a stretch as an acronym (it doesn't stand for anything), which slightly weakens the callback compared to AOC and GND, which are real initialisms.\n**What You Could Have Done:**\n1) Replace the moon joke with a line that connects to the speech's actual content: \"The Green New Deal started as a 14-page resolution that pundits couldn't even pronounce the name of its author correctly. But in less than a year, it's already reshaping the debate from Tennessee to Toronto. That's not a resolution \u2014 that's a revolution in how we talk about climate.\"\n2) After restating the three points, add a forward-looking \"So What?\": \"And here's what that means for every person in this room: the next piece of climate legislation that passes \u2014 whether it's a carbon tax, an environmental justice bill, or an international agreement \u2014 will carry the GND's fingerprints. The question isn't whether it will influence policy. It's whether we'll let it.\"\n3) \"AOC might have a complicated name, but there are only three letters we need to remember about the Green New Deal. Y-E-A \u2014 yes, it's happening.\"\n\n### Speech Quality \u2014 Vocal Delivery & Fluency - 14/20\n**What Worked:**\n1) Tone/pitch variety is excellent: 3151 significant pitch shifts with a standard deviation of 81.6Hz rates as \"High \u2014 expressive.\" The speaker clearly modulates their voice to match content energy, avoiding the monotone delivery that plagues many extemp speakers.\n2) Pacing is solid at 160 words per minute over 470 seconds \u2014 right in the competitive sweet spot of 150-175 wpm. The speech neither rushes nor drags.\n3) Pause usage is controlled: 7 pauses longer than 0.4s averaging 1.05s each. This is a reasonable number for a 7+ minute speech, suggesting the speaker uses pauses deliberately rather than filling every gap with sound.\n4) The auto-detected filler count is low (4 total: \"actually\"\u00d71, \"like\"\u00d73), and the single stutter instance (\"the that the Green New Deal\") is minor. This indicates generally clean fluency.\n**Critical Flaws:**\n1) Emphasis placement is the primary delivery weakness: of the 245 emphasized words, a disproportionate number land on function words \u2014 articles (\"THE\"\u00d73, \"A\"\u00d72), prepositions (\"TO\"\u00d72, \"IN\"\u00d71, \"BY\"\u00d71), conjunctions (\"AND\"\u00d73, \"BUT\"\u00d72), and pronouns (\"I\"\u00d72, \"WE\"\u00d71). Emphasizing \"the,\" \"a,\" \"to,\" and \"and\" wastes the rhetorical tool of vocal stress on words that carry no meaning. Meanwhile, key content words like \"bedrock,\" \"bipartisan,\" \"environmental justice,\" and \"global paradigm\" don't appear in the emphasis list at all.\n2) Volume at -23.1 dBFS is \"Adequate\" but below the -18 dBFS threshold for full marks. The speaker projects enough to be heard but lacks the commanding presence that separates good delivery from great delivery \u2014 in a large room or against a louder competitor, this would be a disadvantage.\n3) The qualifier fillers missed by the auto-scan: \"just\" appears 4 times as a verbal crutch (\"just pass this 14-page resolution,\" \"just alternative energy,\" \"just have a world,\" \"just a greener world\"), and \"simply\" appears twice. Combined with the auto-detected \"like\"\u00d73, the speaker has a pattern of hedging qualifiers that soften their claims.\n4) The repeated word \"climate climate solution\" (Body 1) and the garbled \"the that the Green New Deal\" (Body 1) are fluency stumbles that, while minor individually, cluster in the same section and suggest a momentary loss of composure.\n**What You Could Have Done:**\n1) Practice emphasizing content words instead of function words: in the sentence \"The answer simply is that it will serve as the bedrock for future environmental legislation,\" stress should land on ANSWER, BEDROCK, and LEGISLATION \u2014 not on \"that,\" \"is,\" or \"the.\" Drill this by reading your thesis statement aloud and deliberately hitting only the nouns and verbs.\n2) Increase projection by practicing the speech at a volume that feels slightly too loud in rehearsal \u2014 the -23.1 dBFS reading suggests the speaker is holding back. Aim for -18 dBFS or above.\n3) Replace \"just\" with nothing (delete it) or with a more precise word: \"We're not merely going to pass this 14-page resolution\" / \"we've often looked only to alternative energy.\" Replace \"simply\" with nothing: \"The answer is that it will serve as the bedrock.\"\n4) Slow down slightly in Body 1 where both stumbles occur \u2014 the \"climate climate\" and \"the that\" repetitions suggest the speaker is moving faster than their articulation can keep up in that section.\n\n### Total Composite Score: 70/100\n\n### Judge's Rank: 2/5\n\n### Rank Explanation:\nThis speech would place 2nd against 5 other competitors on this question. The speaker's core strengths are a genuinely creative and memorable hook, an outstanding evidence base (9 dated, authoritative sources), and expressive vocal delivery with strong pitch variety and controlled pacing. These elements elevate the speech well above the median. However, the bloated introduction (25% of speech time versus a 14% target), the underdeveloped and logically weak third point, multiple garbled phrases that would confuse a live judge (\"climate and motivations,\" \"cut reductions,\" \"dead face\"), and a pattern of post hoc reasoning and hyperbole in the argumentation prevent this from being a first-place speech. The gap between this speaker's strong research/creative instincts and their weaker analytical execution in Body 3 is the defining feature of the round.\n\n### Actionable Drill for Next Round:\nDrill: \"Mechanism Sentence\" practice for Body 3 development. The speech's single worst flaw is the underdeveloped third point, which asserts a global paradigm shift without explaining the causal mechanism. Practice this: take any extemp question, write your third body point's claim, then force yourself to write a single sentence that begins with \"The specific mechanism by which this happens is...\" before you cite any evidence. Do this for 5 different questions in a row, timing yourself at 30 seconds per mechanism sentence. This builds the habit of inserting the warrant between evidence and claim, which is exactly what was missing when the speaker jumped from \"candidates in Spain ran on a GND agenda\" to \"the GND is creating a unified platform\" without explaining how one causes the other.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal last November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  The Green New Deal resolution was introduced by AOC and Senator Markey in February 2019, not November 2018. It was a 14-page resolution. The Atlantic article from June 2019 discusses the Green New Deal.\n\n[TRUE] The Green New Deal was met with regret, but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific article from The Atlantic on June 12, 2019, wasn't found to explicitly state 'regret but immense popularity', other sources from around that time indicate mixed reactions, with some opposition but also significant public support for its underlying goals, especially among Democrats.\n\n[TRUE] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  New Consensus published a document on February 9, 2019, outlining a vision and goals for the Green New Deal, aiming to transform it into a comprehensive policy agenda, which aligns with the idea of working towards a sweeping policy agenda by 2020.\n\n[UNVERIFIED] Emissions rose by 3.8% in January of this year (referring to 2019 or 2020, likely 2019 given other dates).\n  Cited source: Scientific American, January of this year\n  A specific Scientific American article from January 2019 or 2020 stating a 3.8% rise in emissions was not found. General reports on emissions trends from that period exist, but this precise statistic and attribution could not be confirmed.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post article from April 3, 2019, discusses how Republican rhetoric on climate change has shifted, noting that for years, Republicans cast doubt on whether climate change was even occurring.\n\n[TRUE] Mitt Romney ran on a campaign in 2011 saying he didn't know if humans were a cause of climate change, and neither his 2011 nor 2016 campaign proposed sweeping climate solutions.\n  Cited source: (no source given)\n  Mitt Romney did express uncertainty about human causation of climate change during his 2012 presidential campaign (not 2011, but the sentiment is consistent with the speaker's point about past Republican stances). His campaigns were not known for proposing sweeping climate solutions.\n\n[FALSE] 64% of Republicans believe climate change is a severe threat, and 45% of all Americans believe we need immediate action.\n  Cited source: The Washington Post, April 3, 2019\n  A Washington Post-Kaiser Family Foundation poll published in September 2019 (not April 3, 2019) found that 60% of Republicans believe human activity causes climate change, but only 46% of Americans said drastic action is needed. Another Washington Post article from April 24, 2019, showed different numbers for support of the Green New Deal.\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen, with Senator Lamar Alexander proposing his Manhattan Project on Clean Energy and Matt Gaetz proposing a Green Real Deal.\n  Cited source: Politico, March 26, 2019\n  A Politico article from March 22, 2019 (close to March 26), confirms that Matt Gaetz was drafting a 'Green Real Deal' resolution. A TIME article from March 26, 2019, states that Senator Lamar Alexander proposed a 'New Manhattan Project' on clean energy, and that the Green New Deal had forced a discussion on climate change among Republicans.\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reports that 1.6 million Americans live near the most polluting incinerators, and these pollutants are linked to health problems including asthma and heart disease. It also notes that lower-income and minority communities are disproportionately affected.\n\n[UNVERIFIED] In Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (e.g., the Climate and Equitable Jobs Act in 2021), a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and a specific focus on hiring marginalized people in Illinois was not found. The dates and specific numbers don't align perfectly with readily available information.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) stated 'we're all going to die' at the beginning of this year, representing global apathy.\n  Cited source: (no source given)\n  While IPCC reports do issue dire warnings about climate change impacts, there is no record of climate scientists from the IPCC stating 'we're all going to die' in an apathetic manner at the beginning of 2019 (or any year). The IPCC communicates scientific findings, not emotional pronouncements.\n\n[TRUE] The most sweeping piece of climate legislation worldwide is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December of 2018\n  The Paris Agreement sets a long-term goal of limiting global warming to well below 2 degrees Celsius above pre-industrial levels, and pursuing efforts to limit it to 1.5 degrees Celsius. While it establishes goals, the mechanisms for achieving these are largely left to individual nations' determined contributions, which are often criticized for lacking sufficient detail or ambition to meet the targets. A Los Angeles Times article from December 2019 (not 2018) discusses the Paris Agreement's goals and shortcomings.\n\n[TRUE] The Green New Deal originated in the UK before the US proposed it in 2018, but AOC's accessibility has made it globally accessible.\n  Cited source: New York Times, March of 2019\n  The concept of a 'Green New Deal' has roots in the UK and was discussed prior to AOC's proposal. AOC's advocacy in 2019 significantly raised its profile and global awareness. A New York Times article from March 2019 was not specifically found to state this, but other sources confirm the UK origin and AOC's role in popularizing it.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, creating a unified platform for emissions reductions.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest article from June 4, 2019, states that the Green New Deal has become a global phenomenon, with politicians and parties in countries like Spain, Sweden, Norway, and Canada adopting similar agendas.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
    kimik3: "EXTEMPLARY \u2014 OFFICIAL PRACTICE BALLOT\nRound 1\nQUESTION: How will the Green New Deal influence future environmental legislation?\n\n### Creative Hook & Intro - 7/8\n- **What Worked:**\n1) The AGD is genuinely creative and specific \u2014 opening with cable pundits mangling AOC's name (\"One cable pundit called her Alessandra Oxycontin\") is a memorable, humorous narrative hook rather than a clich\u00e9 quote or statistic.\n2) The \"three letters\" device is a clever structural frame: \"while we commonly know her as AOC, there are three letters also attached to her name, GND\" converts the hook into a substantive link without an awkward gap.\n3) The thesis is explicit and answers the exact question drawn: \"The answer simply is that it will serve as the bedrock for future environmental legislation\" \u2014 no ambiguity about the speaker's side.\n4) The preview formally marks all three points: \"First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally... by leading to a new global paradigm on climate policy.\"\n- **Critical Flaws:**\n1) The Lou Dobbs joke misfires logically \u2014 \"Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez\" delivers the *correct* pronunciation as the punchline, so the sarcasm lands only if the audience already knows Dobbs mispronounced it; as written, the joke contradicts the setup that pundits \"are not always successful.\"\n2) The intro spends significant time on background summary (the Atlantic history of the resolution, New Consensus's 2020 agenda) before arriving at the question, delaying the link-to-question moment well past where a judge expects it.\n- **What You Could Have Done:**\n1) \"One cable pundit called her Alessandra Oxycontin**, and Lou Dobbs \u2014 the self-styled paradigm of journalistic integrity \u2014 managed to invent three entirely new syllables trying.**\"\n2) \"**We don't have much time to waste \u2014 emissions rose 3.8% last year alone. So before I trace the history of this resolution, let's answer the question that matters:** How will the Green New Deal influence future environmental legislation?\"\n\n### Structure - 8/10\n- **What Worked:**\n1) The full skeleton is present and correctly ordered: single AGD, link, explicit thesis, three-point preview, three distinct body paragraphs, and a conclusion that re-previews the points.\n2) The point-two-to-point-three transition is signposted with a vivid mini-AGD: \"climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die\" \u2014 a real transitional moment, not an abrupt jump.\n3) The conclusion delivers a genuine callback to the hook: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 the letters device bookends the speech intentionally.\n4) Timing breakdown (word-count-based, against the 470s recording): Introduction ~24% (~113s), Body 1 ~22% (~103s), Body 2 ~22% (~103s), Body 3 ~20% (~94s), Conclusion ~12% (~56s). The three body points are evenly weighted, which is a real strength.\n- **Critical Flaws:**\n1) The intro runs severely hot at ~24% versus the 14% benchmark (~113s vs. ~66s) \u2014 nearly a minute of background on the Atlantic article and New Consensus crowds out body development time, and the conclusion at ~12% (~56s vs. the 7%/~33s target) is correspondingly padded with a re-asked question and re-stated thesis.\n2) The intro-to-body-one transition is abrupt: the speaker jumps from the preview straight into \"Republicans for years have said that innovation is the way that we can solve climate change\" with no linking sentence connecting the preview to the innovation framing.\n3) There are no mid-body callbacks to the AOC-name hook \u2014 the letters device goes silent through all three body points and only resurfaces in the final sentence, so the throughline disappears for the middle four minutes.\n- **What You Could Have Done:**\n1) \"**We don't have much time to waste, so let's get straight to the question.** How will the Green New Deal influence future environmental legislation?\" \u2014 cutting the New Consensus paragraph entirely to bring the intro toward ~15%.\n2) \"...by leading to a new global paradigm on climate policy. **Let's start where the political fight is fiercest.** Republicans for years have said that innovation is the way that we can solve climate change.\"\n3) \"**Just as pundits fumbled AOC's name, Republicans fumbled her policy \u2014 until now.** An article from the Washington Post tells us on April the 3rd of 2019...\"\n\n### Strength of Argument & Analysis - 11/16\n- **What Worked:**\n1) Point 1's core claim \u2014 the GND forces bipartisan action \u2014 is well-supported and convincing: the Politico evidence (Alexander's \"Manhattan Project on Clean Energy,\" Gaetz's \"Green Real Deal\") shows named Republicans responding, and the speaker supplies the warrant: \"they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate.\" Evidence \u2192 warrant \u2192 thesis link is complete.\n2) Point 2's core claim \u2014 the GND democratizes climate policy via environmental justice \u2014 has the strongest \"so what\" moment in the speech: \"We're making sure that those who have been the most marginalized by our pollution are now the most advantaged\" explicitly explains why the Illinois bill matters rather than dropping it.\n3) Point 3's diagnosis of the Paris Accords is analytically sharp: \"it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there\" identifies a concrete gap that the GND-as-paradigm claim can plausibly fill.\n4) Point 1 engages the opposing view fairly at the top \u2014 \"Republicans for years have said that innovation is the way that we can solve climate change\" \u2014 then refutes it with the Romney 2011 evidence rather than ignoring it.\n- **Critical Flaws:**\n1) Point 3 proves something adjacent but not the thesis. The claim is that the GND creates \"a new unified global paradigm,\" but the NYT evidence concedes \"the Green New Deal has been around before the United States proposed it in 2018. It came from the UK\" \u2014 if the concept predates AOC's resolution, foreign candidates running on it doesn't prove *this* resolution influenced *future* legislation; the missing warrant is a sentence explaining why the U.S. version, specifically, is what globalized the agenda.\n2) Point 1's causal attribution is asserted, not demonstrated: \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal\" \u2014 the speaker never shows Alexander or Gaetz citing the GND; the missing \"so what\" is that correlation between the GND's introduction and GOP proposals isn't proof of influence without a statement, vote, or timeline linking them.\n3) Point 2's New Jersey claim is dropped without a warrant: \"In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators\" \u2014 no source, no mechanism, and the phrase \"climate and motivations\" is incoherent; the missing analysis is who conducted the study and how incinerator proximity (not \"climate\") drives the asthma rate.\n4) The \"$93 trillion\" figure is used only as a joke (\"If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal\") and never engaged as a substantive cost objection \u2014 the strongest argument against the GND-as-bedrock thesis is waved off, leaving the fairness test unmet at the speech level.\n- **Verdict: MODERATE** \u2014 Point 1 is genuinely convincing, Point 2 is strong on impact but soft on evidence, and Point 3's own sourcing undercuts its causal chain.\n- **What You Could Have Done:**\n1) \"It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. **That's the mechanism: before her resolution, 'Green New Deal' was a British think-tank phrase; after it, the National Interest shows candidates in Spain, Sweden, Norway, and Canada running on it as a platform \u2014 the U.S. resolution is what turned a concept into a campaign.**\"\n2) \"Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal**. Neither Alexander nor Gaetz proposed climate legislation in a decade in Congress \u2014 both moved within sixty days of the GND's introduction, and Gaetz explicitly branded his bill the 'Green Real Deal,' a direct response in name and substance.**\"\n3) \"In my home state of New Jersey, it's doubled the rate of asthma **\u2014 a Rutgers environmental health study found communities within a mile of the Newark incinerator suffer asthma at twice the state average, because particulate matter from incineration concentrates in the low-income neighborhoods zoned around them.**\"\n4) \"**Yes, critics peg the cost at $93 trillion \u2014 but that figure prices in the jobs guarantee and health care, not just energy, and the point of this speech is that even its critics are now legislating in its shadow.**\"\n\n### Flaws in Reasoning - 8/12\n- **What Worked:**\n1) The speaker avoids slippery-slope escalation \u2014 claims stay proportionate to evidence (e.g., the GND \"guides\" future debate rather than \"guaranteeing\" passage), and no fallacy of that type appears.\n2) The internal framing is consistent: \"bedrock\" is defined in the thesis and each point ties back to influence on *future* legislation rather than drifting into whether the GND itself should pass.\n- **Critical Flaws:**\n1) **Post hoc ergo propter hoc** in Point 1: \"the Green New Deal and the poll numbers are finally forcing Republicans to listen\" \u2014 the speaker's own sentence offers two causes (poll numbers AND the GND), then attributes the GOP shift to the GND without ruling out the polling explanation he himself cites. Severity: undermines Point 1's causal core, though the Gaetz naming evidence partially rescues it.\n2) **Hasty generalization** in Point 2: \"the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally\" \u2014 a joke substituting for evidence that the movement is demographically exclusionary; one punchline cannot establish the premise the entire point rests on. Severity: minor-to-moderate; the Guardian incinerator data does the real work anyway.\n3) **Straw man** in Point 1's framing of the GOP position: \"Republicans saw climate change as a figment of political imagination\" backed by a 2011 Romney quote \u2014 using an eight-year-old primary statement to represent the 2019 Republican position, when the speaker's own evidence shows the position has already evolved to \"innovation.\" Severity: moderate; it weakens the fairness of the setup.\n4) **Unproven causal leap** in Point 3: candidates in \"Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda\" is asserted to be the GND \"creating a unified platform\" \u2014 but the NYT evidence dates the concept to the UK before 2018, so the speaker never proves these foreign campaigns descend from AOC's resolution rather than the earlier British lineage. Severity: significant; it's the gap that keeps Point 3 from proving the thesis.\n- **What You Could Have Done:**\n1) \"The Green New Deal and the poll numbers are finally forcing Republicans to listen **\u2014 and while the polls set the stage, the GND wrote the script: Gaetz didn't name his bill the 'Green Real Deal' because of a poll.**\"\n2) \"**The climate movement's leadership and membership remain overwhelmingly white and affluent \u2014 which is why frontline communities have historically been afterthoughts in climate bills.**\"\n3) \"**As recently as 2016, the GOP platform rejected climate action outright \u2014 Romney's 2011 skepticism was the norm, not the exception \u2014 which makes the post-GND shift to actual proposals all the more striking.**\"\n4) \"**The concept may have been born in the UK, but the National Interest shows these candidates campaigning on it only after AOC's resolution made it a global brand \u2014 the U.S. version is the node that connected the network.**\"\n\n### Strength of Evidence - 12/16\n- **What Worked:**\n1) Source count and diversity exceed benchmark: eight unique citations (The Atlantic, Scientific American, Washington Post, Politico, The Guardian, Vox, Los Angeles Times, New York Times, plus National Interest) \u2014 roughly 2-3 per point, all reputable outlets.\n2) Dating discipline is strong: nearly every citation carries a day/month/year (\"The Atlantic tells us on June the 12th of 2019,\" \"Politico on March the 26th of 2019,\" \"The Guardian... on May the 21st of 2019\"), appropriate for a 2019 topic.\n3) The Politico citation is the best-applied evidence in the speech \u2014 named senators, named proposals, directly proving the \"bipartisan action\" claim rather than decorative name-dropping.\n- **Critical Flaws:**\n1) The Scientific American citation is under-specified: \"an article from the Scientific American from January of this year that emissions rose by 3.8%\" \u2014 no day attached, and no scope given (U.S. emissions? global?), so the statistic can't be weighed.\n2) The National Interest citation is misattributed in delivery: \"The national interest tells us on June the 4th of 2019\" appears mid-sentence inside the NYT discussion with no signposting that a new source has begun, making it flow as if the NYT said it.\n3) The New Jersey asthma doubling claim carries no citation at all \u2014 \"it's doubled the rate of asthma\" is the single most striking statistic in the speech and the only one delivered with zero sourcing.\n4) The Washington Post polling evidence is garbled as delivered: \"Republicans, now 64%, believe that climate change is a severe threat\" \u2014 64% of Republicans believing climate change is a severe threat is implausible on its face and likely a misread of an all-Americans figure; as delivered, the citation's application is confusing.\n- **What You Could Have Done:**\n1) \"**An article from Scientific American on January 8th of this year shows U.S. carbon emissions rose 3.8% in 2018 \u2014 the largest increase in eight years.**\"\n2) \"**And it's not just the New York Times \u2014 the National Interest reported on June 4th of 2019 that** candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\"\n3) \"**According to a Rutgers environmental health study,** in my home state of New Jersey, **living near these incinerators has** doubled the rate of asthma.\"\n4) \"**The Washington Post continues that 64% of Americans \u2014 including a growing share of Republicans \u2014** believe that climate change is a severe threat to our future survival.\"\n\n### Clarity - 7/10\n- **What Worked:**\n1) Signposting is consistent and audible: \"This is the first way...\", \"Secondly, we have to look more broadly...\", \"Finally, and perhaps most importantly...\" \u2014 a listener without the transcript can track position throughout.\n2) Technical terms are mostly made accessible: GND is defined on first use (\"GND, standing for the Green New Deal\"), and the Paris Accords' \"1.5 degrees\" is explained as \"a goal... with no actual mechanism.\"\n3) The conclusion's re-preview (\"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality\") is crisply parallel to the intro preview.\n- **Critical Flaws:**\n1) Awkward phrasing: \"because of climate and motivations on these incinerators\" is word salad \u2014 the intended claim is presumably \"because of pollution from these incinerators.\"\n2) Awkward phrasing: \"This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it\" \u2014 \"we can change that\" collides with the point's actual claim; rephrase to \"This is the second way the Green New Deal is influencing future environmental legislation.\"\n3) Broken sentence: \"We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax\" \u2014 the fragment after the period has no subject; it should read \"We're not simply going to pass this 14-page resolution; we're going to use it to come to bipartisan solutions like a carbon tax.\"\n4) Vague pronoun: \"The problem with it is it proposes a goal\" \u2014 both \"it\"s refer to the Paris Accords, but stacked back-to-back they force a stumble; \"The problem is that it proposes a goal\" is cleaner.\n5) Filler/hedge audit (text-based): \"just\" appears as padding in \"We're not simply going to just pass,\" \"we've often looked to just alternative energy,\" and \"isn't just a greener world\"; \"very\" in \"they're also very white\" and \"sat very apathetically\" \u2014 low overall, but clustered at key lines.\n- **Verdict: MODERATELY CLEAR** \u2014 the skeleton is easy to follow, but three garbled sentences land at analytically important moments.\n- **What You Could Have Done:**\n1) \"In my home state of New Jersey, **living near these incinerators has** doubled the rate of asthma.\"\n2) \"This is the second way **the Green New Deal is influencing** future environmental legislation \u2014 by democratizing it with environmental justice.\"\n3) \"We're not simply going to pass this 14-page resolution**; we're going to use it as leverage** to come to bipartisan solutions like a carbon tax.\"\n4) \"The problem **is that the Accords propose** a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there.\"\n\n### Conclusion Strength - 7/8\n- **What Worked:**\n1) The summary accurately restates all three points in preview-parallel language: \"first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality.\"\n2) The callback is the best moment of the speech: \"AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A\" \u2014 it resolves the name-mispronunciation hook with a genuine twist (GND \u2192 YEA) rather than a flat restatement.\n3) The question is explicitly re-asked and re-answered (\"How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock\"), giving the judge a clean flowable close.\n- **Critical Flaws:**\n1) The moon line is a missed opportunity that veers toward flippancy: \"if we're not careful about climate change, we're all gonna have to move to the moon\" \u2014 it undercuts the urgency the conclusion is trying to build and adds no analytical weight.\n2) There is no forward-looking \"so what\" beyond the pun \u2014 no statement of what happens if the GND's influence fails or what the audience should watch for (e.g., the 2020 New Consensus agenda mentioned in the intro is never recalled).\n- **What You Could Have Done:**\n1) \"We landed a man on the moon **because this country decided the impossible was a deadline, not a dream \u2014 the Green New Deal sets that same kind of deadline for our own planet.**\"\n2) \"**Watch the 2020 agenda New Consensus releases \u2014 every provision in it will trace back to this 14-page resolution.** AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A.\"\n\n### Speech Quality - 16/20\n- **What Worked:**\n1) Pace is squarely competitive: 160 WPM over 470s sits in the 150-175 target band \u2014 brisk enough to hold energy, controlled enough to flow.\n2) Tone/pitch variety is a standout: 3151 significant pitch shifts with 81.6Hz std-dev (\"High \u2014 expressive\") \u2014 the delivery tracks the content's humor and urgency rather than reading flat.\n3) Filler discipline is excellent: only 4 auto-detected fillers (\"actually\"\u00d71, \"like\"\u00d73) and 1 stutter across a ~7-minute speech \u2014 my own read confirms \"like\" in \"a table much like yours\" is grammatical, not a crutch, so the true crutch count is even lower.\n4) Emphasis frequently lands on rhetorically important words: \"SOLVE,\" \"DON'T have much time,\" \"WILL the Green New Deal,\" and the signpost cue \"MORE broadly\" are exactly where a judge wants vocal weight.\n- **Critical Flaws:**\n1) Volume is merely adequate at -23.1 dBFS (subscore 8/10) \u2014 below the -18 dBFS strong-projection threshold; in a large round room this reads as under-projected, particularly on the quieter evidentiary stretches.\n2) Emphasis placement is erratic in the intro: spikes land on function words \u2014 \"THE Atlantic,\" \"MET with,\" \"TO transform,\" \"IN an article,\" \"THAT it will serve\" \u2014 diluting the impact of the well-placed hits; roughly a third of the sampled emphasized words are articles, prepositions, or conjunctions.\n3) Only 7 pauses over 0.4s in 470 seconds (averaging 1.05s) \u2014 the delivery rarely stops to let a joke or a thesis land; the \"Alessandra Oxycontin\" punchline and the \"Y-E-A\" close both deserve a beat of silence they don't get.\n4) The opening line triple-emphasizes \"CABLE NEWS PUNDITS LOVE\" \u2014 front-loading four spikes in the first sentence leaves the actual punchline (the mispronunciations) with less dynamic contrast.\n- **What You Could Have Done:**\n1) **Project from the diaphragm on evidence lines \u2014 treat \"emissions rose by 3.8%\" as a headline, not an aside.**\n2) \"**Strip emphasis from connective words and save it for content:** an article from The Atlantic tells us that AOC proposed the influential **Green New Deal** last November.\"\n3) \"**Pause a full beat after the punchlines:** One cable pundit called her Alessandra Oxycontin. [beat] And Lou Dobbs...\"\n4) \"**Open at conversational volume and build:** Cable news pundits love to pronounce one freshman Congresswoman's name \u2014 **Alexandria. Ocasio-Cortez.**\"\n\n### Total Composite Score: 76/100\n### Judge's Rank: 2/5\n### Rank Explanation:\nThis speech would place 2nd against 5 other competitors on this question. The speaker pairs one of the most original hooks in the round \u2014 the AOC-name device that pays off brilliantly in the \"Y-E-A\" close \u2014 with genuinely strong source discipline (eight dated, reputable citations) and expressive, well-paced delivery. What holds it out of first is analytical follow-through: Point 3's own New York Times evidence undercuts its causal claim, the bipartisan-influence argument rests on post hoc reasoning the speaker half-concedes in the same sentence, and the most striking statistic in the speech (the New Jersey asthma doubling) arrives with no source at all. The intro also runs nearly a minute long, and several garbled sentences (\"climate and motivations on these incinerators\") land at analytically important moments. Against a typical state-level field, the polish and structure beat most competitors, but a sharper analyst with equal delivery would take the round.\n\n### Actionable Drill for Next Round:\n**The \"Prove the Cause\" drill:** Take your three main points from this speech. For each, write the causal claim in one sentence (e.g., \"The GND forced Republicans to propose climate bills\"), then list every *alternative* explanation your own evidence mentions (poll numbers, UK origins, pre-existing trends). For each alternative, write one sentence of warrant that rules it out or subordinates it \u2014 the way the \"Gaetz named his bill the Green Real Deal\" detail rules out pure polling. Practice delivering those ruling-out sentences verbatim until causal attribution becomes automatic rather than asserted.\n\n--- EVIDENCE FACT-CHECK (does not count toward score) ---\n\n[TRUE] AOC proposed the influential Green New Deal last November (2018) as a 14-page white paper congressional resolution.\n  Cited source: The Atlantic, June 12, 2019\n  Alexandria Ocasio-Cortez and Senator Edward Markey released a 14-page resolution for their Green New Deal (House Resolution 109) on February 7, 2019, which aligns with the 'last November' (2018) timeframe for its initial proposal or discussion, preceding the formal resolution.\n\n[TRUE] The Green New Deal was met with regret but also immense popularity across the United States.\n  Cited source: The Atlantic, June 12, 2019\n  While the specific article from The Atlantic on June 12, 2019, was not found, other sources from early 2019 indicate that the Green New Deal, or its core concepts, had broad popularity among voters (including some Republicans initially) but also faced significant political polarization and opposition.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE9SsjgxWKh0zU9RPgtIz9bZPXgjQsZQFFXTsohMGhp1e6NmPyCI4CM5DFffvH77Ljrqw-Qjf420HhNF-vy_0Cf3XJDMwOWUD1hCSneSkA2thHgwHnEaJtQSTZcAX_UqQyVUlkRZRbty4nec3qmormIGNipWIlflMaoY202w8s54zWltA0PGtHqJAKWvEXQzjtnyu6MI8qHsTMWIPEOWoS6tMOEWEKyenmE5ohNsTnlunAshqcfgmgOd_CMSm2dP02RzGCFL8c\n\n[UNVERIFIED] The think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020.\n  Cited source: The Atlantic, June 12, 2019\n  While New Consensus is a think tank associated with the Green New Deal, and the goal was to develop a policy agenda, a specific article from The Atlantic on June 12, 2019, stating this exact timeline and effort by New Consensus was not found in the search results.\n\n[FALSE] Emissions rose by 3.8%.\n  Cited source: Scientific American, January of this year (2019)\n  Reports from January 2019, including coverage of Rhodium Group data, indicated that U.S. carbon dioxide emissions rose by an estimated 3.4% in 2018, not 3.8%.\n\n[TRUE] Before innovation, Republicans saw climate change as a figment of political imagination.\n  Cited source: The Washington Post, April 3, 2019\n  An article from The Washington Post on April 3, 2019, discusses how Republicans for years cast doubt on climate change, but some are now acknowledging human-caused climate change.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHn7AGEZu6RA-gO93CA7m8ZUB0cTDTHO0CVP1yd347WfsTGEVgguEf3pIlHNPI5AxT7c4UqvFDtR-PQvDOQHhqJCa7-iTEQzoy8FaP76i3Otm6ucfe85un8G5lq3ArdhG2D24Q9SpY=\n\n[FALSE] In 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change.\n  Cited source: (no source given)\n  In June 2011, Mitt Romney publicly stated that he believed the world was getting warmer and that humans contributed to it. However, his stance later shifted, and in October 2011, he said, 'We don't know what's causing climate change on this planet.' The claim that he ran on a campaign saying he 'didn't even know' if humans were a cause is an oversimplification and misrepresents his initial 2011 statement.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF2tOj2srV__voNm42S3XnJA79hw7AM4Tu6-EDkVwG49VszQbzJ4xYDHIr97UzR74tobLngl0QVqrp0gqi835VCrrHIWzYLQWRSa6aqpZ78x-S9Q7x_10v6JXXiDPhIFlDKnalrDh1BW4nsEy3pRy8KqA5folNxNWJKws_MEje5rkdO5A_n1IjT\n\n[FALSE] Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action.\n  Cited source: The Washington Post (continues from April 3, 2019, but likely a different article)\n  A Washington Post-Kaiser Family Foundation poll from summer 2019 (reported Sept 13, 2019) found that 60% of Republicans believed human activity caused climate change, and 46% of all Americans said the U.S. needs to 'drastically reduce' fossil fuel use in the next few years. Another Post-KFF poll from 2020 indicated that almost 7 in 10 Republican adults under 45 believed human activity was causing climate change. The specific numbers cited (64% Republicans, 45% Americans) for these exact claims were not found in the provided search results for the given timeframe.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEyv4mw3q1sLas2mS5BGQjelGIpaQQgc-MPZHk-FlsO5QbEyA4zOMOtME1Hgv2sbOrwJGMCvhCty2w87r_8ZSOuyB5M0-hsLQ0TEh5xe0VrQZoVRtSsv9gFPnJxHI4-xBRlzXhDEVlHHnyUA-FTmNZANwAP9m7iNMl2nBq7UD5iJVYmfLca8nhoCGHsYoPFNbAtTHE8H6rLQrvrl6_6kre2ECVZHvxZdnUSaiQKEydz-7wA5Ue1Y9GHhK_qSElgO7SlC6EhDYWTO2w8reel5bmbN4lQ-i8J0WBelF8tBjnnmQ\n\n[TRUE] The Green New Deal and poll numbers are forcing Republicans to listen, leading Senator Lamar Alexander to propose his Manhattan Project on Clean Energy and Matt Gaetz to propose a Green Real Deal combining carbon capture with less oil drilling.\n  Cited source: Politico, March 26, 2019\n  A March 26, 2019, article reported that the Green New Deal was forcing a discussion on climate change among Republicans. Senator Lamar Alexander proposed a 'New Manhattan Project' for clean energy, and Representative Matt Gaetz announced plans to draft a 'Green Real Deal' offering conservative solutions.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHSy0RUhd-Avp-LYGQJfksUyQtfoJMSB4aq0IF3jw-llL8DUcFk-YPOEBAQ7DjdB7uwC3ql-6N2dW23hkk8s4nb4LhfeHninH6WCly2O4czay-VoRwrntNlEEIruzH-xo91-vt_IP0ONiIpWLD8DbY=\n\n[TRUE] 1.6 million Americans live near a trash incinerator, leading to higher rates of asthma and maternal mortality.\n  Cited source: The Guardian, May 21, 2019\n  A Guardian article from May 21, 2019, reported that 1.6 million Americans live near the most polluting incinerators, with these pollutants linked to health problems like asthma and heart disease. The article also highlights that these incinerators are disproportionately located near low-income and minority communities.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1cBXxCktTJWQvPB3F8s5pPEyUmJVdmPPWHcoTZf2Gn0bB1NCOchV0SooL8vWVlqeS8Cfq8QRiMNxI_lzgCIhdu3trnE1gV1z06dWzfQnSKvbUWl0_8TeW4ZGzx9jgO0YdMFWUHDSTjNbLCV3Nvw4j-2yh35jAl1NXgUnLcqohxAD9WVD7B7ourRBl5tlnf3U--jToCrjF887SrgzCzlPF-OYGXA==\n\n[UNVERIFIED] In the state of Illinois, an equity environmental Justice Bill was passed, leading to 40 million solar panels installed by 2050 with a focus on hiring marginalized people.\n  Cited source: Vox, March 7, 2019\n  While Illinois has passed significant clean energy legislation (like the Climate and Equitable Jobs Act), a specific Vox article from March 7, 2019, detailing an 'equity environmental Justice Bill' with a target of '40 million solar panels installed by 2050' and explicit hiring focus on marginalized people was not found in the search results. The date is also quite early for such detailed legislative outcomes.\n\n[FALSE] Climate scientists with the Intergovernmental Panel on Climate Change (IPCC) said 'we're all going to die' at the beginning of this year (2019), representing global apathy.\n  Cited source: (no source given, but attributed to IPCC scientists)\n  The IPCC reports are scientific assessments, not statements like 'we're all going to die.' While IPCC reports, such as the 2018 Special Report on Global Warming of 1.5\u00b0C, highlighted dire consequences of inaction, they do not use such emotional language. The claim of 'dead face' and 'apathetic' scientists is a dramatic interpretation, not a factual report from the IPCC.\n  https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEU0O1IACbuw1WncDR82UmpTRdRfJ4Ldr1OZNdjMeqjLD4TA9d7_rLziRd80IjyCuspuSfeimpBdyJVxvqM1fC5PdBWfwVPJvbpaNYwx_00tOi8YCX8tm3KPb2PYis3ca13LkhIPUY-AR3htuVUQ9HPGLObbjImq3XkJk6I6923\n\n[TRUE] The most sweeping piece of climate legislation globally is the Paris Climate Accords, which proposes a goal of 1.5 degrees Celsius of heating with no actual mechanism on how to get there.\n  Cited source: Los Angeles Times, December 2018\n  Los Angeles Times articles from December 2018 and later confirm that the Paris Agreement sets a goal of limiting global warming to 'well below 2 degrees Celsius' and pursuing efforts for 1.5 degrees Celsius. It is also noted that the agreement, while a breakthrough, left many details to be firmed up later and lacked strong enforcement mechanisms.\n\n[TRUE] The Green New Deal originated in the UK, but AOC's accessibility has made it a globally accessible source.\n  Cited source: New York Times, March 2019\n  Multiple sources, including Wikipedia, confirm that the concept of a 'Green New Deal' originated earlier in the UK and Europe (around 2008) and was adopted by the Green Party in the U.S. in 2010, before Alexandria Ocasio-Cortez popularized it in 2019.\n\n[TRUE] Candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda.\n  Cited source: The National Interest, June 4, 2019\n  The National Interest published an article on June 4, 2019, discussing how the Green New Deal concept was gaining traction internationally, including in Canada and Europe.\n\n--- TRANSCRIPT ---\n\nCable news pundits love to pronounce one freshman Congresswoman's name, Alexandria Ocasio-Cortez. The problem is they're not always successful. One cable pundit called her Alessandra Oxycontin and Lou Dobbs, the paradigm of journalistic integrity, called her Alexandria Ocasio-Cortez. And while we commonly know her as AOC, there are three letters also attached to her name, GND, standing for the Green New Deal. An article from The Atlantic tells us on June the 12th of 2019 that AOC proposed the influential Green New Deal last November as a 14-page white paper congressional resolution. This deal attempted to solve the ever-pressing emergency of climate change, as the United States, after withdrawing from the Paris Climate Accords has no sweeping environmental legislation to protect us in the near future. The Atlantic continues that the deal was met with regret, but also immense popularity across the United States. And now the think tank New Consensus is working to transform this resolution into a sweeping policy agenda by the year 2020. We don't have much time to waste. In fact, we see in an article from the Scientific American from January of this year that emissions rose by 3.8%. We face crises around the world, in Sudan and Yemen, but this is a crisis of the natural world. And that's exactly why for everyone in this room, we have to ask today's question. How will the Green New Deal influence future environmental legislation? The answer simply is that it will serve as the bedrock for future environmental legislation. First, by forcing bipartisan action on climate mitigation. more broadly by addressing the critical concept of environmental justice, and finally, and perhaps most importantly, by leading to a new global paradigm on climate policy. Republicans for years have said that innovation is the way that we can solve climate change. But what exactly is innovation? If I had a nickel for every time they said innovation, I'd be able to pay for the $93 trillion Green New Deal. This is the first way in which the Green New Deal will influence future environmental legislation. It will force some kind of bipartisan action on climate mitigation. An article from the Washington Post tells us on April the 3rd of 2019 that before innovation, Republicans saw climate change as a figment of political imagination. Going back to 2011, Mitt Romney ran on a campaign that said he didn't even know if humans were a cause of climate change, and in neither his campaign nor the 2016 campaign did Republicans propose any kind of sweeping climate climate solution. This is very different from the American popular opinion. In fact, the Washington Post continues that Republicans, now 64%, believe that climate change is a severe threat to our future survival, and 45% of all Americans believe that we need immediate action. We see in a further article from Politico on March the 26th of 2019 that the Green New Deal and the poll numbers are finally forcing Republicans to listen. Senator Lamar Alexander of Tennessee, a Republican, proposed his Manhattan Project on Clean Energy. Matt Gaetz of Florida proposed a Green Real Deal, which would combine carbon capture with less oil drilling. Both of these solutions are certainly influenced by popularity, but they're also because of the Democratic ploy of the Green New Deal to change innovation into forcing Republicans to actually innovate. This is a showing that the that the Green New Deal is part of a way to guide future climate debate. We're not simply going to just pass this 14-page resolution. to come to bipartisan solutions like a carbon tax, one that allows us to grow our economy while cutting emissions. Secondly, we have to look more broadly to the question of environmental justice because while the climate movement is right, they're also very white. In fact, the climate movement looks like a cross between a Comic-Con convention and a Bernie Sanders rally. This is the second way that we can change that the Green New Deal is influencing future environmental legislation by democratizing it with environmental justice. An article from The Guardian tells us on May the 21st of 2019, though we think of solar panels and carbon capture, Americans are tangibly being hurt by climate change. 1.6 million Americans live near a trash incinerator, a product of our industrial complex that has led to higher rates of asthma and maternal mortality. In my home state of New Jersey, it's doubled the rate of asthma because of climate and motivations on these incinerators. In climate legislation, we've often looked to just alternative energy, but this time the Green New Deal is proposing a jobs guarantee, universal health care, and better subsidies to allow minorities to get equity. This is great because we're designing a new future where we won't just have a world where we're not swimming all the time, but also where everyone will be on an equal footing. We see in a different article, this time from Vox on March the 7th of 2019, that in the state of Illinois this led to an equity environmental Justice Bill being passed, where there will be 40 million solar panels installed by 2050 that will also have a focus on inviting and hiring marginalized people. In this way, we're considering an impact that isn't just a greener world. We're making sure that those who have been the most marginalized by our pollution are now the most advantaged, and there is nothing more powerful than that. Finally, and perhaps most importantly, at the beginning of this year, climate scientists with the Intergovernmental Panel on Climate Change sat very apathetically at a table much like yours and said, we're all going to die. Their dead face was a little apathetic, but it represents a global apathy towards sweeping climate change legislation. And it's the final way the Green New Deal will influence this future environmental legislation by leading to a new unified global paradigm. We see in an article from the Los Angeles Times from December of 2018 that the most sweeping piece of climate legislation we have around the world is the Paris Climate Accords. The problem with it is it proposes a goal, 1.5 degrees of Celsius of heating, with no actual mechanism on how to get there. We see in a final article, this time from the New York Times, from March of 2019, that ultimately the Green New Deal has been around before the United States proposed it in 2018. It came from the UK, but Alexandria Ocasio-Cortez's accessibility with it has now made it more of a globally accessible source. The national interest tells us on June the 4th of 2019, the candidates in Spain, Sweden, Norway, and even Canada have run on a Green New Deal agenda, and the Green New Deal is creating a unified platform where we can all cut reductions. We landed a man on the moon, and if we're not careful about climate change, we're all gonna have to move to the moon. That's exactly why we have to return back to today's question. How will the Green New Deal influence future environmental legislation? The answer is that it will serve as a fundamental bedrock. More specifically, first, by leading to bipartisan action, second, by addressing environmental justice, and finally, by leading to global universality. AOC might have a complicated name, but there are only three letters we need to learn about the Green New Deal. Y-E-A. Thank you very much. Thank you.",
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

  function splitOffFactCheckAndTranscript(feedback){
    const idx = feedback.indexOf('--- EVIDENCE FACT-CHECK');
    if(idx === -1) return { ballotText: feedback, factCheckText: null };
    const ballotText = feedback.slice(0, idx).trim();
    const rest = feedback.slice(idx);
    const transcriptIdx = rest.indexOf('--- TRANSCRIPT ---');
    const factCheckText = (transcriptIdx === -1 ? rest : rest.slice(0, transcriptIdx)).trim();
    return { ballotText, factCheckText };
  }

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

  const RUBRIC_VISIBLE_VIEWS = [viewRecord, viewResults, viewExample, viewHistory];
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
  document.getElementById('navHomeBtn').addEventListener('click', () => {
    showView(viewRecord);
  });
  navMenuPanel.querySelectorAll('.nav-menu-item[data-target]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = item.getAttribute('data-target');
      const targetBtn = document.getElementById(targetId);
      if(targetBtn) targetBtn.click();
    });
  });

  navMenuPanel.querySelectorAll('.nav-menu-item[data-target]').forEach(item => {
    const targetId = item.getAttribute('data-target');
    if(targetId === 'themeToggle') return;
    const targetBtn = document.getElementById(targetId);
    if(!targetBtn) return;
    const syncActive = () => item.classList.toggle('active', targetBtn.classList.contains('active'));
    syncActive();
    new MutationObserver(syncActive).observe(targetBtn, { attributes:true, attributeFilter:['class'] });
  });

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
      if(!viewExample.classList.contains('hidden')){
        examplePbPlayBtn.click();
      } else if(!viewResults.classList.contains('hidden')){
        pbPlayBtn.click();
      } else if(recBtn && !recBtn.disabled){
        recBtn.click();
      }
    }
  });

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

  let suppressPanelClose = false;
  function makeDraggablePanel(panelEl, handleEl){
    if(!panelEl || !handleEl) return;
    handleEl.style.cursor = 'grab';
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    function onDown(e){
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

  const SIGNAL_PRESETS = DATA.SIGNAL_PRESETS;

  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = SIGNAL_PRESETS[btn.dataset.preset];
      if(!preset) return;
      timeSignals = preset.map(s => ({ ...s }));
      editingIndex = -1;
      document.getElementById('addSignalBtn').textContent = '+ Add';
      renderSignalList();
    });
  });

  async function fetchWithTimeout(url, options, timeoutMs){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onExternalAbort = null;
    const extSignal = pipelineAbortController && pipelineAbortController.signal;
    if(extSignal){
      if(extSignal.aborted) controller.abort();
      else{
        onExternalAbort = () => controller.abort();
        extSignal.addEventListener('abort', onExternalAbort);
      }
    }
    try{
      return await fetch(url, { ...options, signal: controller.signal });
    }catch(err){
      if(err.name === 'AbortError'){
        if(extSignal && extSignal.aborted){
          const cancelErr = new Error('pipeline_cancelled');
          cancelErr.name = 'AbortError';
          cancelErr.pipelineCancelled = true;
          throw cancelErr;
        }
        throw new Error('timeout:The model took too long to respond ('+Math.round(timeoutMs/1000)+'s) — it may be overloaded. Try again.');
      }
      throw err;
    }finally{
      clearTimeout(timer);
      if(onExternalAbort) extSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  document.getElementById('submitBtn').addEventListener('click', () => {
    runPipeline(null, null, null);
  });

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

  cancelBallotBtn && cancelBallotBtn.addEventListener('click', () => {
    if(pipelineAbortController) pipelineAbortController.abort();
  });

  function extFromMime(mime){ return mime.includes('mp4') ? 'mp4' : 'webm'; }

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
  function estimatePitch(buf, sampleRate){
    const SIZE = buf.length;
    let rms = computeRMS(buf);
    if(rms < 0.012) return -1;
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
    return (pitch>60 && pitch<500) ? pitch : -1;
  }

  async function analyzeAudioDelivery(audioBuffer, words){
    try{
      const sampleRate = audioBuffer.sampleRate;
      const channelData = mixDownToMono(audioBuffer);

      const frameSize = Math.round(sampleRate*0.03);
      const hopSize    = Math.round(sampleRate*0.015);
      const frames = [];
      for(let i=0; i+frameSize<=channelData.length; i+=hopSize){
        const slice = channelData.subarray(i, i+frameSize);
        frames.push({ t: i/sampleRate, rms: computeRMS(slice), pitch: estimatePitch(slice, sampleRate) });
      }
      if(!frames.length) return null;

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

      const pitchSeries = frames.map(f=>f.pitch).filter(p=>p>0);
      let toneChanges = 0, lastPitch = null;
      pitchSeries.forEach(p=>{
        if(lastPitch!==null && Math.abs(p-lastPitch)/lastPitch > 0.12) toneChanges++;
        lastPitch = p;
      });
      const pitchStdDev = stddev(pitchSeries);
      const pitchVarietyLabel = pitchStdDev>32 ? 'High — expressive' : pitchStdDev>14 ? 'Moderate' : 'Low — monotone risk';

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

  const GROQ_UPLOAD_SAFE_BYTES = 2 * 1024 * 1024;
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

  async function resampleMono(audioBuffer, targetSampleRate){
    const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1, Math.ceil(audioBuffer.duration*targetSampleRate), targetSampleRate
    );
    const src = offlineCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offlineCtx.destination);
    src.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
  }

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

  async function audioBufferSliceToWav(audioBuffer, startSec, endSec){
    const sr = audioBuffer.sampleRate;
    const s = Math.max(0, Math.floor((startSec||0)*sr));
    const e = Math.min(audioBuffer.length, Math.ceil((endSec==null?audioBuffer.duration:endSec)*sr));
    const length = Math.max(1, e-s);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const slice = ctx.createBuffer(audioBuffer.numberOfChannels, length, sr);
    for(let ch=0; ch<audioBuffer.numberOfChannels; ch++){
      slice.copyToChannel(audioBuffer.getChannelData(ch).subarray(s, e), ch, 0);
    }
    try{ ctx.close(); }catch(err){}
    const targetRate = 16000;
    const mono = await resampleMono(slice, targetRate);
    return encodeWavFromFloat32(mono, targetRate);
  }

  function isTransientError(err){
    const s = String(err && err.message || err);
    return /:429:|:500:|:502:|:503:|:504:|:529:/.test(s) || /rate.?limit/i.test(s) || /overloaded/i.test(s) || s.includes('Failed to fetch');
  }
  async function withKeyFallback(fn, ...keys){
    const list = [...new Set(keys)];
    if(!list.some(k => !k)) list.push(null);
    let lastErr = null;
    for(const k of list){
      for(let attempt = 0; attempt < 3; attempt++){
        if(pipelineAbortController && pipelineAbortController.signal.aborted){
          const cancelErr = new Error('pipeline_cancelled');
          cancelErr.name = 'AbortError';
          cancelErr.pipelineCancelled = true;
          throw cancelErr;
        }
        try{
          return await fn(k);
        }catch(err){
          lastErr = err;
          if(err.pipelineCancelled || err.name === 'AbortError') throw err;
          if(err.rateLimited) throw err;
          if(attempt < 2 && isTransientError(err)){
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

  async function transcribeChunkResilient(audioBuffer, startSec, endSec, keys, labelPrefix, onProgress){
    const wav = await audioBufferSliceToWav(audioBuffer, startSec, endSec);
    if(wav.size > GROQ_UPLOAD_SAFE_BYTES && (endSec - startSec) > 20 && wav.size/2 > GROQ_UPLOAD_MIN_BYTES){
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

  const FIXED_CHUNK_SECONDS = 60;
  async function transcribeLongAudio(audioBuffer, keysIn, onStatus){
    const keys = [...new Set((keysIn || []).filter(Boolean))];
    if(!keys.length) keys.push(null);

    const duration = audioBuffer.duration;
    if(duration <= FIXED_CHUNK_SECONDS * 1.25){
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
    let commentSearchFrom = 0;
    (ann.comments||[]).forEach(c=>{
      if(!c || !c.quote || !c.color || !ANN_COLORS.includes(c.color)) return;
      const loc = locateQuote(c.quote, normMap, 0);
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

  let transcriptWordEls = [];
  function cacheTranscriptWordEls(){
    transcriptWordEls = Array.from(transcriptBody.querySelectorAll('.tw'));
  }

  function fmtPb(s){
    if(!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
  }

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

  function findActiveWordIndex(spans, t){
    let lo = 0, hi = spans.length - 1, ans = -1;
    while(lo <= hi){
      const mid = (lo+hi) >> 1;
      if(spans[mid].ts <= t){ ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function syncActiveWord(spans, els, currentActiveEl, t){
    if(!spans.length || !els.length) return currentActiveEl;
    const idx = findActiveWordIndex(spans, t);
    const inRange = idx >= 0 && t <= spans[idx].te + 0.35;
    const newEl = inRange ? els[idx] : null;
    if(newEl === currentActiveEl) return currentActiveEl;
    if(currentActiveEl) currentActiveEl.classList.remove('tw-active');
    if(newEl){
      newEl.classList.add('tw-active');
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

  const EXAMPLE_YT_VIDEO_ID = DATA.EXAMPLE_YT_VIDEO_ID;
  const EXAMPLE_WORD_TIMESTAMPS = DATA.EXAMPLE_WORD_TIMESTAMPS;
  const EXAMPLE_SPEECH_START = DATA.EXAMPLE_SPEECH_START;
  const EXAMPLE_SPEECH_END = DATA.EXAMPLE_SPEECH_END;

  let exampleWordSpans = [];
  let exampleWordEls = [];
  let exampleActiveWordEl = null;
  let ytApiReady = false;
  let ytPlayerReady = false;
  let ytPollTimer = null;

  const YT_STATE_PLAYING = 1;

  let ytFrame = null;
  let ytCachedTime = 0;
  let ytCachedState = -1;
  let ytListenTimer = null;

  function loadYouTubeIframeAPI(){
    ytApiReady = true;
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
      if(data.info && typeof data.info === 'object'){
        if(typeof data.info.currentTime === 'number') ytCachedTime = data.info.currentTime;
        if(typeof data.info.playerState === 'number') ytCachedState = data.info.playerState;
      }
    });

    ytFrame.addEventListener('load', () => {
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
      autoScrollToWordEnabled = true;
      seekExampleVideo(ts);
    }
  });

  function annotateRange(plainTranscript, rangeStart, rangeEnd, spans){
    let html = '', cursor = rangeStart;
    spans.forEach(sp=>{
      if(sp.end <= rangeStart || sp.start >= rangeEnd) return;
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

  transcriptBody.addEventListener('click', (e)=>{
    const wordEl = e.target.closest('.tw');
    if(!wordEl) return;
    const ts = parseFloat(wordEl.dataset.ts);
    if(!isNaN(ts)){
      autoScrollToWordEnabled = true;
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

    commentPopover.style.left = '0px';
    commentPopover.style.top = '0px';

    const popW = commentPopover.getBoundingClientRect().width || 300;

    const elRect = el.getBoundingClientRect();
    const margin = 12;
    let left = elRect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
    let top = elRect.bottom + 10;

    commentPopover.style.left = left + 'px';
    commentPopover.style.top = top + 'px';

    const popRect = commentPopover.getBoundingClientRect();
    if(popRect.bottom > window.innerHeight - margin){
      top = elRect.top - popRect.height - 10;
      commentPopover.style.top = Math.max(margin, top) + 'px';
      commentPopover.classList.add('cp-flip');
    }else{
      commentPopover.classList.remove('cp-flip');
    }

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

  const EXAMPLE_CATEGORIES = DATA.EXAMPLE_CATEGORIES;
  const EXAMPLE_TOTAL = EXAMPLE_CATEGORIES.reduce((s,c)=>s+c.score,0);
  const EXAMPLE_RANK = DATA.EXAMPLE_RANK;
  const EXAMPLE_RANK_EXPLANATION = DATA.EXAMPLE_RANK_EXPLANATION;
  const EXAMPLE_DRILL = DATA.EXAMPLE_DRILL;
  const EXAMPLE_FACT_CHECK = DATA.EXAMPLE_FACT_CHECK || [];

  function renderExampleBallot(){
    autoScrollToWordEnabled = true;
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

    const T = EXAMPLE_TRANSCRIPT_HTML;
    const body = document.getElementById('exampleTranscriptBody');
    body.innerHTML = T;

    exampleActiveWordEl = null;
    exampleWordSpans = wrapWordsInDom(body, EXAMPLE_SPEECH_START, 1);
    exampleWordEls = exampleWordSpans.map(s => s.el);
    attachCommentListeners(body, seekExampleVideo);

    exampleWordSpans.forEach((s, i) => {
      const offset = EXAMPLE_WORD_TIMESTAMPS[i] ?? (i * 0.4);
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
    pipelineAbortController = new AbortController();
    cancelBallotBtn && cancelBallotBtn.classList.remove('hidden');
    processError.classList.add('hidden');
    processErrorActions.classList.add('hidden');
    setProcStep(null);
    const phrases = introDrillMode ? INTRO_PIPELINE_PHRASES : bodyDrillMode ? BODY_PIPELINE_PHRASES : roughDraftMode ? ROUGHDRAFT_PIPELINE_PHRASES : PIPELINE_PHRASES;
    try{
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

      const metricsBlock = roughDraftMode ? '' : buildDeliveryMetricsBlock(lastDeliveryMetrics.audioUnavailable ? null : lastDeliveryMetrics, lastDeliveryMetrics);
      let judgeChoice = getJudgeModelChoice();
      let judgeWeightKey = judgeModelValue;
      const EVIDENCE_TRUTH_ASSUMPTION_NOTE = '\n\nEVIDENCE ACCURACY ASSUMPTION (this overrides anything above that implies otherwise): Do not attempt to fact-check, verify, or research whether any statistic, quote, or cited source in this transcript is actually true, accurate, or was really said/reported as claimed. Treat every citation exactly as the speaker delivered it and assume it is 100% factually accurate. This is intentional — a separate, independent automated fact-checking pass runs after this ballot and is not part of your job here, so spending any effort verifying claims only wastes time and tokens. Score "Strength of Evidence" (or the equivalent evidence criteria) purely on citation PRACTICE: how well the evidence is logically applied to the claim, how reputable the named source sounds by reputation, how well-dated and diverse the citations are, and whether the speaker explains why it matters — never on whether the underlying fact is real.';
      const runJudging = async (choice, weightKey) => withKeyFallback(async (k) => {
        const tierProfile = choice.tier ? TIER_PROFILES[choice.tier] : null;
        const baseMessages = [
          {role:'system', content: (introDrillMode ? INTRO_RUBRIC_PROMPT : bodyDrillMode ? BODY_RUBRIC_PROMPT : roughDraftMode ? ROUGHDRAFT_RUBRIC_PROMPT : RUBRIC_PROMPT) + EVIDENCE_TRUTH_ASSUMPTION_NOTE},
          {role:'user', content:'TRANSCRIPT:\n\n'+transcript+'\n\n'+metricsBlock}
        ];
        const doFetch = async (messages, maxTokensOverride, weightOverride) => {
          const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/${choice.fn}`,{
            method:'POST',
            headers:{
              'Authorization':'Bearer '+(await getAuthToken()),
              'apikey': SUPABASE_ANON_KEY,
              'Content-Type':'application/json'
            },
            body: choice.fn === 'gemini-generate' ? JSON.stringify({
              prompt: messages.map(m => m.content).join('\n\n'),
              maxOutputTokens: maxTokensOverride || 32768,
              overrideKey: undefined,
              category: 'ballot_feedback',
              weight: weightOverride != null ? weightOverride : (BALLOT_FEEDBACK_MODEL_WEIGHTS[weightKey] || 1)
            }) : JSON.stringify({
              model: choice.model, temperature:0.4, max_tokens: maxTokensOverride || (tierProfile ? tierProfile.maxTokensPerRound : (STREAMING_JUDGE_FNS.has(choice.fn) ? 32000 : 3000)),
              ...(tierProfile && tierProfile.reasoningEffort ? { reasoning: { effort: tierProfile.reasoningEffort } } : {}),
              ...(choice.model === 'openai/gpt-oss-120b' ? { reasoning_effort: 'low' } : {}),
              messages,
              overrideKey: choice.fn === 'groq-chat' ? (k || undefined) : undefined,
              category: 'ballot_feedback',
              weight: weightOverride != null ? weightOverride : (BALLOT_FEEDBACK_MODEL_WEIGHTS[weightKey] || 1)
            })
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
            throw new Error('platform_rate_limited:429:'+JSON.stringify(info).slice(0,200));
          }
          if(window.RateLimitUI) window.RateLimitUI.refresh();
          if(!res.ok) throw new Error('judging_failed:'+res.status+':'+await safeErrText(res));
          return res;
        };
        const GPT_OSS_TPM_LIMIT = 8000;
        const estimateTokens = (str) => Math.ceil((str||'').length / 3.5);
        const budgetOutputTokens = (systemContent, userContent, ceiling) => {
          const promptTokens = estimateTokens(systemContent) + estimateTokens(userContent);
          const SAFETY_MARGIN = 300;
          return Math.max(900, Math.min(ceiling, GPT_OSS_TPM_LIMIT - promptTokens - SAFETY_MARGIN));
        };
        const GPT_OSS_CATEGORY_CEILING = 1700;
        const GPT_OSS_SYNTHESIS_CEILING = 3200;
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
        async function runGptOssSplitJudging(){
          const userMsg = 'TRANSCRIPT:\n\n'+transcript+'\n\n'+metricsBlock;
          const parts = [];
          for(let i = 0; i < GPT_OSS_GROUPS.length; i++){
            const group = GPT_OSS_GROUPS[i];
            const sysContent = group.prompt + EVIDENCE_TRUTH_ASSUMPTION_NOTE;
            const msgs = [{role:'system', content: sysContent}, {role:'user', content: userMsg}];
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
            if(i < GPT_OSS_GROUPS.length - 1){
              setProcStep('judging', 'Pacing for rate limit (~1 min)…');
              await new Promise(r => setTimeout(r, 65000));
            }
          }

          setProcStep('judging', 'Pacing for rate limit (~1 min)…');
          await new Promise(r => setTimeout(r, 65000));

          setProcStep('judging', `Step ${GPT_OSS_GROUPS.length+1} of ${GPT_OSS_GROUPS.length+1}`);
          const SCORE_HEADER_RE = /^###\s*.+?[-–—]\s*(\d+)\s*\/\s*(\d+)/m;
          let compositeScore = 0, compositeCap = 0;
          for(const p of parts){
            const m = SCORE_HEADER_RE.exec(p);
            if(!m) throw new Error('judging_failed:Could not find a "- score/cap" header in one of GPT-OSS 120B\'s category passes to compute the composite score from. That pass\'s output may not have followed the expected format — try again.');
            compositeScore += parseInt(m[1], 10);
            compositeCap += parseInt(m[2], 10);
          }
          const CATEGORY_SYNTHESIS_CHAR_CAP = 700;
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
          const partC = rawPartC.replace(
            /^\*{0,2}\s*(Judge.?s Rank|Rank Explanation|Actionable Drill(?: for Next Round)?)\s*:?\s*\*{0,2}\s*:?\s*/gim,
            (_m, label) => '### '+label+': '
          );
          if(!/Judge.?s\s*Rank/i.test(partC))
            throw new Error('judging_failed:truncated:GPT-OSS 120B\'s synthesis pass got cut off before finishing the rank.');
          const scoreLine = '### Total Composite Score: '+compositeScore+'/'+compositeCap;

          return (parts.join('\n\n')+'\n\n'+scoreLine+'\n'+partC).trim();
        }
        const isGptOssSplitEligible = choice.model === 'openai/gpt-oss-120b'
          && !introDrillMode && !bodyDrillMode && !roughDraftMode;
        const content = isGptOssSplitEligible
          ? await runGptOssSplitJudging()
          : STREAMING_JUDGE_FNS.has(choice.fn)
          ? await runHackClubChatToCompletion(doFetch, baseMessages, (round) => {
              setProcStep('judging', round > 1 ? `Wave ${round}` : '');
            }, tierProfile)
          : choice.fn === 'gemini-generate'
          ? extractGeminiContent(await (await doFetch(baseMessages)).json())
          : extractChatContent(await (await doFetch(baseMessages)).json());
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
        if(err.rateLimited || judgeChoice.fn === 'groq-chat') throw err;
        console.error('Judge model failed, falling back to Llama:', judgeChoice.model, err);
        let reason = '';
        const msg = String(err && err.message || '');
        const statusMatch = msg.match(/^judging_failed:(\d{3}):(.*)$/s);
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
        setProcStep('judging');
        feedback = await runJudging(judgeChoice, judgeWeightKey);
      }
      if(!feedback) throw new Error('judging_failed:empty:No content returned.');
      lastRawFeedback = feedback;
      if(window.RateLimitUI) window.RateLimitUI.addBallotFeedbackUsage(judgeWeightKey);

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
      statusSub.textContent = 'Independently verifying your evidence against the live web...';
      pipelineProgress.setStage(98, DATA.CC_PHRASES);
      setProcStep('factcheck');
      lastFactCheck = await runFactCheckPass(transcript);

      pipelineProgress.finish();
      finishProcSteps();
      renderResults(feedback, transcript);
    }catch(err){
      pipelineProgress.stop();
      if(err && (err.pipelineCancelled || err.name === 'AbortError')){
        processError.classList.add('hidden');
        processErrorActions.classList.add('hidden');
        showView(viewReview);
      }else{
        handlePipelineError(err);
      }
    }finally{
      pipelineAbortController = null;
      cancelBallotBtn && cancelBallotBtn.classList.add('hidden');
    }
  }

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
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const data = JSON.parse(cleaned);
      if(!data || (!Array.isArray(data.sections) && !Array.isArray(data.comments))) return null;
      return {
        sections: Array.isArray(data.sections) ? data.sections : [],
        comments: Array.isArray(data.comments) ? data.comments : []
      };
    }catch(e){
      console.warn('Transcript annotation unavailable:', e);
      return null;
    }
  }

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
      if(typeof j.error?.message === 'string') return j.error.message;
      if(j.error?.message && typeof j.error.message === 'object'){
        const inner = j.error.message;
        const readable = inner.detail || inner.title || inner.error || inner.reason;
        return readable ? String(readable) : JSON.stringify(inner).slice(0, 200);
      }
      if(typeof j.error === 'string'){
        const tailMatch = j.error.match(/^\w+_failed:\d+:(.*)$/s);
        const tail = tailMatch ? tailMatch[1] : j.error;
        try{
          const inner = JSON.parse(tail);
          const readable = inner.detail || inner.title || inner.message || inner.error;
          if(readable) return String(readable);
        }catch(e){  }
        return tail;
      }
      return JSON.stringify(j).slice(0,200);
    }catch(e){ return res.statusText || 'Unknown error'; }
  }

  function handlePipelineError(err){
    let msg = 'Something went wrong talking to Groq.';
    const s = String(err.message || err);
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
        if(body) out.rankExplanation = body;
      }
      else if(rankExplMatch) out.rankExplanation = (title.replace(/Rank Explanation:?/i,'').trim()+' '+body).trim();
      else if(drillMatch) out.drill = (title.replace(/Actionable Drill for Next Round:?/i,'').trim()+' '+body).trim();
      else if(catMatch && !totalMatch && !rankMatch){
        let whatWorked = extractField(body,'What Worked');
        if(!whatWorked){
          const stopAlternation = BALLOT_FIELD_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
          const leadRe = new RegExp('^([\\s\\S]*?)(?=\\n{0,2}-?\\s*\\*\\*(?:'+stopAlternation+'):?\\*\\*|$)', 'i');
          const leadMatch = body.match(leadRe);
          const candidate = leadMatch ? leadMatch[1].trim() : '';
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

  function buildBallotBodyHtml(parsed, rawFeedback, factCheck){
    let html = '';
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
    autoScrollToWordEnabled = true;
    const parsed = parseBallot(feedback);
    let html = '';

    const resultQuestion = document.getElementById('resultQuestion');
    const resultQuestionText = document.getElementById('resultQuestionText');
    if(lastQuestion){
      resultQuestionText.textContent = lastQuestion;
      resultQuestion.classList.remove('hidden');
    }else{
      resultQuestion.classList.add('hidden');
    }

    html += buildBallotBodyHtml(parsed, feedback, lastFactCheck);

    resultsContent.innerHTML = html;

    renderDeliveryMetrics(lastDeliveryMetrics);

    setupResultsPlayback();

    renderTranscript(transcript, lastTranscriptAnnotations);
    tsMeta_round.textContent = roundNo;

    if(parsed.total !== null) flightHistory.push({round:roundNo, total:parsed.total});
    renderFlightStrips();
    recordBallotToHistory(parsed, feedback, transcript, lastQuestion, roundNo, recordedBlob, lastTranscriptAnnotations, lastDeliveryMetrics, captureMode, introDrillMode, bodyDrillMode, lastFactCheck, roughDraftMode);
    showView(viewResults);
  }

  function renderFlightStrips(){
    if(flightStripResults) flightStripResults.classList.add('hidden');
  }

  function resetHomeView(){
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
      if(e && e.name === 'AbortError') return;
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

  function setupExportMenu(btnId, panelId){
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if(!btn || !panel) return null;
    document.body.appendChild(panel);
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