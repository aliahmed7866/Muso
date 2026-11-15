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
    w.AbortController = AbortController;
    let startupReads = 0;
    w.fetch = (endpoint, options) => {
      if (endpoint === '/api/library' && ++startupReads <= 3) {
        return Promise.reject(new TypeError('Server is down'));
      }
      return fetch(new URL(endpoint, url), options);
    };
    w.matchMedia = () => ({matches: false});
    w.scrollTo = () => {};
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
    w.eval(fs.readFileSync(path.join(__dirname, '../static/sound.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8') + '\nwindow.testSleep = {restoreSleep, setSleep, resumeAfterReload}; window.testNetwork = {api, searchInto}; window.testUI = {refresh, position};');
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
    await until(() => d.getElementById('status').textContent.includes('Waiting for Muso'));
    assert.equal(titles().length, 0);
    // Returning to an already-open page retries the initial library load.
    Object.defineProperty(d, 'visibilityState', {value: 'visible', configurable: true});
    d.dispatchEvent(new w.Event('visibilitychange'));
    await until(() => titles().length === 4);
    assert.equal(startupReads, 4);
    delete d.visibilityState;
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
    const playingSource = audio.src;
    audio.currentTime = 12;
    await click('Refresh');
    await until(() => !d.getElementById('refresh-library').disabled);
    assert.equal(audio.src, playingSource);
    assert.equal(audio.currentTime, 12);
    assert.equal(paused, false);
    w.performance.getEntriesByType = () => [{type: 'reload'}];
    w.dispatchEvent(new w.Event('pagehide'));
    audio.pause();
    w.testSleep.resumeAfterReload();
    assert.equal(paused, false);
    audio.pause();
    w.dispatchEvent(new w.Event('pagehide'));
    w.testSleep.resumeAfterReload();
    assert.equal(paused, true);
    await audio.play();

    assert.equal(d.querySelectorAll('.track.playing').length, 1);
    const original = saved().queue;
    d.getElementById('queue').click();
    await click('Clear queue', dialog);
    assert.deepEqual(saved().queue, []);
    await click('Undo queue change', dialog);
    assert.deepEqual(saved().queue, original);
    dialog.querySelector('[aria-label="Move Coral up"]').focus();
    dialog.scrollTop = 120;
    await click('Move Coral up', dialog);
    assert.notDeepEqual(saved().queue, original);
    assert.equal(d.activeElement.getAttribute('aria-label'), 'Move Coral down');
    assert.equal(dialog.scrollTop, 120);
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
    // Simulate a timer callback arriving before its wall-clock deadline.
    await audio.play();
    const realSetTimeout = w.setTimeout;
    let earlyCallback;
    w.setTimeout = callback => { earlyCallback = callback; return 0; };
    w.testSleep.setSleep(Date.now() + 80);
    w.setTimeout = realSetTimeout;
    earlyCallback();
    assert.equal(paused, false);
    await until(() => paused);
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
    // Read retries recover from dropped local responses; mutations are never replayed.
    const realFetch = w.fetch;
    let reads = 0, writes = 0;
    w.fetch = async (endpoint, options) => {
      if (endpoint === '/api/network-test') {
        reads++;
        if (reads < 3) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ok: true}));
      }
      if (endpoint === '/api/discovery/run') {
        writes++;
        throw new TypeError('Failed to fetch');
      }
      return realFetch(endpoint, options);
    };
    assert.equal((await w.testNetwork.api('network-test')).ok, true);
    assert.equal(reads, 3);
    await assert.rejects(w.testNetwork.api('discovery/run', 'POST'), /Reconnecting to Muso automatically.*Termux/);
    assert.equal(writes, 1);
    d.querySelector('[data-view=discover]').click();
    await click('Discover Now');
    assert.ok(d.getElementById('body').textContent.includes('Reconnecting to Muso automatically'));
    assert.equal([...d.querySelectorAll('button')].find(b => b.textContent === 'Discover Now').disabled, false);
    assert.equal(writes, 2);
    // Short polling recovers a dropped read and renders a completed background search.
    const results = d.createElement('div');
    d.body.append(results);
    let polls = 0, starts = 0, providerFailure = false;
    const answer = value => new Response(JSON.stringify(value));
    w.fetch = async (endpoint, options) => {
      if (endpoint === '/api/search/tasks') { starts++; return answer({id: 'test-search', status: 'running'}); }
      if (endpoint === '/api/search/tasks/test-search') {
        polls++;
        if (polls === 1) throw new TypeError('Failed to fetch');
        if (polls === 2) return answer({status: 'running'});
        if (providerFailure) return answer({status: 'failed', error: 'YouTube timed out. Retry.'});
        return answer({status: 'done', results: [{title: 'Found song', artist: 'Artist', duration: 180, url: 'https://www.youtube.com/watch?v=abcdefghijk'}]});
      }
      return realFetch(endpoint, options);
    };
    await w.testNetwork.searchInto('Song Artist', results);
    assert.ok(results.textContent.includes('Found song'));
    assert.equal(starts, 1);
    assert.equal(results.getAttribute('aria-busy'), 'false');
    providerFailure = true;
    await w.testNetwork.searchInto('Song Artist', results);
    assert.ok(results.textContent.includes('YouTube timed out. Retry.'));
    providerFailure = false;
    await click('Retry search', results);
    await until(() => results.textContent.includes('Found song'));
    results.remove();
    w.fetch = realFetch;
    // The same playlist navigation is reachable on a phone and a desktop.
    d.querySelector('[data-view=playlists]').click();
    assert.equal(d.querySelectorAll('.playlist-card').length, 2);
    await click('Listening session', d.getElementById('body'));
    assert.equal(d.getElementById('heading').textContent, 'Listening session');
    assert.equal(d.querySelector('[data-view=playlists]').getAttribute('aria-pressed'), 'true');
    assert.equal(titles().length, 4);
    d.querySelector('[data-view=library]').click();
    // Background refresh must retain the filter, focus and caret, and the audio.
    let filterInput = d.querySelector('input[type=search]');
    filterInput.value = 'Amber'; filterInput.dispatchEvent(new w.Event('input'));
    filterInput.focus(); filterInput.setSelectionRange(2, 4);
    const sourceBefore = audio.src;
    audio.currentTime = 23;
    await w.testUI.refresh();
    filterInput = d.querySelector('input[type=search]');
    assert.equal(d.activeElement, filterInput);
    assert.equal(filterInput.value, 'Amber');
    assert.equal(filterInput.selectionStart, 2);
    assert.equal(filterInput.selectionEnd, 4);
    assert.equal(audio.src, sourceBefore);
    assert.equal(audio.currentTime, 23);
    await click('Clear search');
    assert.equal(d.activeElement, filterInput);
    assert.equal(filterInput.value, '');
    assert.equal(titles().length, 4);
    filterInput.value = 'no-such-track'; filterInput.dispatchEvent(new w.Event('input'));
    await click('Reset filters');
    assert.equal(titles().length, 4);
    await click('Play all');
    d.getElementById('now').click();
    assert.equal(d.getElementById('dialog-title').textContent, 'Now Playing');
    assert.equal(d.getElementById('np-title').textContent, titles()[0]);
    assert.equal(d.getElementById('np-play').getAttribute('aria-label'), 'Pause');
    assert.equal(d.getElementById('np-like').getAttribute('aria-pressed'), 'false');
    await click('Like current song', dialog);
    await until(() => d.getElementById('np-like').getAttribute('aria-pressed') === 'true');
    assert.equal(paused, false);
    assert.equal(d.getElementById('dialog-title').textContent, 'Now Playing');
    const nextId = saved().queue[0];
    await click('Next', dialog);
    assert.equal(saved().current, nextId);
    assert.equal(d.getElementById('np-title').textContent, (await library()).tracks.find(t => t.id === nextId).title);
    const seek = d.getElementById('np-seek');
    seek.value = 25; seek.dispatchEvent(new w.Event('input'));
    assert.equal(audio.currentTime, 30);
    assert.equal(d.getElementById('seek').value, '25');
    assert.equal(seek.getAttribute('aria-valuetext'), '0:30 of 2:00');
    await click('Pause', dialog);
    assert.equal(paused, true);
    assert.equal(d.getElementById('play').getAttribute('aria-label'), 'Play');
    await click('Play', dialog);
    assert.equal(paused, false);
    const mode = saved().repeat;
    d.getElementById('np-repeat').click(); await wait(20);
    assert.equal(saved().repeat, (mode + 1) % 3);
    assert.equal(d.getElementById('np-repeat').getAttribute('aria-label'), d.getElementById('repeat').getAttribute('aria-label'));
    const queued = [...saved().queue].sort();
    d.getElementById('np-shuffle').click(); await wait(20);
    assert.deepEqual([...saved().queue].sort(), queued);
    assert.equal(d.getElementById('np-shuffle').getAttribute('aria-pressed'), d.getElementById('shuffle').getAttribute('aria-pressed'));
    await click('Queue', dialog);
    assert.equal(d.getElementById('dialog-title').textContent, 'Play queue');
    await click('Now playing · ' + d.getElementById('now-title').textContent, dialog);
    assert.ok(d.getElementById('np-title'));
    await click('Sleep', dialog);
    await click('After this song', dialog);
    d.getElementById('now').click();
    assert.equal(d.getElementById('np-sleep').textContent, 'Sleep · end');
    dialog.close();
    // A failed save is readable inside the modal's top layer; a retry works.
    d.querySelector('[data-view=playlists]').click();
    await click('New playlist', d.getElementById('body'));
    w.fetch = (endpoint, options) => endpoint === '/api/playlists' && options.method === 'POST'
      ? Promise.resolve(new Response(JSON.stringify({error: 'Save failed. Please retry.'}), {status: 503}))
      : realFetch(endpoint, options);
    dialog.querySelector('input').value = 'Evening';
    dialog.querySelector('form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await until(() => d.getElementById('dialog-notice'));
    assert.equal(d.getElementById('dialog-notice').textContent, 'Save failed. Please retry.');
    assert.equal(dialog.open, true);
    w.fetch = realFetch;
    dialog.querySelector('form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await until(() => d.getElementById('heading').textContent === 'Evening');
    assert.ok(d.getElementById('body').textContent.includes('Add saved songs'));
    // Manual/library refresh must not discard an in-progress Discover search.
    d.querySelector('[data-view=discover]').click();
    const discoverInput = d.querySelector('#body form input');
    discoverInput.value = 'An artist';
    await w.testUI.refresh();
    assert.equal(d.querySelector('#body form input'), discoverInput);
    assert.equal(discoverInput.value, 'An artist');
    console.log('PASS: listening, recovery, playlists, filter focus/caret, Now Playing transport/seek/like/repeat/shuffle/sleep, in-dialog errors, and Discover preservation');
  } finally {
    dom?.window.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

