/* ==========================================================================
   Extemplary — first-run onboarding tutorial ("cutscene" walkthrough)

   Runs ONLY the first time a brand-new account is created. Never runs for
   people logging in to an existing account, and never runs again once
   finished or skipped (tracked per-account in localStorage).

   Design: this file does NOT reach into the main app's closures (the whole
   app lives inside one big IIFE). Instead it drives the real UI the same
   way a person would — highlighting real buttons, requiring real clicks on
   them, and watching the app's own hidden/shown classes to know when a
   real action (a goal was saved, a briefing came back, a question was
   picked, etc.) actually happened.
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
    // handler runs — if it succeeds, we'll know to launch the tutorial the
    // moment authGate disappears.
    authForm.addEventListener('submit', function(){
      if(authTabSignup.classList.contains('active')){
        var email = (byId('authEmail') && byId('authEmail').value || '').trim();
        if(email) localStorage.setItem(PENDING_KEY, email);
      }
    }, true);
  }

  function maybeLaunchAfterSignIn(){
    if(!authGate || !authGate.classList.contains('hidden')) return;
    var pendingEmail = localStorage.getItem(PENDING_KEY);
    if(!pendingEmail) return;
    var liveEmail = (accountEmail && accountEmail.textContent || '').trim();
    if(!liveEmail || liveEmail.toLowerCase() !== pendingEmail.toLowerCase()) return;
    if(localStorage.getItem(doneKeyFor(liveEmail))) { localStorage.removeItem(PENDING_KEY); return; }
    localStorage.removeItem(PENDING_KEY);
    setTimeout(function(){ Tutorial.start(liveEmail); }, 700);
  }

  if(authGate){
    new MutationObserver(maybeLaunchAfterSignIn)
      .observe(authGate, { attributes:true, attributeFilter:['class'] });
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

  function el(){ // dom refs, grabbed lazily since app builds some content late
    return {
      dim: byId('tutDim'), box: byId('tutBox'), ring: byId('tutRing'), hlbox: byId('tutHighlightBox'),
      title: byId('tutTitle'), text: byId('tutText'), avatar: byId('tutAvatar'),
      count: byId('tutStepCount'), hint: byId('tutHint'), hintText: byId('tutHintText'),
      next: byId('tutNextBtn'), skip: byId('tutSkipBtn'), choiceRow: byId('tutChoiceRow'),
      yes: byId('tutYesBtn'), no: byId('tutNoBtn')
    };
  }

  function clearSpotlight(){
    var e = el();
    e.ring.style.display = 'none';
    e.hlbox.style.display = 'none';
  }

  // Draws the highlight ring + glow box around a target purely as
  // separate, always-on-top overlay elements — the target itself is
  // never given a new position/z-index/class, so it's never at risk of
  // being covered by (or blocking clicks through) anything else, and it
  // stays 100% clickable exactly where the app already put it.
  function paintHighlight(target){
    var e = el();
    if(!target){ e.ring.style.display = 'none'; e.hlbox.style.display = 'none'; return; }
    var r = target.getBoundingClientRect();
    e.hlbox.style.display = 'block';
    e.hlbox.style.top = (r.top - 4) + 'px';
    e.hlbox.style.left = (r.left - 4) + 'px';
    e.hlbox.style.width = (r.width + 8) + 'px';
    e.hlbox.style.height = (r.height + 8) + 'px';
    e.ring.style.display = 'block';
    e.ring.style.top = (r.top + r.height/2) + 'px';
    e.ring.style.left = (r.left + r.width/2) + 'px';
  }

  function positionBox(target){
    var e = el();
    e.box.classList.remove('tut-center');
    e.box.querySelectorAll('.tut-arrow').forEach(function(a){ a.remove(); });
    paintHighlight(target);
    if(!target){
      e.box.classList.add('tut-center');
      e.box.style.top = ''; e.box.style.left = ''; e.box.style.right = '';
      return;
    }
    var r = target.getBoundingClientRect();
    var boxRect = e.box.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var spaceBelow = vh - r.bottom, spaceAbove = r.top;
    var top, left, arrowClass;
    var boxH = boxRect.height || 190, boxW = boxRect.width || 320;
    if(spaceBelow > boxH + 24 || spaceBelow > spaceAbove){
      top = Math.min(r.bottom + 18, vh - boxH - 10);
      arrowClass = 'tut-arrow-top';
    } else {
      top = Math.max(10, r.top - boxH - 18);
      arrowClass = 'tut-arrow-bottom';
    }
    left = Math.min(Math.max(10, r.left), vw - boxW - 10);
    e.box.style.top = top + 'px';
    e.box.style.left = left + 'px';
    e.box.style.right = 'auto';
    var arrow = document.createElement('div');
    arrow.className = 'tut-arrow ' + arrowClass;
    arrow.style.left = Math.min(Math.max(16, r.left - left + r.width/2 - 9), boxW - 30) + 'px';
    e.box.appendChild(arrow);
  }

  function applySpotlight(sel){
    var t = sel ? q(sel) : null;
    if(t) t.scrollIntoView({ block:'center', behavior:'smooth' });
    return t;
  }

  var repositionHandler = null;

  function render(){
    var step = state.steps[state.idx];
    var e = el();
    e.dim.classList.add('tut-visible');
    e.box.classList.add('tut-visible');
    e.avatar.textContent = step.avatar || '🎙️';
    e.title.textContent = step.title;
    e.text.innerHTML = step.html || '';
    e.count.textContent = 'Step ' + (state.idx+1) + ' of ' + state.steps.length;
    e.hint.classList.add('hidden');
    e.next.style.display = 'inline-block';
    e.choiceRow.style.display = 'none';
    e.skip.style.display = step.hideSkip ? 'none' : 'inline-block';

    clearSpotlight();
    if(step.before) step.before();

    var target = applySpotlight(step.spotlight);
    positionBox(target);
    setTimeout(function(){ positionBox(step.spotlight ? q(step.spotlight) : null); }, 320);

    if(repositionHandler){ window.removeEventListener('resize', repositionHandler); window.removeEventListener('scroll', repositionHandler, true); }
    repositionHandler = function(){ var t = step.spotlight ? q(step.spotlight) : null; positionBox(t); };
    window.addEventListener('resize', repositionHandler);
    window.addEventListener('scroll', repositionHandler, true);

    // advance modes
    if(step.choice){
      e.next.style.display = 'none';
      e.choiceRow.style.display = 'block';
      e.yes.onclick = function(){ step.choice.yes(); advance(); };
      e.no.onclick = function(){ step.choice.no(); advance(); };
    } else if(step.waitForClick){
      e.next.style.display = 'none';
      e.hint.classList.remove('hidden');
      e.hintText.textContent = step.hintText || 'Go ahead — click it!';
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
      var poll = setInterval(function(){
        if(step.waitForCondition()){
          clearInterval(poll);
          setTimeout(advance, 300);
        }
      }, 250);
      state.cleanupPoll = function(){ clearInterval(poll); };
    } else {
      e.next.onclick = advance;
      e.next.textContent = step.nextLabel || 'Next →';
    }
  }

  function advance(){
    if(state.cleanupClick){ state.cleanupClick(); state.cleanupClick = null; }
    if(state.cleanupPoll){ state.cleanupPoll(); state.cleanupPoll = null; }
    var step = state.steps[state.idx];
    if(step.after) step.after();
    state.idx++;
    if(state.idx >= state.steps.length){ finish(); return; }
    render();
  }

  function finish(){
    if(state && state.cleanupClick) state.cleanupClick();
    if(state && state.cleanupPoll) state.cleanupPoll();
    if(repositionHandler){ window.removeEventListener('resize', repositionHandler); window.removeEventListener('scroll', repositionHandler, true); }
    clearSpotlight();
    var e = el();
    e.dim.classList.remove('tut-visible');
    e.box.classList.remove('tut-visible');
    if(state && state.email) localStorage.setItem(doneKeyFor(state.email), '1');
    state = null;
  }

  function skip(){ finish(); }

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
      html: "Your account is all set up. I'm going to walk you through every part of the site — the sidebar, your Calendar, Ballot History, the recording tools, and how to run a full practice round. It only takes a few minutes, and you can bail out any time with <b>Skip tutorial</b>."
    });

    // ---- Sidebar orientation -------------------------------------------------
    steps.push({
      title: 'Your navigation sidebar',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navMenuPanel',
      html: "This sidebar is home base. Every page in Extemplary — Home, Calendar, My Ballot History, Timer, Time Signals, Light/Dark Mode, Shortcuts, Current Events, and the Citation Checker — is reachable from here. We'll use it to get around for the rest of this tutorial."
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
      html: "Any day you record a ballot, set a goal, or complete a round keeps your streak alive — it's tracked here and in the flame counter in the header. This calendar also lays out milestone markers at 3, 7, 14, 30, and 365 days."
    });

    steps.push({
      title: 'Tournaments & events',
      avatar: '🗓️',
      spotlight: '#streakEventsWrap',
      html: "The same calendar doubles as a lightweight tournament tracker. Add an upcoming competition's date and name here, and it'll show up in a running, sorted list of what's next — with past events tucked behind a toggle."
    });

    steps.push({
      title: "Let's set your first goal",
      avatar: '🎯',
      spotlight: '#streakAddGoalBtn',
      waitForClick: '#streakAddGoalBtn',
      hintText: 'Click "+ New Goal".',
      html: "Goals are concrete targets you track from your own ballot history — a streak length, an overall score, a category score, or a number of rounds this month. Let's create your first one."
    });

    steps.push({
      title: 'Build your goal',
      avatar: '🎯',
      spotlight: '#goalModalBody',
      waitForCondition: function(){ var m = byId('goalModal'); return m && m.classList.contains('hidden'); },
      hintText: 'Pick any goal type you like, then click "Save Goal".',
      html: "Pick a goal type from the dropdown — it doesn't matter which one for now — fill in the target, and hit <b>Save Goal</b>."
    });

    steps.push({
      title: 'Nice — goal set! ✅',
      avatar: '🎯',
      spotlight: '#streakGoalsWrap',
      html: "Your goal now tracks a live progress bar computed straight from your ballot history. My History also surfaces auto-suggested goals based on your own weakest categories — you'll see those in a minute."
    });

    // ---- History ----------------------------------------------------------
    steps.push({
      title: 'Now, My Ballot History',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="historyToggle"]',
      waitForClick: '.nav-menu-item[data-target="historyToggle"]',
      hintText: 'Click "My Ballot History" in the sidebar.',
      html: "Next: your Ballot History. Click the highlighted <b>My Ballot History</b> item in the sidebar."
    });

    steps.push({
      title: "Coach's Overall Notes",
      avatar: '📜',
      spotlight: '#historyOverallFeedback',
      html: "Once you've recorded a few rounds, this area fills in with comprehensive feedback that finds patterns across your entire practice history — your biggest recurring strength, your biggest recurring weakness, and one concrete next step. It refreshes automatically at milestone round counts."
    });

    steps.push({
      title: 'Trends across your ballots',
      avatar: '📈',
      spotlight: '#historyTrends',
      html: "This section aggregates your average score in every rubric category, plus sparkline trend graphs for your overall score and each category — so you can see exactly where you're improving (or backsliding) round by round."
    });

    steps.push({
      title: 'Your goals & full round list',
      avatar: '📋',
      spotlight: '#historyListWrap',
      html: "Below that: your active goals (with Suggested Goals generated from your own weak spots), then every completed round. Expand any round to rewatch the video, re-read the transcript, or reread the full judge's feedback."
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
      html: "Extemp gives you 30 minutes to prep a speech. Click this clock icon any time to open a real countdown timer — start, pause, resume, or reset it, right from the header or the sidebar."
    });

    steps.push({
      title: 'Light / Dark mode',
      avatar: '🌗',
      spotlight: '#themeToggle',
      html: "Prefer a darker screen for late-night prep? Click this toggle any time to flip between light and dark mode — your preference is remembered."
    });

    steps.push({
      title: 'Keyboard shortcuts',
      avatar: '⌨️',
      spotlight: '#shortcutsToggle',
      html: "There's a full set of keyboard shortcuts for power users — starting/stopping the timer, recording, and navigating the ballot without touching your mouse. Click here any time to see the full list."
    });

    // ---- Time signal settings ------------------------------------------------
    steps.push({
      title: 'Time Signal settings',
      avatar: '🔔',
      spotlight: '#settingsToggle',
      html: "This is where you customize <b>time signals</b> — little on-screen alerts that pop up at specific points while you're recording (e.g. \"1 minute left\"). Add, relabel, recolor, or remove signals here, or reset to the defaults. This is also where you can paste your own Groq/Gemini API keys if you ever hit rate limits.<br><br>Your signals fire for real while you're actually recording: the on-screen clock turns amber at 6:00 and red with a hard-stop warning at 7:00, so you always know exactly how much time is left, even without opening this panel."
    });

    // ---- Tournament Briefing (forced use) ---------------------------------
    steps.push({
      title: 'Tournament Briefing',
      avatar: '🗞️',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="briefingToggle"]',
      waitForClick: '.nav-menu-item[data-target="briefingToggle"]',
      hintText: 'Click "Current Events Summary" in the sidebar.',
      html: "Let's generate a real briefing — a current-events overview covering domestic, international, and economic news, plus the kinds of questions likely to come up."
    });

    steps.push({
      title: 'Generate your briefing',
      avatar: '🗞️',
      spotlight: '#bfSetupStep',
      waitForCondition: function(){ var r = byId('bfResultStep'); return r && !r.classList.contains('hidden'); },
      hintText: 'Click "In a few hours", then click "Generate Briefing".',
      html: 'Click the <b>"In a few hours"</b> timing option, then click <b>Generate Briefing</b>. This calls a real AI model, so it may take a few seconds.'
    });

    steps.push({
      title: 'Your briefing is ready',
      avatar: '🗞️',
      spotlight: '#bfResultContent',
      html: "That's a real, current briefing — you can regenerate it, copy the transcript, or download it as a PDF. Use this the morning of a tournament to walk in already caught up on the news."
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
      html: "This is a full sample round — speech, video, annotated transcript, and judge's feedback — so you know exactly what a finished round looks like before you ever record your own. Click any word in the transcript (or any judge's note) and the video jumps right to that moment."
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

    // ---- Citation checker (forced use, exact example text) -----------------
    steps.push({
      title: 'The Citation Checker',
      avatar: '🔎',
      before: function(){ openSidebar(); },
      spotlight: '.nav-menu-item[data-target="citationToggle"]',
      waitForClick: '.nav-menu-item[data-target="citationToggle"]',
      hintText: 'Click "Citation Checker" in the sidebar.',
      html: "Before you use a stat or quote in-round, you can verify it here — Extemplary searches the web live and marks it TRUE, FALSE, or UNVERIFIED."
    });

    steps.push({
      title: 'Try it — type this exact example',
      avatar: '🔎',
      spotlight: '#ccSetupStep',
      waitForCondition: function(){ var r = byId('ccResultStep'); return r && !r.classList.contains('hidden'); },
      hintText: 'Fill in all three fields, then click "Check Citation".',
      html: 'Copy these into the three fields, then click <b>Check Citation</b>:' +
        '<span class="tut-type-example">Claim: 500 freshman at Howard University have been unenrolled from the prestigious, historically Black Washington, D.C., university for the 2026-27 school year due to tuition issues.\nDate: 7/25/26\nSource: CNN</span>' +
        "Tip: if you're ever unsure of an exact date, swap any unknown digit for <code>?</code> (e.g. 06/??/2025) to check an approximate range instead."
    });

    steps.push({
      title: 'Verdict!',
      avatar: '🔎',
      spotlight: '#ccResultStep',
      html: "That's a real verdict — TRUE, FALSE, or UNVERIFIED — with a short explanation and a link to the actual source Extemplary found. Use this on any claim before it goes in a speech, or to check a citation from someone else's."
    });

    steps.push({
      title: 'Back to Home',
      avatar: '🧭',
      before: function(){ openSidebar(); },
      spotlight: '#navHomeBtn',
      waitForClick: '#navHomeBtn',
      hintText: 'Click "Home" in the sidebar.',
      html: "Last stop before recording — open the sidebar and click <b>Home</b>."
    });

    // ---- Recording a round --------------------------------------------------
    steps.push({
      title: 'Recording a practice round',
      avatar: '🎬',
      spotlight: '#view-record',
      html: "Here's the full flow: get a question (custom, or drawn for you), a 30-minute prep timer, then record yourself on camera. When you submit, Extemplary transcribes your speech, analyzes your vocal delivery, and scores you against an 8-category NSDA extemp rubric — with an annotated, color-coded transcript and a synced video player."
    });

    steps.push({
      title: 'Receive a question',
      avatar: '❓',
      spotlight: '#qModeReceiveBtn',
      waitForClick: '#qModeReceiveBtn',
      hintText: 'Click "Receive a question".',
      html: "Instead of typing your own question, let's have Extemplary draw one for you — exactly like a real tournament draw."
    });

    steps.push({
      title: 'Pick a category',
      avatar: '❓',
      spotlight: '#qCategoryStep',
      waitForCondition: function(){ var p = byId('qPickStep'); return p && !p.classList.contains('hidden'); },
      hintText: 'Click Domestic, International, or Economic.',
      html: "Pick any category — <b>International</b>, <b>Domestic</b>, or <b>Economic</b> — and the AI will draft three real current-events questions for you."
    });

    steps.push({
      title: 'Pick your question',
      avatar: '❓',
      spotlight: '#qPickStep',
      waitForCondition: function(){ var c = byId('qConfirmedStep'); return c && !c.classList.contains('hidden'); },
      hintText: 'Click one of the 3 questions to draw it.',
      html: "Just like a tournament draw, pick one of the three questions — that's the one you'll speak on."
    });

    steps.push({
      title: 'Ready to record?',
      avatar: '🎬',
      spotlight: '#recBtn',
      html: "That's your question locked in. This red button starts your camera recording whenever you're ready to deliver your speech. Want to start recording now?",
      choice: {
        yes: function(){ var b = byId('recBtn'); if(b) b.click(); },
        no: function(){}
      }
    });

    steps.push({
      title: "You're all set! 🎓",
      avatar: '🎉',
      html: "That's every major feature of Extemplary — the sidebar, Calendar & Goals, Ballot History, the Timer, Light/Dark Mode, Shortcuts, Time Signals, Tournament Briefing, the Example Ballot, the Citation Checker, and recording a round with a drawn question. Good luck out there!",
      hideSkip: true
    });

    return steps;
  }

})();