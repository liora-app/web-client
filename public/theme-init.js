// Liora: the theme (and on /chat/ the sky preset) before the first frame. A classic synchronous
// script, first in <head> of both pages: the CSP allows no inline script. It only reads storage and
// only sets data attributes on <html>; src/ui/theme.ts and src/ui/sky.ts write the choices.
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
})()
