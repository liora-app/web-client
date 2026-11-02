import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const url = process.env.CHECK_URL ?? 'http://127.0.0.1:8084'
const devUrl = process.env.MOTION_URL ?? 'http://127.0.0.1:8083'
const report = { url, checks: [], errors: [], failedResponses: [], screenshots: [] }
await mkdir('.checks', { recursive: true })
const browser = await chromium.launch({ channel: 'chromium', args: process.platform === 'win32' ? ['--use-angle=d3d11'] : [] })
const pass = name => { report.checks.push(name); console.log('PASS', name) }
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
const page = await context.newPage()
page.on('pageerror', error => report.errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })
page.on('response', response => { if (response.status() >= 400) report.failedResponses.push(`${response.status()} ${response.url()}`) })
const settled = async stage => {
  await page.waitForFunction(index => {
    const panel = document.querySelector(`.stage[data-stage="${index}"] .stage-content`)
    return document.documentElement.dataset.visibleStage === String(index) && Number(getComputedStyle(panel).opacity) > .99
  }, stage, { timeout: 15000 })
  await page.waitForTimeout(1500)
}
const capture = async name => {
  await page.screenshot({ path: `.checks/${name}.png`, timeout: 10000 })
  report.screenshots.push(name)
}
try {
  const modelResponse = page.waitForResponse(response => response.url().endsWith('/models/companion.glb'))
  const response = await page.goto(url)
  assert.match(response.headers()['content-security-policy'], /wasm-unsafe-eval/)
  assert.equal((await modelResponse).status(), 200)
  await page.waitForFunction(() => document.documentElement.dataset.avatar === 'ready', null, { timeout: 30000 })
  await page.locator('.entry').waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => typeof window.sanctuary), 'undefined')
  pass('Production CSP allows the authored GLB, with no development API exposed')
  await settled(0)
  await capture('production-hero')
  for (const [stage, selector] of [[1, '.nav [data-go="1"]'], [2, '.nav [data-go="2"]'], [3, '.nav [data-go="3"]']]) {
    await page.locator(selector).click()
    await settled(stage)
    assert.equal(await page.locator('.stage.is-active').count(), 1)
    await capture(`production-stage-${stage}`)
  }
  await page.locator('[data-lantern="0"]').click()
  assert.equal(await page.locator('#answer-0').isVisible(), true)
  await page.locator('[data-help]').click()
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true)
  await page.keyboard.press('Escape')
  await page.locator('.brand').click()
  await settled(0)
  await page.locator('.primary').click()
  await settled(4)
  pass('Real navigation, FAQ, help and hero CTA work with normal scroll animation')
  await page.locator('#chat-input').fill('Сьогодні хочеться трохи спокою')
  await page.locator('.send').click()
  await page.locator('.message--notice').waitFor({ timeout: 12000 })
  const fit = await page.locator('.conversation-panel').evaluate(panel => ({ top: panel.getBoundingClientRect().top, bottom: panel.getBoundingClientRect().bottom, height: innerHeight, overflow: panel.scrollHeight - panel.clientHeight }))
  assert.ok(fit.top > 80 && fit.bottom <= fit.height - 55 && fit.overflow <= 1)
  await capture('production-conversation')
  pass('Production conversation shows the demo notice and remains inside the viewport')

  const motion = await context.newPage()
  motion.on('pageerror', error => report.errors.push(error.message))
  await motion.goto(devUrl)
  await motion.waitForFunction(() => document.documentElement.dataset.avatar === 'ready', null, { timeout: 30000 })
  await motion.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const samples = await motion.evaluate(async () => {
    const initial = window.sanctuary.motion().avatar
    window.sanctuary.setProgress(1)
    const frames = []
    for (let index = 0; index < 24; index++) {
      await new Promise(resolve => setTimeout(resolve, 130))
      const state = window.sanctuary.motion()
      frames.push({ right: state.avatar.rightHand[1], left: state.avatar.leftHand[1], scale: state.coreScale })
    }
    return { initial, frames }
  })
  report.motion = samples
  assert.equal(samples.initial.source, 'glb')
  assert.equal(samples.initial.bones.length, 16)
  assert.ok(Math.max(...samples.frames.map(frame => frame.right)) > samples.initial.rightHand[1] + .3)
  assert.ok(Math.abs(samples.frames.at(-1).right - samples.initial.rightHand[1]) < .15)
  assert.ok(Math.max(...samples.frames.map(frame => frame.left)) - Math.min(...samples.frames.map(frame => frame.left)) < .15)
  await motion.evaluate(() => window.sanctuary.setProgress(0))
  await motion.waitForTimeout(500)
  await motion.evaluate(() => window.sanctuary.setProgress(1))
  await motion.waitForTimeout(700)
  assert.ok((await motion.evaluate(() => window.sanctuary.motion().avatar.rightHand[1])) < samples.initial.rightHand[1] + .15)
  pass('The real 16-bone avatar waves once, returns to rest and keeps the other arm stable')
  for (const sample of samples.frames) {
    assert.equal(sample.scale[0], sample.scale[1])
    assert.equal(sample.scale[1], sample.scale[2])
    assert.ok(sample.scale[0] >= 1 && sample.scale[0] <= 1.161)
  }
  assert.ok(Math.max(...samples.frames.map(frame => frame.scale[0])) - Math.min(...samples.frames.map(frame => frame.scale[0])) > .025)
  pass('The core keeps breathing with uniform scale while scrolling is stopped')
  await motion.close()
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.failedResponses, [])
  pass('No JavaScript, network or CSP errors in the production walkthrough')
} finally {
  await writeFile('.checks/production-verification.json', JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ passed: report.checks.length, errors: report.errors }))
