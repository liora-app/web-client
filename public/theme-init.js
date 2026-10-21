// Liora: the theme (and on /chat/ the sky preset) before the first frame. A classic synchronous
// script, first in <head> after the charset and the theme-color: the CSP allows no inline script.
// It only reads storage, sets attributes on <html> and the theme-color; src/ui/theme.ts and
// src/ui/sky.ts write the choices.
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
  } catch (e) {
    // Blocked storage: the system's theme and the night.
  }
  try {
    // The bar in --color-bg: the choice, else the system (no light-dark(): dark).
    var t = root.getAttribute('data-theme')
    var day = t ? t === 'light' : matchMedia('(prefers-color-scheme: light)').matches
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = day && CSS.supports('color', 'light-dark(#000, #fff)') ? 'rgb(246, 241, 234)' : 'rgb(18, 26, 27)'
  } catch (e) {}
})()
