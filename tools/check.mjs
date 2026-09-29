// Проверка вёрстки и жестов на телефонах, планшетах и десктопе.
// Запускает headless Chrome, эмулирует устройства и шлёт настоящие touch-события через DevTools Protocol.
//
//   python3 -m http.server 8791 --bind 127.0.0.1        # в корне репозитория
//   node tools/check.mjs                                 # все сценарии
//   ONLY=iphone,desk node tools/check.mjs                # выборочно
//   BASE=https://dezdoss.github.io/astana-arena/index.html node tools/check.mjs   # живой сайт
//
// Скриншоты и отчёт в JSON складываются в каталог OUT (по умолчанию временный).
// Нужны Node 22+ и Google Chrome; путь к Chrome можно задать через CHROME.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333, BASE = process.env.BASE || 'http://127.0.0.1:8791/index.html';
const OUT = process.env.OUT || mkdtempSync(path.join(tmpdir(), 'arena-check-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const dir = mkdtempSync(path.join(OUT, 'chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--mute-audio', '--hide-scrollbars', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) { await sleep(250); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch {} }
if (!wsUrl) { chrome.kill(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); const logs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type.toUpperCase() + ' ' + m.params.args.map(a => a.value ?? a.description).join(' ')); };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
const touch = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i + 1, radiusX: 8, radiusY: 8, force: 1 })) });
const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await sleep(60); await touch('touchEnd', []); };
const swipe = async (x0, y0, x1, y1, steps = 10) => { await touch('touchStart', [[x0, y0]]); for (let i = 1; i <= steps; i++) { await sleep(16); await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); } await sleep(30); await touch('touchEnd', []); };
const pinch = async (cx, cy, d0, d1, steps = 12) => { await touch('touchStart', [[cx - d0, cy], [cx + d0, cy]]); for (let i = 1; i <= steps; i++) { const d = d0 + (d1 - d0) * i / steps; await sleep(16); await touch('touchMove', [[cx - d, cy], [cx + d, cy]]); } await sleep(30); await touch('touchEnd', []); };
const center = sel => ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
const fps = ms => ev(`new Promise(res=>{let n=0;const t0=performance.now();(function f(){n++;performance.now()-t0<${ms}?requestAnimationFrame(f):res(+(n/((performance.now()-t0)/1000)).toFixed(1))})()})`);
const device = async (d) => { await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: !!d.mobile, screenWidth: d.w, screenHeight: d.h });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!d.mobile, maxTouchPoints: 5 }); await send('Emulation.setUserAgentOverride', { userAgent: d.ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }); };
const open = async (q = '') => { await send('Page.navigate', { url: BASE + '?debug=1' + q }); for (let i = 0; i < 80; i++) { await sleep(250); try { if (await ev(`!!window.__arena && document.getElementById('loader').classList.contains('hide')`)) break; } catch {} } await sleep(900); };
const layout = () => ev(`(()=>{const st=document.getElementById('stage'),r=st.getBoundingClientRect(),gl=document.getElementById('gl');const vis=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return getComputedStyle(e).display!=='none'&&b.width>0?[Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]:null};
  const over=[...document.querySelectorAll('.ov-row,.modebar,.compass,.card,.hints span,.sheet-head,.top .brand,.top .ghost')].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0&&getComputedStyle(e).opacity!=='0').map(e=>{const b=e.getBoundingClientRect();return {c:e.className||e.id,l:b.left,r:b.right,t:b.top,b:b.bottom}});
  const out=over.filter(o=>o.l<-0.5||o.r>innerWidth+0.5).map(o=>o.c+' ['+Math.round(o.l)+'..'+Math.round(o.r)+']');
  return {vp:innerWidth+'x'+innerHeight,touch:document.documentElement.classList.contains('is-touch'),lite:__arena.lite,stage:Math.round(r.width)+'x'+Math.round(r.height),cls:st.className.replace('stage ',''),canvas:gl.width+'x'+gl.height,px:+__arena.pxRatio.toFixed(2),view:{scale:+__arena.view.scale.toFixed(2),fov:+__arena.view.fov.toFixed(1),seatFov:+__arena.view.seatFov.toFixed(1)},rail:getComputedStyle(document.getElementById('rail')).position,tris:__arena.tris,calls:__arena.calls,nearSectors:__arena.lod,scrollW:document.documentElement.scrollWidth,offscreen:out,rows:[...document.querySelectorAll('.ov-row')].filter(e=>!e.hidden).map(e=>{const b=e.getBoundingClientRect();return Math.round(b.left)+'..'+Math.round(b.right)+'@'+Math.round(b.top)}),modebar:vis('.modebar'),compass:vis('.compass')}})()`);

