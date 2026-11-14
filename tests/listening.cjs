// Run: MUSO_TEST_PYTHON=.venv/bin/python node tests/listening.cjs
// Requires Playwright and its Chromium browser in the development environment.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {chromium} = require('playwright');

(async () => {
  const server = spawn(process.env.MUSO_TEST_PYTHON || 'python3', [path.join(__dirname, 'serve_listening_fixture.py')]);
  let browser;
  let logs = '';
  server.stderr.on('data', chunk => { logs += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Fixture did not start: ' + logs)), 15000);
      server.once('error', reject);
      server.once('exit', code => { clearTimeout(timeout); reject(new Error('Fixture exited ' + code + ': ' + logs)); });
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
    browser = await chromium.launch({headless: true, executablePath: process.env.MUSO_TEST_CHROMIUM || undefined, args: ['--no-sandbox']});
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const button = (name, scope = page) => scope.getByRole('button', {name, exact: true});
    const close = () => button('Close').click();
    const titles = () => page.locator('.track .song strong').allTextContents();
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('muso.playback.v1')));
    const library = () => page.evaluate(() => fetch('/api/library').then(r => r.json()));
    await page.goto(url);
    await page.waitForSelector('.track');
    assert.equal((await titles()).length, 4);
    for (const [mix, expected] of [
      ['Your favourites', ['Amber', 'Coral']], ['First listen', ['Blue', 'Dawn']],
      ['Rediscover', ['Amber']], ['Fresh arrivals', ['Blue', 'Dawn']]
    ]) {
      await button(mix).click();
      assert.deepEqual(await titles(), expected);
    }
    await button('All songs').click();
    await button('Select songs').click();
    await page.getByRole('checkbox', {name: 'Select Amber', exact: true}).check();
    await page.getByRole('checkbox', {name: 'Select Blue', exact: true}).check();
    await page.getByRole('searchbox').fill('Coral');
    await button('Select matching').click();
    assert.equal(await page.locator('.selection-bar strong').textContent(), '3 selected');
    await button('Add to playlist').click();
    await button('Sample playlist', page.locator('#dialog')).click();
    assert.deepEqual((await library()).playlists[0].tracks, ['0', '1', '2']);
    await button('Queue selected').click();
    assert.deepEqual((await saved()).queue, ['0', '1', '2']);
    await button('Queue selected').click();
    assert.deepEqual((await saved()).queue, ['0', '1', '2']);
    await button('Done selecting').click();
    await page.getByRole('searchbox').fill('');
    await button('Play all').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused);
    assert.equal(await page.locator('.track.playing').count(), 1);
    const original = (await saved()).queue;
    await page.locator('#queue').click();
    await button('Clear queue').click();
    assert.equal((await saved()).queue.length, 0);
    await button('Undo queue change').click();
    assert.deepEqual((await saved()).queue, original);
    await button('Move Coral up').click();
    assert.notDeepEqual((await saved()).queue, original);
    await button('Undo queue change').click();
    assert.deepEqual((await saved()).queue, original);
    await button('Save as playlist').click();
    await page.getByRole('textbox', {name: 'New playlist name', exact: true}).fill('Listening session');
    await button('Create & add').click();
    assert.equal((await library()).playlists.find(p => p.name === 'Listening session').tracks.length, 4);
    // Play next promotes an already queued song instead of adding a duplicate.
    await button('Options for Dawn').click();
    await button('Play next', page.locator('#dialog')).click();
    assert.equal((await saved()).queue[0], '3');
    assert.equal(new Set((await saved()).queue).size, 3);
    // An undo snapshot must not bring back a queue from a previous song.
    await page.locator('#queue').click();
    await button('Remove Coral').click();
    await close();
    await page.locator('#next').click();
    await page.locator('#queue').click();
    assert.equal(await button('Undo queue change').count(), 0);
    await close();
    // Sleep-after-song takes precedence over looping and keeps upcoming music.
    await page.locator('#repeat').click();
    await button('Loop current song', page.locator('#dialog')).click();
    await page.locator('#sleep').click();
    await button('After this song').click();
    const beforeEnd = await saved();
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')));
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
    assert.deepEqual((await saved()).queue, beforeEnd.queue);
    assert.equal((await saved()).current, beforeEnd.current);
    assert.equal(await page.locator('#sleep').textContent(), 'Sleep');
    // A deadline survives reopening the app and still pauses playback.
    await page.locator('#sleep').click();
    await button('15 min').click();
    const deadline = await page.evaluate(() => JSON.parse(localStorage.getItem('muso.sleep.v1')).until);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('sleep').textContent.includes('15m'));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('muso.sleep.v1')).until), deadline);
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused);
    await page.evaluate(() => setSleep(Date.now() + 100));
    await page.waitForFunction(() => document.getElementById('audio').paused);
    assert.equal(await page.locator('#sleep').textContent(), 'Sleep');
    // Bulk removal only changes membership, not the audio library.
    await button('Sample playlist', page.locator('#playlists')).click();
    await button('Select songs').click();
    await button('Select matching').click();
    await button('Remove from playlist').click();
    await page.waitForFunction(() => document.querySelectorAll('.track').length === 0);
    const afterRemoval = await library();
    assert.equal(afterRemoval.tracks.length, 4);
    assert.deepEqual(afterRemoval.playlists[0].tracks, []);
    await page.locator('[data-view="library"]').click();
    await page.waitForSelector('.track');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.MUSO_TEST_SCREENSHOT) await page.screenshot({path: process.env.MUSO_TEST_SCREENSHOT, fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Every song remains in a shuffle-play session exactly once.
    await button('Shuffle play').click();
    const shuffled = await saved();
    assert.equal(new Set([shuffled.current, ...shuffled.queue]).size, 4);
    assert.equal(shuffled.queue.length, 3);
    assert.deepEqual(errors, []);
    console.log('PASS: mixes, selection, playlist deduplication/removal, queue undo/save/promotion, sleep precedence/persistence, shuffle, mobile and desktop layout');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
