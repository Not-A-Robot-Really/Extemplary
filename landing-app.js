(function(){

  const SUPABASE_URL = 'https://iiehhmelfotwkdqxplug.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpZWhobWVsZm90d2tkcXhwbHVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDYxMzEsImV4cCI6MjA5ODkyMjEzMX0.8QzN1LJmr70Sidxp2RsOq-z3S_NX5lN9QWTr45CSaHo';
  const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

  const CLERK_PUBLISHABLE_KEY = 'pk_test_aW1tdW5lLWtvYWxhLTU4Mi5jbGVyay5hY2NvdW50cy5kZXYk';

  const supabaseClient = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

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

  const DATA = window.APP_DATA;
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
  const ANN_LABELS = DATA.ANN_LABELS;
  const CIRCLE_PATH = DATA.CIRCLE_PATH;
  function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function inlineMd(s){ return escHtml(s).replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>'); }
  function bandClass(score, max){
    const ratio = (max ? score/max : score/10);
    return colorFromRatio(ratio);
  }

  const QGEN_PHRASES = DATA.QGEN_PHRASES;
  const BF_PHRASES = DATA.BF_PHRASES;
  const CC_PHRASES = DATA.CC_PHRASES;
  const QUESTION_EXAMPLES = DATA.QUESTION_EXAMPLES;

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
      const info = await res.json().catch(()=> ({}));
      const err = new Error('rate_limited');
      err.rateLimited = true; err.category = info.category || category; err.count = info.currentCount; err.limit = info.usageLimit;
      throw err;
    }
    if(!res.ok){
      const bodyText = await res.text().catch(()=> '');
      throw new Error('gemini_failed:'+res.status+':'+bodyText.slice(0,300));
    }
    const json = await res.json();
    const candidate = json.candidates?.[0];
    if(!candidate) throw new Error('gemini_no_candidate:'+JSON.stringify(json).slice(0,200));
    return candidate;
  }
  async function callGemini(prompt, maxOutputTokens, category){
    return await callGeminiWithKey(prompt, null, maxOutputTokens, category);
  }

  function buildQuestionGenPrompt(category, dateStr){
    const examples = QUESTION_EXAMPLES[category].slice(0,5).map(q => '- '+q).join('\n');
    return `You write NSDA competitive extemp questions. Today: ${dateStr}.
Use Google Search to find real ${category} news from the last 7-14 days. Then write 3 new ${category} extemp questions, each tied to a specific real event/person/policy you found. One sentence each, ending in "?", under 30 words, analytical/predictive phrasing ("Will...","Can...","Should...","How will..."). No older than a few weeks unless still developing. Don't copy these style examples verbatim:
${examples}
Output ONLY this JSON, nothing else: {"questions":["...","...","..."]}`;
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

  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

  function buildCitationPrompt(claim, date, source){
    const hasWildcard = date.includes('?');
    const dateNote = hasWildcard
      ? `The speaker is unsure of part of the date and has marked the unknown digits with "?". Treat this as a range/approximation (e.g. "06/??/2025" means "sometime in June 2025") rather than a literal string.`
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

  const commentPopover = document.getElementById('commentPopover');
  const cpTag = document.getElementById('cpTag');
  const cpText = document.getElementById('cpText');
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

  const authForm = document.getElementById('authForm');
  const authTabLogin = document.getElementById('authTabLogin');
  const authTabSignup = document.getElementById('authTabSignup');
  const authConfirmWrap = document.getElementById('authConfirmWrap');
  const authCodeWrap = document.getElementById('authCodeWrap');
  const authInfo = document.getElementById('authInfo');
  const authResendCodeBtn = document.getElementById('authResendCodeBtn');
  const authError = document.getElementById('authError');
  const authSubmitBtn = document.getElementById('authSubmitBtn');

  function showAuthInfo(msg){
    authInfo.textContent = msg;
    authInfo.classList.remove('hidden');
  }
  function hideAuthInfo(){
    authInfo.classList.add('hidden');
  }

  let clerkLoadPromise = null;
  async function getClerk(){
    if(!window.Clerk) throw new Error('clerk_not_loaded:Verification service failed to load. Check your connection and reload.');
    if(!clerkLoadPromise) clerkLoadPromise = window.Clerk.load();
    await clerkLoadPromise;
    return window.Clerk;
  }
  getClerk().catch(() => {});
  let pendingSignUp = null;

  function resetPendingSignUp(){
    pendingSignUp = null;
    authCodeWrap.classList.add('hidden');
    hideAuthInfo();
    document.getElementById('authCode').value = '';
    document.getElementById('authEmailWrap').classList.remove('hidden');
    document.getElementById('authPasswordWrap').classList.remove('hidden');
    document.getElementById('authEmail').disabled = false;
    document.getElementById('authPassword').disabled = false;
  }
  const authCardEl = document.querySelector('.auth-card');
  let authMode = 'login';

  function lockAuthCardTop(){
    if(!authCardEl) return;
    var wasSignup = authConfirmWrap && !authConfirmWrap.classList.contains('hidden');
    if(wasSignup) authConfirmWrap.classList.add('hidden');
    var hero = authCardEl.closest('.landing-hero');
    if(hero){
      var photo = hero.querySelector('.landing-hero-photo');
      authCardEl.style.alignSelf = 'flex-start';
      authCardEl.style.marginTop = '0px';
      var baselineTop = authCardEl.getBoundingClientRect().top;
      var cardHeight = authCardEl.getBoundingClientRect().height;
      var photoRect = photo ? photo.getBoundingClientRect() : hero.getBoundingClientRect();
      var photoCenterY = photoRect.top + photoRect.height / 2;
      var desiredTop = photoCenterY - cardHeight / 2;
      var marginTop = Math.max(0, desiredTop - baselineTop);
      authCardEl.style.marginTop = marginTop + 'px';
    }
    if(wasSignup) authConfirmWrap.classList.remove('hidden');
  }
  lockAuthCardTop();
  let authLockResizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(authLockResizeTimer);
    authLockResizeTimer = setTimeout(lockAuthCardTop, 150);
  });

  function setAuthMode(mode){
    authMode = mode;
    resetPendingSignUp();
    authTabLogin.classList.toggle('active', mode === 'login');
    authTabSignup.classList.toggle('active', mode === 'signup');
    authConfirmWrap.classList.toggle('hidden', mode !== 'signup');
    document.getElementById('authPasswordConfirm').required = (mode === 'signup');
    authSubmitBtn.textContent = mode === 'login' ? 'Log In' : 'Sign Up';
    authError.classList.remove('visible');
    const indicator = document.getElementById('authTabIndicator');
    if(indicator) indicator.style.transform = mode === 'signup' ? 'translateX(100%)' : 'translateX(0)';
  }
  authTabLogin.addEventListener('click', () => setAuthMode('login'));
  authTabSignup.addEventListener('click', () => setAuthMode('signup'));

  function showAuthError(msg){
    authError.textContent = msg;
    authError.classList.add('visible');
  }

  function describeAuthError(err){
    if(!err) return 'Unknown error.';
    const parts = [];
    if(typeof err === 'string') return err;
    if(err.message) parts.push(err.message);
    if(err.error_description && err.error_description !== err.message) parts.push(err.error_description);
    if(err.status) parts.push('(status ' + err.status + ')');
    if(err.code) parts.push('[' + err.code + ']');
    if(parts.length) return parts.join(' ');
    try{ return JSON.stringify(err); }catch(e){ return String(err); }
  }

  async function startSignupVerification(email, password){
    const clerk = await getClerk();
    if(clerk.session){ try{ await clerk.signOut(); }catch(e){} }
    const clerkSignUp = await clerk.client.signUp.create({ emailAddress: email, password });
    await clerkSignUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    pendingSignUp = { clerkSignUp, email, password };
    document.getElementById('authEmailWrap').classList.add('hidden');
    document.getElementById('authPasswordWrap').classList.add('hidden');
    authConfirmWrap.classList.add('hidden');
    authCodeWrap.classList.remove('hidden');
    document.getElementById('authEmail').disabled = true;
    document.getElementById('authPassword').disabled = true;
    authSubmitBtn.textContent = 'Verify & Create Account';
    showAuthInfo('A message has been sent to your email. Please enter the 6 digit code from that email below.');
  }

  async function completeSignupVerification(code){
    if(!pendingSignUp) throw new Error('No verification in progress, start sign-up again.');
    const { clerkSignUp, email, password } = pendingSignUp;
    if(clerkSignUp.verifications?.emailAddress?.status !== 'verified'){
      try{
        await clerkSignUp.attemptEmailAddressVerification({ code });
      }catch(err){
        const msg = err?.errors?.[0]?.message || err?.message || '';
        if(!/already.*verif/i.test(msg)) throw err;
      }
    }
    if(clerkSignUp.verifications?.emailAddress?.status !== 'verified'){
      throw new Error('That code is incorrect or expired, request a new one and try again.');
    }
    const clerkUserId = clerkSignUp.createdUserId;
    if(!clerkUserId){
      throw new Error('clerk_setup:Verification succeeded but Clerk did not finish creating a user record, double check the sign-up is configured to require only email and password.');
    }
    await createVerifiedAccount(email, password, clerkUserId);
    try{ const clerk = await getClerk(); if(clerk.session) await clerk.signOut(); }catch(e){}
    try{ localStorage.setItem('extemplary_tutorial_pending_email', email); }catch(e){}
    resetPendingSignUp();
    const { error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(signInError) throw signInError;
    window.location.href = 'index.html';
  }

  async function createVerifiedAccount(email, password, clerkUserId){
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/create-verified-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (await getAuthToken()),
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ email, password, clerkUserId })
    });
    if(res.status === 409) return;
    if(!res.ok){
      const info = await res.json().catch(() => ({}));
      throw new Error(info.error || ('account_creation_failed:' + res.status));
    }
  }

  authResendCodeBtn.addEventListener('click', async () => {
    if(!pendingSignUp) return;
    authResendCodeBtn.disabled = true;
    const original = authResendCodeBtn.textContent;
    authResendCodeBtn.textContent = 'Sending...';
    try{
      await pendingSignUp.clerkSignUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      showAuthInfo('A new code has been sent to ' + pendingSignUp.email + '. Please enter it below.');
    }catch(err){
      showAuthError('Could not resend code: ' + describeAuthError(err));
    }finally{
      authResendCodeBtn.disabled = false;
      authResendCodeBtn.textContent = original;
    }
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.classList.remove('visible');
    if(!supabaseClient){
      showAuthError('Could not load the sign-in service. Check your internet connection and reload.');
      return;
    }
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    authSubmitBtn.disabled = true;
    const originalBtnText = authSubmitBtn.textContent;
    try{
      if(authMode === 'signup'){
        if(pendingSignUp){
          const code = document.getElementById('authCode').value.trim();
          if(!code){ showAuthError('Enter the verification code.'); return; }
          authSubmitBtn.textContent = 'Verifying...';
          await completeSignupVerification(code);
          return;
        }
        const confirm = document.getElementById('authPasswordConfirm').value;
        if(password !== confirm){ showAuthError("Passwords don't match."); return; }
        if(password.length < 6){ showAuthError('Password must be at least 6 characters.'); return; }
        try{
          authSubmitBtn.textContent = 'Sending code...';
          await startSignupVerification(email, password);
        }catch(err){
          console.error('Sign-up verification start error:', err);
          authSubmitBtn.textContent = originalBtnText;
          if(/already.*(sign.?up|exist)/i.test(err.message||'') || err.code === 'form_identifier_exists'){
            showAuthError('That email may already have an account, try logging in instead.');
            setAuthMode('login');
          }else{
            showAuthError(describeAuthError(err));
          }
        }
      }else{
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if(error){ console.error('Log-in error:', error); showAuthError(describeAuthError(error)); return; }
        window.location.href = 'index.html';
      }
    }catch(err){
      console.error('Auth exception:', err);
      showAuthError('Something went wrong: ' + describeAuthError(err));
      if(pendingSignUp) authSubmitBtn.textContent = 'Verify & Create Account';
    }finally{
      authSubmitBtn.disabled = false;
    }
  });

  (function setupTranscriptHighlightDemo(){
    const el = document.getElementById('transcriptDemoText');
    if(!el) return;
    const waveBars = Array.from(document.querySelectorAll('#vocalWaveIcon .vw-bar'));
    function pulseWave(word){
      if(!waveBars.length) return;
      const intensity = Math.max(0.35, Math.min(1, (word ? word.length : 3) / 9));
      waveBars.forEach((bar, idx) => {
        const mid = (waveBars.length - 1) / 2;
        const posFalloff = 1 - Math.abs(idx - mid) / (mid + 1) * 0.55;
        const jitter = 0.75 + Math.random() * 0.5;
        const scale = Math.max(0.22, Math.min(1, intensity * posFalloff * jitter));
        bar.style.transform = `scaleY(${scale.toFixed(2)})`;
      });
    }
    function idleWave(){
      waveBars.forEach(bar => { bar.style.transform = 'scaleY(0.22)'; });
    }
    const words = el.textContent.trim().split(/\s+/);
    el.innerHTML = words.map(w => `<span class="tw">${w}</span>`).join(' ');
    const spans = Array.from(el.querySelectorAll('.tw'));
    let i = 0;
    function step(){
      spans.forEach(s => s.classList.remove('tw-active'));
      if(i < spans.length){
        spans[i].classList.add('tw-active');
        pulseWave(spans[i].textContent);
        const len = spans[i].textContent.length;
        const dur = 190 + Math.min(len, 10) * 22;
        i++;
        setTimeout(step, dur);
      }else{
        idleWave();
        i = 0;
        setTimeout(step, 900);
      }
    }
    step();
  })();

  (function setupHeroHeadline(){
    const variants = [
      { before: 'Everything you need to ', word: 'break', after: ' into finals' },
      { before: 'Everything you need to get a ', word: '1st', after: ' in your round' },
      { before: 'Everything you need to practice, improve, and ', word: 'excel', after: '' }
    ];
    const pick = variants[Math.floor(Math.random() * variants.length)];
    const el = document.getElementById('landingHeroHeadlineText');
    if(el){
      el.textContent = '';
      el.appendChild(document.createTextNode(pick.before));
      const span = document.createElement('span');
      span.className = 'hl-word';
      span.textContent = pick.word;
      el.appendChild(span);
      el.appendChild(document.createTextNode(pick.after));
    }
  })();

  (function setupLandingReveal(){
    const targets = document.querySelectorAll('#authGate .landing-example');
    if(!targets.length) return;
    if(!('IntersectionObserver' in window)){
      targets.forEach(t => t.classList.add('in-view'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if(entry.isIntersecting){
          const el = entry.target;
          setTimeout(() => el.classList.add('in-view'), 0);
          io.unobserve(el);
        }
      });
    }, { threshold: 0.15 });
    targets.forEach(t => io.observe(t));
  })();

  window.__frameTasks = [];

  (function ensureFrameLoop(){
    function tick(){
      for(let i = 0; i < window.__frameTasks.length; i++) window.__frameTasks[i]();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  (function setupFeatureScrollHijack(){
    const grid = document.getElementById('landingFeatureGrid');
    const cards = grid ? Array.from(grid.querySelectorAll('.feature-card')) : [];
    if(!cards.length) return;
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      cards.forEach(c => c.classList.add('revealed'));
      return;
    }

    const SENS_WHEEL = 0.0028;
    const SENS_TOUCH = 0.0042;
    const SENS_KEY = 0.14;
    const APPROACH_STEP_MAX = 46;
    const APPROACH_FRAME_CAP = 120;
    const state = cards.map((el, i) => ({ el, dir: i % 2 === 0 ? 'left' : 'right', progress: 0 }));
    let currentIndex = 0;
    let mode = 'approach';

    const scroller = document.getElementById('authGate') || document.scrollingElement || document.documentElement;
    if(scroller && scroller.style) scroller.style.scrollBehavior = 'auto';

    function render(i){
      const s = state[i];
      const eased = 1 - Math.pow(1 - s.progress, 3);
      const offsetPct = (1 - eased) * 100;
      if(s.progress <= 0){
        s.el.style.transform = `translateX(${s.dir === 'left' ? -100 : 100}%)`;
        s.el.style.opacity = '0';
        s.el.classList.remove('revealed');
      } else if(s.progress >= 1){
        s.el.style.transform = '';
        s.el.style.opacity = '';
        s.el.classList.add('revealed');
      } else {
        s.el.style.transform = `translateX(${(s.dir === 'left' ? -offsetPct : offsetPct).toFixed(2)}%)`;
        s.el.style.opacity = String(Math.min(1, s.progress / 0.7));
        s.el.classList.remove('revealed');
      }
    }

    state.forEach((s, i) => { s.progress = 0; render(i); });

    (function ensureTopTriggerCardReveals(){
      const idx = cards.findIndex(c => c.dataset.trigger === 'top');
      if(idx === -1 || !('IntersectionObserver' in window)) return;
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if(!entry.isIntersecting) return;
          io.unobserve(entry.target);
          const s = state[idx];
          if(s.progress >= 1) return;
          const startProgress = s.progress;
          const duration = 550;
          const startTime = performance.now();
          function tick(now){
            const t = Math.min(1, (now - startTime) / duration);
            s.progress = startProgress + (1 - startProgress) * t;
            render(idx);
            if(t < 1){
              requestAnimationFrame(tick);
            } else if(currentIndex <= idx){
              currentIndex = idx + 1;
              mode = 'approach';
            }
          }
          requestAnimationFrame(tick);
        });
      }, { threshold: 0.5 });
      io.observe(cards[idx]);
    })();

    function authGateVisible(){
      if(!scroller) return false;
      if(scroller.classList.contains('hidden')) return false;
      return window.getComputedStyle(scroller).display !== 'none';
    }

    function nearSection(){
      const rect = grid.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    }

    function captured(){
      return authGateVisible() && nearSection() && currentIndex < cards.length;
    }

    window.__releaseFeatureScrollHijack = function(){
      currentIndex = cards.length;
      mode = 'approach';
    };

    function normalizeWheel(e){
      let d = e.deltaY;
      if(e.deltaMode === 1) d *= 16;
      else if(e.deltaMode === 2) d *= window.innerHeight;
      return Math.max(-90, Math.min(90, d));
    }

    function handleDelta(delta, sens){
      const card = cards[currentIndex];

      if(mode === 'slide'){
        const s = state[currentIndex];
        const next = s.progress + delta * sens;
        if(next >= 1){
          s.progress = 1;
          render(currentIndex);
          currentIndex++;
          mode = 'approach';
        } else if(next <= 0 && delta < 0){
          s.progress = 0;
          render(currentIndex);
          mode = 'approach';
        } else {
          s.progress = Math.max(0, Math.min(1, next));
          render(currentIndex);
        }
        return;
      }

      const step = Math.max(-APPROACH_FRAME_CAP, Math.min(APPROACH_FRAME_CAP, delta));
      scroller.scrollTop += step;
      if(delta <= 0) return;
      const rect = card.getBoundingClientRect();
      const armed = card.dataset.trigger === 'top'
        ? rect.top <= 0
        : rect.bottom <= window.innerHeight + 2;
      if(armed){
        mode = 'slide';
      }
    }

    let pendingDelta = 0;
    let pendingSens = SENS_WHEEL;
    const FRAME_DELTA_CAP = 130;

    function queueDelta(delta, sens){
      pendingDelta = Math.max(-FRAME_DELTA_CAP, Math.min(FRAME_DELTA_CAP, pendingDelta + delta));
      pendingSens = sens;
    }

    window.__frameTasks.push(function(){
      if(pendingDelta === 0) return;
      const d = pendingDelta;
      pendingDelta = 0;
      handleDelta(d, pendingSens);
    });

    window.addEventListener('wheel', (e) => {
      if(!captured()) return;
      const delta = normalizeWheel(e);
      e.preventDefault();
      queueDelta(delta, SENS_WHEEL);
    }, { passive: false });

    let touchY = null;
    window.addEventListener('touchstart', (e) => {
      if(!captured()) return;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if(touchY === null || !captured()){ touchY = e.touches[0] ? e.touches[0].clientY : null; return; }
      const y = e.touches[0].clientY;
      const delta = Math.max(-90, Math.min(90, touchY - y));
      e.preventDefault();
      queueDelta(delta, SENS_TOUCH);
      touchY = y;
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const downKeys = ['ArrowDown', 'PageDown', ' '];
      const upKeys = ['ArrowUp', 'PageUp'];
      if(!downKeys.includes(e.key) && !upKeys.includes(e.key)) return;
      if(!captured()) return;
      const dir = downKeys.includes(e.key) ? 1 : -1;
      e.preventDefault();
      queueDelta(dir * 40, SENS_KEY);
    }, { passive: false });

    window.addEventListener('resize', () => { state.forEach((s, i) => render(i)); });
  })();

  (function setupLightZoneBackground(){
    const bg = document.getElementById('lightZoneBg');
    if(!bg) return;

    function measure(){
      bg.style.backgroundSize = `${window.innerWidth}px auto`;
    }

    window.addEventListener('resize', measure);
    window.addEventListener('load', measure);
    measure();
  })();

  document.getElementById('landingExampleBtn').addEventListener('click', () => {
    window.location.href = 'index.html?preview=example';
  });

  attachCommentListeners(document.getElementById('wrSnippet'), () => {});

  (function setupWrVideoModal(){
    const modal = document.createElement('div');
    modal.id = 'wrVideoModal';
    modal.innerHTML = `
      <div class="wr-video-backdrop"></div>
      <div class="wr-video-frame">
        <button type="button" class="wr-video-close" aria-label="Close video">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-68"></use></svg>
        </button>
        <div class="wr-video-embed"></div>
      </div>`;
    document.body.appendChild(modal);
    const embed = modal.querySelector('.wr-video-embed');
    function open(){
      embed.innerHTML = '<iframe src="https://www.youtube.com/embed/lzoUu1fDmWE?start=20&autoplay=1&rel=0" title="Extemplary example round" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>';
      modal.classList.add('show');
    }
    function close(){
      modal.classList.remove('show');
      embed.innerHTML = '';
    }
    document.getElementById('wrThumb').addEventListener('click', open);
    modal.querySelector('.wr-video-close').addEventListener('click', close);
    modal.querySelector('.wr-video-backdrop').addEventListener('click', close);
  })();

  document.querySelectorAll('.demo-signup-cta').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('.landing-hero').scrollIntoView({ behavior:'smooth', block:'center' });
      setAuthMode('signup');
      setTimeout(() => document.getElementById('authEmail').focus(), 500);
    });
  });

  (function setupDemoTimer(){
    const DEMO_TIMER_SECONDS = 30 * 60;
    let remaining = DEMO_TIMER_SECONDS;
    let ticking = null;
    const disp = document.getElementById('demoTimerDisplay');
    const startBtn = document.getElementById('demoTimerStart');
    const pauseBtn = document.getElementById('demoTimerPause');
    const resumeBtn = document.getElementById('demoTimerResume');
    const resetBtn = document.getElementById('demoTimerReset');
    function paint(){
      const m = Math.floor(remaining/60), s = remaining%60;
      disp.textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
      disp.classList.toggle('warn', remaining <= 60);
    }
    function tick(){
      remaining = Math.max(0, remaining - 1);
      paint();
      if(remaining === 0){ clearInterval(ticking); ticking = null; toRunningState(false); }
    }
    function toRunningState(running){
      startBtn.classList.toggle('hidden', remaining !== DEMO_TIMER_SECONDS);
      pauseBtn.classList.toggle('hidden', !running);
      resumeBtn.classList.toggle('hidden', running || remaining === DEMO_TIMER_SECONDS || remaining === 0);
    }
    startBtn.addEventListener('click', () => {
      paint();
      ticking = setInterval(tick, 1000);
      toRunningState(true);
    });
    pauseBtn.addEventListener('click', () => {
      clearInterval(ticking); ticking = null;
      toRunningState(false);
    });
    resumeBtn.addEventListener('click', () => {
      ticking = setInterval(tick, 1000);
      toRunningState(true);
    });
    resetBtn.addEventListener('click', () => {
      clearInterval(ticking); ticking = null;
      remaining = DEMO_TIMER_SECONDS;
      paint();
      startBtn.classList.remove('hidden');
      pauseBtn.classList.add('hidden');
      resumeBtn.classList.add('hidden');
    });
    paint();
  })();

  (function setupHeroConstellation(){
    const canvas = document.getElementById('heroConstellation');
    if(!canvas) return;
    const hero = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    let nodes = [];
    let meshNodes = [];
    let mouse = { x: null, y: null };
    let raf = null;

    function nodeCount(){
      const area = w * h;
      return Math.max(70, Math.min(240, Math.round(area / 8000)));
    }

    function biasedX(){
      const sideBand = w * 0.16;
      if(Math.random() < 0.72){
        const left = Math.random() < 0.5;
        const base = Math.random() * sideBand;
        return left ? base : w - base;
      }
      return Math.random() * w;
    }

    function makeNode(){
      return {
        x: biasedX(),
        y: Math.random() * h,
        z: Math.random(),
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: 1.1 + Math.random() * 1.6
      };
    }

    function buildMesh(){
      meshNodes = [];
      const bandW = w * 0.26;
      const density = Math.max(50, Math.min(160, Math.round((h * bandW) / 2600)));
      const bands = [
        { x0: 0, x1: bandW },
        { x0: w - bandW, x1: w }
      ];
      bands.forEach(band => {
        for(let i = 0; i < density; i++){
          const t = Math.random();
          const x = band.x0 + t * (band.x1 - band.x0);
          meshNodes.push({
            x, y: Math.random() * h,
            vx: (Math.random() - 0.5) * 0.18,
            vy: (Math.random() - 0.5) * 0.18,
            z: 0.2 + Math.random() * 0.6,
            r: 1 + Math.random() * 1.3
          });
        }
      });
    }

    function resize(){
      w = hero.clientWidth;
      h = hero.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = nodeCount();
      if(nodes.length === 0){
        nodes = Array.from({ length: target }, () => makeNode());
      } else if(nodes.length < target){
        while(nodes.length < target) nodes.push(makeNode());
      } else if(nodes.length > target){
        nodes.length = target;
      }
      buildMesh();
    }

    function drawMesh(){
      const bandW = w * 0.26;
      meshNodes.forEach(n => {
        n.x += n.vx;
        n.y += n.vy;
        const inLeftBand = n.x < bandW + 40;
        const loBound = inLeftBand ? 0 : w - bandW;
        const hiBound = inLeftBand ? bandW : w;
        if(n.x < loBound - 10){ n.x = loBound - 10; n.vx *= -1; }
        if(n.x > hiBound + 10){ n.x = hiBound + 10; n.vx *= -1; }
        if(n.y < -10){ n.y = h + 10; } else if(n.y > h + 10){ n.y = -10; }
      });

      const K = 3;
      const maxLink = Math.max(90, Math.min(w, h) * 0.14);
      ctx.lineWidth = 0.6;
      for(let i = 0; i < meshNodes.length; i++){
        const a = meshNodes[i];
        const distances = [];
        for(let j = 0; j < meshNodes.length; j++){
          if(i === j) continue;
          const b = meshNodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if(dist < maxLink) distances.push({ j, dist });
        }
        distances.sort((p, q) => p.dist - q.dist);
        distances.slice(0, K).forEach(({ j, dist }) => {
          if(j < i) return;
          const b = meshNodes[j];
          const alpha = (1 - dist / maxLink) * 0.32 * ((a.z + b.z) / 2 + 0.3);
          ctx.strokeStyle = `rgba(140,175,225,${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        });
      }

      meshNodes.forEach(n => {
        const size = n.r * (0.7 + n.z * 0.9);
        ctx.beginPath();
        ctx.fillStyle = `rgba(170,200,240,${(0.25 + n.z * 0.4).toFixed(3)})`;
        ctx.arc(n.x, n.y, size, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    function step(animate, t){
      t = t || 0;
      ctx.clearRect(0, 0, w, h);
      const linkDist = Math.max(190, Math.min(w, h) * 0.3);

      const clipX = w * 0.12, clipY = h * 0.12, clipW = w * 0.76, clipH = h * 0.76;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip('evenodd');

      nodes.forEach(n => {
        n.x += n.vx;
        n.y += n.vy;
        if(mouse.x !== null){
          const dx = (mouse.x - w / 2) * 0.02 * n.z;
          const dy = (mouse.y - h / 2) * 0.02 * n.z;
          n.x += dx * 0.02;
          n.y += dy * 0.02;
        }
        if(n.x < -20) n.x = w + 20; else if(n.x > w + 20) n.x = -20;
        if(n.y < -20) n.y = h + 20; else if(n.y > h + 20) n.y = -20;
      });

      drawMesh();

      const K = 5;
      for(let i = 0; i < nodes.length; i++){
        const a = nodes[i];
        const distances = [];
        for(let j = 0; j < nodes.length; j++){
          if(i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if(dist < linkDist) distances.push({ j, dist });
        }
        distances.sort((p, q) => p.dist - q.dist);
        distances.slice(0, K).forEach(({ j, dist }) => {
          if(j < i) return;
          const b = nodes[j];
          const alpha = (1 - dist / linkDist) * 0.4 * ((a.z + b.z) / 2 + 0.3);
          ctx.strokeStyle = `rgba(120,160,220,${alpha.toFixed(3)})`;
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        });
      }

      nodes.forEach(n => {
        const size = n.r * (0.6 + n.z * 1.1);
        const alpha = 0.35 + n.z * 0.55;
        ctx.beginPath();
        ctx.fillStyle = `rgba(160,195,240,${alpha.toFixed(3)})`;
        ctx.arc(n.x, n.y, size, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.restore();

      if(animate) raf = requestAnimationFrame((now) => step(true, now));
    }

    resize();
    window.addEventListener('resize', resize);
    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    });
    hero.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });

    step(!reduceMotion);
  })();

  (function setupTilt(){
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if(window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    document.querySelectorAll('#authGate .feature-card').forEach(card => {
      let raf = null;
      card.addEventListener('mousemove', (e) => {
        if(!card.classList.contains('revealed')) return;
        const rect = card.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        if(raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          card.classList.add('tilting');
          card.style.transform = `rotateX(${(-py*6).toFixed(2)}deg) rotateY(${(px*6).toFixed(2)}deg)`;
        });
      });
      card.addEventListener('mouseleave', () => {
        if(raf) cancelAnimationFrame(raf);
        card.classList.remove('tilting');
        if(card.classList.contains('revealed')) card.style.transform = '';
      });
    });
  })();

  (function setupDemoQuestions(){
    const DEMO_Q_KEY = 'extemplary-demo-question-used';
    const catRow = document.getElementById('demoQCatRow');
    const errEl = document.getElementById('demoQError');
    const loading = document.getElementById('demoQLoading');
    const loadingText = document.getElementById('demoQLoadingText');
    const optionsEl = document.getElementById('demoQOptions');
    const confirmedWrap = document.getElementById('demoQConfirmed');
    const confirmedText = document.getElementById('demoQConfirmedText');
    const lockEl = document.getElementById('demoQLock');
    const genBtn = document.getElementById('demoGenerateQuestionsBtn');
    const demoQProgress = createProgressController(
      document.getElementById('demoQProgressFill'),
      document.getElementById('demoQProgressPhrase')
    );
    let demoQCategory = null;

    function lockDemo(){
      lockEl.classList.add('show');
      catRow.style.pointerEvents = 'none';
      catRow.style.opacity = '0.4';
      genBtn.disabled = true; genBtn.style.opacity = '0.4';
      try{ localStorage.setItem(DEMO_Q_KEY, '1'); }catch(e){}
    }

    if(localStorage.getItem(DEMO_Q_KEY) === '1'){
      lockEl.classList.add('show');
      catRow.style.opacity = '0.4';
      catRow.style.pointerEvents = 'none';
      genBtn.disabled = true; genBtn.style.opacity = '0.4';
    }

    catRow.querySelectorAll('.q-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if(localStorage.getItem(DEMO_Q_KEY) === '1') return;
        catRow.querySelectorAll('.q-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        demoQCategory = btn.dataset.cat;
        genBtn.disabled = false;
      });
    });

    genBtn.addEventListener('click', async () => {
      if(localStorage.getItem(DEMO_Q_KEY) === '1' || !demoQCategory) return;
      errEl.style.display = 'none';
      confirmedWrap.classList.add('hidden');
      optionsEl.innerHTML = '';
      catRow.style.pointerEvents = 'none';
      catRow.style.opacity = '0.5';
      genBtn.disabled = true; genBtn.style.opacity = '0.5';
      const category = demoQCategory;
      loadingText.textContent = `Drafting three ${category.toLowerCase()} questions…`;
      loading.classList.remove('hidden');
      demoQProgress.start(QGEN_PHRASES, 90);
      try{
        const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        const prompt = buildQuestionGenPrompt(category, dateStr);
        const candidate = await callGemini(prompt, undefined, 'question_generator');
        const questions = extractQuestions(candidate);
        demoQProgress.finish();
        await new Promise(r => setTimeout(r, 220));
        loading.classList.add('hidden');
        questions.forEach(q => {
          const card = document.createElement('div');
          card.className = 'q-option-card';
          card.textContent = q;
          card.addEventListener('click', () => {
            if(localStorage.getItem(DEMO_Q_KEY) === '1') return;
            confirmedText.textContent = q;
            confirmedWrap.classList.remove('hidden');
            optionsEl.innerHTML = '';
            lockDemo();
          });
          optionsEl.appendChild(card);
        });
      }catch(err){
        console.warn('Landing demo question generation failed:', err);
        demoQProgress.stop();
        loading.classList.add('hidden');
        errEl.textContent = "Couldn't draft questions right now, please try again in a moment.";
        errEl.style.display = 'block';
        catRow.style.pointerEvents = '';
        catRow.style.opacity = '';
        genBtn.disabled = false; genBtn.style.opacity = '';
      }
    });
  })();

  (function setupDemoBriefing(){
    const DEMO_BF_KEY = 'extemplary-demo-briefing-used';
    const btn = document.getElementById('demoBriefingBtn');
    const errEl = document.getElementById('demoBfError');
    const loading = document.getElementById('demoBfLoading');
    const resultEl = document.getElementById('demoBfResult');
    const lockEl = document.getElementById('demoBfLock');
    const timingRow = document.getElementById('demoBfTimingRow');
    const customRow = document.getElementById('demoBfCustomRow');
    const customDate = document.getElementById('demoBfCustomDate');
    const demoBfProgress = createProgressController(
      document.getElementById('demoBfProgressFill'),
      document.getElementById('demoBfProgressPhrase')
    );
    let demoBfTiming = null;
    const alreadyUsed = () => localStorage.getItem(DEMO_BF_KEY) === '1';

    timingRow.querySelectorAll('.bf-timing-btn').forEach(tb => {
      tb.addEventListener('click', () => {
        if(alreadyUsed()) return;
        timingRow.querySelectorAll('.bf-timing-btn').forEach(b => b.classList.remove('active'));
        tb.classList.add('active');
        demoBfTiming = tb.dataset.timing;
        customRow.classList.toggle('show', demoBfTiming === 'custom');
        btn.disabled = false;
      });
    });

    function describeDemoTiming(){
      const now = new Date();
      if(demoBfTiming === 'today'){
        return `in a few hours, later today (${now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })})`;
      }
      if(demoBfTiming === 'tomorrow'){
        const t = new Date(now.getTime() + 24*60*60*1000);
        return `tomorrow (${t.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })})`;
      }
      if(demoBfTiming === 'custom' && customDate.value){
        const d = new Date(customDate.value);
        if(!isNaN(d.getTime())) return `on ${d.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`;
      }
      return 'soon';
    }

    if(alreadyUsed()){
      lockEl.classList.add('show');
      btn.disabled = true; btn.style.opacity = '0.4';
      timingRow.style.pointerEvents = 'none'; timingRow.style.opacity = '0.5';
    }

    async function callGeminiWithRetry(prompt, category){
      try{
        return await callGemini(prompt, undefined, category);
      }catch(err){
        const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(err?.message || '');
        if(!isNetworkError) throw err;
        await new Promise(r => setTimeout(r, 1200));
        return await callGemini(prompt, undefined, category);
      }
    }

    btn.addEventListener('click', async () => {
      if(alreadyUsed() || !demoBfTiming) return;
      errEl.style.display = 'none';
      resultEl.innerHTML = '';
      btn.disabled = true; btn.style.opacity = '0.5';
      timingRow.style.pointerEvents = 'none'; timingRow.style.opacity = '0.6';
      loading.classList.remove('hidden');
      demoBfProgress.start(typeof BF_PHRASES !== 'undefined' ? BF_PHRASES : ['Pulling together your briefing…'], 92);
      try{
        const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        const timingDesc = describeDemoTiming();
        const prompt = `You are prepping a competitive NSDA extemp speaker whose tournament is ${timingDesc}. Today is ${dateStr}. Use Google Search to find real, current news from the last week. Write a brief briefing in exactly this plain-text structure (use this exact "## " header, nothing before it):\n\n## Domestic\n4-5 bullet points ("- ") on the most important U.S. domestic stories from the last week. Each bullet MUST start with a short label followed by a colon, like "- Government Shutdown Fight: description here." Wrap the 2-3 most important key terms in double asterisks like **this**.\n\nFormatting rules: plain text only besides the "**bold**" spans, no other markdown, no intro or closing remarks, nothing before "## Domestic" or after the last bullet.`;
        const candidate = await callGeminiWithRetry(prompt, 'current_events');
        const raw = (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
        demoBfProgress.finish();
        await new Promise(r => setTimeout(r, 220));
        loading.classList.add('hidden');
        resultEl.innerHTML = renderBriefingText(raw);
        lockEl.classList.add('show');
        try{ localStorage.setItem(DEMO_BF_KEY, '1'); }catch(e){}
      }catch(err){
        console.warn('Landing demo briefing failed:', err);
        demoBfProgress.stop();
        loading.classList.add('hidden');
        const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(err?.message || '');
        errEl.textContent = isNetworkError
          ? "Couldn't reach the briefing service, check your connection (or an ad blocker/extension may be blocking the request) and try again."
          : "Couldn't generate a briefing right now, please try again in a moment.";
        errEl.style.display = 'block';
        btn.disabled = false; btn.style.opacity = '';
        timingRow.style.pointerEvents = ''; timingRow.style.opacity = '';
      }
    });
  })();

  (function setupDemoCitation(){
    const DEMO_CC_KEY = 'extemplary-demo-citation-used';
    const claimInput = document.getElementById('demoCcClaimInput');
    const dateInput = document.getElementById('demoCcDateInput');
    const sourceInput = document.getElementById('demoCcSourceInput');
    const btn = document.getElementById('demoCcCheckBtn');
    const errEl = document.getElementById('demoCcError');
    const loading = document.getElementById('demoCcLoading');
    const loadingText = document.getElementById('demoCcLoadingText');
    const resultEl = document.getElementById('demoCcResult');
    const verdictStamp = document.getElementById('demoCcVerdictStamp');
    const verdictNum = document.getElementById('demoCcVerdictNum');
    const explanationEl = document.getElementById('demoCcExplanation');
    const sourceLinkEl = document.getElementById('demoCcSourceLink');
    const lockEl = document.getElementById('demoCcLock');
    const demoCcProgress = createProgressController(
      document.getElementById('demoCcProgressFill'),
      document.getElementById('demoCcProgressPhrase')
    );
    const alreadyUsed = () => localStorage.getItem(DEMO_CC_KEY) === '1';
    const datePattern = /^[0-9?]{2}\/[0-9?]{2}\/[0-9?]{4}$/;

    if(alreadyUsed()){
      lockEl.classList.add('show');
      btn.disabled = true; btn.style.opacity = '0.4';
      [claimInput, dateInput, sourceInput].forEach(el => { el.disabled = true; });
    }

    btn.addEventListener('click', async () => {
      if(alreadyUsed()) return;
      const claim = claimInput.value.trim();
      const date = dateInput.value.trim();
      const source = sourceInput.value.trim();
      errEl.style.display = 'none';

      if(!claim || !date || !datePattern.test(date) || !source){
        errEl.textContent = !claim ? 'Please enter a claim.'
          : (!source ? 'Please enter a source.'
          : 'Please enter a date as mm/dd/yyyy (use ? for unknown digits, e.g. 06/??/2025).');
        errEl.style.display = 'block';
        return;
      }

      resultEl.classList.add('hidden');
      btn.disabled = true; btn.style.opacity = '0.5';
      [claimInput, dateInput, sourceInput].forEach(el => { el.disabled = true; });
      loadingText.textContent = 'Searching the web to verify this citation…';
      loading.classList.remove('hidden');
      demoCcProgress.start(typeof CC_PHRASES !== 'undefined' ? CC_PHRASES : ['Reading the claim…', 'Searching for matching coverage…'], 92);

      try{
        const prompt = buildCitationPrompt(claim, date, source);
        const candidate = await callGemini(prompt, 700, 'citation_checker');
        const result = extractCitationVerdict(candidate);

        demoCcProgress.finish();
        await new Promise(r => setTimeout(r, 220));
        loading.classList.add('hidden');

        verdictStamp.className = 'cc-verdict-stamp ' + result.verdict;
        verdictStamp.style.padding = '8px 22px';
        verdictNum.textContent = result.verdict === 'true' ? 'TRUE' : result.verdict === 'false' ? 'FALSE' : 'UNVERIFIED';
        explanationEl.textContent = result.explanation || (result.verdict === 'unverified' ? "Couldn't confirm this either way from what's publicly searchable." : '');
        if(result.verdict === 'true' && result.sourceUrl){
          sourceLinkEl.innerHTML = `Source: <a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.sourceTitle || result.sourceUrl)}</a>`;
        }else if(result.verdict === 'true'){
          sourceLinkEl.innerHTML = `<span class="q-hint">Confirmed, but no direct link was found via search.</span>`;
        }else{
          sourceLinkEl.innerHTML = '';
        }
        resultEl.classList.remove('hidden');
        lockEl.classList.add('show');
        try{ localStorage.setItem(DEMO_CC_KEY, '1'); }catch(e){}
      }catch(err){
        console.warn('Landing demo citation check failed:', err);
        demoCcProgress.stop();
        loading.classList.add('hidden');
        const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(err?.message || '');
        errEl.textContent = isNetworkError
          ? "Couldn't reach the citation checker, check your connection (or an ad blocker/extension may be blocking the request) and try again."
          : "Couldn't check that citation right now, please try again in a moment.";
        errEl.style.display = 'block';
        btn.disabled = false; btn.style.opacity = '';
        [claimInput, dateInput, sourceInput].forEach(el => { el.disabled = false; });
      }
    });
  })();

  function renderMiniTrendBars(){
    document.querySelectorAll('.fc-mini-trend-fill[data-pct]').forEach(fillEl => {
      const pct = parseFloat(fillEl.dataset.pct) || 0;
      fillEl.style.background = colorFromRatio(pct / 100);
    });
  }
  setTimeout(renderMiniTrendBars, 0);

  function renderDemoCategoryCard(){
    const panel = document.getElementById('demoCategoryPanel');
    const demoCat = (DATA.EXAMPLE_CATEGORIES || []).find(c => c.name === 'Structure') || (DATA.EXAMPLE_CATEGORIES || [])[1];
    if(!panel || !demoCat) return;
    const band = bandClass(demoCat.score, demoCat.max);
    panel.innerHTML = `
      <div class="category demo-category-reveal" style="border-top:none;padding-top:0;">
        <div class="badge-wrap" style="--bc:${band}">
          <div class="score">${demoCat.score}<small>/${demoCat.max}</small></div>
        </div>
        <div>
          <h3 class="cat-name">${escHtml(demoCat.name)}</h3>
          <div class="cat-row worked"><span class="tag">What Worked</span>${inlineMd(demoCat.whatWorked)}</div>
          <div class="cat-row flaws"><span class="tag">Critical Flaws</span>${inlineMd(demoCat.criticalFlaws)}</div>
          <div class="cat-row evidence"><span class="tag">What You Could Have Done</span>${inlineMd(demoCat.evidence)}</div>
        </div>
      </div>`;
  }
  setTimeout(renderDemoCategoryCard, 0);

  (function animateLandingGoalRing(){
    const ring = document.querySelector('.fc-decor-goal-seal .goal-card-seal-ring');
    const pctEl = document.getElementById('landingGoalPct');
    if(!ring || !pctEl) return;
    const target = 82, riseMs = 2400, holdMs = 1100, pauseMs = 900;
    function cycle(){
      const start = performance.now();
      function tick(now){
        const t = Math.min(1, (now - start) / riseMs);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = Math.round(eased * target);
        ring.style.setProperty('--goal-pct', val);
        pctEl.textContent = val + '%';
        if(t < 1){
          requestAnimationFrame(tick);
        }else{
          setTimeout(() => {
            ring.style.setProperty('--goal-pct', 0);
            pctEl.textContent = '0%';
            setTimeout(cycle, pauseMs);
          }, holdMs);
        }
      }
      requestAnimationFrame(tick);
    }
    cycle();
  })();

  (function setupSideWords(){
    const leftInner  = document.getElementById('sideWordsLeftInner');
    const rightInner = document.getElementById('sideWordsRightInner');
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

        const direction = (i % 2 === 0) ? 'alternate' : 'alternate-reverse';
        const duration = 18 + (i % 5) * 3;
        span.style.animation = 'driftWobble ' + duration + 's ease-in-out infinite';
        span.style.animationDirection = direction;
        span.style.animationDelay = '-' + ((i * 1.7) % duration).toFixed(1) + 's';

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

  (async function initAuth(){
    if(!supabaseClient) return;
    const { data } = await supabaseClient.auth.getSession();
    if(data?.session && !data.session.user?.is_anonymous){
      window.location.href = 'index.html';
      return;
    }
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if(event === 'SIGNED_IN' && session && !session.user?.is_anonymous){
        window.location.href = 'index.html';
      }
    });
  })();

})();