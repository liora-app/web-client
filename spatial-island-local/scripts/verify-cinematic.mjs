import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const browser=await chromium.launch({channel:'chromium',args:process.platform==='win32'?['--use-angle=d3d11']:[]})
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1.25,reducedMotion:'no-preference'})
const report={hardware:'',viewport:'1440x900 @1.25 DPR',stations:[],route:null,errors:[]}
page.on('pageerror',error=>report.errors.push(error.message))
page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text())})
try {
  await page.goto(process.env.CHECK_URL??'http://127.0.0.1:8083/')
  await page.waitForFunction(()=>document.documentElement.dataset.avatar==='ready',null,{timeout:60000})
  await page.locator('.entry').waitFor({state:'detached'})
  report.hardware=await page.evaluate(()=>{const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');if(!gl)return 'WebGL unavailable';const extension=gl.getExtension('WEBGL_debug_renderer_info');return extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})
  for(const progress of [0,.25,.5,.75,1]) {
    await page.evaluate(value=>window.sanctuary.setProgress(value),progress)
    await page.waitForTimeout(3500)
    const data=await page.evaluate(()=>window.sanctuary.inspect().cinematic)
    report.stations.push({progress,...data})
    console.log(`Progress ${progress}: median ${data.fps.toFixed(1)} FPS; p95 ${data.frameP95.toFixed(1)} ms`)
    assert.ok(data.fps>=60,`Median FPS below 60 at ${progress}: ${data.fps}`)
  }
  report.route=await page.evaluate(async()=>{
    const clearances=[]
    for(let index=0;index<=100;index++){
      window.sanctuary.setProgress(index/100)
      await new Promise(requestAnimationFrame)
      if(index%5===0)clearances.push(window.sanctuary.inspect().cinematic.cameraClearance)
    }
    return {minimumClearance:Math.min(...clearances),samples:clearances}
  })
  assert.ok(report.route.minimumClearance>.1,'Camera enters an artifact safety volume')
  assert.deepEqual(report.errors,[])
  console.log(`PASS Camera route: ${report.route.minimumClearance.toFixed(3)} minimum clearance`)
} finally {
  await writeFile('.checks/cinematic-performance.json',JSON.stringify(report,null,2))
  await browser.close()
}
