const DATA = window.APP_DATA;
(function(){

  // ------ SUPABASE CONFIG ------
  // Fill these in with YOUR project's values (Project Settings → API).
  // SUPABASE_ANON_KEY is the public "anon" key, it's designed to be
  // exposed in client-side code (Supabase docs make this explicit) and is
  // NOT the same thing as a service_role key or a Groq/Gemini API key. The
  // real Groq/Gemini keys now live only as server-side secrets on the edge
  // functions below and never ship in this file.
  const SUPABASE_URL = 'https://iiehhmelfotwkdqxplug.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpZWhobWVsZm90d2tkcXhwbHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDYxMzEsImV4cCI6MjA5ODkyMjEzMX0.8QzN1LJmr70Sidxp2RsOq-z3S_NX5lN9QWTr45CSaHo';
  const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

  // ----- Auth/Verification & SAVED PROGRESS ----
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
  const VIDEO_BUCKET = 'ballot-videos';

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
      isBodyDrill: !!(row.delivery_metrics && row.delivery_metrics.isBodyDrill)
    }));
  }
  // **NOTE: DON'T FORGET TO INCLUDE row.delivery_metrics in line 50 to ~57
  
  // Records one completed round (called from renderResults once feedback
  // has been parsed) so it shows up later in "My History".
  async function recordBallotToHistory(parsed, feedback, transcript, question, round, videoBlob, annotations, deliveryMetrics, recordSource, isIntroDrill, isBodyDrill){
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
    const deliveryMetricsWithSource = Object.assign({}, deliveryMetrics || {}, { recordSource: recordSource || 'camera', isIntroDrill: !!isIntroDrill, isBodyDrill: !!isBodyDrill });
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
    if(pt === 'introdrill') return ' (Rapid Drill: Introduction)';
    if(pt === 'bodydrill') return ' (Rapid Drill: Body)';
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
          <option value="introdrill">Rapid Drill: Introduction</option>
          <option value="bodydrill">Rapid Drill: Body</option>
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
    const xGrid = xLabels.map((r,i) => {
      const x = xForI(i);
      return `<line class="grid-line" x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${h-marginBottom}"/>
        <text class="axis-label" x="${x.toFixed(1)}" y="${(h-marginBottom+18).toFixed(1)}" text-anchor="middle">R${r}</text>`;
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
  let historyTrendsMode = 'all'; // 'all' | 'regular' | 'introdrill' | 'bodydrill'
  const HISTORY_MODE_OPTIONS = [
    { v:'all', l:'All' },
    { v:'regular', l:'Regular Practice' },
    { v:'introdrill', l:'Rapid Drill: Introduction' },
    { v:'bodydrill', l:'Rapid Drill: Body' }
  ];
  function filterByPracticeType(list, mode){
    if(mode === 'regular') return list.filter(e => !e.isIntroDrill && !e.isBodyDrill);
    if(mode === 'introdrill') return list.filter(e => !!e.isIntroDrill);
    if(mode === 'bodydrill') return list.filter(e => !!e.isBodyDrill);
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
    const rounds = asc.map((e,i) => {
      const cats = (e.categories||[]).map(c => `${c.name} ${c.score}/${c.max||10}`).join(', ');
      return `Round ${i+1}: ${e.total !== null && e.total !== undefined ? e.total : '—'}/100 total. Categories — ${cats || 'n/a'}`;
    }).join('\n');
    return `You are an expert NSDA Extemporaneous Speaking coach reviewing a student's full practice history across ${asc.length} round${asc.length===1?'':'s'}:\n\n${rounds}\n\nWrite a concise, honest, encouraging OVERALL coaching comment in 2-3 sentences, addressed directly to the student ("you"), synthesizing patterns across ALL of these rounds — not just the most recent one. Name their single biggest recurring strength and, more importantly, their single biggest recurring area to improve, then give one concrete, actionable next step. Write it as natural flowing coaching prose, not a list of category names. Return ONLY the 2-3 sentence comment — no headers, no markdown, no preamble.`;
  }
  async function generateOverallCoachingComment(asc){
    const candidate = await callGemini(buildOverallFeedbackPrompt(asc), 300);
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
      wrap.innerHTML = '<div class="history-empty">No saved ballots yet — finish a practice round and it will show up here.</div>';
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
              <span class="hc-mode-badge ${entry.isIntroDrill ? 'is-intro' : entry.isBodyDrill ? 'is-body' : 'is-regular'}">${entry.isIntroDrill ? 'Rapid Drill: Intro' : entry.isBodyDrill ? 'Rapid Drill: Body' : 'Regular Practice'}</span>
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
            const ballotHtml = buildBallotBodyHtml(parsed, entry.feedback || '(no feedback saved)');
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


  function applySpeakerName(email){
    if(!speakerNameEl) return;
    var stored = null;
    try{ stored = localStorage.getItem('extemplary_speaker_name:' + (email||'').toLowerCase()); }catch(e){}
    speakerNameEl.textContent = (stored && stored.trim()) ? stored.trim().slice(0, 20) : 'You';
  }

  window.addEventListener('extemplary:speaker-name-set', function(ev){
    if(!speakerNameEl) return;
    var name = (ev.detail && ev.detail.name || '').trim().slice(0, 20);
    speakerNameEl.textContent = name || 'You';
  });

  const accountChip = document.getElementById('accountChip');
  const accountEmail = document.getElementById('accountEmail');

  function onSignedIn(user){
    currentUser = { id: user.id, email: user.email };
    accountChip.classList.remove('hidden');
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
    });
  })();


  // ===== Decorative side-margin parallax words (purely visual, no interaction) =====
  (function setupSideWords(){
    const leftInner  = document.getElementById('sideWordsLeftInner');
    const rightInner = document.getElementById('sideWordsRightInner');
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
      return picked.join('   ·   ');
    }

    function fillColumn(container, wordList, spacing, offset){
      const totalHeight = container.offsetHeight || (window.innerHeight * 4);
      const count = Math.ceil(totalHeight / spacing);
      for(let i=0;i<count;i++){
        const span = document.createElement('div');
        span.className = 'side-word';
        span.textContent = randomLineText(wordList);
        span.style.top = (i * spacing + 40) + 'px';

        // Every row uses the same wobble keyframe but with direction:alternate,
        // so motion continuously reverses at each extreme instead of ever
        // snapping back to its start, that snap was what caused the visible
        // "skip" whenever the old animation looped. Half the rows start out
        // of phase (alternate-reverse) so they don't all move in lockstep.
        const direction = (i % 2 === 0) ? 'alternate' : 'alternate-reverse';
        const duration = 18 + (i % 5) * 3; // 18–30s, slow and varied per row
        span.style.animation = 'driftWobble ' + duration + 's ease-in-out infinite';
        span.style.animationDirection = direction;
        span.style.animationDelay = '-' + ((i * 1.7) % duration).toFixed(1) + 's';

        // Swap in new random words only at the extremes of the wobble (where
        // horizontal velocity is momentarily zero), and crossfade the text via
        // opacity rather than popping it, so the content change is never
        // visible as a jump, satisfies a smooth, continuous-feeling wall.
        span.addEventListener('animationiteration', () => {
          span.style.opacity = '0';
          setTimeout(() => {
            span.textContent = randomLineText(wordList);
            span.style.opacity = '1';
          }, 300);
        });

        container.appendChild(span);
      }
    }
    fillColumn(leftInner, WORDS, 30, 0);
    fillColumn(rightInner, WORDS, 30, 5);

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
      leftInner.style.transform  = 'translateY(' + currentLeftY.toFixed(2)  + 'px)';
      rightInner.style.transform = 'translateY(' + currentRightY.toFixed(2) + 'px)';
      requestAnimationFrame(animateParallax);
    }
    window.addEventListener('scroll', computeParallaxTargets, { passive:true });
    computeParallaxTargets();
    requestAnimationFrame(animateParallax);
  })();

  const RUBRIC_PROMPT = DATA.RUBRIC_PROMPT;
  const INTRO_RUBRIC_PROMPT = DATA.INTRO_RUBRIC_PROMPT;
  const BODY_RUBRIC_PROMPT = DATA.BODY_RUBRIC_PROMPT;

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
  let lastRawFeedback = '';
  let lastQuestion = '';
  let lastDeliveryMetrics = null;
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
  function createProgressController(fillEl, phraseEl){
    let target = 0, current = 0, raf = null, phraseTimer = null, phrases = [], phraseIdx = 0;
    function paint(){
      fillEl.style.width = current.toFixed(1) + '%';
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
  const pipelineProgress = createProgressController(procProgressFill, procProgressPhrase);
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
  const viewCitation   = document.getElementById('view-citation');
  const viewHistory    = document.getElementById('view-history');
  const viewStreak     = document.getElementById('view-streak');
  const statusText     = document.getElementById('statusText');
  const statusSub      = document.getElementById('statusSub');
  const processError   = document.getElementById('processError');
  const processErrorActions = document.getElementById('processErrorActions');
  const roundNoEl      = document.getElementById('roundNo');
  const speakerNameEl  = document.getElementById('speakerName');
  const sessionTag     = document.getElementById('sessionTag');
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
  const sigMin         = document.getElementById('sigMin');
  const sigSec         = document.getElementById('sigSec');
  const sigLabel       = document.getElementById('sigLabel');
  const sigColor       = document.getElementById('sigColor');

  // ===== VIEWS =====
  let viewBeforeExample = null;
  let viewBeforeBriefing = null;
  function showView(v){
    [viewRecord, viewReview, viewProcessing, viewResults, viewExample, viewBriefing, viewHistory, viewCitation, viewStreak].forEach(x => x.classList.add('hidden'));
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
  let practiceMode = 'regular'; // 'regular' | 'introdrill' | 'bodydrill'
  let introDrillMode = false;
  let bodyDrillMode = false;
  const INTRO_PREP_SECONDS = 5 * 60;
  const INTRO_RECORD_CAP_SECONDS = 65; // ~1 minute, with a few seconds of grace
  const BODY_PREP_SECONDS = 10 * 60;
  const BODY_RECORD_CAP_SECONDS = 125; // ~2 minutes, with a few seconds of grace
  const REGULAR_PREP_SECONDS = 30 * 60;
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

  const modeSwitch         = document.getElementById('modeSwitch');
  const modeRegularBtn     = document.getElementById('modeRegularBtn');
  const modeIntroDrillBtn  = document.getElementById('modeIntroDrillBtn');
  const modeBodyDrillBtn   = document.getElementById('modeBodyDrillBtn');
  const modeSwitchHint     = document.getElementById('modeSwitchHint');
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

  function setPracticeMode(mode){
    practiceMode = mode;
    introDrillMode = (mode === 'introdrill');
    bodyDrillMode = (mode === 'bodydrill');
    const isRegular = mode === 'regular';
    modeRegularBtn.classList.toggle('active', isRegular);
    modeIntroDrillBtn.classList.toggle('active', introDrillMode);
    modeBodyDrillBtn.classList.toggle('active', bodyDrillMode);
    modeRegularBtn.setAttribute('aria-selected', String(isRegular));
    modeIntroDrillBtn.setAttribute('aria-selected', String(introDrillMode));
    modeBodyDrillBtn.setAttribute('aria-selected', String(bodyDrillMode));
    modeSwitchHint.textContent = introDrillMode
      ? '5-minute prep, then record just the introduction up to 1 minute. Graded only on hook, link, thesis, clarity, and delivery.'
      : bodyDrillMode
      ? '10-minute prep, then record just 1 body paragraph up to 2 minutes. Graded on everything the full round is graded on except the intro and conclusion.'
      : '30-minute prep, then record a full 7-minute. Graded on all 8 rubric categories.';
    ballotModeLabel.textContent = introDrillMode ? 'Rapid Drill: Introduction' : bodyDrillMode ? 'Rapid Drill: Body' : 'Regular Practice';
    ballotModeLabel.classList.toggle('is-intro', introDrillMode);
    ballotModeLabel.classList.toggle('is-body', bodyDrillMode);
    ballotModeLabel.classList.toggle('is-regular', isRegular);
    ballotTitleEl.textContent = introDrillMode ? 'Intro Drill Ballot' : bodyDrillMode ? 'Body Drill Ballot' : 'Practice Ballot';
    startTimerBtn.classList.toggle('mode-regular', isRegular);
    startTimerBtn.classList.toggle('mode-introdrill', introDrillMode);
    startTimerBtn.classList.toggle('mode-bodydrill', bodyDrillMode);
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
    { label:'Easy+', instructions:'Keep this an EASY-PLUS question, tied to a major well-known topic but requiring awareness of one specific recent headline within it.', example:'Can the U.S. and China finalize a lasting trade agreement this year?' },
    { label:'Somewhat Easy', instructions:'Keep this a SOMEWHAT-EASY question, tied to a widely covered domestic policy debate that dominates mainstream news, requiring one specific but well-known detail.', example:'Should Congress pass new background-check legislation for gun purchases?' },
    { label:'Mild Easy', instructions:'Keep this a MILDLY-EASY question, tied to a well-known institution or alliance but framed around a specific recent decision rather than the general topic.', example:'Should NATO members commit to higher defense-spending targets this year?' },
    { label:'Leaning Easy', instructions:'Keep this a LEANING-EASY question: build it around a fairly well-known event, policy, or public figure that a generally informed reader would likely recognize, but with slightly more specificity than a purely surface-level topic. Avoid truly obscure names or narrow regional policy details.', example:'Should the U.S. expand tariffs on Chinese-made electric vehicles and batteries?' },
    { label:'Easy-Medium', instructions:'Keep this an EASY-TO-MEDIUM question, tied to a well-known economic institution but requiring slightly more specific awareness of a recent development.', example:'Is the Federal Reserve right to hold interest rates steady at its next meeting?' },
    { label:'Medium-Leaning Easy', instructions:'Keep this a MEDIUM question that leans slightly easy, tied to a specific ongoing domestic policy debate covered widely enough that most attentive news readers would recognize it.', example:'Should more states adopt no-excuse mail-in voting ahead of the midterms?' },
    { label:'Medium-Easy', instructions:'Keep this a MEDIUM-EASY question, tied to a specific recent development within a well-covered ongoing international story, requiring more than headline-level knowledge but nothing obscure.', example:'Can Mexico\'s president sustain her approval ratings amid rising cartel violence?' },
    { label:'Medium-Easy Plus', instructions:'Keep this a MEDIUM-EASY-PLUS question, tied to a specific, actively-developing domestic regulatory or corporate story that requires having followed recent business/tech news, not just the general topic.', example:'Will the FTC\'s latest antitrust suit change how Big Tech companies acquire startups?' },
    { label:'Easy-Leaning Medium', instructions:'Keep this an EASY-LEANING-MEDIUM question, tied to a specific piece of domestic economic legislation or its expiring provisions, requiring more than surface awareness of the policy debate.', example:'Should Congress renew the expiring provisions of the CHIPS Act\'s semiconductor subsidies?' },
    { label:'Medium-Minus', instructions:'Keep this a MEDIUM-MINUS question, built around a well-known international institution but tied to a specific recent funding or leadership development within it.', example:'Can the World Health Organization close the funding gap left by the U.S. withdrawal?' },
    { label:'Medium', instructions:'Keep this a MEDIUM-difficulty question: it should require knowing a specific recent event, policy, or somewhat-less-famous public figure, but still be findable in mainstream news coverage from the last couple weeks — not obscure enough to require specialty trade press.', example:'Should the European Central Bank cut rates again after its latest inflation report?' },
    { label:'Medium-Plus', instructions:'Keep this a MEDIUM-PLUS question, built around a specific international legal or diplomatic development that requires having followed the story beyond a single headline.', example:'Will the International Criminal Court\'s arrest warrant change how governments host wanted officials at summits?' },
    { label:'Medium-Hard', instructions:'Keep this a MEDIUM-HARD question, tied to a specific domestic regulatory or health-policy debate that requires having followed the story somewhat closely, not just the headline.', example:'Should the FDA speed up approval timelines for next-generation weight-loss drugs?' },
    { label:'Medium-Leaning Hard', instructions:'Keep this a MEDIUM question that leans slightly hard, built around a specific financial-regulatory body and a narrow rule change that requires having read beyond general headlines to recognize.', example:'Should the Basel Committee tighten capital rules for regional banks after last year\'s mid-size bank failures?' },
    { label:'Mostly Hard', instructions:'Keep this a MOSTLY-HARD question, built around a specific regional economic institution or trade bloc and a narrow, less mainstream development within it.', example:'Can the African Continental Free Trade Area deliver tariff-free trade before member states abandon its timeline?' },
    { label:'Leaning Hard', instructions:'Keep this a LEANING-HARD question: build it around a specific, less mainstream event, policy, or regional figure that requires having read somewhat deeper coverage (not just front-page headlines) to recognize.', example:'Can Kenya\'s president rebuild public trust after last year\'s finance-bill protests?' },
    { label:'Somewhat Hard', instructions:'Keep this a SOMEWHAT-HARD question, built around a regional political crisis or lesser-known transitional government that requires having followed specific ongoing coverage, not just general world news.', example:'Can Bangladesh\'s interim government deliver credible elections after last year\'s unrest?' },
    { label:'Hard-Leaning', instructions:'Keep this a HARD-LEANING question, built around a specific obscure treaty, territorial dispute, or narrow diplomatic ambiguity that would require having read a full article on the subject, not just a headline, to recognize. Prefer treaties, disputes, or narrow policies over \'can this leader survive\' framings.', example:'Will the Svalbard Treaty\'s mineral-rights ambiguity spark a diplomatic dispute between Norway and Russia?' },
    { label:'Very Hard-Leaning', instructions:'Keep this a VERY-HARD-LEANING question, built around a specific niche international regulatory or certification body and a narrow enforcement dispute most people would not have encountered outside dedicated coverage.', example:'Should the Kimberley Process suspend a member after new evidence of conflict-diamond smuggling through Zimbabwe?' },
    { label:'Hard', instructions:'Keep this a HARD, NICHE question: build it around a specific, lesser-known event, policy, or figure that most people would never have heard of — the kind of question that requires having read niche news coverage closely, not just general headlines. Favor obscure names, minor regional leaders, or narrow specific policies/deals over broad well-known topics.', example:'Can East Timor\'s José Ramos-Horta defuse backlash over the AB Digital Technology Resort deal?' },
    { label:'Very Hard-Leaning Plus', instructions:'Keep this a question just below the hardest tier, built around a specific regional political bloc or forum and a narrow diplomatic strain within it, requiring specialist-level regional news familiarity.', example:'Can the Pacific Islands Forum hold together after Kiribati\'s renewed ties with Beijing strain the bloc?' },
    { label:'Very Hard', instructions:'Keep this a VERY HARD, deeply niche question, built around an extremely obscure bilateral agreement, minor deal, or narrow trade-press-only development that virtually no one outside specialist coverage would recognize. Prefer a specific treaty, compact, or agreement over a \'can this leader survive\' framing.', example:'Will the U.S.–Micronesia Compact of Free Association renewal survive this session\'s congressional budget fights?' },
    { label:'Extremely Hard-Leaning', instructions:'Keep this an EXTREMELY niche question, built around an extremely obscure regional figure and a disputed political development that virtually no one outside specialist coverage would recognize.', example:'Can Comoros President Azali Assoumani consolidate power after his disputed reelection and the opposition\'s boycott?' },
    { label:'Extremely Hard', instructions:'Keep this an EXTREMELY HARD question — the most niche tier available, built around a highly specific minor trade-law ruling, obscure regulatory dispute, or narrow diplomatic/legal development that only someone reading specialist/trade press coverage within the last few days would recognize. Go more obscure than the \'Very Hard\' tier, and prefer an institutional/legal/regulatory angle over a \'can this leader survive\' framing.', example:'Will a WTO fisheries-subsidy ruling force the Faroe Islands to renegotiate its mackerel quota with the EU?' }
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
      qDifficultyCatLabel.textContent = selectedCategory.toLowerCase();
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
  const GEMINI_MODEL = 'gemini-2.5-flash';

  // Gemini calls go through the edge function's own server-side keys, 
  // there's no user-supplied override key anymore.
  function geminiKeyList(){
    return [];
  }

  async function callGeminiWithKey(prompt, apiKey, maxOutputTokens){
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/gemini-generate`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer '+SUPABASE_ANON_KEY,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ prompt, maxOutputTokens: maxOutputTokens||1024, overrideKey: apiKey || undefined })
    });
    if(!res.ok){
      const bodyText = await res.text().catch(()=> '');
      throw new Error('gemini_failed:'+res.status+':'+bodyText.slice(0,300));
    }
    const json = await res.json();
    const candidate = json.candidates?.[0];
    if(!candidate) throw new Error('gemini_no_candidate:'+JSON.stringify(json).slice(0,200));
    return candidate;
  }

  // Tries each available override key in order, then lets the edge function
  // fall back through its own server-side keys if none are supplied/work.
  async function callGemini(prompt, maxOutputTokens){
    const keys = geminiKeyList();
    if(!keys.length) return await callGeminiWithKey(prompt, null, maxOutputTokens);
    let lastErr = null;
    for(const key of keys){
      try{
        return await callGeminiWithKey(prompt, key, maxOutputTokens);
      }catch(err){
        lastErr = err;
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
      const candidate = await callGemini(prompt, 3200);
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
      qGenError.textContent = "Couldn't draft questions right now — check your connection and try again." + waitNote + detail;
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
      const candidate = await callGemini(prompt, 2400);
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
      bfError.textContent = "Couldn't put together a briefing right now — check your connection and try again." + waitNote + detail;
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
      const candidate = await callGemini(prompt, 700);
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
      ccError.textContent = "Couldn't check that citation right now — check your connection and try again." + waitNote + detail;
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
    const fullTable = rubricPanel.querySelector('.rubric-table:not(#introRubricTable):not(#bodyRubricTable)');
    const introTable = document.getElementById('introRubricTable');
    const bodyTable = document.getElementById('bodyRubricTable');
    if(fullTable) fullTable.classList.toggle('hidden', isIntro || isBody);
    if(introTable) introTable.classList.toggle('hidden', !isIntro);
    if(bodyTable) bodyTable.classList.toggle('hidden', !isBody);
    rubricModeLabel.textContent = isIntro ? 'Rapid Drill: Introduction Rubric' : isBody ? 'Rapid Drill: Body Rubric' : 'Regular Practice Rubric';
    rubricModeLabel.classList.toggle('is-intro', isIntro);
    rubricModeLabel.classList.toggle('is-body', isBody);
    rubricModeLabel.classList.toggle('is-regular', !isIntro && !isBody);
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
    const mode = introDrillMode ? 'introdrill' : bodyDrillMode ? 'bodydrill' : 'regular';
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
    if(ballotHeadEl) ballotHeadEl.classList.toggle('hidden', !BALLOT_HEAD_VISIBLE_VIEWS.includes(v));
  };
  rubricToggle.classList.toggle('hidden', !RUBRIC_VISIBLE_VIEWS.includes(viewRecord));
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
  function applyTheme(theme){
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if(theme === 'light'){
      document.documentElement.setAttribute('data-theme', 'light');
      themeIconMoon.classList.add('hidden');
      themeIconSun.classList.remove('hidden');
      navThemeIconMoon?.classList.add('hidden');
      navThemeIconSun?.classList.remove('hidden');
      if(metaTheme) metaTheme.setAttribute('content', '#e9edf1');
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeIconMoon.classList.remove('hidden');
      themeIconSun.classList.add('hidden');
      navThemeIconMoon?.classList.remove('hidden');
      navThemeIconSun?.classList.add('hidden');
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
        <button class="sig-edit" data-i="${i}" title="Edit" type="button">Edit</button>
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
    signalCount.textContent = sorted.length + (sorted.length === 1 ? ' signal' : ' signals');
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
      if(err.name === 'AbortError') throw new Error('timeout:Groq took too long to respond ('+Math.round(timeoutMs/1000)+'s) — it may be overloaded. Try again.');
      throw err;
    }finally{
      clearTimeout(timer);
    }
  }

  document.getElementById('submitBtn').addEventListener('click', () => {
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
  const GROQ_UPLOAD_SAFE_BYTES = 8 * 1024 * 1024;  // conservative per-chunk budget, well under Groq's ~25MB cap and any proxy/edge-function body-size limit in front of it
  const GROQ_UPLOAD_MIN_BYTES  = 512 * 1024;        // floor so we don't recurse forever on a genuinely broken upload path

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
    return /:429:|:500:|:502:|:503:|:504:/.test(s) || /rate.?limit/i.test(s) || s.includes('Failed to fetch');
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
          if(attempt < 2 && isTransientError(err)){
            await new Promise(r => setTimeout(r, 600 * (attempt+1)));
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
    if(key) form.append('overrideKey', key);
    const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/groq-transcribe`,{
      method:'POST',
      headers:{
        'Authorization':'Bearer '+SUPABASE_ANON_KEY,
        'apikey': SUPABASE_ANON_KEY
      },
      body:form
    }, 75000);
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
      onStatus && onStatus('Transcribing testimony…', '', 0.92);
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
          'Transcribing testimony… (part '+(completed+1)+' of '+chunkRanges.length+')',
          'Recording is long, so it\'s being processed in '+chunkRanges.length+' parts'+(keys.length>1?' across '+keys.length+' API keys':'')+'.',
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
        <span class="tag">Feedback</span>
        <p>${inlineMd(EXAMPLE_DRILL)}</p>
      </div>`;
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
    const phrases = introDrillMode ? INTRO_PIPELINE_PHRASES : bodyDrillMode ? BODY_PIPELINE_PHRASES : PIPELINE_PHRASES;
    statusText.textContent = 'Reading audio track…';
    statusSub.textContent = 'Decoding and compressing the recording before upload.';
    pipelineProgress.start(phrases.audio, 8);
    try{
      let audioBuffer;
      try{
        audioBuffer = await decodeAudioFromBlob(recordedBlob);
      }catch(e){
        throw new Error('decode_failed::Could not decode the recording\'s audio track in this browser.');
      }

      pipelineProgress.setStage(12, phrases.transcribe);
      const { text: transcript, words: wordTimestamps } = await transcribeLongAudio(
        audioBuffer, [key, key2, key3],
        (main, sub, frac)=>{
          statusText.textContent = main; statusSub.textContent = sub;
          // frac (0-1), when provided, reflects progress through multi-part
          // transcription, map it onto the 12%-40% band for this stage.
          const pct = (typeof frac === 'number') ? 12 + frac * 28 : 40;
          pipelineProgress.setStage(pct);
        }
      );
      if(!transcript){ pipelineProgress.stop(); showProcessError("Didn't catch any speech — check your mic isn't muted and try again.", true); return; }
      lastTranscript = transcript;
      lastWordTimestamps = Array.isArray(wordTimestamps) ? wordTimestamps : [];

      statusText.textContent = 'Analyzing vocal delivery…';
      statusSub.textContent = 'Measuring volume, emphasis, tone shifts, and pacing from the waveform.';
      pipelineProgress.setStage(55, phrases.delivery);
      const deliveryMetrics = await analyzeAudioDelivery(audioBuffer, wordTimestamps);
      const fillerStutterStats = countFillersAndStutters(transcript);
      lastDeliveryMetrics = deliveryMetrics
        ? Object.assign(deliveryMetrics, fillerStutterStats)
        : Object.assign({ audioUnavailable:true }, fillerStutterStats);

      statusText.textContent = 'The panel is deliberating…';
      statusSub.textContent = introDrillMode
        ? 'Llama 3.3 70B Versatile is scoring your introduction against the intro-drill rubric.'
        : bodyDrillMode
        ? 'Llama 3.3 70B Versatile is scoring your body point against the body-drill rubric.'
        : 'Llama 3.3 70B Versatile is scoring your speech against the rubric.';
      pipelineProgress.setStage(88, phrases.judging);

      const metricsBlock = buildDeliveryMetricsBlock(deliveryMetrics, fillerStutterStats);
      const chatJson = await withKeyFallback(async (k) => {
        const res = await fetchWithTimeout(`${SUPABASE_FUNCTIONS_URL}/groq-chat`,{
          method:'POST',
          headers:{
            'Authorization':'Bearer '+SUPABASE_ANON_KEY,
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type':'application/json'
          },
          body: JSON.stringify({
            model:'llama-3.3-70b-versatile', temperature:0.4, max_tokens:3000,
            messages:[
              {role:'system', content: introDrillMode ? INTRO_RUBRIC_PROMPT : bodyDrillMode ? BODY_RUBRIC_PROMPT : RUBRIC_PROMPT},
              {role:'user', content:'TRANSCRIPT:\n\n'+transcript+'\n\n'+metricsBlock}
            ],
            overrideKey: k || undefined
          })
        }, 60000);
        if(!res.ok) throw new Error('judging_failed:'+res.status+':'+await safeErrText(res));
        return await res.json();
      }, key, key2, key3);
      const feedback = chatJson.choices?.[0]?.message?.content || '';
      if(!feedback) throw new Error('judging_failed:empty:No content returned.');
      lastRawFeedback = feedback;

      statusText.textContent = 'Marking up the transcript…';
      statusSub.textContent = 'Adding inline judge comments and paragraph structure.';
      pipelineProgress.setStage(95, phrases.annotate);
      lastTranscriptAnnotations = await fetchTranscriptAnnotations(transcript, key, key2, key3);

      pipelineProgress.finish();
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
            'Authorization':'Bearer '+SUPABASE_ANON_KEY,
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type':'application/json'
          },
          body: JSON.stringify({
            model:'llama-3.3-70b-versatile', temperature:0.3, max_tokens:3800,
            response_format:{ type:'json_object' },
            messages:[
              {role:'system', content: introDrillMode ? INTRO_ANNOTATION_PROMPT : bodyDrillMode ? BODY_ANNOTATION_PROMPT : ANNOTATION_PROMPT},
              {role:'user', content:'TRANSCRIPT:\n\n'+transcript}
            ],
            overrideKey: k || undefined
          })
        }, 45000);
        if(!res.ok) throw new Error('annotation_failed:'+res.status);
        return await res.json();
      }, key, key2, key3);
      const raw = chatJson.choices?.[0]?.message?.content || '';
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
      return (j.error?.message) ? j.error.message : JSON.stringify(j).slice(0,200);
    }catch(e){ return res.statusText || 'Unknown error'; }
  }

  function handlePipelineError(err){
    let msg = 'Something went wrong talking to Groq.';
    const s = String(err.message || err);
    if(s.includes('Failed to fetch')||err instanceof TypeError)
      msg = "Couldn't reach Groq's API — open this file directly in your browser (not an embedded preview) and check your internet connection.";
    else if(s.includes(':401:')||s.toLowerCase().includes('invalid api key'))
      msg = 'Groq rejected the API key (401). Double-check you pasted the correct key.';
    else if(s.includes(':413:')||s.toLowerCase().includes('request entity too large'))
      msg = 'The recording was still too large to upload even after automatic compression and splitting. Try recording a shorter speech, or check your internet connection and try again.';
    else if(s.startsWith('transcription_failed'))
      msg = 'Transcription failed: '+s.split(':').slice(2).join(':');
    else if(s.startsWith('decode_failed'))
      msg = s.split(':').slice(2).join(':') || "Couldn't read the recording's audio track.";
    else if(s.startsWith('judging_failed'))
      msg = 'Judging failed: '+s.split(':').slice(2).join(':');
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
      else if(catMatch && !totalMatch && !rankMatch) out.categories.push({
        name: catMatch[1].replace(/[-–—:\s]+$/,'').trim(),
        score: parseFloat(catMatch[2]),
        max: parseInt(catMatch[3],10),
        whatWorked:  extractField(body,'What Worked'),
        criticalFlaws: extractField(body,'Critical Flaws'),
        evidence:    extractField(body,'What You Could Have Done')
      });
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
  function buildBallotBodyHtml(parsed, rawFeedback){
    let html = '';
    if(parsed.categories.length >= 3 && parsed.total !== null){
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
      if(parsed.rankExplanation) html += `
        <div class="rank-explanation">${inlineMd(parsed.rankExplanation)}</div>`;
      if(parsed.drill) html += `
        <div class="drill">
          <span class="tag">Feedback</span>
          <p>${inlineMd(parsed.drill)}</p>
        </div>`;
    }else{
      html += `<div class="raw-fallback">${basicMarkdown(rawFeedback)}</div>`;
    }
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

    if(parsed.categories.length >= 3 && parsed.total !== null){
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
      if(parsed.rankExplanation) html += `
        <div class="rank-explanation">${inlineMd(parsed.rankExplanation)}</div>`;
      if(parsed.drill) html += `
        <div class="drill">
          <span class="tag">Feedback</span>
          <p>${inlineMd(parsed.drill)}</p>
        </div>`;
    }else{
      html += `<div class="raw-fallback">${basicMarkdown(feedback)}</div>`;
    }

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
    recordBallotToHistory(parsed, feedback, transcript, lastQuestion, roundNo, recordedBlob, lastTranscriptAnnotations, lastDeliveryMetrics, captureMode, introDrillMode, bodyDrillMode);
    showView(viewResults);
  }

  function renderFlightStrips(){
    if(!flightHistory.length){ flightStripResults.classList.add('hidden'); return; }
    const chips = flightHistory.map(f=>`<span class="chip">R${f.round}: <b>${f.total}/100</b></span>`).join('');
    flightStripResults.innerHTML = chips;
    flightStripResults.classList.remove('hidden');
  }

  function resetHomeView(){
    // Blank the question box back to its initial "choose a method" state
    questionMode = null;
    introPrepStartedForCurrentQuestion = false;
    bodyPrepStartedForCurrentQuestion = false;
    stopIntroPrepTimer();
    introPrepModal.classList.add('hidden');
    stopBodyPrepTimer();
    bodyPrepModal.classList.add('hidden');
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

  function downloadBallotTxt(){
    const blob = new Blob([
      'EXTEMPLARY — OFFICIAL PRACTICE BALLOT\nRound '+roundNo+'\n',
      lastQuestion ? 'QUESTION: '+lastQuestion+'\n\n' : '\n',
      lastRawFeedback,
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
      lastRawFeedback + '\n\n--- TRANSCRIPT ---\n\n' + lastTranscript;
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