// Run with jsdom installed: MUSO_TEST_PYTHON=.venv/bin/python node tests/listening-dom.cjs
// Exercises real Flask endpoints; media playback and dialog APIs are simulated.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await wait(20); }
  throw new Error('Timed out waiting for UI update');
}
(async () => {
  const server = spawn(process.env.MUSO_TEST_PYTHON || 'python3', [path.join(__dirname, 'serve_listening_fixture.py')]);
  let dom, logs = '';
  server.stderr.on('data', chunk => { logs += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(logs || 'No fixture URL')), 10000);
      server.on('error', reject);
      server.on('exit', code => { clearTimeout(timeout); reject(new Error('Fixture exited ' + code + ': ' + logs)); });
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
    const html = await (await fetch(url)).text();
    dom = new JSDOM(html, {url, runScripts: 'outside-only'});
    const w = dom.window, d = w.document;
    w.fetch = (endpoint, options) => fetch(new URL(endpoint, url), options);
    w.matchMedia = () => ({matches: false});
    w.confirm = () => true;
    const dialog = d.getElementById('dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    const audio = d.getElementById('audio');
    let paused = true;
    Object.defineProperty(audio, 'paused', {get: () => paused});
    Object.defineProperty(audio, 'duration', {get: () => 120});
    audio.play = async () => { paused = false; audio.dispatchEvent(new w.Event('play')); };
    audio.pause = () => { paused = true; audio.dispatchEvent(new w.Event('pause')); };
    audio.load = () => {};
    w.eval(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8') + '\nwindow.testSleep = {restoreSleep, setSleep};');
    const saved = () => JSON.parse(w.localStorage.getItem('muso.playback.v1'));
    const library = async () => (await fetch(url + '/api/library')).json();
    const click = async (name, root = d) => {
      const button = [...root.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent) === name);
      assert.ok(button, 'Missing button: ' + name);
      assert.equal(button.disabled, false, 'Disabled button: ' + name);
      button.click();
      await wait(20);
    };
    const select = title => {
      const input = d.querySelector(`[aria-label="Select ${title}"]`);
      assert.ok(input);
      input.checked = true;
      input.dispatchEvent(new w.Event('change'));
    };
    const titles = () => [...d.querySelectorAll('.track .song strong')].map(el => el.textContent);
    await until(() => titles().length === 4);
    for (const [mix, expected] of [
      ['Your favourites', ['Amber', 'Coral']], ['First listen', ['Blue', 'Dawn']],
      ['Rediscover', ['Amber']], ['Fresh arrivals', ['Blue', 'Dawn']]
    ]) {
      await click(mix);
      assert.deepEqual(titles(), expected);
    }
    await click('All songs');
    await click('Select songs');
    select('Amber'); select('Blue');
    const search = d.querySelector('input[type=search]');
    search.value = 'Coral'; search.dispatchEvent(new w.Event('input'));
    await click('Select matching');
    assert.equal(d.querySelector('.selection-bar strong').textContent, '3 selected');
    await click('Add to playlist');
    await click('Sample playlist', dialog);
    await until(async () => (await library()).playlists[0].tracks.length === 3);
    assert.deepEqual((await library()).playlists[0].tracks, ['0', '1', '2']);
    await until(() => !dialog.open);
    await click('Queue selected');
    assert.deepEqual(saved().queue, ['0', '1', '2']);
    await click('Queue selected');
    assert.deepEqual(saved().queue, ['0', '1', '2']);
    await click('Done selecting');
    d.querySelector('input[type=search]').value = '';
    d.querySelector('input[type=search]').dispatchEvent(new w.Event('input'));
    await click('Play all');
    assert.equal(paused, false);
    assert.equal(d.querySelectorAll('.track.playing').length, 1);
    const original = saved().queue;
    d.getElementById('queue').click();
    await click('Clear queue', dialog);
    assert.deepEqual(saved().queue, []);
    await click('Undo queue change', dialog);
    assert.deepEqual(saved().queue, original);
    await click('Move Coral up', dialog);
    assert.notDeepEqual(saved().queue, original);
    await click('Undo queue change', dialog);
    assert.deepEqual(saved().queue, original);
    await click('Save as playlist', dialog);
    dialog.querySelector('input').value = 'Listening session';
    dialog.querySelector('form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await until(async () => (await library()).playlists.length === 2);
    assert.equal((await library()).playlists[1].tracks.length, 4);
    await until(() => !dialog.open);
    await click('Options for Dawn');
    await click('Play next', dialog);
    assert.equal(saved().queue[0], '3');
    assert.equal(new Set(saved().queue).size, 3);
    d.getElementById('queue').click();
    await click('Remove Coral', dialog);
    dialog.close();
    d.getElementById('next').click();
    d.getElementById('queue').click();
    assert.equal(dialog.textContent.includes('Undo queue change'), false);
    dialog.close();
    d.getElementById('repeat').click();
    await click('Loop current song', dialog);
    d.getElementById('sleep').click();
    await click('After this song', dialog);
    const beforeEnd = saved();
    audio.dispatchEvent(new w.Event('ended'));
    assert.equal(paused, true);
    assert.deepEqual(saved().queue, beforeEnd.queue);
    assert.equal(saved().current, beforeEnd.current);
    assert.equal(d.getElementById('sleep').textContent, 'Sleep');
    d.getElementById('sleep').click();
    await click('15 min', dialog);
    const deadline = JSON.parse(w.localStorage.getItem('muso.sleep.v1')).until;
    w.testSleep.restoreSleep();
    assert.equal(JSON.parse(w.localStorage.getItem('muso.sleep.v1')).until, deadline);
    await audio.play();
    w.testSleep.setSleep(Date.now() + 50);
    await until(() => paused);
    assert.equal(d.getElementById('sleep').textContent, 'Sleep');
    // Reopening with an expired timer must not schedule another full interval.
    w.localStorage.setItem('muso.sleep.v1', JSON.stringify({until: Date.now() - 1, afterSong: false}));
    w.testSleep.restoreSleep();
    assert.equal(d.getElementById('sleep').textContent, 'Sleep');
    await click('Sample playlist', d.getElementById('playlists'));
    await click('Select songs'); await click('Select matching');
    await click('Remove from playlist');
    await until(async () => (await library()).playlists[0].tracks.length === 0);
    assert.equal((await library()).tracks.length, 4);
    await until(() => titles().length === 0);
    d.querySelector('[data-view=library]').click();
    await click('Shuffle play');
    assert.equal(new Set([saved().current, ...saved().queue]).size, 4);
    assert.equal(saved().queue.length, 3);
    // A stale playlist edit must fail without overwriting another edit.
    const response = await fetch(url + '/api/playlists/sample', {
      method: 'PATCH', headers: {'Content-Type': 'application/json', 'X-Muso-Token': d.querySelector('meta[name=muso-token]').content},
      body: JSON.stringify({tracks: ['3'], expected_tracks: ['0']})
    });
    assert.equal(response.status, 409);
    assert.deepEqual((await library()).playlists[0].tracks, []);
    console.log('PASS: 4 mixes, selection across filters, bulk playlists, duplicate-free queue, play-next promotion, queue undo/save, sleep/loop precedence, restored/expired deadlines, shuffle and edit conflicts');
  } finally {
    dom?.window.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
