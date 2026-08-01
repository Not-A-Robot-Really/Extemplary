// This file fetches icons.svg (the icon symbol sprite, split up for organization) and kinda "injects" it
// into #iconSpriteMount, so all of the mentions of <use href="#icon-N"> keep working just fine.
fetch('icons.svg').then(r => r.text()).then(svgText => {
  document.getElementById('iconSpriteMount').innerHTML = svgText;
});