await send('Page.enable'); await send('Runtime.enable');
const report = {};
const D = { iphone: { w: 390, h: 844, dpr: 3, mobile: true, ua: UA_IPHONE }, android: { w: 360, h: 740, dpr: 3, mobile: true, ua: UA_ANDROID }, se: { w: 320, h: 568, dpr: 2, mobile: true, ua: UA_IPHONE },
  iphoneL: { w: 844, h: 390, dpr: 3, mobile: true, ua: UA_IPHONE }, ipad: { w: 820, h: 1180, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  desk: { w: 1440, h: 900, dpr: 2 }, deskS: { w: 1024, h: 700, dpr: 2 }, deskXS: { w: 800, h: 600, dpr: 2 } };
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const want = k => !only.length || only.includes(k);
try {
  if (want('iphone')) {
    await device(D.iphone); await open();
    const r = report.iphone = { layout: await layout(), fpsIdle: await fps(1500) }; await shot('iphone-1-overview');
    // one-finger orbit, pinch zoom
    const c = await center('#gl'); const az0 = await ev('__arena.orb.goal.az'), r0 = await ev('__arena.orb.goal.r');
    await swipe(c[0] - 80, c[1], c[0] + 80, c[1]); await sleep(300); r.orbitDelta = +(await ev('__arena.orb.goal.az') - az0).toFixed(3);
    await pinch(c[0], c[1], 40, 120); await sleep(300); r.pinchZoom = [Math.round(r0), Math.round(await ev('__arena.orb.goal.r'))]; r.selectedAfterPinch = await ev('__arena.state.mode');
    r.hintsOpacity = await ev(`getComputedStyle(document.querySelector('.hints')).opacity`);
    // sheet: tap summary, steppers, drag down
    let p = await center('#sheetToggle'); await tap(p[0], p[1]); await sleep(600); r.sheetOpen = await ev('__arena.sheet.open'); await shot('iphone-2-sheet');
    p = await center('.step[data-for=inRow][data-step="1"]'); await tap(p[0], p[1]); await tap(p[0], p[1]); await tap(p[0], p[1]); await sleep(100);
    p = await center('.step[data-for=inSeat][data-step="-1"]'); await tap(p[0], p[1]); await sleep(100); r.afterSteppers = await ev(`document.getElementById('pkSeat').textContent`);
    p = await center('.grab'); await swipe(p[0], p[1] + 10, p[0], p[1] + 220, 12); await sleep(600); r.sheetAfterDragDown = await ev('__arena.sheet.open');
    await swipe(p[0], 844 - 40, p[0], 844 - 300, 12); await sleep(600); r.sheetAfterDragUp = await ev('__arena.sheet.open');
    await tap(c[0], 200); await sleep(500); r.sheetAfterCanvasTap = await ev('__arena.sheet.open'); r.modeAfterCanvasTap = await ev('__arena.state.mode');
    // go to the seat
    p = await center('#btnPeek'); await tap(p[0], p[1]); await sleep(2200); r.seat = await ev(`({mode:__arena.state.mode,tris:__arena.tris,calls:__arena.calls,nearSectors:__arena.lod,label:document.getElementById('pkLabel').textContent,fov:+__arena.sv.fov.toFixed(1),modebar:getComputedStyle(document.querySelector('.modebar')).display,card:getComputedStyle(document.querySelector('.card')).display})`); await shot('iphone-3-seat');
    const yaw0 = await ev('__arena.sv.yaw'); await swipe(c[0] + 60, c[1], c[0] - 60, c[1]); await sleep(300); r.lookDelta = +(await ev('__arena.sv.yaw') - yaw0).toFixed(3);
    await pinch(c[0], c[1], 40, 110); await sleep(300); r.seatFovAfterPinch = +(await ev('__arena.sv.fov')).toFixed(1);
    p = await center('#btnPeek'); await tap(p[0], p[1]); await sleep(2000); r.backMode = await ev('__arena.state.mode');
    // match + night
    p = await center('#evMatch'); await tap(p[0], p[1]); await sleep(500); p = await center('#btnNight'); await tap(p[0], p[1]); await sleep(2500);
    r.match = { fans: await ev('__arena.fans'), tris: await ev('__arena.tris'), calls: await ev('__arena.calls'), fps: await fps(1500), layout: (await layout()).rows }; await shot('iphone-4-match-night');
    p = await center('#evConcert'); await tap(p[0], p[1]); await sleep(800); p = await center('#evNone'); await tap(p[0], p[1]); await sleep(500);
    r.floorFansHiddenAfterConcert = await ev(`__arena.atmo.event`) === 'none';
    // tap a seat from a closer view
    await ev(`document.getElementById('btnDay').click(); __arena.orb.goal.r=90; __arena.orb.goal.target.set(60,8,0); __arena.orb.goal.az=-Math.PI/2; __arena.orb.goal.pol=1.15;`); await sleep(1800);
    const before = await ev('__arena.state.selected'); await tap(c[0], c[1] + 40); await sleep(2200); r.tapSeat = { before, after: await ev('__arena.state.selected'), mode: await ev('__arena.state.mode'), peek: await ev(`document.getElementById('pkSeat').textContent`) }; await shot('iphone-5-tap-seat');
  }
  if (want('preview')) {
    await device({ w: 1200, h: 630, dpr: 2 }); await open(); await ev(`document.getElementById('evMatch').click()`); await sleep(1500); await shot('preview');
    await device(D.iphone); await open(); await shot('p-1'); await ev(`document.getElementById('sheetToggle').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`); await sleep(700); await shot('p-2');
    await ev(`__arena.sheet.open&&document.getElementById('sheetToggle').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'})); document.getElementById('evMatch').click(); document.getElementById('btnPeek').click()`); await sleep(3000); await shot('p-3');
    report.preview = await layout();
  }
  if (want('extras')) {
    await device(D.iphone); await open(); const r = report.extras = {};
    await ev(`document.querySelector('[data-view="top"]').click()`); await sleep(1800); await shot('x-1-top'); r.top = (await layout()).tris;
    await ev(`document.querySelector('[data-view="city"]').click()`); await sleep(1800); await shot('x-2-city');
    await ev(`document.querySelector('[data-view="exterior"]').click()`); await sleep(1800); await shot('x-3-exterior');
    await ev(`document.getElementById('btnAbout').click()`); await sleep(700); await shot('x-4-about'); r.about = await ev(`(()=>{const b=document.getElementById('about').getBoundingClientRect();return [Math.round(b.left),Math.round(b.right),Math.round(b.width)]})()`);
    await ev(`document.getElementById('btnAboutClose').click()`); await sleep(400);
    await ev(`document.getElementById('evConcert').click(); document.getElementById('btnNight').click(); document.getElementById('btnPeek').click()`); await sleep(3200); await shot('x-5-concert-seat'); r.concert = await ev(`({mode:__arena.state.mode,tris:__arena.tris,lod:__arena.lod,city:__arena.cityOn})`);
    await ev(`document.getElementById('btnPeek').click(); document.getElementById('evNone').click(); document.getElementById('btnDay').click(); document.getElementById('btnWinter').click(); document.querySelector('[data-view="stadium"]').click()`); await sleep(3500); await shot('x-6-winter'); r.winter = await ev(`({mode:__arena.state.mode,city:__arena.cityOn,roof:document.getElementById('roofLabel').textContent})`);
    // rotate the phone while sitting in the seat
    await ev(`document.getElementById('btnWinter').click(); document.getElementById('btnPeek').click()`); await sleep(2500); const f0 = await ev('__arena.sv.fov');
    await device(D.iphoneL); await sleep(1200); r.rotate = { fovPortrait: +f0.toFixed(1), fovLandscape: +(await ev('__arena.sv.fov')).toFixed(1), layout: (await layout()).cls, rail: (await layout()).rail }; await shot('x-7-rotated-seat');
  }
  for (const k of ['android', 'se', 'iphoneL', 'ipad', 'desk', 'deskS', 'deskXS']) { if (!want(k)) continue; await device(D[k]); await open(); const r = report[k] = { layout: await layout(), fps: await fps(1200) }; await shot(k + '-1-overview');
    await ev(`document.getElementById('evMatch').click()`); await sleep(700); r.rowsMatch = (await layout()).rows; r.off2 = (await layout()).offscreen;
    await ev(`document.getElementById('btnPeek').offsetParent?document.getElementById('btnPeek').click():document.getElementById('btnGo').click()`); await sleep(2300); r.seat = await ev(`({mode:__arena.state.mode,tris:__arena.tris,calls:__arena.calls,nearSectors:__arena.lod,fov:+__arena.sv.fov.toFixed(1),card:getComputedStyle(document.querySelector('.card')).display,modebar:getComputedStyle(document.querySelector('.modebar')).display})`); await shot(k + '-2-seat'); }
} finally { report.out = OUT; report.logs = logs.filter(l => !/ERR_NAME_NOT_RESOLVED|gstatic/.test(l)); console.log(JSON.stringify(report, null, 1)); ws.close(); chrome.kill(); }
