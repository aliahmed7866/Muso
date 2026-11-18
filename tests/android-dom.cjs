const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await wait(20); }
  throw new Error('Timed out waiting for native UI');
}
(async () => {
  const server = spawn(process.env.MUSO_TEST_PYTHON || 'python3', [path.join(__dirname, 'serve_listening_fixture.py')]);
  let dom, logs = '';
  server.stderr.on('data', chunk => logs += chunk);
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      server.on('error', reject);
      server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    });
    const html = await (await fetch(url)).text();
    dom = new JSDOM(html, {url: 'https://muso.android.localhost/', runScripts:'outside-only', pretendToBeVisual:true});
    const w = dom.window, d = w.document;
    w.matchMedia = () => ({matches:false}); w.scrollTo = () => {}; w.confirm = () => true;
    d.getElementById('dialog').showModal = function(){this.open=true;};
    d.getElementById('dialog').close = function(){this.open=false;};
    const token = d.querySelector('meta[name=muso-token]').content;
    const calls = [];
    const state = {ids:[], index:0, current:'', position:0, duration:120, playing:false, repeat:0, shuffle:false, sound:{}, sleepUntil:0, sleepAfterSong:false};
    w.HTMLMediaElement.prototype.play = () => { throw new Error('Android must not play browser audio'); };
    w.MusoBridge = {postMessage(raw) {
      const request = JSON.parse(raw), {id,action,args} = request;
      setTimeout(async () => {
        try {
          let result;
          if (action === 'api') {
            const response = await fetch(url + '/api/' + args.path, {method:args.method, headers:{'X-Muso-Token':token,'Content-Type':'application/json'}, body:args.body ? JSON.stringify(args.body):undefined});
            result = {status:response.status, data:await response.json()};
          } else {
            calls.push(args);
            if (args.op === 'load' || args.op === 'queue' && state.current === args.current) {
              state.ids = args.ids; state.index = args.index || 0; state.current = state.ids[state.index] || '';
              state.repeat = args.repeat; state.shuffle = args.shuffle;
              if (args.op === 'load') {state.playing=true; state.position=0;}
            }
            if (args.op === 'pause') state.playing=false;
            if (args.op === 'play') state.playing=true;
            if (args.op === 'seek') state.position=args.seconds;
            if (args.op === 'sleep') {state.sleepUntil=args.until;state.sleepAfterSong=args.afterSong;}
            if (args.op === 'sound') state.sound=args.settings;
            result=state;
          }
          w.MusoAndroid.resolve(id, JSON.parse(JSON.stringify(result)), null);
        } catch (e) {w.MusoAndroid.resolve(id,null,e.message);}
      },1);
    }};
    for (const file of ['android.js','sound.js','app.js']) w.eval(fs.readFileSync(path.join(__dirname,'../static',file),'utf8') + (file === 'app.js' ? '\nwindow.testQueue = addToQueue;' : '')); 
    await until(() => d.querySelectorAll('.track').length === 4);
    assert.equal(d.getElementById('install').hidden,true);
    const click = async text => { const el=[...d.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent)===text);assert.ok(el,text);el.click();await wait(30);};
    w.testQueue(['0','1']);
    await until(() => state.ids.length === 2);
    assert.equal(state.playing,false,'Queuing does not autoplay');
    await click('Play all');
    await until(() => state.playing);
    assert.equal(state.ids.length-state.index,4);
    const initialIndex=state.index;
    const playing=state.current;
    d.getElementById('play').click();await until(()=>!state.playing);
    d.getElementById('play').click();await until(()=>state.playing);
    await click('Refresh');assert.equal(state.current,playing);assert.equal(state.playing,true);
    await click('Open Now Playing');
    assert.equal(d.getElementById('np-title').textContent,d.getElementById('now-title').textContent);
    d.getElementById('np-next').click();await until(()=>state.current!==playing);
    assert.equal(calls.filter(x=>x.op==='load').at(-1).index,initialIndex+1);
    // A transition made by the Android service is reflected without reloading the library.
    state.index=initialIndex+2;state.current=state.ids[state.index];state.position=19;
    await w.MusoAndroid.poll();
    assert.equal(d.getElementById('now-title').textContent,['Amber','Blue','Coral','Dawn'][Number(state.current)]);
    assert.equal(d.getElementById('elapsed').textContent,'0:19');
    console.log('PASS: native bridge, full library, controls, queue, background state reconciliation, no web audio, refresh preservation');
  } catch (error) {console.error(logs);throw error;}
  finally {dom?.window.close();server.kill('SIGTERM');}
})().catch(error=>{console.error(error);process.exitCode=1;});
