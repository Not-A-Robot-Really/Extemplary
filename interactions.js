(function () {

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button, [role="button"]');
    if (!btn || btn.disabled) return;

    btn.classList.remove('btn-pop-anim');

    void btn.offsetWidth;
    btn.classList.add('btn-pop-anim');
  }, true);

  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'btnClickPop' || e.animationName === 'btnClickPopSmall') {
      e.target.classList.remove('btn-pop-anim');
    }
  });
})();