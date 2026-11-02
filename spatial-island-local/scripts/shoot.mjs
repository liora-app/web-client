// GPU screenshots of the five stops plus frame/load metrics.
// One browser, one page, stops rendered one after another (never in parallel).
// Usage: node scripts/shoot.mjs --tag before [--url http://127.0.0.1:8083/] [--out .checks/shots]
//        [--size 1440x900] [--dpr 1.25] [--stops 0,.25,.5,.75,1] [--settle 2600]
//        [--eval "window.sanctuary.selectLantern(1)"]  (runs once after boot, before the stops)
//        [--clip 600,250,500,400]  (also saves <tag>-<i>-clip.png of that CSS-pixel rect at each stop)
// --perf turns vsync and the frame-rate limit off, so fps/p95 reflect GPU time, not the display cap.
// Without it the page runs at the display rate (gentler on a shared GPU); use that for look checks.
// A machine-wide lock (os.tmpdir()/liora-gpu-shoot.lock) serialises renders from parallel agents.
// --no-avatar aborts the GLB request (procedural fallback) to attribute triangles to the model.
import { chromium } from '@playwright/test'
import { mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const url = arg('url', process.env.CHECK_URL ?? 'http://127.0.0.1:8083/')
const out = arg('out', '.checks/shots'), tag = arg('tag', 'shot')
const [width, height] = arg('size', '1440x900').split('x').map(Number)
const dpr = Number(arg('dpr', '1.25')), settle = Number(arg('settle', '2600'))
const stops = arg('stops', '0,.25,.5,.75,1').split(',').map(Number)
const noAvatar = process.argv.includes('--no-avatar'), perf = process.argv.includes('--perf')
const evalCode = arg('eval', ''), clipArg = arg('clip', '')
const clip = clipArg ? (([x, y, w, h]) => ({ x, y, width: w, height: h }))(clipArg.split(',').map(Number)) : null
await mkdir(out, { recursive: true })

const lock = join(tmpdir(), 'liora-gpu-shoot.lock')
for (let waited = 0; ; waited += 1000) {
  try { await mkdir(lock); break } catch {
    const age = await stat(lock).then(s => Date.now() - s.mtimeMs).catch(() => 0)
    if (age > 300000) { await rm(lock, { recursive: true, force: true }); continue } // stale (>5 min)
    if (waited % 30000 === 0) console.log('waiting for the GPU lock…')
    await new Promise(r => setTimeout(r, 1000))
  }
}
const release = () => rm(lock, { recursive: true, force: true })
process.on('SIGINT', async () => { await release(); process.exit(130) })

const browser = await chromium.launch({
  channel: 'chromium',
  args: [...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []), '--ignore-gpu-blocklist', '--enable-gpu-rasterization', ...(perf ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
}).catch(async e => { await release(); throw e })
const report = { url, tag, viewport: `${width}x${height}@${dpr}`, noAvatar, perf, renderer: '', load: {}, stops: [], errors: [] }
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr, reducedMotion: 'no-preference' })
  if (noAvatar) await page.route('**/*.glb', r => r.abort())
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()) })
  let t0 = Date.now()
  // Vite may full-reload the page while it boots right after an edit: retry the boot twice.
  for (let attempt = 1; ; attempt++) {
    try {
      t0 = Date.now()
      await page.goto(url)
      await page.waitForFunction(() => document.documentElement.dataset.webgl === 'ready', null, { timeout: 60000 })
      break
    } catch (e) { if (attempt >= 3) throw e; console.log(`boot attempt ${attempt} failed (${String(e.message).split(/\r?\n/)[0]}), retrying`) }
  }
  report.renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) return 'none'
    const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  })
  console.log('renderer:', report.renderer)
  if (/swiftshader|llvmpipe|software|basic render/i.test(report.renderer)) throw new Error(`Software renderer, refusing to measure: ${report.renderer}`)
  await page.waitForFunction(() => document.documentElement.dataset.webgl === 'ready', null, { timeout: 60000 })
  report.load.webglReadyMs = Date.now() - t0
  await page.waitForFunction(() => ['ready', 'fallback'].includes(document.documentElement.dataset.avatar), null, { timeout: 120000 })
  report.load.avatarReadyMs = Date.now() - t0
  report.load.avatar = await page.evaluate(() => document.documentElement.dataset.avatar)
  report.load.resources = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource')
    const sum = (f) => entries.filter(f).reduce((s, e) => s + (e.transferSize || e.encodedBodySize || 0), 0)
    return { totalKB: Math.round(sum(() => true) / 1024), modelKB: Math.round(sum(e => /\.glb/.test(e.name)) / 1024), count: entries.length }
  })
  await page.locator('.entry').waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  if (evalCode) await page.evaluate(code => (0, eval)(code), evalCode)
  for (const [i, p] of stops.entries()) {
    await page.evaluate(v => window.sanctuary.setProgress(v), p)
    await page.waitForTimeout(settle)
    const c = await page.evaluate(() => { const s = window.sanctuary.inspect(); return { ...s.cinematic, calls: s.calls, geometries: s.resources.geometries, textures: s.resources.textures } })
    const file = `${out}/${tag}-${i}.png`
    await page.screenshot({ path: file, timeout: 30000 })
    if (clip) await page.screenshot({ path: `${out}/${tag}-${i}-clip.png`, clip, timeout: 30000 })
    report.stops.push({ progress: p, file, fps: +c.fps.toFixed(1), p95: +c.frameP95.toFixed(2), calls: c.calls, triangles: c.triangles, geometries: c.geometries, textures: c.textures })
    console.log(`stop ${p}: ${c.fps.toFixed(1)} fps, p95 ${c.frameP95.toFixed(1)} ms, ${c.calls} calls, ${c.triangles} tris -> ${file}`)
  }
} finally {
  await writeFile(`${out}/${tag}.json`, JSON.stringify(report, null, 2))
  console.log('load:', JSON.stringify(report.load), 'errors:', report.errors.length ? report.errors : 'none')
  await browser.close()
  await release()
}
