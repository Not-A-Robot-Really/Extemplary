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
  // separate, always-on-top overlay elements — the target itself is
  // never given a new position/z-index/class, so it's never at risk of
  // being covered by (or blocking clicks through) anything else, and it
  // stays 100% clickable exactly where the app already put it.
  //
  // The highlight box itself does the dimming: a huge, rounded-corner
  // box-shadow spread (see .tut-highlight-box in style.css) darkens the
  // whole viewport EXCEPT the rectangle it's drawn around, so whatever is
  // inside the outline reads at full brightness and everything else stays
  // dim, instead of the old flat overlay dimming the target too. The
  // pulsing ring is only drawn when the current step actually needs a
  // real click on the target — for pure "look at this" steps it's just
  // visual clutter that can block the very thing being shown off, so it's
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
  // top of the very thing the step is highlighting — the two things it
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
  // as a "click here" cue — for plain look-at-this steps it just sits on
  // top of the very thing being shown off, so we leave it off.
  function stepNeedsRing(step){
    return !!step.waitForClick;
  }

  function render(){
    var step = state.steps[state.idx];
    var e = el();
    e.dim.classList.add('tut-visible');
    e.box.classList.add('tut-visible');
    e.avatar.textContent = step.avatar || '🎙️';
    e.title.textContent = step.title;
    e.text.innerHTML = step.html || '';
    e.count.textContent = 'Step ' + (state.idx+1) + ' of ' + state.steps.length;
    var progressFill = byId('tutProgressFill');
    if(progressFill) progressFill.style.width = Math.round(((state.idx+1) / state.steps.length) * 100) + '%';
    e.hint.classList.add('hidden');
    e.next.style.display = 'inline-block';
    e.choiceRow.style.display = 'none';
    e.skip.style.display = step.hideSkip ? 'none' : 'inline-block';

    clearSpotlight();
    if(step.before) step.before();

    var showRing = stepNeedsRing(step);
    var target = applySpotlight(step.spotlight);
    positionBox(target, showRing);

    // Keep tracking the target continuously (not just once), since
    // several steps spotlight things that resize or shift mid-step — a
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
      // for a Next button — without taking Next away from anyone who'd
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
    if(state.idx >= state.steps.length){ finish(); return; }
    render();
  }

  function finish(){
    if(state && state.cleanupClick) state.cleanupClick();
    if(state && state.cleanupPoll) state.cleanupPoll();
    if(repositionTimer){ clearInterval(repositionTimer); repositionTimer = null; }
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
      html: "Your account is all set up! I'm going to walk you through every function of the site: the sidebar, calendar, Ballot History, the recording tools, and how to run a full practice round. It only takes a few minutes, and you can exit out any time with <b>Skip tutorial</b>."
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
      title: 'Nice — goal set! ✅',
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
      spotlight: '#historyOverallFeedback',
      html: "Once you've recorded a few rounds, this area fills in with comprehensive feedback that finds patterns across your entire practice history, including your biggest recurring strength, your biggest recurring weakness, and one concrete next step. It refreshes automatically at milestone round counts."
    });

    steps.push({
      title: 'Trends across your ballots',
      avatar: '📈',
      spotlight: '#historyTrends',
      html: "This section aggregates your average score in every rubric category, plus sparkline trend graphs for your overall score and each category so you can see exactly where you're improving (or regressing) round by round."
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
      html: "There's a full set of keyboard shortcuts for convenience sakes. Click here any time to see the full list."
    });

    // ---- Time signal settings ------------------------------------------------
    steps.push({
      title: 'Time Signal settings',
      avatar: '🔔',
      spotlight: '#settingsToggle',
      html: "This is where you customize <b>time signals</b>, little on-screen alerts that pop up at specific points while you're recording (e.g. \"1 minute left\"). Add, relabel, recolor, or remove signals here, or reset to the defaults. This is also where you can paste your own Groq/Gemini API keys if you ever hit rate limits.<br><br>Your signals fire for real while you're actually recording: the on-screen clock turns amber at 6:00 and red with a hard-stop warning at 7:00, so you always know exactly how much time is left, even without opening this panel."
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

    // ---- Citation checker (forced use, exact example text) -----------------
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
      title: 'Try it — type this exact example',
      avatar: '🔎',
      spotlight: '#ccSetupStep',
      waitForCondition: function(){ var r = byId('ccResultStep'); return r && !r.classList.contains('hidden'); },
      watchError: function(){
        var dErr = byId('ccDateError'), cErr = byId('ccClaimError'), sErr = byId('ccSourceError');
        if(dErr && dErr.style.display === 'block') return 'That date needs the mm/dd/yyyy format exactly — try 07/25/2026.';
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
      html: "Here's the brief overcourse of what an Extemp round looks like. You receive a question (custom, or drawn for you), you have 30 minutes to prepare, then record yourself on camera. When you submit, Extemplary transcribes your speech and scores you against an 8-category NSDA extemp rubric, which you can view by clicking the paper icon on the top right— with an annotated."
    });

    steps.push({
      title: 'Receive a question',
      avatar: '❓',
      spotlight: '#qModeReceiveBtn',
      waitForClick: '#qModeReceiveBtn',
      hintText: 'Click "Receive a question".',
      html: "Instead of typing your own question, let's have Extemplary draw one for you, exactly like a real tournament draw."
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