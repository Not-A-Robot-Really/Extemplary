
(function () {

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button, [role="button"]');
    if (!btn || btn.disabled) return;

    // Restart the animation even on rapid repeat clicks.
    btn.classList.remove('btn-pop-anim');
    // Force reflow so re-adding the class retriggers the CSS animation.
    void btn.offsetWidth;
    btn.classList.add('btn-pop-anim');
  }, true);

  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'btnClickPop' || e.animationName === 'btnClickPopSmall') {
      e.target.classList.remove('btn-pop-anim');
    }
  });
})();