// Fetches icons.svg (the icon symbol sprite, split out for organization) and injects it
// into #iconSpriteMount so all existing <use href="#icon-N"> references keep working.
fetch('icons.svg').then(r => r.text()).then(svgText => {
  document.getElementById('iconSpriteMount').innerHTML = svgText;
});