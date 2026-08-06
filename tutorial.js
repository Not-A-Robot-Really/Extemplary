/* ==========================================================================
   Extemplary: first-run tutorial (cutscene) walkthrough

   Runs ONLY the first time a brand-new account is created. Never runs for
   people logging in to an existing account, and never runs again once
   finished or skipped (tracked per-account in localStorage).

   Design: this file does NOT reach into the main app's closures (the whole
   app lives inside one big IIFE). Instead it drives the real UI the same
   way a person would: highlighting real buttons, requiring real clicks on
   them, and watching the app's own hidden/shown classes to know when a
   real action (a goal was saved, a briefing came back, a question was
   picked, etc.) actually happened.

   Remember: KEEP skelPct AT (55, 90), it'll look wonky if it isn't
   ========================================================================== */
(function(){
  "use strict";

  var $ = function(sel, root){ return (root||document).querySelector(sel); };
  var byId = function(id){ return document.getElementById(id); };

  /* ---------------------------------------------------------------------
     1. DECIDE WHETHER TO EVEN ARM THE TUTORIAL
     --------------------------------------------------------------------- */
  var PENDING_KEY = 'extemplary_tutorial_pending_email';
  var doneKeyFor = function(email){ return 'extemplary_tutorial_done:' + (email||'').toLowerCase(); };

  var authForm = byId('authForm');
  var authTabSignup = byId('authTabSignup');
  var authGate = byId('authGate');
  var accountEmail = byId('accountEmail');

  if(authForm && authTabSignup){
    // Capture phase so we record intent before the app's own async signup
    // handler runs; if it succeeds, we'll know to launch the tutorial the
    // moment authGate disappears.
    authForm.addEventListener('submit', function(){
      if(authTabSignup.classList.contains('active')){
        var email = (byId('authEmail') && byId('authEmail').value || '').trim();
        if(email) localStorage.setItem(PENDING_KEY, email);
      }
    }, true);
  }

  function maybeLaunchAfterSignIn(){
    var pendingEmail = localStorage.getItem(PENDING_KEY);
    if(!pendingEmail) return;
    var liveEmail = (accountEmail && accountEmail.textContent || '').trim();
    if(!liveEmail || liveEmail.toLowerCase() !== pendingEmail.toLowerCase()) return;
    if(localStorage.getItem(doneKeyFor(liveEmail))) { localStorage.removeItem(PENDING_KEY); return; }
    localStorage.removeItem(PENDING_KEY);
    setTimeout(function(){ Tutorial.start(liveEmail); }, 700);
  }

  // NOTE: index.html (the app) no longer has an #authGate on the page. Signing
  // in there just fills in #accountEmail via the app's own onSignedIn().
  // PAY ATTENTION to that element instead. Also check once immediately in case
  // it was already populated before this script finished loading.
  if(accountEmail){
    new MutationObserver(maybeLaunchAfterSignIn)
      .observe(accountEmail, { childList:true, characterData:true, subtree:true });
    maybeLaunchAfterSignIn();
  }

  /* ---------------------------------------------------------------------
     2. THE ENGINE
     --------------------------------------------------------------------- */
  var Tutorial = { start: start };
  window.ExtemplaryTutorial = Tutorial; // exposed for manual testing/QA

  var state = null; // { steps, idx, email, cleanup }

  function q(sel){ return document.querySelector(sel); }

  function openSidebar(){
    var panel = byId('navMenuPanel');
    if(panel) panel.classList.remove('nav-drawer-collapsed');
  }

  /* ---------------------------------------------------------------------
     Fake "skeleton" preview of My Ballot History for brand-new accounts.
     A new user has zero recorded rounds, so the real page would show
     nothing for Coach's Notes / Trends / Goals / round list, but the
     tour still wants to point at those sections and describe what they
     become once you've recorded ~7 speeches. Rather than invent fake
     copy (which reads as real and can be confusing/wrong), this paints
     plain placeholder blocks in the exact real layout: same headings,
     same card/bar counts, but every line of actual text or data is just
     a colored rectangle. Widths/colors are randomized per render so it
     reads as clearly-a-placeholder rather than a specific data point.
     Purely cosmetic; real renderHistoryList() overwrites all of this
     the moment History is opened for real after the tour.
     --------------------------------------------------------------------- */
  function skelPct(min, max){ return Math.round(min + Math.random() * (max - min)); }
  function skelColor(){
    var palette = ['#8a9bb5', '#b58a9b', '#9bb58a', '#c9a86a', '#7a8ca8', '#a87a8c'];
    return palette[Math.floor(Math.random() * palette.length)];
  }
  function skelBarRow(){
    return '<div class="tut-skel-block tut-skel-bar" style="width:' + skelPct(40, 92) + '%;height:14px;background:' + skelColor() + ';opacity:0.55;"></div>';
  }

  // Real rubric category names (just labels, no invented scores) so the
  // skeleton preview reads as "this app, before you have data" rather than
  // a generic loading spinner. Widths/values next to them are still random
  // placeholders, never anything that looks like a specific real result.
  var SKEL_CATEGORIES = [
    'Creative Hook & Intro', 'Structure', 'Strength of Argument & Analysis',
    'Flaws in Reasoning', 'Strength of Evidence', 'Speech Quality, Vocal Delivery, and Fluency'
  ];
  var SKEL_MODES = [
    { cls:'is-regular', label:'Regular Practice' },
    { cls:'is-intro', label:'Rapid Drill: Intro' },
    { cls:'is-body', label:'Rapid Drill: Body' }
  ];
  var HISTORY_MODE_OPTIONS_SKEL = [
    { v:'all', l:'All' },
    { v:'regular', l:'Regular Practice' },
    { v:'introdrill', l:'Rapid Drill: Introduction' },
    { v:'bodydrill', l:'Rapid Drill: Body' }
  ];

  /* -------- Coach's Overall Notes -------- */
  function paintOverallSkeleton(){
    var overallEl = byId('historyOverallFeedback');
    if(!overallEl) return;
    overallEl.innerHTML =
      '<div class="history-overall tut-skel">' +
        '<div class="ho-head">' +
          '<span class="ho-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-67"></use></svg></span>' +
          '<h3>Coach\u2019s Overall Notes</h3>' +
        '</div>' +
        '<div class="tut-skel-block tut-skel-line" style="width:96%;"></div>' +
        '<div class="tut-skel-block tut-skel-line" style="width:88%;"></div>' +
        '<div class="tut-skel-block tut-skel-line" style="width:63%;"></div>' +
      '</div>';
  }

  /* -------- Trends Across Your Ballots (real layout: head row + practice-
     type filter select + overall/category trend rows + strengths/
     weaknesses + trend-chart panel with its own select) -------- */
  function paintTrendsSkeleton(){
    var trendsEl = byId('historyTrends');
    if(!trendsEl) return;

    var overallPct = skelPct(55, 90);
    var catRows = SKEL_CATEGORIES.map(function(name){
      var pct = skelPct(45, 95);
      return '<div class="trend-row">' +
        '<span class="trend-name">' + name + '</span>' +
        '<span class="trend-bar-wrap"><span class="tut-skel-block tut-skel-bar" style="width:' + pct + '%;height:100%;background:' + skelColor() + ';opacity:0.55;"></span></span>' +
        '<span class="trend-avg tut-skel-block tut-skel-line" style="width:34px;height:11px;margin:0;display:inline-block;"></span>' +
      '</div>';
    }).join('');

    function strengthWeaknessCol(cls, headingIcon, heading){
      var items = '';
      for(var i=0;i<2;i++){
        items += '<li><span class="tut-skel-block tut-skel-line" style="width:' + skelPct(60,90) + '%;margin:0;height:11px;"></span></li>';
      }
      return '<div class="col ' + cls + '"><h4>' + headingIcon + ' ' + heading + '</h4><ul>' + items + '</ul></div>';
    }
    var strengthIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-65"></use></svg>';
    var weaknessIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-66"></use></svg>';

    var chartBars = '';
    for(var j=0;j<9;j++){
      chartBars += '<div class="tut-skel-block tut-skel-bar" style="width:9%;height:' + skelPct(20,100) + '%;background:' + skelColor() + ';opacity:0.6;"></div>';
    }

    trendsEl.innerHTML =
      '<div class="history-trends tut-skel">' +
        '<div class="trend-head-row">' +
          '<h3>Trends Across Your Ballots</h3>' +
          '<div class="trend-mode-filter">' +
            '<label for="historyModeFilter">Practice type</label>' +
            '<select class="tcp-select" id="historyModeFilter">' +
              HISTORY_MODE_OPTIONS_SKEL.map(function(o){ return '<option value="' + o.v + '">' + o.l + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="trend-rows">' +
          '<div class="trend-row trend-row-overall">' +
            '<span class="trend-name">Overall Score</span>' +
            '<span class="trend-bar-wrap"><span class="tut-skel-block tut-skel-bar" style="width:' + overallPct + '%;height:100%;background:' + skelColor() + ';opacity:0.6;"></span></span>' +
            '<span class="trend-avg tut-skel-block tut-skel-line" style="width:40px;height:13px;margin:0;display:inline-block;"></span>' +
          '</div>' +
          catRows +
        '</div>' +
        '<div class="trend-summary">' +
          strengthWeaknessCol('strength', strengthIcon, 'Overall Strengths') +
          strengthWeaknessCol('weakness', weaknessIcon, 'Overall Weaknesses') +
        '</div>' +
        '<div class="trend-chart-panel">' +
          '<div class="tcp-head">' +
            '<label for="trendChartSelectSkel">View trend</label>' +
            '<select class="tcp-select" id="trendChartSelectSkel"><option>Overall Score</option></select>' +
          '</div>' +
          '<div class="trend-chart-big"><div class="tut-skel-chart">' + chartBars + '</div></div>' +
        '</div>' +
      '</div>';

    // Cosmetic only: a brand-new account has no ballots to actually
    // filter, so picking an option just repaints a fresh random preview
    // rather than wiring up real filtering logic.
    var modeSel = byId('historyModeFilter');
    if(modeSel) modeSel.addEventListener('change', paintTrendsSkeleton);
  }

  /* -------- Your Goals (real goal-card / seal / suggested-goals shapes) -------- */
  function paintGoalsSkeleton(){
    var goalsEl = byId('historyGoals');
    if(!goalsEl) return;
    var cards = '';
    for(var k=0;k<2;k++){
      var pct = skelPct(20, 85);
      cards += '<div class="goal-card tut-skel">' +
        '<div class="goal-card-seal" style="--goal-pct:' + pct + '">' +
          '<div class="goal-card-seal-ring"></div>' +
          '<div class="goal-card-seal-hole"><span class="goal-card-seal-pct">' + pct + '%</span></div>' +
        '</div>' +
        '<div class="goal-card-main">' +
          '<div class="goal-card-label tut-skel-block tut-skel-line" style="width:' + skelPct(50,72) + '%;"></div>' +
          '<div class="goal-card-progress tut-skel-block tut-skel-line" style="width:64px;height:11px;"></div>' +
        '</div>' +
      '</div>';
    }
    var suggested = '';
    for(var s=0;s<2;s++){
      suggested += '<div class="suggested-goal-card">' +
        '<div class="tut-skel-block tut-skel-line" style="width:' + skelPct(55,80) + '%;margin:0;"></div>' +
        '<div class="tut-skel-block" style="width:70px;height:26px;background:' + skelColor() + ';opacity:0.6;border-radius:20px;"></div>' +
      '</div>';
    }
    goalsEl.innerHTML =
      '<div class="history-goals tut-skel">' +
        '<div class="hg-head">' +
          '<div class="sec-head-title">' +
            '<span class="sec-icon sec-icon-target"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-71"></use></svg></span>' +
            '<h3>Your Goals</h3>' +
          '</div>' +
          '<button type="button" class="btn primary" disabled style="opacity:0.5;cursor:default;">+ New Goal</button>' +
        '</div>' +
        '<div class="goals-list">' + cards + '</div>' +
        '<div class="suggested-goals">' +
          '<h4>Suggested for you</h4>' +
          '<div class="suggested-goals-list">' + suggested + '</div>' +
        '</div>' +
      '</div>';
  }

  /* -------- Full round list (real .history-card shape, including the
     mode badge for Regular / Rapid Drill: Intro / Rapid Drill: Body so
     the tour can show off the new practice types right in context) -------- */
  function paintListSkeleton(){
    var listWrapEl = byId('historyListWrap');
    if(!listWrapEl) return;
    var cardsHtml = '';
    for(var m=0;m<3;m++){
      var mode = SKEL_MODES[m % SKEL_MODES.length];
      var catRows = '';
      var catCount = skelPct(3,5);
      var cats = SKEL_CATEGORIES.slice(0, catCount);
      for(var n=0;n<cats.length;n++){
        catRows += '<div class="hc-cat"><b class="tut-skel-block tut-skel-line" style="width:30px;height:11px;margin:0;display:inline-block;"></b> ' + cats[n] + '</div>';
      }
      cardsHtml += '<div class="history-card tut-skel">' +
        '<div class="history-card-head">' +
          '<div class="hc-top">' +
            '<div class="hc-top-left">' +
              '<span class="hc-round">Round ' + (m+1) + '</span>' +
              '<span class="hc-mode-badge ' + mode.cls + '">' + mode.label + '</span>' +
              '<span class="hc-date tut-skel-block tut-skel-line" style="width:100px;height:11px;margin:0;display:inline-block;"></span>' +
            '</div>' +
            '<div class="hc-score tut-skel-block tut-skel-line" style="width:44px;height:24px;margin:0;"></div>' +
          '</div>' +
          '<div class="hc-question tut-skel-block tut-skel-line" style="width:' + skelPct(60,90) + '%;"></div>' +
        '</div>' +
        '<div class="tut-skel-cats" style="padding:0 20px 18px;">' + catRows + '</div>' +
      '</div>';
    }
    var list = byId('historyList');
    if(list) list.innerHTML = cardsHtml;
  }

  function paintHistorySkeleton(){
    paintOverallSkeleton();
    paintTrendsSkeleton();
    paintGoalsSkeleton();
    paintListSkeleton();
  }
  // Don't use 'tutInputRow' for 39e
  function el(){ // dom refs, grabbed lazily since app builds some content late
    return {
      dim: byId('tutDim'), box: byId('tutBox'), ring: byId('tutRing'), hlbox: byId('tutHighlightBox'),
      title: byId('tutTitle'), text: byId('tutText'), avatar: byId('tutAvatar'),
      count: byId('tutStepCount'), hint: byId('tutHint'), hintText: byId('tutHintText'),
      next: byId('tutNextBtn'), skip: byId('tutSkipBtn'), choiceRow: byId('tutChoiceRow'),
      yes: byId('tutYesBtn'), no: byId('tutNoBtn'),
      inputRow: byId('tutInputRow'), nameInput: byId('tutNameInput'), nameError: byId('tutNameError')
    };
  }

  var NAME_MAX_LEN = 20; // secretly capped (the person is never told this number)

  function nameKeyFor(email){ return 'extemplary_speaker_name:' + (email||'').toLowerCase(); }

  /* ---------------------------------------------------------------------
     Speaker name uniqueness, checked against Supabase (same project/anon
     key app.js uses -- the anon key is public by design, safe to reuse
     here). This is a SEPARATE client instance, but supabase-js persists
     the auth session to localStorage under a key derived from the project
     ref, so it shares the same signed-in session as app.js's client
     without needing to sign in again.

     Requires a "usernames" table in Supabase (see setup_usernames.sql):
       user_id uuid primary key references auth.users(id)
       name text
       name_lower text  (unique index on this, case-insensitive uniqueness)

     If that table doesn't exist yet, or the request fails for any other
     reason (offline, RLS misconfigured, etc.), this fails OPEN -- it lets
     the name through rather than getting a brand-new user stuck on step 2
     of the tutorial forever. Run the SQL file once and it starts actually
     enforcing uniqueness.
     --------------------------------------------------------------------- */
  var SUPABASE_URL = 'https://iiehhmelfotwkdqxplug.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpZWhobWVsZm90d2tkcXhwbHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDYxMzEsImV4cCI6MjA5ODkyMjEzMX0.8QzN1LJmr70Sidxp2RsOq-z3S_NX5lN9QWTr45CSaHo';
  var _tutSupabase = null;
  function tutSupabase(){
    if(_tutSupabase) return _tutSupabase;
    if(window.supabase && window.supabase.createClient){
      _tutSupabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _tutSupabase;
  }

  // Resolves { ok:true } if the name is free (and claims it for this
  // account) or { ok:false, message } if someone else already has it.
  function claimSpeakerName(name){
    var sb = tutSupabase();
    if(!sb) return Promise.resolve({ ok:true });
    var lower = (name || '').trim().toLowerCase();
    if(!lower) return Promise.resolve({ ok:true });
    return sb.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      var uid = session && session.user && session.user.id;
      if(!uid) return { ok:true }; // no session yet -- can't enforce, don't block

      return sb.from('usernames').select('user_id').eq('name_lower', lower).maybeSingle()
        .then(function(sel){
          if(sel.error && sel.error.code && sel.error.code !== 'PGRST116'){
            return { ok:true }; // table missing / RLS issue -- fail open
          }
          var takenByOther = sel.data && sel.data.user_id && sel.data.user_id !== uid;
          if(takenByOther){
            return { ok:false, message: "That name is already taken. Try a different one." };
          }
          return sb.from('usernames')
            .upsert({ user_id: uid, name: name, name_lower: lower }, { onConflict: 'user_id' })
            .then(function(up){
              if(up.error && up.error.code === '23505'){
                // Unique-index race: someone else claimed it a moment ago.
                return { ok:false, message: "That name is already taken. Try a different one." };
              }
              return { ok:true };
            });
        });
    }).catch(function(){ return { ok:true }; });
  }

  function clearSpotlight(){
    var e = el();
    e.ring.style.display = 'none';
    e.hlbox.style.display = 'none';
    e.dim.classList.add('tut-visible');
  }

  // Returns a fresh, up-to-date target for the current step (never a
  // cached reference), and treats zero-size/hidden elements as "no
  // target" so the spotlight never gets stuck on something invisible.
  function liveTarget(sel){
    if(!sel) return null;
    var t = q(sel);
    if(!t) return null;
    var r = t.getBoundingClientRect();
    if(r.width < 1 || r.height < 1) return null;
    return t;
  }

  // Draws the highlight ring + glow box around a target purely as
  // separate, always-on-top overlay elements; the target itself is
  // never given a new position/z-index/class, so it's never at risk of
  // being covered by (or blocking clicks through) anything else, and it
  // stays 100% clickable exactly where the app already put it.
  //
  // The highlight box itself does the dimming: a huge, rounded-corner
  // box-shadow spread (see .tut-highlight-box in style.css) darkens the
  // whole viewport EXCEPT the rectangle it's drawn around, so whatever is
  // inside the outline reads at full brightness and everything else stays
  // dim, instead of the old flat overlay dimming the target too. The
  // "pulsing ring" is only drawn when the current step actually needs a
  // real click on the target: for pure "look at this" steps it's just
  // visual FLUFF that can block the very thing being shown off, so it's
  // left out.
  function paintHighlight(target, showRing){
    var e = el();
    if(!target){ e.ring.style.display = 'none'; e.hlbox.style.display = 'none'; e.dim.classList.add('tut-visible'); return; }
    e.dim.classList.remove('tut-visible');
    var r = target.getBoundingClientRect();
    e.hlbox.style.display = 'block';
    e.hlbox.style.top = (r.top - 4) + 'px';
    e.hlbox.style.left = (r.left - 4) + 'px';
    e.hlbox.style.width = (r.width + 8) + 'px';
    e.hlbox.style.height = (r.height + 8) + 'px';
    if(showRing){
      e.ring.style.display = 'block';
      e.ring.style.top = (r.top + r.height/2) + 'px';
      e.ring.style.left = (r.left + r.width/2) + 'px';
    } else {
      e.ring.style.display = 'none';
    }
  }

  // Docks the instructions panel to whichever side of the screen the
  // current target is furthest from (or the right side by default, when
  // there's no target). Because the panel always lives on a fixed edge
  // rail instead of floating next to the target, it can never end up on
  // top of the very thing the step is highlighting, the two things it
  // needs to avoid overlapping (target rect, panel rect) are pinned to
  // opposite sides of the viewport by construction.
  function positionBox(target, showRing){
    var e = el();
    e.box.classList.remove('tut-center', 'tut-dock-left');
    paintHighlight(target, showRing);
    var vw = window.innerWidth;
    var dockLeft = false;
    if(!target){
      e.box.classList.add('tut-center');
    } else {
      var r = target.getBoundingClientRect();
      var targetCenter = r.left + r.width/2;
      dockLeft = targetCenter > vw/2; // target's on the right → dock panel left
      if(dockLeft) e.box.classList.add('tut-dock-left');
    }
  }

  function applySpotlight(sel){
    var t = sel ? q(sel) : null;
    if(t) t.scrollIntoView({ block:'center', behavior:'smooth' });
    return t;
  }

  var repositionHandler = null;
  var repositionTimer = null;

  // Whether the current step actually requires clicking the spotlighted
  // element. That's the only time the pulsing orange ring earns its keep
  // as a "click here" cue: for plain look-at-this steps it just sits on
  // top of the very thing being shown off, so we leave it off.
  function stepNeedsRing(step){
    return !!step.waitForClick;
  }

  function render(){
    var step = state.steps[state.idx];
    var e = el();
    e.dim.classList.add('tut-visible');
    e.box.classList.add('tut-visible');
    e.box.classList.toggle('tut-box-formal', !!step.formal);
    e.avatar.textContent = step.avatar || '🎙️';
    e.title.textContent = step.title;
    e.text.innerHTML = step.html || '';
    e.count.textContent = 'Step ' + (state.idx+1) + ' of ' + state.steps.length;
    var progressFill = byId('tutProgressFill');
    if(progressFill) progressFill.style.width = Math.round(((state.idx+1) / state.steps.length) * 100) + '%';
    e.hint.classList.add('hidden');
    e.next.style.display = 'inline-block';
    e.choiceRow.style.display = 'none';
    if(e.inputRow) e.inputRow.style.display = 'none';
    e.skip.style.display = step.hideSkip ? 'none' : 'inline-block';

    clearSpotlight();
    if(step.before) step.before();

    var showRing = stepNeedsRing(step);
    var target = applySpotlight(step.spotlight);
    positionBox(target, showRing);

    // Keep tracking the target continuously (not just once), since
    // several steps spotlight things that resize or shift mid-step, a
    // goal-builder box growing as fields fill in, a question box that
    // disappears once a new question is generated, etc. Re-querying the
    // DOM fresh every tick (via liveTarget) instead of reusing a cached
    // element reference means the outline stays accurate to whatever's
    // really on screen right now, and gracefully clears itself if the
    // target vanishes.
    if(repositionHandler){ window.removeEventListener('resize', repositionHandler); window.removeEventListener('scroll', repositionHandler, true); }
    if(repositionTimer){ clearInterval(repositionTimer); repositionTimer = null; }
    repositionHandler = function(){ positionBox(liveTarget(step.spotlight), stepNeedsRing(step)); };
    window.addEventListener('resize', repositionHandler);
    window.addEventListener('scroll', repositionHandler, true);
    if(step.spotlight){
      repositionTimer = setInterval(repositionHandler, 200);
    }

    // advance modes
    if(step.input){
      e.next.onclick = advance;
      e.next.textContent = step.nextLabel || 'Next →';
      if(e.inputRow && e.nameInput){
        e.inputRow.style.display = 'block';
        e.nameInput.value = '';
        e.nameInput.maxLength = NAME_MAX_LEN;
        if(e.nameError){ e.nameError.style.display = 'none'; e.nameError.textContent = ''; }
        e.next.setAttribute('disabled', 'disabled');
        e.next.style.opacity = '0.5';
        var onInput = function(){
          var v = e.nameInput.value.slice(0, NAME_MAX_LEN);
          if(v !== e.nameInput.value) e.nameInput.value = v;
          if(e.nameError){ e.nameError.style.display = 'none'; e.nameError.textContent = ''; }
          var ok = v.trim().length > 0;
          if(ok){ e.next.removeAttribute('disabled'); e.next.style.opacity = '1'; }
          else { e.next.setAttribute('disabled', 'disabled'); e.next.style.opacity = '0.5'; }
        };
        e.nameInput.oninput = onInput;
        var submitting = false;
        var trySubmit = function(){
          if(e.next.hasAttribute('disabled') || submitting) return;
          var name = e.nameInput.value.trim().slice(0, NAME_MAX_LEN);
          submitting = true;
          e.next.setAttribute('disabled', 'disabled');
          e.next.style.opacity = '0.5';
          e.nameInput.classList.add('tut-name-input-checking');
          var prevLabel = e.next.textContent;
          e.next.textContent = 'Checking…';
          claimSpeakerName(name).then(function(result){
            if(result.ok){
              if(step.onSubmit) step.onSubmit(name);
              advance();
              return;
            }
            submitting = false;
            e.nameInput.classList.remove('tut-name-input-checking');
            e.next.textContent = prevLabel;
            e.next.removeAttribute('disabled');
            e.next.style.opacity = '1';
            if(e.nameError){
              e.nameError.textContent = result.message || "That name is already taken. Try a different one.";
              e.nameError.style.display = 'block';
            }
            setTimeout(function(){ e.nameInput.focus(); e.nameInput.select(); }, 30);
          });
        };
        e.nameInput.onkeydown = function(ev){
          if(ev.key === 'Enter' && !e.next.hasAttribute('disabled')) trySubmit();
        };
        setTimeout(function(){ e.nameInput.focus(); }, 50);
        e.next.onclick = trySubmit;
      }
    } else if(step.choice){
      e.next.style.display = 'none';
      e.choiceRow.style.display = 'block';
      e.yes.onclick = function(){ step.choice.yes(); advance(); };
      e.no.onclick = function(){ step.choice.no(); advance(); };
    } else if(step.waitForClick){
      e.next.style.display = 'none';
      e.hint.classList.remove('hidden');
      e.hintText.textContent = step.hintText || 'Go ahead! click it!';
      var handler = function(ev){
        if(ev.target.closest(step.waitForClick)){
          document.removeEventListener('click', handler, true);
          setTimeout(advance, 250);
        }
      };
      document.addEventListener('click', handler, true);
      state.cleanupClick = function(){ document.removeEventListener('click', handler, true); };
    } else if(step.waitForCondition){
      e.next.style.display = 'none';
      e.hint.classList.remove('hidden');
      e.hintText.textContent = step.hintText || 'Waiting for you…';
      var baseHint = step.hintText || 'Waiting for you…';
      var poll = setInterval(function(){
        if(step.waitForCondition()){
          clearInterval(poll);
          setTimeout(advance, 300);
          return;
        }
        if(step.watchError){
          var err = step.watchError();
          e.hintText.textContent = err ? err : baseHint;
        }
      }, 250);
      state.cleanupPoll = function(){ clearInterval(poll); };
    } else {
      e.next.onclick = advance;
      e.next.textContent = step.nextLabel || 'Next →';
      // Plain informational steps still often invite a click on the
      // spotlighted icon/button ("click this any time…"). If the user
      // actually clicks it, treat that as their way of saying "got it"
      // and move on automatically instead of leaving them stuck looking
      // for a Next button, without taking Next away from anyone who'd
      // rather just read and move on themselves.
      if(step.spotlight){
        var autoHandler = function(ev){
          var t = liveTarget(step.spotlight);
          if(t && (t === ev.target || t.contains(ev.target))){
            document.removeEventListener('click', autoHandler, true);
            setTimeout(advance, 250);
          }
        };
        document.addEventListener('click', autoHandler, true);
        state.cleanupClick = function(){ document.removeEventListener('click', autoHandler, true); };
      }
    }
  }

  function advance(){
    if(state.cleanupClick){ state.cleanupClick(); state.cleanupClick = null; }
    if(state.cleanupPoll){ state.cleanupPoll(); state.cleanupPoll = null; }
    if(repositionTimer){ clearInterval(repositionTimer); repositionTimer = null; }
    var step = state.steps[state.idx];
    if(step.after) step.after();
    state.idx++;
    if(state.idx >= state.steps.length){ finish(true); return; }
    render();
  }

  function finish(completed){
    if(state && state.cleanupClick) state.cleanupClick();
    if(state && state.cleanupPoll) state.cleanupPoll();
    if(repositionTimer){ clearInterval(repositionTimer); repositionTimer = null; }
    if(repositionHandler){ window.removeEventListener('resize', repositionHandler); window.removeEventListener('scroll', repositionHandler, true); }
    clearSpotlight();
    var e = el();
    e.dim.classList.remove('tut-visible');
    e.box.classList.remove('tut-visible');
    if(completed) fireConfetti();
    if(state && state.email) localStorage.setItem(doneKeyFor(state.email), '1');
    state = null;
  }

  function skip(){ finish(false); }

  // Small celebratory confetti burst, shown once, only when someone
  // actually finishes every step (not when they skip out early). Plain
  // CSS-animated divs (no canvas/deps) that clean themselves up after
  // the animation ends so nothing lingers in the DOM.
  function fireConfetti(){
    var colors = ['#123a63', '#a3322a', '#2f8f5b', '#c9932f', '#6a4c93', '#1e88a8'];
    var root = document.createElement('div');
    root.className = 'tut-confetti-root';
    var count = 90;
    for(var i=0;i<count;i++){
      var piece = document.createElement('span');
      piece.className = 'tut-confetti-piece';
      var left = Math.random()*100;
      var delay = Math.random()*0.35;
      var duration = 2.2 + Math.random()*1.3;
      var drift = (Math.random()*2-1)*140;
      var rotate = 360 + Math.random()*360;
      var size = 6 + Math.random()*6;
      var color = colors[Math.floor(Math.random()*colors.length)];
      var isRound = Math.random() < 0.35;
      piece.style.left = left + 'vw';
      piece.style.width = size + 'px';
      piece.style.height = (isRound ? size : size*2.4) + 'px';
      piece.style.background = color;
      piece.style.borderRadius = isRound ? '50%' : '2px';
      piece.style.animationDelay = delay + 's';
      piece.style.animationDuration = duration + 's';
      piece.style.setProperty('--tut-confetti-drift', drift + 'px');
      piece.style.setProperty('--tut-confetti-rotate', rotate + 'deg');
      root.appendChild(piece);
    }
    document.body.appendChild(root);
    setTimeout(function(){ if(root.parentNode) root.parentNode.removeChild(root); }, 3900);
  }

  function start(email){
    if(!email) return;
    if(localStorage.getItem(doneKeyFor(email))) return;
    if(state) return; // already running
    state = { steps: buildSteps(), idx: 0, email: email };
    byId('tutSkipBtn').onclick = skip;
    render();
  }

  /* ---------------------------------------------------------------------
     3. THE STEPS
     --------------------------------------------------------------------- */
  function buildSteps(){
    var steps = [];

    steps.push({
      title: 'Welcome to Extemplary! 🎉',
      avatar: '🎙️',
      html: "Your account is all set up! I'm going to walk you through every function of the site: the sidebar, calendar, Ballot History, the recording tools, and how to run a full practice round. It only takes a few minutes, and you can exit out any time with <b>Skip tutorial</b>."
    });

    // ---- Capture the speaker's name -----------------------------------------
    steps.push({
      title: "Official Speaker Name",
      avatar: '🖋️',
      input: true,
      formal: true,
      html: "Before we go any further, let's set this properly. Every ballot you ever submit carries a <b>Speaker</b> field, and this is what fills it in. It's how your feedback, your history, and your judge's comments all refer to you from here on out.<br><br>Take a second and enter the name you actually want to see on your ballots. It needs to be unique, so if someone else already has it, you'll need to pick a different one.",
      onSubmit: function(name){
        // Persist under the per-account key (used for future logins) AND a
        // single global "latest name entered" key. The global key is the
        // real source of truth for what shows on screen right now -- it
        // sidesteps any mismatch between the email this session thinks
        // it's on and whatever app.js re-reads later (case differences,
        // a delayed/duplicate SIGNED_IN re-fire, etc). Whatever the person
        // just typed here always wins.
        try{ localStorage.setItem(nameKeyFor(state && state.email), name); }catch(e){}
        try{ localStorage.setItem('extemplary_speaker_name_latest', name); }catch(e){}
        // Write the DOM directly, right now -- don't only rely on the
        // custom event being caught by a listener that may not exist yet.
        var el2 = byId('speakerName');
        if(el2){
          var clean = (name || '').trim().slice(0, 20).toLowerCase().replace(/\s+/g, '');
          el2.textContent = '@' + (clean || 'you');
        }
        try{
          window.dispatchEvent(new CustomEvent('extemplary:speaker-name-set', { detail: { name: name } }));
        }catch(e){}
      }
    });

    // ---- Sidebar orientation -------------------------------------------------
    steps.push({
      title: 'Your navigation sidebar',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navMenuPanel',
      html: "This sidebar is home base. Every page in ExtemplaryDar is accessable from here. We'll use it to get around for the rest of this tutorial."
    });

    steps.push({
      title: 'Head to your Calendar',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="streakToggle"]',
      waitForClick: '.nav-menu-item[data-target="streakToggle"]',
      hintText: 'Click "Calendar" in the sidebar.',
      html: "First stop: your Calendar. Click the highlighted <b>Calendar</b> item in the sidebar to open it."
    });

    // ---- Calendar / streak tab ------------------------------------------------
    steps.push({
      title: 'Your Streak Calendar',
      avatar: '🔥',
      spotlight: '#streakSummary',
      html: "Any day you record a ballot, set a goal, or complete a round keeps your streak alive or starts a new one. It is tracked here and flame counter at the top left. This calendar also lays out milestone markers at 3, 7, 14, 30, and 365 days."
    });

    steps.push({
      title: 'Tournaments & events',
      avatar: '🗓️',
      spotlight: '#streakEventsWrap',
      html: "The same calendar doubles as tournament tracker. Add an upcoming competition's date and name here, and it'll show up in a sorted list of what's next."
    });

    steps.push({
      title: "Let's set your first goal",
      avatar: '🎯',
      spotlight: '#streakAddGoalBtn',
      waitForClick: '#streakAddGoalBtn',
      hintText: 'Click "+ New Goal".',
      html: "Goals are explicit milestones you can use to progress through your Extemp journey! Goals can be anything from a streak length, an overall score, a category score, or a number of rounds this month. Let's create your first one."
    });

    steps.push({
      title: 'Build your goal',
      avatar: '🎯',
      spotlight: '#goalModalBody',
      waitForCondition: function(){ var m = byId('goalModal'); return m && m.classList.contains('hidden'); },
      hintText: 'Pick any goal type you like, then click "Save Goal".',
      html: "Pick a goal type from the dropdown, fill in the target, and hit <b>Save Goal</b>."
    });

    steps.push({
      title: 'Nice! goal set! ✅',
      avatar: '🎯',
      spotlight: '#streakGoalsWrap',
      html: "Your goal now tracks a live progress bar computed straight from your ballot history. My History also surfaces auto-suggested goals based on your own weakest categories."
    });

    // ---- History ----------------------------------------------------------
    steps.push({
      title: 'Now, My Ballot History',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="historyToggle"]',
      waitForClick: '.nav-menu-item[data-target="historyToggle"]',
      hintText: 'Click "My Ballot History" in the sidebar.',
      html: "This is the Ballot History. Click the highlighted <b>My Ballot History</b> item in the sidebar."
    });

    steps.push({
      title: "Coach's Overall Notes",
      avatar: '📜',
      before: function(){ paintHistorySkeleton(); },
      spotlight: '#historyOverallFeedback',
      html: "Once you've recorded a few rounds (around 7 speeches in), this area fills in with comprehensive feedback that finds patterns across your entire practice history, including your biggest recurring strength, your biggest recurring weakness, and one concrete next step. It refreshes automatically at milestone round counts. Here's a preview of the layout you'll see once there's real data (the actual page is empty right now since you haven't recorded anything yet)."
    });

    steps.push({
      title: 'Trends across your ballots',
      avatar: '📈',
      before: function(){ paintHistorySkeleton(); },
      spotlight: '#historyTrends',
      html: "This section aggregates your average score in every rubric category, plus sparkline trend graphs for your overall score and each category so you can see exactly where you're improving (or regressing) round by round. Again, this is just a placeholder preview of the layout. It'll fill in with your real numbers after a few recorded rounds."
    });

    steps.push({
      title: 'Filter by practice type',
      avatar: '\uD83D\uDD0D',
      before: function(){ paintHistorySkeleton(); },
      spotlight: '#historyModeFilter',
      html: "Every one of your rounds is tagged by the practice mode you recorded it in. Use this <b>Practice type</b> dropdown to see trends for just <b>Regular Practice</b>, just <b>Rapid Drill: Introduction</b>, or just <b>Rapid Drill: Body</b>. Handy once you've been mixing drill types and want to see how each one's coming along on its own."
    });

    steps.push({
      title: 'Your goals & full round list',
      avatar: '📋',
      before: function(){ paintHistorySkeleton(); },
      spotlight: '#historyListWrap',
      html: "Below that: your active goals (with Suggested Goals generated from your own weak spots), then every completed round. Expand any round to rewatch the video, re-read the transcript, or reread the full judge's feedback. What you're seeing now is a placeholder preview. This will be filled in with your actual goals and rounds."
    });

    steps.push({
      title: 'Back to Home',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navHomeBtn',
      waitForClick: '#navHomeBtn',
      hintText: 'Click "Home" in the sidebar.',
      html: "Let's head back to the main recording page. Open the sidebar and click <b>Home</b>."
    });

    // ---- Quick cutscenes: timer / theme / shortcuts -----------------------
    steps.push({
      title: 'The 30-minute prep timer',
      avatar: '⏱️',
      spotlight: '#timerToggle',
      after: function(){ var p = byId('timerPanel'); if(p) p.classList.add('hidden'); },
      html: "Extemp gives you 30 minutes to prep a speech. Click this clock icon any time to open a real countdown timer. You can start, pause, resume, or reset right from the header or the sidebar."
    });

    steps.push({
      title: 'Light / Dark mode',
      avatar: '🌗',
      spotlight: '#themeToggle',
      html: "Prefer a lighter screen? Click this toggle any time to flip between light and dark mode. This will be automatically saved."
    });

    steps.push({
      title: 'Keyboard shortcuts',
      avatar: '⌨️',
      spotlight: '#shortcutsToggle',
      after: function(){ var p = byId('shortcutsPanel'); if(p) p.classList.add('hidden'); },
      html: "There's a full set of keyboard shortcuts for convenience sakes. Click here any time to see the full list."
    });

    // ---- Time signal settings ------------------------------------------------
    steps.push({
      title: 'Time Signal settings',
      avatar: '🔔',
      spotlight: '#settingsToggle',
      after: function(){ var p = byId('settingsPanel'); var t = byId('settingsToggle'); if(p) p.classList.add('hidden'); if(t) t.classList.remove('active'); },
      html: "This is where you customize <b>time signals</b>, little on-screen alerts that pop up at specific points while you're recording (e.g. \"1 minute left\"). Add, relabel, recolor, or remove signals here, or reset to the defaults. This is also where you can paste your own Groq/Gemini API keys if you ever hit rate limits.<br><br>Your signals fire for real while you're actually recording: the on-screen clock turns amber at 6:00 and red with a hard stop warning at 7:00, so you always know exactly how much time is left, even without opening this panel."
    });

    // ---- AI Token Usage widget ------------------------------------------------
    steps.push({
      title: 'Keeping an eye on AI usage',
      avatar: '🤖',
      spotlight: '.ai-usage-btn',
      html: "Every AI feature on Extemplary — ballot feedback, the citation checker, the practice question generator, and current-events summaries — shares a fair daily usage budget per account. Click this robot icon any time to see exactly how much of each you've used today, as a set of progress bars. It resets every day at midnight UTC, and if you ever run up against a limit, this is the first place to check."
    });

    // ---- Tournament Briefing (forced use) ---------------------------------
    steps.push({
      title: 'Tournament Briefing',
      avatar: '🗞️',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="briefingToggle"]',
      waitForClick: '.nav-menu-item[data-target="briefingToggle"]',
      hintText: 'Click "Current Events Summary" in the sidebar.',
      html: "Let's generate a briefing, current-events overview covering domestic, international, and economic news, plus the kinds of questions likely to come up."
    });

    steps.push({
      title: 'Pick your timing',
      avatar: '🗞️',
      spotlight: '#bfTimingRow .bf-timing-btn[data-timing="today"]',
      waitForClick: '#bfTimingRow .bf-timing-btn[data-timing="today"]',
      hintText: 'Click "In a few hours".',
      html: 'Click <b>"In a few hours"</b>. This tells the AI your tournament is coming up soon so it can focus on the most relevant recent news.'
    });

    steps.push({
      title: 'Generate your briefing',
      avatar: '🗞️',
      spotlight: '#bfGenerateBtn',
      waitForCondition: function(){ var r = byId('bfResultStep'); return r && !r.classList.contains('hidden'); },
      hintText: 'Click "Generate Briefing".',
      html: 'Now click <b>Generate Briefing</b>. This calls a real AI model, so it may take a few seconds.'
    });

    steps.push({
      title: 'Your briefing is ready',
      avatar: '🗞️',
      spotlight: '#bfResultContent',
      html: "That's a real, updated briefing. You can regenerate it, copy the transcript, or download it as a PDF. Use this the morning of a tournament to walk in already caught up on the news."
    });

    // ---- Example ballot -----------------------------------------------------
    steps.push({
      title: 'The Example Ballot',
      avatar: '📄',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="helpToggle"]',
      waitForClick: '.nav-menu-item[data-target="helpToggle"]',
      hintText: 'Click "Example Ballot" in the sidebar.',
      html: "Click the highlighted <b>Example Ballot</b> item in the sidebar."
    });

    steps.push({
      title: 'Here\'s what an example ballot feedback looks like!',
      avatar: '📄',
      spotlight: '#exampleResultsContent',
      html: "This is a full sample round with speech, video, annotated transcript, and judge's feedback so you know exactly what a finished round looks like before you ever record your own. Click any word in the transcript (or any judge's note) and the video jumps right to that moment."
    });

    steps.push({
      title: 'Back to Home',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navHomeBtn',
      waitForClick: '#navHomeBtn',
      hintText: 'Click "Home" in the sidebar.',
      html: "Open the sidebar and click <b>Home</b> to head back to the main recording page."
    });

    // ---- Grading rubric icon on the paper -----------------------------------
    steps.push({
      title: 'The Grading Rubric',
      avatar: '📐',
      spotlight: '#rubricToggle',
      waitForClick: '#rubricToggle',
      hintText: 'Click the highlighted rubric icon on the paper.',
      html: "See that small icon in the top-right corner of the ballot paper? That opens the full <b>Grading Rubric</b>, the one every speech gets judged against. Click it now."
    });

    steps.push({
      title: 'Every category, every point',
      avatar: '📐',
      spotlight: '#rubricPanel',
      html: "This is the full rubric: Creative Hook &amp; Intro, Structure, Strength of Argument &amp; Analysis, Flaws in Reasoning, Strength of Evidence, and more. Each category has its own point value and the exact criteria the AI judge checks for. It's the same rubric used to score every round you record, so it's worth a skim before your first one. You can reopen this any time from the same icon on the paper."
    });

    // ---- LLM Model Rankings icon on the paper -------------------------------
    steps.push({
      title: 'The LLM Model Rankings',
      avatar: '📊',
      spotlight: '#aiCompareToggle',
      waitForClick: '#aiCompareToggle',
      hintText: 'Click the highlighted chip icon on the paper.',
      html: "Right next to the rubric icon is another one, click it now and it opens the <b>LLM Model Rankings</b>. This ranks every AI model available as a judge by quality and cost, so you can see how they stack up against each other before picking one."
    });

    steps.push({
      title: 'Comparing the judges',
      avatar: '📊',
      spotlight: '#view-aiCompare',
      html: "Each row is a model you could pick as your judge, with its quality and cost scores side by side. The ones marked \"Available Here\" are the ones you can actually select in the model picker. You can reopen this page any time from the same icon on the paper."
    });


    steps.push({
      title: 'The Citation Checker',
      avatar: '🔎',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="citationToggle"]',
      waitForClick: '.nav-menu-item[data-target="citationToggle"]',
      hintText: 'Click "Citation Checker" in the sidebar.',
      html: "You can verify the legitimacy of any evidence mentioned in a speech here. It searches the web live and marks it TRUE, FALSE, or UNVERIFIED."
    });

    steps.push({
      title: 'Try it! Type this exact example',
      avatar: '🔎',
      spotlight: '#ccSetupStep',
      waitForCondition: function(){ var r = byId('ccResultStep'); return r && !r.classList.contains('hidden'); },
      watchError: function(){
        var dErr = byId('ccDateError'), cErr = byId('ccClaimError'), sErr = byId('ccSourceError');
        if(dErr && dErr.style.display === 'block') return 'That date needs the mm/dd/yyyy format exactly. Try 07/25/2026.';
        if(cErr && cErr.style.display === 'block') return "Don't forget to fill in the Claim field.";
        if(sErr && sErr.style.display === 'block') return "Don't forget to fill in the Source field.";
        return null;
      },
      hintText: 'Fill in all three fields, then click "Check Citation".',
      html: 'Type each of these into its matching field, then click <b>Check Citation</b>. Note the date field requires the mm/dd/yyyy format shown below:' +
        '<span class="tut-type-example">Claim:\n500 freshman at Howard University have been unenrolled from the prestigious, historically Black Washington, D.C., university for the 2026-27 school year due to tuition issues.\n\nDate (mm/dd/yyyy):\n07/25/2026\n\nSource:\nCNN</span>' +
        "Tip: if you're ever unsure of an exact date, swap any unknown digit for <code>?</code> (e.g. 06/??/2026) to check an approximate range instead."
    });

    steps.push({
      title: 'Verdict!',
      avatar: '🔎',
      spotlight: '#ccResultStep',
      html: "That's a real verdict (TRUE) with a short explanation and a link to the actual source Extemplary found. Use this on any claim before it goes in a speech, or to check a citation from someone else's."
    });

    steps.push({
      title: 'Back to Home',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navHomeBtn',
      waitForClick: '#navHomeBtn',
      hintText: 'Click "Home" in the sidebar.',
      html: "Open the sidebar and click <b>Home</b>."
    });

    // ---- Recording a round --------------------------------------------------
    steps.push({
      title: 'Recording a practice round',
      avatar: '🎬',
      spotlight: '#view-record',
      html: "Here's the brief overcourse of what an Extemp round looks like. You receive a question (custom, or drawn for you), you have 30 minutes to prepare, then record yourself on camera. When you submit, Extemplary transcribes your speech and scores you against an 8-category NSDA extemp rubric, which you can view by clicking the paper icon on the top right."
    });

    steps.push({
      title: 'Three practice modes',
      avatar: '\u26A1',
      spotlight: '#modeSwitch',
      html: "Before you record, pick a mode here. <b>Regular Practice</b> is a full 7-minute round graded on all 8 rubric categories, the standard tournament format. <b>Rapid Drill: Introduction</b> is a short-form drill focused only on your opening (hook, link, thesis) so you can rep intros fast without recording a whole speech. <b>Rapid Drill: Body</b> does the same for your body paragraphs: structure, argument strength, evidence, and reasoning, without needing a full intro or conclusion. Each drill grades against its own separate, focused rubric, different from Regular Practice's full 8-category rubric, and shows up tagged in your Ballot History, so you can track all three separately."
    });

    // ---- AI judge model picker dropdown, sits right next to the mode switch -
    steps.push({
      title: 'Choose your AI judge',
      avatar: '🤖',
      spotlight: '#modelPicker',
      html: "This dropdown picks which AI model grades your speech. It's set to <b>Llama 3.3 70B</b> by default, and that's a good place to start. You can compare all the available models on the <b>LLM Model Rankings</b> page we just looked at, then come back here and switch any time."
    });

    steps.push({
      title: "Let's stick with Regular Practice",
      avatar: '\u26A1',
      spotlight: '#modeRegularBtn',
      waitForClick: '#modeRegularBtn',
      hintText: 'Click "Regular Practice".',
      html: "For the rest of this tour, click <b>Regular Practice</b> so we're working with the standard full-round format."
    });

    steps.push({
      title: 'Receive a question',
      avatar: '❓',
      spotlight: '#qModeReceiveBtn',
      waitForClick: '#qModeReceiveBtn',
      hintText: 'Click "Receive a question".',
      html: "Instead of typing your own question, let's have Extemplary draw one for you just like a tournament draw."
    });

    steps.push({
      title: 'Pick a category',
      avatar: '❓',
      spotlight: '#qCategoryStep',
      waitForCondition: function(){ var d = byId('qDifficultyStep'); return d && !d.classList.contains('hidden'); },
      hintText: 'Click Domestic, International, or Economic.',
      html: "Pick any category: <b>International</b>, <b>Domestic</b>, or <b>Economic</b>, and Extemplary will draft three real current-events questions for you."
    });

    steps.push({
      title: 'Choose a difficulty',
      avatar: '🎚️',
      spotlight: '#qDifficultyStep',
      before: function(){
        var s = byId('qDifficultySlider');
        if(s && s.value !== '15'){
          s.value = '15';
          s.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      waitForClick: '#qDifficultyContinueBtn',
      hintText: 'Leave it on "Medium" and click "Draft 3 Questions".',
      html: "This slider controls how easy or obscure your question will be, all the way from <b>Extremely Easy</b> to <b>Extremely Hard</b>. For this tour, let's stick with <b>Medium</b> — leave the slider where it is and click <b>Draft 3 Questions</b>. On your own rounds, feel free to drag it to whatever difficulty you want to practice at."
    });

    steps.push({
      title: 'Pick your question',
      avatar: '❓',
      spotlight: '#qPickStep',
      waitForCondition: function(){ var c = byId('qConfirmedStep'); return c && !c.classList.contains('hidden'); },
      hintText: 'Click one of the 3 questions to draw it.',
      html: "Just like a tournament draw, pick one of the three questions to be the one you'll speak about."
    });

    steps.push({
      title: 'Ready to record?',
      avatar: '🎬',
      spotlight: '#recBtn',
      html: "Your question is locked in. This red button starts your camera recording whenever you're ready to deliver your speech. Want to start recording now?",
      choice: {
        yes: function(){ var b = byId('recBtn'); if(b) b.click(); },
        no: function(){}
      }
    });

    steps.push({
      title: "You're all set! 🎓",
      avatar: '🎉',
      html: "That's every major feature of Extemplary. Good luck on your Extemp journey!",
      hideSkip: true
    });

    return steps;
  }

})();