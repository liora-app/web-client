// Liora: the theme (on /chat/ also the sky preset) before the first frame: a classic script first in
// <head> (the CSP allows no inline one). It only reads storage and sets <html> attributes and the bar.
;(function () {
  var root = document.documentElement
  try {
    var lock = root.getAttribute('data-theme-lock')
    if (lock === 'light' || lock === 'dark') {
      root.setAttribute('data-theme', lock)
      return
    }
    var theme = localStorage.getItem('liora:theme')
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme)
    var me = document.currentScript
    if (me && me.hasAttribute('data-sky')) {
      var sky = localStorage.getItem('liora:sky')
      if (sky === 'dusk' || sky === 'dawn') root.setAttribute('data-sky', sky)
    }
  } catch (e) {}
  try {
    // The bar in --color-bg, as theme.ts writes it later: the day's first stop, or the night — the hex
    // its meta ships. Without light-dark(): dark.
    var t = root.getAttribute('data-theme')
    var day = t ? t === 'light' : matchMedia('(prefers-color-scheme: light)').matches
    var meta = document.querySelector('meta[name="theme-color"]')
    var n = parseInt(meta.content.slice(1), 16)
    meta.content = day && CSS.supports('color', 'light-dark(#000, #fff)') ? 'rgb(126, 199, 185)' : 'rgb(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')'
  } catch (e) {}
})()
