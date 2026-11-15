// Run: MUSO_TEST_PYTHON=.venv/bin/python node tests/listening.cjs
// Requires Playwright and its Chromium browser in the development environment.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
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
    const capture = async name => {
      if (!process.env.MUSO_TEST_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.MUSO_TEST_SCREENSHOT_DIR, {recursive: true});
      await page.screenshot({path: path.join(process.env.MUSO_TEST_SCREENSHOT_DIR, name + '.png'), fullPage: !await page.locator('#dialog').evaluate(d => d.open)});
    };
    await page.goto(url);
    await page.waitForSelector('.track');
    assert.equal((await titles()).length, 4);
    await capture('library-phone');
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
    await page.locator('#dialog').waitFor({state: 'hidden'});
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
    await page.locator('#dialog').waitFor({state: 'hidden'});
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
    await page.locator('#now').click();
    assert.equal(await page.locator('#dialog').evaluate(d => d.contains(document.activeElement)), true);
    await capture('now-playing-phone');
    while (await page.locator('#np-repeat').getAttribute('aria-label') !== 'Repeat song') await page.locator('#np-repeat').click();
    await page.locator('#np-sleep').click();
    await button('After this song').click();
    const beforeEnd = await saved();
    await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')));
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
    assert.deepEqual((await saved()).queue, beforeEnd.queue);
    assert.equal((await saved()).current, beforeEnd.current);
    assert.equal(await page.locator('#sleep').textContent(), 'Sleep');
    // A deadline survives reopening the app and still pauses playback.
    await page.locator('#now').click();
    await page.locator('#np-sleep').click();
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
    await page.locator('[data-view="playlists"]').click();
    await capture('playlists-phone');
    await button('Sample playlist', page.locator('#body')).click();
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
    await page.locator('#now').click();
    assert.equal(await page.locator('#dialog-title').textContent(), 'Now Playing');
    const upcoming = (await saved()).queue[0];
    await page.locator('#np-next').click();
    assert.equal((await saved()).current, upcoming);
    assert.equal(await page.locator('#np-title').textContent(), (await library()).tracks.find(t => t.id === upcoming).title);
    await page.locator('#np-play').click();
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
    await page.locator('#np-play').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused);
    await close();
    await page.getByRole('searchbox').fill('Amber');
    await page.getByRole('searchbox').evaluate(input => { input.focus(); input.setSelectionRange(2,4); });
    await page.evaluate(() => refresh());
    assert.deepEqual(await page.getByRole('searchbox').evaluate(input => [input === document.activeElement, input.value, input.selectionStart, input.selectionEnd]), [true, 'Amber', 2, 4]);
    await button('Clear search').click();
    for (const width of [320,390,720,1280]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
      await page.locator('#now').click();
      assert.equal(await page.locator('#dialog').evaluate(d => d.scrollWidth <= d.clientWidth), true);
      assert.equal(await page.locator('#np-play').isVisible(), true);
      await close();
      await capture(`library-${width}`);
    }
    // Real music titles and playlist names can be much longer than fixture names.
    await page.evaluate(async () => {
      await api('tracks/' + current, 'PATCH', {title: 'LongTitle'.repeat(30), artist: 'An artist with a very long name '.repeat(5)});
      await refresh();
    });
    await page.setViewportSize({width:320,height:640});
    await page.locator('#now').click();
    assert.equal(await page.locator('#dialog').evaluate(d => d.scrollWidth <= d.clientWidth), true, 'Long title overflows Now Playing');
    await close();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Long title overflows library');
    assert.deepEqual(errors, []);
    console.log('PASS: listening, Now Playing, playlist navigation, preserved search focus, and 320–1280px layout');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

