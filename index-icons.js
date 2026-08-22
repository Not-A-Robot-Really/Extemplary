fetch('icons.svg').then(r => r.text()).then(svgText => {
  document.getElementById('iconSpriteMount').innerHTML = svgText;
})