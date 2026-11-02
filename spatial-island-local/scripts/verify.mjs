import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir,writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const base=process.env.CHECK_URL??'http://127.0.0.1:8083'
await mkdir('.checks',{recursive:true})
const browser=await chromium.launch({channel:'chromium',args:[...(process.platform==='win32'?['--use-angle=d3d11']:[]),'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
const report={url:base,checks:[],skipped:[],errors:[],networkFailures:[],screenshots:[]}
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['microphone']})
await context.addInitScript(()=>{
  class SpeechMock {
    lang='';continuous=false;interimResults=false;onresult=null;onerror=null;onend=null
    start(){window.__speech=this}abort(){window.__speech=null}stop(){this.onend?.()}
  }
  window.SpeechRecognition=SpeechMock
})
const page=await context.newPage()
page.on('pageerror',e=>report.errors.push(e.message))
page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())})
page.on('response',r=>{if(r.status()>=400)report.networkFailures.push(`${r.status()} ${r.url()}`)})
const pass=name=>{report.checks.push(name);console.log('PASS',name)}
// Intersection over union of two screen boxes [left, top, right, bottom].
const iou=(a,b)=>{const w=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),both=w*h;return both/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-both)}
const wait=ms=>page.waitForTimeout(ms)
async function at(p){await page.evaluate(value=>window.sanctuary.setProgress(value),p);await wait(700);await page.waitForFunction(value=>Math.abs(window.sanctuary.progress()-value)<.002,p);await wait(150)}
async function screenshot(name){if(!['verified-desktop-4','verified-390-844-4','verified-320-568-4'].includes(name))return;await page.screenshot({path:`.checks/${name}.png`,timeout:20000});report.screenshots.push(name)}
try{
  const start=Date.now();await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.webgl==='ready',null,{timeout:30000});await page.locator('.entry').waitFor({state:'detached'});report.readyMs=Date.now()-start
  await page.waitForFunction(()=>document.documentElement.dataset.avatar==='ready',null,{timeout:60000});const ownAvatar=await page.evaluate(()=>window.sanctuary.inspect().avatar);assert.equal(ownAvatar.source,'glb');assert.equal(ownAvatar.bones.length,16);pass('Authored knitted GLB loads by default with all 16 bound bones')
  assert.equal(await page.locator('.stage').count(),5);assert.equal(await page.evaluate(()=>Math.round(document.querySelector('#scroll-wrapper').getBoundingClientRect().height/innerHeight)),5)
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#webgl-container')).pointerEvents),'none')
  pass('Five 100vh stages, fixed background canvas and independent HTML layer')
  const visibility=await page.evaluate(()=>{const failures=[],dead=[.15,.16,.175,.18,.34,.37,.41,.59,.62,.66,.84,.87,.89];for(const value of [...Array.from({length:101},(_,i)=>i/100),...dead].flatMap(p=>[p,1-p])){window.sanctuary.setProgress(value);const visible=[...document.querySelectorAll('.stage-content')].filter(e=>getComputedStyle(e).visibility==='visible'&&Number(getComputedStyle(e).opacity)>.001);if(visible.length>1||dead.includes(value)&&visible.length)failures.push({value,visible:visible.length})}return failures});assert.deepEqual(visibility,[]);pass('Forward/reverse scroll has one visible panel at most and clean dead zones')
  const expected=[[-2.1,2,5.6],[-2.25,1.1,1.95],[-1.75,.65,2.65],[.25,1.75,2.1],[0,1.35,1.85]]
  for(let i=0;i<5;i++){
    await at(i/4);const state=await page.evaluate(()=>window.sanctuary.inspect())
    expected[i].forEach((value,k)=>assert.ok(Math.abs(state.camera[k]-value)<.025,`Waypoint ${i}, axis ${k}: ${state.camera}`))
    // Hero (art-5): the three stations read apart. Lotus and folios keep their spots, so that pair only must not grow
    // (it measures ≈.07 offline: the folios' right edge meets the lotus' outer petals); the cocoon must clear both.
    if(i===0){const boxes=state.screenBoxes;for(const [a,b,limit] of [['cocoon','lotus',.05],['cocoon','sheets',.05],['lotus','sheets',.1]])assert.ok(iou(boxes[a],boxes[b])<limit,`Hero ${a}/${b} overlap ${iou(boxes[a],boxes[b]).toFixed(3)}: ${JSON.stringify(boxes)}`)}
    assert.equal(state.coreScale[0],state.coreScale[1]);assert.equal(state.coreScale[1],state.coreScale[2]);assert.equal(await page.locator('.stage.is-active').getAttribute('data-stage'),String(i))
    await screenshot(`verified-desktop-${i}`)
  }
  pass('All five camera waypoints, independent target path and spherical core')
  const finalTarget=await page.evaluate(()=>window.sanctuary.inspect().target);[0,.55,-.8].forEach((v,i)=>assert.ok(Math.abs(finalTarget[i]-v)<.01));pass('Final camera uses the specified centered target');const cinematic=await page.evaluate(()=>window.sanctuary.inspect().cinematic);assert.equal(cinematic.grass,4500);assert.equal(cinematic.petals,36);assert.equal(cinematic.particles,180);assert.equal(cinematic.mistLayers,3);assert.equal(cinematic.silhouettes,6);assert.deepEqual(cinematic.bloom,[.5,.4,.8]);assert.equal(cinematic.exposure,1.45);assert.equal(cinematic.transmission,.35);assert.equal(cinematic.grain,.03);pass('Cinematic rendering, terrain, vegetation and atmospheric counts match the specification')
  await at(.25);await page.locator('[data-direction="1"]').click();assert.equal(await page.locator('[data-direction="1"]').getAttribute('aria-selected'),'true');await page.locator('[data-direction="1"]').press('ArrowRight');assert.equal(await page.locator('[data-direction="2"]').getAttribute('aria-selected'),'true');await wait(800);assert.equal((await page.evaluate(()=>window.sanctuary.inspect())).paperFront,2);pass('Direction cards, keyboard tabs and the matching origami sheet in front')
  await at(.5);await wait(1200);const closed=await page.evaluate(()=>window.sanctuary.inspect());assert.ok(closed.privacyClosure>.99);await at(.25);await wait(1000);assert.ok((await page.evaluate(()=>window.sanctuary.inspect())).privacyClosure<.01);pass('Kintsugi ceramic cocoon closes at privacy and reopens when reversing')
  await at(.75);await page.locator('[data-lantern="1"]').click();assert.equal(await page.locator('#answer-1').isVisible(),true);await wait(900);const lanterns=(await page.evaluate(()=>window.sanctuary.inspect())).lanterns;assert.ok(lanterns[1]>2.8&&lanterns[0]<.65&&lanterns[2]<.65);await page.locator('[data-lantern="1"]').press('Enter');assert.equal(await page.locator('#answer-1').isVisible(),false);pass('Accessible FAQ drives the corresponding 3D lantern')
  await page.locator('[data-help]').click();assert.equal(await page.locator('dialog').evaluate(n=>n.open),true);await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(n=>n.open),false);assert.equal(await page.locator('[data-help]').evaluate(n=>n===document.activeElement),true);pass('Native help modal, Escape and restored keyboard focus')
  await at(1);await page.locator('[data-scenario="2"]').click();assert.match(await page.locator('#chat-input').inputValue(),/перевантаження/)
  const payload='<img src=x onerror="window.__xss=1">';await page.locator('#chat-input').fill(payload);await page.locator('.send').click();await page.waitForFunction(()=>!document.querySelector('#chat-messages').hasAttribute('aria-busy'),null,{timeout:12000});assert.equal(await page.locator('.message--user .message__text').last().textContent(),payload);assert.equal(await page.locator('#chat-messages img').count(),0);assert.equal(await page.evaluate(()=>window.__xss),undefined)
  await page.locator('#chat-input').fill('  ');assert.equal(await page.locator('.send').isDisabled(),true);assert.equal(await page.locator('#chat-input').getAttribute('maxlength'),'500');pass('Local chat, typewriter response, whitespace validation, length limit and XSS protection')
  await page.locator('#private-mode').focus();await page.locator('#private-mode').press('Space');assert.equal(await page.locator('#private-mode').isChecked(),false);await page.locator('.save-note').last().click();await page.locator('.notes-toggle').click();await page.locator('.note textarea').fill('Моя відредагована теза');assert.equal(await page.locator('.note textarea').inputValue(),'Моя відредагована теза');await page.locator('.toggle').click();assert.equal(await page.locator('#private-mode').isChecked(),true);assert.equal(await page.locator('.note').count(),0);pass('Opt-in notes, editing and deletion; privacy enabled by default')
  await page.locator('.microphone').click();await page.waitForFunction(()=>window.__speech);await page.evaluate(()=>window.__speech.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Мені хочеться поговорити'}}]}));assert.match(await page.locator('#chat-input').inputValue(),/Мені хочеться поговорити/);await page.evaluate(()=>window.__speech.onerror({error:'not-allowed'}));assert.equal(await page.locator('.microphone').getAttribute('aria-pressed'),'false');assert.match(await page.locator('.toast').textContent(),/Мікрофон недоступний/);pass('Voice capture, analyser, transcription and safe permission-error recovery')
  const desktopA11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();report.a11y=desktopA11y.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}));assert.equal(report.a11y.length,0,JSON.stringify(report.a11y));pass('WCAG A/AA automated check on conversation')
  for(const [width,height] of [[390,844],[320,568],[1000,600]]){
    await page.setViewportSize({width,height});await page.waitForFunction(()=>document.querySelector('#scroll-wrapper').offsetHeight===innerHeight*5);await wait(300)
    for(const p of [0,.25,.5,.75,1]){await at(p);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Horizontal overflow ${width}/${p}`);const bounds=await page.locator('.stage.is-active .stage-content').boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1,`Panel outside viewport ${width}/${p}`);const fit=await page.locator('.stage.is-active .stage-content').evaluate(e=>({overflow:getComputedStyle(e).overflowY,scroll:e.scrollHeight,client:e.clientHeight}));assert.equal(fit.overflow,'visible');assert.ok(fit.scroll<=fit.client+1,`Panel content overflows ${width}/${height}/${p}: ${JSON.stringify(fit)}`);if(p<1)assert.ok(bounds.y>=95&&bounds.y+bounds.height<=height-71);if(p===0){const gap=await page.evaluate(()=>document.querySelector('.journey-footer').getBoundingClientRect().top-document.querySelector('.hero>.fine-print').getBoundingClientRect().bottom);assert.ok(gap>=36)}if(p===.25){assert.equal(await page.locator('.process h3').isVisible(),true);assert.equal(await page.locator('.process-step').count(),3);for(const detail of await page.locator('.process-step').all()){await detail.locator('summary').click();const fit=await page.locator('.journal-panel').evaluate(e=>({s:e.scrollHeight,c:e.clientHeight}));assert.ok(fit.s<=fit.c+1)}}if(p===1){const framing=await page.evaluate(()=>window.sanctuary.inspect().framing);for(const [key,rect]of Object.entries(framing)){assert.ok(rect[0]>=-1&&rect[2]<=width+1,`${key} cropped horizontally: ${rect}`);assert.ok(rect[1]>=79&&rect[3]<bounds.y-8,`${key} overlaps header/chat: ${rect}, panel ${bounds.y}`)}}await screenshot(`verified-${width}-${height}-${p*4}`)}
    const composer=await page.locator('.composer').boundingBox();assert.ok(composer.y>=0&&composer.y+composer.height<height-55);pass(`Safe panels, no inner scroll, hero gap and visible avatar/lotus on ${width}x${height}`)
  }
  pass('All process copy remains available through native accessible disclosure steps')
  // ux-7: every lantern the FAQ answers light stays in view, clear of the FAQ panel (desktop framing from panel rects).
  // 1000x600 depends on the FAQ panel's rect (main.ts framePanels): with the old constants lantern 0 sat under its edge.
  const lanternSizes=[]
  for(const [width,height] of [[1000,600],[1440,900]]){
    await page.setViewportSize({width,height});await page.waitForFunction(()=>document.querySelector('#scroll-wrapper').offsetHeight===innerHeight*5);await wait(300);await at(.75)
    const faq=await page.locator('.faq-panel').boundingBox(),state=await page.evaluate(()=>window.sanctuary.inspect()),screens=state.lanternScreens
    assert.ok(state.panelRects[3],`The scene holds no rect for the FAQ panel on ${width}x${height}`)
    lanternSizes.push(`${width}x${height}`)
    screens.forEach(([x,y],i)=>assert.ok(Math.max(faq.x-x,x-faq.x-faq.width,faq.y-y,y-faq.y-faq.height)>=12,`Lantern ${i} at ${Math.round(x)},${Math.round(y)} within 12 px of the FAQ panel ${JSON.stringify(faq)} on ${width}x${height}`))
  }
  pass(`All three lanterns stay clear of the FAQ panel on ${lanternSizes.join(' and ')}`)
  await page.setViewportSize({width:1440,height:1000});await page.waitForFunction(()=>document.querySelector('#scroll-wrapper').offsetHeight===innerHeight*5);await wait(350);await at(.75);const oldGeometry=(await page.evaluate(()=>window.sanctuary.inspect())).resources.geometries
  for(let i=0;i<4;i++)await page.locator('[data-lantern="0"]').click()
  await wait(200);assert.equal((await page.evaluate(()=>window.sanctuary.inspect())).resources.geometries,oldGeometry);pass('Repeated interactions do not grow GPU geometry count')
  const [lx,ly]=(await page.evaluate(()=>window.sanctuary.inspect())).lanternScreens[2];await page.mouse.click(lx,ly);await wait(800);assert.equal(await page.locator('[data-lantern="2"]').getAttribute('aria-expanded'),'true');pass('Raycaster on the actual 3D lantern opens the linked FAQ')
  await page.evaluate(()=>document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true})));assert.equal(await page.locator('.webgl-notice').isVisible(),true);await page.locator('[data-retry]').click();await page.waitForFunction(()=>document.querySelector('#webgl-container canvas')&&document.querySelector('.webgl-notice').hidden);assert.equal(await page.locator('#webgl-container canvas').count(),1);pass('WebGL context loss is recoverable with one replacement canvas')
  assert.equal(report.errors.length,0,report.errors.join('\n'));assert.equal(report.networkFailures.length,0,report.networkFailures.join('\n'))
  const fallback=await browser.newPage({viewport:{width:390,height:844}});await fallback.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).startsWith('webgl'))return null;return get.call(this,type,...args)}});await fallback.goto(base);await fallback.locator('.entry').waitFor({state:'detached'});assert.equal(await fallback.locator('.webgl-notice').isVisible(),true);await fallback.locator('.primary').click();await fallback.waitForFunction(()=>document.documentElement.dataset.stage==='4');await fallback.locator('#chat-input').fill('Тест без WebGL');await fallback.locator('.send').click();await fallback.waitForFunction(()=>document.querySelector('.message--assistant')?.textContent.includes('демовідповідь'));await fallback.close();pass('No-WebGL CSS fallback retains navigation and working chat')
  // #54: on a phone the snap follows the whole swipe. A finger relaxing a few px back as it lifts (or iOS rubber-banding)
  // used to read as an upward swipe and send the page back to the stop it had just left.
  const touch=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true}),phone=await touch.newPage()
  phone.on('pageerror',e=>report.errors.push(e.message))
  await phone.goto(base);await phone.waitForFunction(()=>document.documentElement.dataset.webgl==='ready',null,{timeout:30000});await phone.locator('.entry').waitFor({state:'detached'});await phone.waitForTimeout(800)
  const cdp=await touch.newCDPSession(phone),finger=(type,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:195,y}]})
  const swipe=async(from,to,back)=>{await finger('touchStart',from);for(let i=1;i<=12;i++){await finger('touchMove',from+(to-from)*i/12);await phone.waitForTimeout(20)}await phone.waitForTimeout(120);for(let i=1;i<=3;i++){await finger('touchMove',to+back*i/3);await phone.waitForTimeout(25)}await finger('touchEnd');await phone.waitForTimeout(2600);return phone.evaluate(()=>Math.round(window.sanctuary.progress()*4))}
  for(const stop of [1,2])assert.equal(await swipe(650,450,6),stop,`A downward swipe that relaxes 6 px at the lift lands on stop ${stop}`)
  assert.equal(await swipe(300,500,-6),1,'An upward swipe that relaxes 6 px at the lift lands on the previous stop')
  await touch.close();pass('Phone swipes snap with the gesture, not with the finger relaxing as it lifts')
}finally{
  await writeFile('.checks/verification.json',JSON.stringify(report,null,2));await browser.close()
}
console.log(JSON.stringify({passed:report.checks.length,skipped:report.skipped,errors:report.errors,readyMs:report.readyMs}))
