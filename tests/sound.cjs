// Real Chromium + generated tones. No saved user audio or external music sources.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {chromium} = require('playwright');

(async () => {
  const server = spawn(process.env.MUSO_TEST_PYTHON || 'python3', [path.join(__dirname, 'serve_listening_fixture.py')], {env: {...process.env, MUSO_TEST_TONE: '1'}});
  let browser, page, logs = '';
  server.stderr.on('data', value => logs += value);
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(Error(logs || 'Fixture timed out')), 15000);
      server.once('error', reject);
      server.once('exit', code => { clearTimeout(timeout); reject(Error('Fixture exited ' + code + ': ' + logs)); });
      server.stdout.on('data', value => {
        output += value;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
    browser = await chromium.launch({headless: true, executablePath: process.env.MUSO_TEST_CHROMIUM || undefined, args: ['--no-sandbox']});
    page = await browser.newPage({viewport: {width:390,height:844}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const button = name => page.getByRole('button', {name, exact:true});
    const setRange = (id, value) => page.locator('#' + id).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', {bubbles:true})); }, String(value));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('muso.playback.v1')));
    const capture = async name => {
      if (!process.env.MUSO_TEST_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.MUSO_TEST_SCREENSHOT_DIR, {recursive:true});
      await page.screenshot({path:path.join(process.env.MUSO_TEST_SCREENSHOT_DIR, name + '.png'), fullPage:false});
    };
    await page.route('**/api/recap?*', route => route.fulfill({json:{plays:13,songs:3,artists:3,
      top_tracks:[{id:'0',title:'Dar e nijaat OST - Full Original Soundtrack | Heartbreaking Drama Song | Very long title',artist:'Drama ki mehfil',plays:7,available:true},
        {id:'gone',title:'Labrinth – Forever (Official Audio) | euphoria (Original Score from the HBO Series)',artist:'Labrinth',plays:4,available:false},
        {id:'1',title:"Baby, I’m Yours",artist:'Arctic Monkeys',plays:2,available:true}],
      top_artists:[{artist:'Drama ki mehfil',plays:7},{artist:'An artist with a very long name that should wrap correctly',plays:4},{artist:'Arctic Monkeys',plays:2}]}}));
    await page.goto(url);
    await page.waitForSelector('.track');
    await page.locator('[data-view=recap]').click();
    await page.waitForSelector('.recap-row');
    for (const width of [320,390,768,1280]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Recap overflow at ' + width);
      const alignment = await page.locator('.recap-content .recap-ranks').first().locator('.recap-row').evaluateAll(rows => rows.map(row => {
        const rank=row.querySelector('.recap-rank').getBoundingClientRect();
        const caption=row.querySelector('.recap-caption').getBoundingClientRect();
        const count=row.querySelector('.recap-plays').getBoundingClientRect();
        const title=row.querySelector('.recap-caption strong').getBoundingClientRect();
        return {rank:rank.left,caption:caption.left,count:count.right,height:title.height};
      }));
      await page.locator('.recap-ranks').first().scrollIntoViewIfNeeded();
      await capture('recap-' + width);
      assert.ok(alignment.every(row => row.rank===alignment[0].rank && row.caption===alignment[0].caption && row.count===alignment[0].count), 'Recap alignment at ' + width + ': ' + JSON.stringify(alignment));
      assert.ok(alignment.every(row => row.height < 43), 'Titles should clamp to two lines');
      if (width===390) {
        await page.locator('.recap-ranks').first().scrollIntoViewIfNeeded();
        await capture('recap-fixed-phone');
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-view=library]').click();
    await button('Play all').click();
    await page.waitForFunction(() => !audio.paused);
    await page.locator('#now').click();
    await button('Sound').click();
    await button('Enable EQ & crossfade').click();
    await page.waitForFunction(() => sound.canFade);
    await button('Bass').click();
    await setRange('sound-volume',70);
    await setRange('sound-speed',1.2);
    assert.deepEqual(await page.evaluate(() => audioDecks.map(a => [a.volume,a.playbackRate,a.preservesPitch])), [[.7,1.2,true],[.7,1.2,true]]);
    await page.waitForFunction(() => Math.abs(sound.filters[0].gain.value - 6) < .1);
    assert.ok(await page.evaluate(() => {
      const magnitudes = new Float32Array(1), phases = new Float32Array(1);
      sound.filters[0].getFrequencyResponse(new Float32Array([60]),magnitudes,phases);
      return magnitudes[0] > 1.5 && sound.headroom.gain.value < .51;
    }), 'The actual audio filter must boost bass and reserve headroom');
    await page.evaluate(() => {
      window.testAnalyser = sound.context.createAnalyser();
      sound.headroom.connect(testAnalyser);
    });
    await page.waitForFunction(() => {
      const wave = new Float32Array(testAnalyser.fftSize); testAnalyser.getFloatTimeDomainData(wave);
      return wave.some(value => Math.abs(value) > .005);
    });
    await page.locator('#dialog').evaluate(el => el.scrollTop=0);
    await capture('sound-controls-phone');
    await page.locator('#sound-speed').scrollIntoViewIfNeeded();
    await capture('sound-levels-phone');
    await button('Reset sound').click();
    assert.deepEqual(await page.evaluate(() => [audio.volume,audio.playbackRate,sound.settings.enabled]), [1,1,false]);
    await button('Enable EQ & crossfade').click();
    await page.waitForFunction(() => sound.canFade);
    await button('Close').click();

    const begin = () => page.evaluate(() => { setSleep(); setRepeat(0); sound.update({speed:1,crossfade:3}); start(['0','1','2'].map(trackById),0); });
    await begin();
    await page.waitForFunction(() => current==='0' && !audio.paused && !fadeRequest && !fadingOut);
    await page.evaluate(() => seekPlayback(117.2));
    await page.waitForFunction(() => current==='1' && Boolean(fadingOut));
    assert.deepEqual((await saved()).queue, ['2']);
    assert.equal(await page.evaluate(() => audioDecks.filter(a => !a.paused).length), 2);
    await page.waitForFunction(() => {
      const values=audioDecks.map(a => sound.gains.get(a).gain.value);
      return values.every(v => v>.05 && v<.95) && Math.abs(values[0]+values[1]-1)<.02;
    });
    // Seeking cancels the tail; there must never be hidden audio continuing.
    await page.evaluate(() => seekPlayback(20));
    assert.equal(await page.evaluate(() => audioDecks.filter(a => !a.paused).length), 1);
    await page.waitForFunction(() => !audio.seeking && sound.gains.get(audio).gain.value===1, undefined, {timeout:2000});
    await page.evaluate(() => { advance(); pausePlayback(); });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => audioDecks.filter(a => !a.paused).length), 0);
    assert.equal((await saved()).current, '1');
    assert.deepEqual((await saved()).queue, ['2']);

    // Failed preparation keeps the outgoing song and queue intact.
    await page.route('**/api/tracks/2/audio', route => route.abort('failed'));
    await page.locator('#play').click();
    await page.waitForFunction(() => !audio.paused);
    await page.locator('#next').click();
    await page.waitForFunction(() => failedFade==='1:2');
    assert.equal((await saved()).current, '1');
    assert.deepEqual((await saved()).queue, ['2']);
    assert.equal(await page.evaluate(() => !audio.paused), true);
    await page.unroute('**/api/tracks/2/audio');
    await page.locator('#next').click();
    await page.waitForFunction(() => current==='2' && Boolean(fadingOut));
    assert.deepEqual((await saved()).queue, []);
    await page.waitForFunction(() => !fadingOut && audioDecks.filter(a => !a.paused).length===1);
    assert.equal(await page.evaluate(() => sound.gains.get(audio).gain.value), 1);
    // Previous is committed only after the incoming track is ready, too.
    const priorHistory = (await saved()).history;
    await page.route('**/api/tracks/1/audio', route => route.abort('failed'));
    await page.evaluate(() => seekPlayback(0));
    await page.waitForFunction(() => !audio.seeking);
    await page.evaluate(() => previous());
    await page.waitForFunction(() => failedFade==='2:1');
    assert.deepEqual((await saved()).history, priorHistory);
    assert.deepEqual((await saved()).queue, []);
    await page.unroute('**/api/tracks/1/audio');
    await page.evaluate(() => seekPlayback(0));
    await page.waitForFunction(() => !audio.seeking);
    await page.evaluate(() => previous());
    await page.waitForFunction(() => current==='1' && Boolean(fadingOut));
    assert.deepEqual((await saved()).history, priorHistory.slice(0,-1));
    assert.deepEqual((await saved()).queue, ['2']);

    await begin();
    await page.waitForFunction(() => current==='0' && !audio.paused && !fadeRequest && !fadingOut);
    await page.evaluate(() => { setRepeat(1); seekPlayback(117.2); });
    await page.waitForFunction(() => current==='1' && Boolean(fadingOut));
    assert.deepEqual((await saved()).queue, ['2','0']);
    // An expired deadline during overlap silences both media elements.
    await page.evaluate(() => setSleep(Date.now()+100));
    await page.waitForFunction(() => audioDecks.every(a => a.paused));

    await begin();
    await page.waitForFunction(() => current==='0' && !audio.paused && !fadeRequest && !fadingOut);
    await page.evaluate(() => { setRepeat(2); seekPlayback(119.6); });
    await page.waitForFunction(() => current==='0' && audio.currentTime<1 && !audio.paused);
    assert.deepEqual((await saved()).queue, ['1','2']);
    await page.evaluate(() => { setSleep(0,true); seekPlayback(119.6); });
    await page.waitForFunction(() => audio.paused);
    assert.equal((await saved()).current, '0');
    assert.deepEqual((await saved()).queue, ['1','2']);

    await page.evaluate(() => { sound.update({bass:2,mid:-1,treble:3,volume:65,speed:1.1,crossfade:5}); savePlayback(); });
    await page.reload();
    await page.waitForSelector('.track');
    assert.deepEqual(await page.evaluate(() => sound.settings), {enabled:true,bass:2,mid:-1,treble:3,volume:65,speed:1.1,crossfade:5});
    await page.locator('#play').click();
    await page.waitForFunction(() => sound.context?.state==='running' && !audio.paused);
    assert.deepEqual(errors, []);
    console.log('PASS: aligned recap, real EQ output, presets/volume/speed, crossfade overlap, cancellation, failed incoming audio, repeat, sleep, and reload');
  } catch (error) {
    if (page) console.error('Playback state:', await page.evaluate(() => ({current, queue, history, failedFade,
      pending: Boolean(fadeRequest), fading: Boolean(fadingOut), repeat, sleepUntil, sleepAfterSong,
      settings: sound.settings, context: sound.context?.state,
      decks: audioDecks.map(a => ({id:a.id,src:a.getAttribute('src'),paused:a.paused,time:a.currentTime,
        duration:a.duration,ready:a.readyState,seeking:a.seeking,error:a.error?.code,gain:sound.gains.get(a)?.gain.value}))
    })).catch(() => 'Page unavailable'));
    throw error;
  } finally { await browser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode=1; });
