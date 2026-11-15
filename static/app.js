'use strict';
const $ = id => document.getElementById(id);
let audio = $('audio');
const audioDecks = [audio, $('audio-next')];
const sound = new MusoSound(audioDecks);
let fadeRequest = null, fadingOut = null, fadeTimer = null, playbackGeneration = 0, failedFade = '';
const dialog = $('dialog');
const token = document.querySelector('meta[name=muso-token]').content;
let tracks = [], playlists = [], jobs = [], view = 'library', filter = '';
let daily = null;
let updateDailyControls;
let queue = [], current = '', history = [], shuffle = false, repeat = 0, counted = false;
let sleepTimer, toastTimer, importing = false;
let sleepUntil = 0, sleepAfterSong = false;
let activeMix = '', selecting = false, selected = new Set(), queueUndo = null;
let sortOrder = 'default', resumeAt = null, lastSavedAt = 0;
let playedSeconds = 0, lastAudioTime = 0;
let browseBy = 'songs', browseGroup = '';
let libraryReady = false, discoveryPolling = false;
let disconnectedSince = 0;
let initializing;
const recapMonth = new Date();
recapMonth.setDate(1);
const playbackKey = 'muso.playback.v1';
const sleepKey = 'muso.sleep.v1';
const trackOrder = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const trackById = id => tracks.find(track => track.id === id);
const time = value => Number.isFinite(value) ? Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0') : '0:00';
const totalTime = seconds => seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  : seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds)}s`;

const iconPaths = {
  library: 'M4 4v16M9 4v16M14 5l5-1 3 15-5 1z',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  playlist: 'M4 5h12M4 10h12M4 15h7M17 13v7M13.5 16.5h7',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8',
  recap: 'M4 19V9M10 19V4M16 19v-7M22 19V7',
  download: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16',
  install: 'M8 3H4v18h16v-4M15 3v10M11 9l4 4 4-4',
  plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6 6 18',
  play: 'M8 4l13 8-13 8z', pause: 'M8 5v14M16 5v14',
  next: 'M5 5l10 7-10 7zM19 5v14', previous: 'M19 5 9 12l10 7zM5 5v14',
  shuffle: 'M3 6h3c6 0 6 12 12 12h3M18 15l3 3-3 3M3 18h3c2 0 3-2 4-4M14 8c1-2 2-2 4-2h3M18 3l3 3-3 3',
  repeat: 'M3 10V6h16M16 3l3 3-3 3M21 14v4H5M8 15l-3 3 3 3',
  spark: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01'
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name] || iconPaths.play);
  svg.append(path);
  return svg;
}
function iconButton(name, action, label, cls = 'icon') {
  const control = button('', action, cls, label);
  control.append(icon(name));
  return control;
}
for (const control of document.querySelectorAll('[data-icon]')) control.prepend(icon(control.dataset.icon));
for (const [id, name] of [['shuffle','shuffle'], ['prev','previous'], ['next','next']]) $(id).replaceChildren(icon(name));

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, action, cls, label) {
  const item = node('button', text, cls);
  item.type = 'button';
  if (label) {
    item.title = label;
    item.setAttribute('aria-label', label);
  }
  item.onclick = () => Promise.resolve().then(action).catch(error => toast(error.message));
  return item;
}

async function api(path, method = 'GET', data) {
  const headers = {'X-Muso-Token': token};
  if (data && !(data instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    data = JSON.stringify(data);
  }
  // Retry reads only: replaying an import or playlist mutation could duplicate work.
  const attempts = method === 'GET' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), data instanceof FormData ? 180000 : 15000);
    let response, result;
    try {
      response = await fetch('/api/' + path, {method, body: data, headers, signal: controller.signal});
      const text = await response.text();
      try { result = JSON.parse(text); } catch {
        throw new Error(response.status === 404 ? 'Muso needs an update or restart. Update it in Termux, restart Muso, then reload this page.'
          : 'Muso returned an unreadable response. Restart Muso in Termux and reload this page.');
      }
    } catch (error) {
      const connectionError = error.name === 'AbortError' || error.name === 'TypeError';
      if (!connectionError) throw error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
        continue;
      }
      disconnectedSince ||= Date.now();
      $('status').textContent = Date.now() - disconnectedSince < 60000
        ? 'Reconnecting to Muso…' : 'Open Termux to reconnect · your queue is saved';
      throw new Error(error.name === 'AbortError'
        ? 'Muso is taking longer to respond. Reconnecting automatically…'
        : 'Reconnecting to Muso automatically. If this continues, open Termux; your queue is saved.');
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(response.status === 404 && path === 'search/tasks'
      ? 'Restart Muso in Termux to load the updated search, then reload this page.'
      : result?.error || 'Muso could not complete that action.');
    return result;
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  // Native dialogs live above every document z-index. Show feedback inside the
  // open sheet as well, so a failed save is visible and announced there.
  if (dialog.open) {
    let notice = $('dialog-notice');
    if (!notice) {
      notice = node('p', '', 'dialog-notice');
      notice.id = 'dialog-notice';
      notice.setAttribute('role', 'status');
      $('dialog-body').before(notice);
    }
    notice.textContent = message;
    dialog.scrollTop = 0;
  }
  toastTimer = setTimeout(() => { $('toast').hidden = true; $('dialog-notice')?.remove(); }, 5500);
}

function modal(title, ...content) {
  const sameSheet = dialog.open && $('dialog-title').textContent === title;
  const scroll = sameSheet ? dialog.scrollTop : 0;
  const focused = sameSheet && dialog.contains(document.activeElement) ? document.activeElement : null;
  const focusName = focused && (focused.getAttribute('aria-label') || focused.textContent);
  $('dialog-title').textContent = title;
  $('dialog-notice')?.remove();
  $('dialog-body').replaceChildren(...content);
  if (!dialog.open) dialog.showModal();
  else {
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const oppositeMove = focusName?.startsWith('Move ') ? focusName.replace(/ (up|down)$/, (_, direction) => direction === 'up' ? ' down' : ' up') : '';
    const replacement = focusName && (controls.find(control => (control.getAttribute('aria-label') || control.textContent) === focusName)
      || controls.find(control => control.getAttribute('aria-label') === oppositeMove));
    (replacement || $('dialog-body').querySelector('button:not(:disabled), input:not(:disabled)') || $('close')).focus({preventScroll: true});
  }
  // Keep long queues in place when editing; a different sheet starts at the top.
  dialog.scrollTop = scroll;
}

function form(label, placeholder, submit, action, value = '') {
  const wrapper = node('form', undefined, 'form-row');
  const input = node('input');
  input.setAttribute('aria-label', label);
  input.placeholder = placeholder;
  input.value = value;
  input.required = true;
  const send = node('button', submit, 'primary');
  wrapper.append(input, send);
  wrapper.onsubmit = async event => {
    event.preventDefault();
    send.disabled = true;
    try { await action(input.value.trim()); }
    catch (error) { toast(error.message); }
    finally { send.disabled = false; }
  };
  return wrapper;
}

$('refresh-library').addEventListener('click', async () => {
  const control = $('refresh-library');
  control.disabled = true;
  try {
    if (libraryReady) await refresh();
    else await initializeLibrary();
    await poll();
    toast('Library refreshed');
  } catch (error) {
    toast(error.message);
  } finally {
    control.disabled = false;
  }
});

async function refresh() {
  ({tracks, playlists, discovery: daily} = await api('library'));
  if (current && !trackById(current)) {
    cancelTransition();
    current = '';
    resumeAt = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  queue = queue.filter(trackById);
  history = history.filter(trackById);
  selected = new Set([...selected].filter(trackById));
  if (view === 'discover' && updateDailyControls) updateDailyControls();
  else render();
  player();
}

function initializeLibrary() {
  if (libraryReady) return Promise.resolve();
  if (!initializing) {
    $('status').textContent = 'Connecting to Muso…';
    initializing = refresh().then(() => {
      restorePlayback();
      restoreSleep();
      resumeAfterReload();
      libraryReady = true;
      $('status').textContent = '● On this device';
    }).catch(error => {
      $('status').textContent = 'Waiting for Muso · reconnecting automatically';
      throw error;
    }).finally(() => { initializing = null; });
  }
  return initializing;
}

function navigate(next) {
  view = next;
  selecting = false;
  selected.clear();
  activeMix = '';
  filter = '';
  sortOrder = 'default';
  render();
  window.scrollTo({top: 0, behavior: 'instant'});
  if (view === 'imports') poll().catch(error => toast(error.message));
}

const mixes = [
  ['favourites', 'Your favourites', 'Liked songs, ready to play'],
  ['unheard', 'First listen', 'Saved songs you haven’t played'],
  ['rediscover', 'Rediscover', 'Songs you last played over two weeks ago'],
  ['recent', 'Fresh arrivals', 'Added in the last two weeks']
];

function mixTracks(key) {
  const fortnight = Date.now() / 1000 - 14 * 86400;
  if (key === 'favourites') return tracks.filter(t => t.liked).sort((a, b) => b.plays - a.plays);
  if (key === 'unheard') return tracks.filter(t => !t.plays);
  if (key === 'rediscover') return tracks.filter(t => t.last_played && t.last_played < fortnight)
    .sort((a, b) => a.last_played - b.last_played);
  if (key === 'recent') return tracks.filter(t => t.created >= fortnight);
  return tracks;
}

function addToQueue(ids, next = false) {
  const known = new Set(next ? [current] : [current, ...queue]);
  const additions = ids.filter(id => {
    if (!trackById(id) || known.has(id)) return false;
    known.add(id);
    return true;
  });
  if (next) queue = [...additions, ...queue.filter(id => !known.has(id))];
  else queue.push(...additions);
  savePlayback();
  player();
  toast(additions.length ? `${additions.length} ${next ? 'ready to play next' : 'added to the queue'}` : 'Already playing or queued');
}

function renderRecap() {
  const month = recapMonth.getFullYear() + '-' + String(recapMonth.getMonth() + 1).padStart(2, '0');
  const title = recapMonth.toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
  $('summary').textContent = title;
  const controls = node('div', undefined, 'toolbar');
  const step = direction => {
    recapMonth.setMonth(recapMonth.getMonth() + direction);
    renderRecap();
  };
  const forward = button('Next month →', () => step(1));
  const now = new Date();
  forward.disabled = recapMonth >= new Date(now.getFullYear(), now.getMonth(), 1);
  controls.append(button('← Previous month', () => step(-1)), forward);
  const content = node('div', 'Loading recap…', 'recap-content');
  content.setAttribute('aria-live', 'polite');
  $('body').replaceChildren(controls, content);
  api('recap?month=' + month).then(data => {
    if (!data.plays) {
      content.replaceChildren(node('p', 'No plays recorded for this month yet.', 'empty'));
      return;
    }
    const stats = node('div', undefined, 'recap-stats');
    for (const [value, label] of [[data.plays, 'Plays'], [data.songs, 'Songs'], [data.artists, 'Artists']]) {
      const card = node('div', undefined, 'card');
      card.append(node('strong', value.toLocaleString()), node('span', label));
      stats.append(card);
    }
    const artistList = node('ol', undefined, 'recap-ranks');
    for (const [index, artist] of data.top_artists.entries()) {
      const entry = node('li', undefined, 'recap-row recap-artist');
      const bar = node('progress');
      bar.max = data.top_artists[0].plays;
      bar.value = artist.plays;
      bar.setAttribute('aria-label', artist.artist + ' plays');
      const caption = node('div', undefined, 'recap-caption');
      caption.append(node('strong', artist.artist), bar);
      entry.append(node('span', index + 1, 'recap-rank'), caption, recapPlays(artist.plays));
      artistList.append(entry);
    }
    const songList = node('ol', undefined, 'recap-ranks');
    for (const [index, track] of data.top_tracks.entries()) {
      const entry = node('li', undefined, 'recap-row');
      const song = track.available ? button('', () => playTrack(track.id), 'recap-song', 'Play ' + track.title)
        : node('div', undefined, 'recap-song unavailable');
      song.title = track.title + ' · ' + track.artist;
      const cover = node('span', '', 'cover');
      coverArt(cover, track);
      const caption = node('span', undefined, 'recap-caption');
      caption.append(node('strong', track.title), node('small', track.artist));
      if (!track.available) caption.append(node('small', 'No longer in your library', 'recap-unavailable'));
      song.append(cover, caption);
      entry.append(node('span', index + 1, 'recap-rank'), song, recapPlays(track.plays));
      songList.append(entry);
    }
    const available = data.top_tracks.filter(track => track.available).map(track => track.id);
    content.replaceChildren(stats, node('h2', 'Top songs'), songList, node('h2', 'Top artists'), artistList);
    if (available.length) {
      const save = button('Save top songs as a playlist', async () => {
        const result = await api('playlists', 'POST', {name: title + ' Recap', tracks: available});
        navigate(result.id);
        await refresh();
      }, 'primary');
      content.append(save);
    }
  }).catch(error => { content.textContent = error.message; });
}

function recapPlays(plays) {
  const count = node('span', undefined, 'recap-plays');
  count.append(node('strong', plays.toLocaleString()), node('small', plays === 1 ? 'play' : 'plays'));
  return count;
}

function render() {
  // Polling and likes can refresh the list while someone is typing. Keep their
  // focus and caret, as well as the active filter and selection.
  const active = document.activeElement;
  const label = active?.getAttribute('aria-label');
  const inBody = $('body').contains(active);
  const shelfOffset = document.querySelector('.mix-shelf')?.scrollLeft || 0;
  const selection = inBody && active.tagName === 'INPUT' && ['search', 'text'].includes(active.type)
    ? [active.selectionStart, active.selectionEnd] : null;
  renderView();
  const shelf = document.querySelector('.mix-shelf');
  if (shelf) shelf.scrollLeft = shelfOffset;
  if (inBody && label) {
    const replacement = [...$('body').querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === label);
    replacement?.focus({preventScroll: true});
    if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
  }
}

function renderPlaylists() {
  $('summary').textContent = `${playlists.length} ${playlists.length === 1 ? 'playlist' : 'playlists'} · Your music, in your order.`;
  const actions = node('div', undefined, 'actions');
  actions.append(button('New playlist', newPlaylist, 'primary'), button('Liked songs', () => navigate('liked')));
  const grid = node('div', undefined, 'playlist-grid');
  for (const playlist of playlists) {
    const songs = playlist.tracks.map(trackById).filter(Boolean);
    const card = button('', () => navigate(playlist.id), 'playlist-card', playlist.name);
    const cover = node('span', '', 'cover');
    coverArt(cover, {id: playlist.id});
    card.append(cover, node('strong', playlist.name), node('small', `${songs.length} songs · ${totalTime(songs.reduce((sum, t) => sum + (t.duration || 0), 0))}`));
    grid.append(card);
  }
  $('body').append(actions, grid);
  if (!playlists.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('strong', 'A place for every mood'), node('p', 'Create a playlist, then add songs from their options menu or select a few together.'));
    $('body').append(empty);
  }
}

function renderView() {
  updateDailyControls = null;
  const playlist = playlists.find(item => item.id === view);
  for (const tab of document.querySelectorAll('[data-view]')) {
    const selected = tab.dataset.view === view || (tab.dataset.view === 'playlists' && playlist)
      || (tab.dataset.view === 'discover' && view === 'finds');
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', Boolean(selected));
  }
  $('playlists').replaceChildren(...playlists.map(playlist =>
    button(playlist.name, () => navigate(playlist.id), view === playlist.id ? 'selected' : '')));
  $('heading').textContent = playlist?.name || ({library:'Your rotation.', liked:'Liked songs', playlists:'Your playlists.', discover:'Find your next.', finds:'Daily Finds', imports:'Coming your way.', recap:'Your month in music.'}[view] || 'Library');
  $('eyebrow').textContent = playlist ? 'CURATED BY YOU' : ({library:'MADE OF YOUR FAVOURITES', liked:'THE ONES YOU LOVE', playlists:'A PLACE FOR EVERY MOOD', discover:'A LITTLE OUTSIDE YOUR USUAL', finds:'FRESHLY FOUND FOR YOU', imports:'MAKING ROOM FOR MORE', recap:'YOUR LISTENING STORY'}[view] || 'YOUR MUSIC LIBRARY');
  $('body').replaceChildren();
  if (view === 'playlists') {
    renderPlaylists();
    return;
  }
  if (view === 'recap') {
    renderRecap();
    return;
  }
  if (view === 'imports') {
    $('summary').textContent = 'Check progress and choose matches for shared links.';
    renderJobs();
    return;
  }
  if (view === 'discover') {
    $('summary').textContent = 'Search YouTube for a song or artist.';
    const results = node('div');
    const search = form('Song and artist', 'Search for a song or artist', 'Search', query => searchInto(query, results));
    const controls = node('div', undefined, 'card');
    const status = node('p');
    const runStatus = node('p', '', 'muted');
    runStatus.setAttribute('role', 'status');
    const run = button('Discover Now', async () => {
      run.disabled = true;
      let failure = '';
      try {
        daily = await api('discovery/run', 'POST');
      } catch (error) {
        failure = error.message;
      } finally {
        updateDaily();
      }
      if (failure) runStatus.textContent = failure;
    }, 'primary');
    const toggle = button('', async () => {
      daily = await api('discovery', 'PATCH', {enabled: !daily.enabled});
      updateDaily();
    });
    function updateDaily() {
      status.textContent = daily.enabled
        ? `${daily.added} saved today. ${daily.added >= daily.limit ? 'Automatic discovery is complete for today.' : `Automatic discovery runs until ${daily.limit} are saved.`}`
        : 'Automatic additions are paused.';
      toggle.textContent = daily.enabled ? 'Pause daily discovery' : 'Enable daily discovery';
      const request = daily.manual;
      run.disabled = ['queued', 'running'].includes(request?.status);
      if (run.disabled) {
        runStatus.textContent = (request.status === 'running' ? 'Looking for music…' : 'Queued…') +
          ` ${request.added} of ${daily.limit} saved in this batch.`;
      } else {
        const saved = request?.status === 'done' ? `${request.added} songs saved. ` : '';
        runStatus.textContent = saved + (request?.message || '');
      }
    }
    if (daily) {
      const actions = node('div', undefined, 'actions');
      actions.append(run, button('View Daily Finds', () => navigate('finds')), toggle);
      controls.append(node('strong', 'Daily discovery'), status, actions, runStatus);
      updateDaily();
      updateDailyControls = updateDaily;
      $('body').append(controls);
    }
    $('body').append(search, results);
    return;
  }
  const collection = playlist ? playlist.tracks.map(trackById).filter(Boolean) : (view === 'library' ? mixTracks(activeMix) : tracks).filter(track => {
    if (view === 'liked') return track.liked;
    if (view === 'finds') return track.discovered_on;
    return true;
  });
  $('summary').textContent = collection.length + (collection.length === 1 ? ' song saved on this device' : ' songs saved on this device');
  const toolbar = node('div', undefined, 'toolbar');
  let groupFilter = null;
  if (view === 'library') {
    const shelfTitle = node('div', undefined, 'section-heading');
    shelfTitle.append(node('h2', 'Find your mood'), node('small', 'Made from your library'));
    $('body').append(shelfTitle);
    const shelf = node('div', undefined, 'mix-shelf');
    for (const [key, title, description] of mixes) {
      const count = mixTracks(key).length;
      const card = button('', () => {
        activeMix = activeMix === key ? '' : key;
        browseBy = 'songs';
        browseGroup = filter = '';
        sortOrder = 'default';
        selecting = false;
        selected.clear();
        render();
      }, 'mix-card' + (activeMix === key ? ' active' : ''), title);
      card.setAttribute('aria-pressed', activeMix === key);
      const symbol = node('span', undefined, 'mix-symbol');
      symbol.append(icon({favourites:'heart', unheard:'play', rediscover:'clock', recent:'spark'}[key]));
      card.append(symbol, node('strong', title), node('small', description), node('span', count + ' songs', 'mix-count'));
      shelf.append(card);
    }
    $('body').append(shelf);
    if (activeMix) {
      const name = mixes.find(mix => mix[0] === activeMix)[1];
      $('heading').textContent = name;
      toolbar.append(button('All songs', () => { activeMix = ''; render(); }, 'quiet'));
    }
    const browse = node('div', undefined, 'actions browse-modes');
    for (const [key, label] of [['songs', 'Songs'], ['artist', 'Artists'], ['album', 'Albums'], ['genre', 'Genres']]) {
      const choice = button(label, () => {
        browseBy = key;
        browseGroup = '';
        render();
      }, browseBy === key ? 'primary' : undefined);
      choice.setAttribute('aria-pressed', browseBy === key);
      browse.append(choice);
    }
    $('body').append(browse);
    if (browseBy !== 'songs') {
      const groups = new Map();
      for (const track of collection) {
        const label = track[browseBy].trim() || (browseBy === 'genre' ? 'Untagged' : 'Unknown ' + browseBy);
        const owner = browseBy === 'album' && track.album ? ' · ' + track.artist : '';
        const id = (label + owner).toLocaleLowerCase();
        if (!groups.has(id)) groups.set(id, {name: label + owner, tracks: new Set()});
        groups.get(id).tracks.add(track.id);
      }
      const picker = node('select');
      picker.setAttribute('aria-label', 'Choose ' + browseBy);
      picker.append(node('option', 'All ' + (browseBy === 'genre' ? 'genres' : browseBy + 's')));
      picker.options[0].value = '';
      for (const [id, group] of [...groups].sort((a, b) => trackOrder.compare(a[1].name, b[1].name))) {
        const option = node('option', group.name + ' (' + group.tracks.size + ')');
        option.value = id;
        picker.append(option);
      }
      if (!groups.has(browseGroup)) browseGroup = '';
      picker.value = browseGroup;
      groupFilter = groups.get(browseGroup)?.tracks || null;
      picker.onchange = () => { browseGroup = picker.value; render(); };
      toolbar.append(picker);
    }
  }
  const input = node('input');
  input.type = 'search';
  input.placeholder = 'Search your music';
  input.setAttribute('aria-label', 'Filter songs');
  input.value = filter;
  const searchField = node('div', undefined, 'search-field');
  const clearSearch = iconButton('close', () => {
    filter = input.value = '';
    renderList();
    input.focus();
  }, 'Clear search');
  searchField.append(icon('search'), input, clearSearch);
  const sort = node('select');
  sort.setAttribute('aria-label', 'Sort songs');
  for (const [value, label] of [
    ['default', playlist ? 'Playlist order' : activeMix === 'favourites' ? 'Favourite order'
      : activeMix === 'rediscover' ? 'Longest unheard' : 'Newest added'],
    ['recent', 'Recently played'], ['plays', 'Most played'],
    ['title', 'Song title'], ['artist', 'Artist']
  ]) {
    const option = node('option', label);
    option.value = value;
    sort.append(option);
  }
  sort.value = sortOrder;
  const comparators = {
    recent: (a, b) => (b.last_played || 0) - (a.last_played || 0),
    plays: (a, b) => b.plays - a.plays,
    title: (a, b) => trackOrder.compare(a.title, b.title),
    artist: (a, b) => trackOrder.compare(a.artist, b.artist) || trackOrder.compare(a.title, b.title)
  };
  const playAll = button('Play all', () => { if (shown.length) start(shown, 0); }, 'primary');
  playAll.prepend(icon('play'));
  const shuffleAll = button('Shuffle play', () => {
    if (!shown.length) return;
    const shuffled = [...shown];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    start(shuffled, 0);
  });
  const selectSongs = button(selecting ? 'Done selecting' : 'Select songs', () => {
    selecting = !selecting;
    selected.clear();
    render();
  });
  const selectionBar = node('div', undefined, 'selection-bar');
  const resultsCount = node('p', '', 'muted results-count');
  const list = node('div');
  let shown = [];
  function updateSelection() {
    selectionBar.replaceChildren();
    selectionBar.hidden = !selecting;
    if (!selecting) return;
    const ids = [...selected];
    selectionBar.append(node('strong', ids.length + ' selected'), button('Select matching', () => {
      shown.forEach(t => selected.add(t.id));
      renderList();
    }), button('Clear selection', () => { selected.clear(); renderList(); }));
    const actions = [
      button('Play next', () => addToQueue(ids, true)),
      button('Queue selected', () => addToQueue(ids)),
      button('Add to playlist', () => choosePlaylist(ids))
    ];
    if (playlist) actions.push(button('Remove from playlist', async () => {
      await api('playlists/' + playlist.id, 'PATCH', {
        tracks: playlist.tracks.filter(id => !selected.has(id)), expected_tracks: playlist.tracks
      });
      selected.clear();
      await refresh();
      toast('Songs removed from this playlist');
    }));
    for (const action of actions) action.disabled = !ids.length;
    selectionBar.append(...actions);
  }
  function renderList() {
    clearSearch.hidden = !filter;
    const words = filter.toLocaleLowerCase().trim().split(/\s+/);
    shown = collection.filter(track => {
      const searchable = [track.title, track.artist, track.album, track.genre].join(' ').toLocaleLowerCase();
      return (!groupFilter || groupFilter.has(track.id)) && words.every(word => searchable.includes(word));
    });
    if (comparators[sortOrder]) shown.sort(comparators[sortOrder]);
    playAll.disabled = !shown.length;
    shuffleAll.disabled = !shown.length;
    resultsCount.textContent = `${shown.length} songs · ${totalTime(shown.reduce((sum, track) => sum + (track.duration || 0), 0))} total`;
    updateSelection();
    list.replaceChildren(...shown.map((track, index) => {
      const item = row(track, () => start(shown, index));
      if (selecting) {
        item.classList.add('selectable');
        const check = node('input');
        check.type = 'checkbox';
        check.checked = selected.has(track.id);
        check.setAttribute('aria-label', 'Select ' + track.title);
        check.onchange = () => {
          if (check.checked) selected.add(track.id);
          else selected.delete(track.id);
          updateSelection();
        };
        item.prepend(check);
      }
      return item;
    }));
    if (!shown.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('strong', filter || activeMix || groupFilter ? 'No matching songs' : 'No songs yet'));
      if (filter || activeMix || groupFilter) empty.append(node('p', 'Try another mix or change your filters.'));
      else if (view === 'liked') empty.append(node('p', 'Tap the heart beside any song to keep your favourites here.'), button('Browse your library', () => navigate('library')));
      else if (playlist) empty.append(node('p', 'Add saved songs from their options menu or select several in your library.'), button('Browse your library', () => navigate('library')));
      else if (view === 'finds') empty.append(node('p', 'Songs saved by Daily Discovery will appear here.'), button('Back to Discover', () => navigate('discover')));
      else empty.append(node('p', 'Add a link or import audio from your phone.'), button('Add music', addMusic, 'primary'));
      if (filter || activeMix || groupFilter) empty.append(button('Reset filters', () => {
        filter = activeMix = browseGroup = '';
        render();
      }));
      list.append(empty);
    }
  }
  input.oninput = () => { filter = input.value; renderList(); };
  sort.onchange = () => { sortOrder = sort.value; renderList(); };
  toolbar.append(searchField, sort);
  const collectionActions = node('div', undefined, 'actions collection-actions');
  collectionActions.append(playAll, shuffleAll, selectSongs);
  if (playlist) {
    collectionActions.append(button('Edit playlist', () => managePlaylist(playlist), undefined, 'Edit ' + playlist.name));
    collectionActions.append(button('Queue playlist', () => {
      addToQueue(playlist.tracks);
    }));
  }
  $('body').append(toolbar, collectionActions, resultsCount, selectionBar, list);
  renderList();
}

function coverArt(element, track) {
  let hue = 0;
  for (const character of track?.id || '') hue = (hue * 31 + character.charCodeAt(0)) % 360;
  element.style.setProperty('--art-hue', hue + 'deg');
  element.textContent = '';
  element.setAttribute('aria-hidden', 'true');
}

function row(track, play) {
  const item = node('div', undefined, 'track');
  item.dataset.trackId = track.id;
  item.classList.toggle('playing', current === track.id);
  const song = button('', play, 'song', 'Play ' + track.title);
  const caption = node('span');
  const detail = [track.artist];
  if (track.duration) detail.push(time(track.duration));
  if (view === 'library' && browseBy === 'album' && track.album) detail.push(track.album);
  if (view === 'finds') detail.push(track.discovered_on);
  caption.append(node('strong', track.title), node('small', detail.join(' · ')));
  const cover = node('span', '', 'cover');
  coverArt(cover, track);
  song.append(cover, caption);
  const actions = node('div', undefined, 'actions');
  const like = iconButton('heart', async () => {
    await api('tracks/' + track.id, 'PATCH', {liked: !track.liked});
    await refresh();
  }, track.liked ? 'Unlike ' + track.title : 'Like ' + track.title, 'icon' + (track.liked ? ' on' : ''));
  like.setAttribute('aria-pressed', Boolean(track.liked));
  like.classList.add('like-button');
  actions.append(like, iconButton('more', () => trackMenu(track), 'Options for ' + track.title));
  item.append(song, actions);
  return item;
}

function trackMenu(track) {
  const options = node('div', undefined, 'stack');
  if (track.codec) {
    const quality = track.codec.toUpperCase() + (track.bitrate ? ` · ~${track.bitrate} kbps` : '');
    options.append(node('small', quality + ' · Saved audio', 'muted'));
  }
  if (track.discovered_on) {
    const reject = async kind => {
      await api('tracks/' + track.id + '/discovery-feedback', 'POST', {kind});
      dialog.close();
      toast(kind === 'artist' ? 'Artist excluded from future discovery' : 'Song excluded from future discovery');
    };
    options.append(button('Skip this song in discovery', () => reject('song')));
    options.append(button('Skip this artist in discovery', () => reject('artist')));
  }
  options.append(button('Find music like this', async () => {
    daily = await api('discovery/run', 'POST', {seed_id: track.id});
    dialog.close();
    navigate('discover');
  }));
  options.append(button('Play next', () => {
    addToQueue([track.id], true);
    dialog.close();
  }), button('Add to end of queue', () => {
    addToQueue([track.id]);
    dialog.close();
  }));
  options.append(button('Loop this song', () => {
    setRepeat(2);
    if (current !== track.id) playTrack(track.id);
    else if (audio.paused) toggle();
    dialog.close();
  }), button('Add to playlist…', () => choosePlaylist(track)));
  const openPlaylist = playlists.find(item => item.id === view && item.tracks.includes(track.id));
  if (openPlaylist) options.append(button('Remove from this playlist', async () => {
    await api('playlists/' + openPlaylist.id, 'PATCH', {
      tracks: openPlaylist.tracks.filter(id => id !== track.id), expected_tracks: openPlaylist.tracks
    });
    dialog.close();
    await refresh();
  }));
  options.append(button('Edit details', () => {
    const edit = node('form', undefined, 'stack');
    const fields = {};
    for (const key of ['title','artist','album','genre']) {
      const label = node('label', key[0].toUpperCase() + key.slice(1));
      const input = node('input');
      input.required = key === 'title' || key === 'artist';
      input.maxLength = input.required ? 300 : 150;
      input.value = track[key] || '';
      label.append(input);
      fields[key] = input;
      edit.append(label);
    }
    edit.append(node('button','Save','primary'));
    edit.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('tracks/' + track.id, 'PATCH', Object.fromEntries(
          Object.entries(fields).map(([key, input]) => [key, input.value])
        ));
        dialog.close();
        await refresh();
      } catch (error) { toast(error.message); }
    };
    modal('Edit song', edit);
  }));
  options.append(button('Delete from library', async () => {
    if (!confirm('Delete this saved audio from Muso?')) return;
    await api('tracks/' + track.id, 'DELETE');
    dialog.close();
    await refresh();
  }));
  modal(track.title, options);
}

function choosePlaylist(trackOrIds) {
  const ids = [...new Set(Array.isArray(trackOrIds) ? trackOrIds : [trackOrIds.id])].filter(trackById);
  if (!ids.length) return toast('Select at least one saved song');
  const options = node('div', undefined, 'stack');
  for (const playlist of playlists) {
    const included = ids.every(id => playlist.tracks.includes(id));
    const choice = button(playlist.name + (included ? ' ✓' : ''), async () => {
      await api('playlists/' + playlist.id, 'PATCH', {
        tracks: [...new Set([...playlist.tracks, ...ids])], expected_tracks: playlist.tracks
      });
      dialog.close();
      await refresh();
      toast('Added to ' + playlist.name);
    });
    choice.disabled = included;
    options.append(choice);
  }
  options.append(form('New playlist name', 'New playlist name', 'Create & add', async name => {
    await api('playlists', 'POST', {name, tracks: ids});
    dialog.close();
    await refresh();
    toast('Added to ' + name);
  }));
  modal('Add to playlist', options);
}

function orderedTracks(container, ids, onChange, play, beforeChange = () => {}) {
  const rows = document.createDocumentFragment();
  let dragged = null;
  ids.forEach((id, index) => {
    const track = trackById(id);
    if (!track) return;
    const entry = node('div', undefined, 'ordered-track');
    const label = play ? button(track.title, () => play(id, index), 'ordered-title') : node('span', track.title, 'ordered-title');
    label.append(node('small', track.artist));
    const controls = node('div', undefined, 'actions');
    const move = destination => {
      if (destination === index) return;
      beforeChange();
      ids.splice(destination, 0, ids.splice(index, 1)[0]);
      onChange();
    };
    const up = button('↑', () => move(index - 1), 'icon', 'Move ' + track.title + ' up');
    const down = button('↓', () => move(index + 1), 'icon', 'Move ' + track.title + ' down');
    up.disabled = index === 0;
    down.disabled = index === ids.length - 1;
    controls.append(up, down, button('✕', () => {
      beforeChange();
      ids.splice(index, 1);
      onChange();
    }, 'icon', 'Remove ' + track.title));
    entry.draggable = true;
    entry.ondragstart = event => {
      dragged = index;
      event.dataTransfer.setData('text/plain', String(index));
      event.dataTransfer.effectAllowed = 'move';
    };
    entry.ondragend = () => { dragged = null; };
    entry.ondragover = event => { if (dragged !== null) event.preventDefault(); };
    entry.ondrop = event => {
      event.preventDefault();
      if (dragged === null || dragged === index) return;
      beforeChange();
      ids.splice(index, 0, ids.splice(dragged, 1)[0]);
      onChange();
    };
    entry.append(label, controls);
    rows.append(entry);
  });
  container.replaceChildren(rows);
}

function managePlaylist(playlist) {
  const draft = [...playlist.tracks];
  const rows = node('div');
  const renderDraft = () => orderedTracks(rows, draft, renderDraft);
  renderDraft();
  const save = form('Playlist name', 'Playlist name', 'Save playlist', async name => {
    await api('playlists/' + playlist.id, 'PATCH', {name, tracks: draft, expected_tracks: playlist.tracks});
    dialog.close();
    sortOrder = 'default';
    await refresh();
  }, playlist.name);
  const actions = node('div', undefined, 'actions');
  actions.append(button('Duplicate playlist', async () => {
    const suffix = ' (copy)';
    const result = await api('playlists', 'POST', {
      name: playlist.name.slice(0, 80 - suffix.length) + suffix, tracks: draft
    });
    dialog.close();
    view = result.id;
    filter = '';
    sortOrder = 'default';
    await refresh();
  }), button('Delete playlist', async () => {
    if (!confirm('Delete this playlist? Its songs will remain in your library.')) return;
    await api('playlists/' + playlist.id, 'DELETE');
    dialog.close();
    view = 'library';
    await refresh();
  }));
  modal('Edit playlist', save, node('p', 'Drag on desktop or use the arrows to reorder. Save to keep your changes.', 'muted'), rows, actions);
}

async function importLink(url, job) {
  const result = await api(job ? 'jobs/' + job + '/match' : 'import', 'POST', {url});
  dialog.close();
  navigate('imports');
  toast(result.message || 'Import queued');
}

function addMusic() {
  const label = node('label', 'Import audio files');
  const upload = node('input');
  upload.type = 'file';
  upload.multiple = true;
  upload.accept = '.mp3,.m4a,.flac,.wav,.ogg,.opus,.aac';
  const status = node('p', 'MP3, M4A, FLAC, WAV, OGG, Opus or AAC.', 'muted');
  upload.onchange = async () => {
    const files = [...upload.files];
    upload.disabled = true;
    let saved = 0;
    let skipped = 0;
    const failures = [];
    for (const file of files) {
      status.textContent = 'Importing ' + file.name + '…';
      const data = new FormData();
      data.append('file', file);
      try {
        const result = await api('upload', 'POST', data);
        if (result.duplicate) skipped++;
        else saved++;
      }
      catch (error) { failures.push(file.name + ': ' + error.message); }
    }
    upload.disabled = false;
    upload.value = '';
    status.textContent = saved + ' imported. ' + (skipped ? skipped + ' already in your library. ' : '') + failures.join(' ');
    try { await refresh(); } catch (error) { toast(error.message); }
  };
  label.append(upload);
  const content = node('div', undefined, 'stack');
  content.append(form('Music link', 'Paste a song link', 'Import link', url => importLink(url)),
    node('small', 'YouTube, Spotify tracks and SoundCloud. Spotify links let you choose a YouTube recording.'),
    label, status);
  modal('Add music', content);
}

function candidates(results, job) {
  const list = node('div', undefined, 'stack');
  if (!results.length) list.append(node('p','No versions found. Try searching with the song and artist.'));
  for (const result of results) {
    const card = node('div', undefined, 'card');
    const link = node('a', 'Check on YouTube');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const actions = node('div', undefined, 'actions');
    actions.append(button(job ? 'Use this recording' : 'Import audio', () => importLink(result.url, job), 'primary'), link);
    card.append(node('strong', result.title), node('p', result.artist + ' · ' + time(result.duration), 'muted'), actions);
    list.append(card);
  }
  return list;
}

async function searchInto(query, results, job) {
  results.replaceChildren(node('p', 'Searching YouTube…'));
  const request = {};
  results.searchRequest = request;
  results.setAttribute('aria-live', 'polite');
  results.setAttribute('aria-busy', 'true');
  try {
    const task = await api('search/tasks', 'POST', {query});
    const deadline = Date.now() + 180000;
    while (results.isConnected && results.searchRequest === request) {
      const data = await api('search/tasks/' + task.id);
      if (!results.isConnected || results.searchRequest !== request) return;
      if (data.status === 'failed') throw new Error(data.error || 'YouTube search failed. Please retry.');
      if (data.status === 'done') {
        results.replaceChildren(candidates(data.results, job));
        return;
      }
      if (Date.now() >= deadline) throw new Error('The search is taking too long. Check your connection, then retry.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (results.isConnected && results.searchRequest === request) {
      results.replaceChildren(node('p', error.message), button('Retry search', () => searchInto(query, results, job)));
    }
  } finally {
    if (results.searchRequest === request) results.setAttribute('aria-busy', 'false');
  }
}

function matchDialog(job) {
  const results = node('div');
  results.append(candidates(job.candidates, job.id));
  modal(job.title || 'Choose a recording', form('Refine search', 'Song and artist', 'Search', query => searchInto(query, results, job.id), job.title),
    form('YouTube recording link', 'Paste a YouTube match', 'Use link', url => importLink(url, job.id)), results);
}

function renderJobs() {
  const body = $('body');
  if (!jobs.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('p','Shared links and downloads will appear here.'),button('Add a link', addMusic, 'primary'));
    body.replaceChildren(empty);
    return;
  }
  body.replaceChildren(...jobs.map(job => {
    const card = node('article', undefined, 'card');
    const state = {queued:'Queued',working:'Importing',needs_match:'Choose a version',failed:'Failed',done:'Ready offline'}[job.status];
    card.append(node('small', job.provider.toUpperCase() + ' · ' + state), node('p', job.title || job.url), node('small', job.message));
    const actions = node('div', undefined, 'actions');
    if (job.status === 'needs_match') actions.append(button('Choose recording', () => matchDialog(job), 'primary'));
    if (job.status === 'failed') actions.append(button('Retry', async () => { await api('jobs/' + job.id + '/retry','POST'); await poll(); }));
    if (job.status === 'done' && trackById(job.track_id)) actions.append(button('Play', () => playTrack(job.track_id)));
    if (job.status !== 'working') actions.append(button('Dismiss', async () => { await api('jobs/' + job.id,'DELETE'); await poll(); }));
    card.append(actions);
    return card;
  }));
}

async function poll() {
  if (importing) return;
  importing = true;
  try {
    const nextJobs = (await api('jobs')).jobs;
    const changed = JSON.stringify(nextJobs) !== JSON.stringify(jobs);
    jobs = nextJobs;
    const newTrack = jobs.some(job => job.status === 'done' && job.track_id && !trackById(job.track_id));
    if (newTrack && changed) await refresh();
    if (view === 'imports' && changed) renderJobs();
    disconnectedSince = 0;
    const pending = jobs.filter(job => ['queued','working','needs_match'].includes(job.status)).length;
    const attention = jobs.filter(job => ['needs_match','failed'].includes(job.status)).length;
    $('imports-badge').hidden = !(pending || attention);
    $('imports-badge').textContent = String(jobs.filter(job => ['queued','working','needs_match','failed'].includes(job.status)).length);
    $('imports-badge').setAttribute('aria-label', attention ? `${attention} imports need attention` : `${pending} pending imports`);
    $('status').textContent = pending ? pending + ' pending · Imports' : '● On this device';
  } finally { importing = false; }
}

function start(collection, index) {
  queue = collection.slice(index + 1).map(track => track.id);
  if (shuffle) shuffleQueue();
  history = [];
  playTrack(collection[index].id);
}

function shuffleQueue() {
  for (let index = queue.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [queue[index], queue[other]] = [queue[other], queue[index]];
  }
}

function savePlayback() {
  const position = resumeAt ?? (audio.ended ? 0 : audio.currentTime);
  try {
    localStorage.setItem(playbackKey, JSON.stringify({
      current, queue, history: history.slice(-100), position, shuffle, repeat, counted
    }));
    lastSavedAt = Date.now();
  } catch { /* Playback still works with browser storage disabled. */ }
}

function restorePlayback() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(playbackKey)); }
  catch { return; }
  if (!saved) return;
  queue = Array.isArray(saved.queue) ? saved.queue.filter(trackById) : [];
  history = Array.isArray(saved.history) ? saved.history.filter(trackById) : [];
  shuffle = saved.shuffle === true;
  repeat = [0, 1, 2].includes(saved.repeat) ? saved.repeat : 0;
  updatePlaybackModes();
  if (trackById(saved.current)) {
    current = saved.current;
    counted = saved.counted ?? true;
    resumeAt = Number.isFinite(saved.position) ? Math.max(0, saved.position) : 0;
    audio.src = '/api/tracks/' + current + '/audio';
  }
  player();
}

function cancelTransition() {
  playbackGeneration++;
  if (fadeRequest) {
    const request = fadeRequest;
    fadeRequest = null;
    clearTimeout(request.timeout);
    request.cancel?.();
    request.incoming.pause();
    sound.gain(request.incoming, 0);
  }
  finishFade();
}

function finishFade() {
  clearTimeout(fadeTimer);
  fadeTimer = null;
  const outgoing = fadingOut;
  fadingOut = null;
  if (outgoing && outgoing !== audio) {
    outgoing.pause();
    sound.gain(outgoing, 0);
    outgoing.removeAttribute('src');
    outgoing.preload = 'none';
    outgoing.load();
  }
  sound.gain(audio, 1);
}

function resumePlayback() {
  const element = audio, generation = playbackGeneration;
  if (!sound.context && !sound.settings.enabled) return element.play();
  return sound.activate().then(() => {
    if (generation === playbackGeneration && element === audio) return element.play();
  });
}

function pausePlayback() {
  cancelTransition();
  audio.pause();
}

function seekPlayback(seconds) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  cancelTransition();
  failedFade = '';
  audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
  position();
}

function commitTrack(id, recordHistory, options = {}) {
  const previousId = current;
  if (options.consume && queue[0] === id) queue.shift();
  if (options.cycle && repeat === 1 && previousId) queue.push(previousId);
  if (recordHistory && previousId && previousId !== id) history.push(previousId);
  queueUndo = null;
  current = id;
  counted = false;
  playedSeconds = 0;
  lastAudioTime = 0;
  resumeAt = null;
  failedFade = '';
  savePlayback();
  player();
  if (dialog.open && $('dialog-title').textContent === 'Play queue') queueDialog();
}

function playTrack(id, recordHistory = true, options = {}) {
  const track = trackById(id);
  if (!track) return;
  cancelTransition();
  if (!options.noFade && sound.canFade && current && current !== id && !audio.paused && audio.readyState >= 2) {
    crossfadeTo(id, recordHistory, options);
    return;
  }
  audio.src = '/api/tracks/' + id + '/audio';
  commitTrack(id, recordHistory, options);
  resumePlayback().catch(() => toast('Tap play to start audio.'));
}

async function crossfadeTo(id, recordHistory, options) {
  const outgoing = audio, incoming = audioDecks.find(element => element !== audio);
  const generation = playbackGeneration;
  const previousId = current;
  const request = {incoming, timeout: null, cancel: null};
  fadeRequest = request;
  sound.gain(incoming, 0);
  const source = '/api/tracks/' + id + '/audio';
  incoming.preload = 'auto';
  if (incoming.getAttribute('src') !== source || incoming.error) incoming.src = source;
  else incoming.currentTime = 0;
  const cancelled = new Promise((_, reject) => {
    request.cancel = () => reject(new Error('Cancelled'));
    request.timeout = setTimeout(() => reject(new Error('The next song did not become ready.')), 8000);
  });
  try {
    await Promise.race([incoming.play(), cancelled]);
    if (generation !== playbackGeneration || outgoing !== audio || current !== previousId || !trackById(id)
      || (options.consume && queue[0] !== id) || (options.automatic && (sleepAfterSong || repeat === 2))
      || (outgoing.paused && !outgoing.ended) || (sleepUntil && Date.now() >= sleepUntil)) {
      if (fadeRequest === request) cancelTransition();
      if (options.automatic && outgoing === audio && outgoing.ended && !checkSleep(true)) advance(true);
      return;
    }
    fadeRequest = null;
    clearTimeout(request.timeout);
    // A slow incoming source must not fade out the old one before it can play.
    const remaining = Math.max(0, (outgoing.duration - outgoing.currentTime) / outgoing.playbackRate);
    const duration = Math.max(0, Math.min(sound.settings.crossfade, options.automatic ? remaining : 1,
      Number.isFinite(incoming.duration) ? incoming.duration / incoming.playbackRate / 2 : 10));
    outgoing.id = 'audio-next';
    incoming.id = 'audio';
    audio = incoming;
    fadingOut = outgoing;
    if (duration > .05 && !outgoing.ended) {
      sound.fade(outgoing, incoming, duration);
      fadeTimer = setTimeout(finishFade, duration * 1000 + 50);
    } else finishFade();
    commitTrack(id, recordHistory, options);
  } catch (error) {
    if (generation !== playbackGeneration) return;
    fadeRequest = null;
    incoming.pause();
    sound.gain(outgoing, 1);
    failedFade = `${previousId}:${id}`;
    if (!options.automatic) toast('Could not start the next song. Your current song is still selected; try again.');
    if (outgoing.ended && options.automatic) playTrack(id, recordHistory, {...options, noFade: true});
  } finally { clearTimeout(request.timeout); }
}

function prepareTransition() {
  if (!sound.canFade || audio.paused || audio.seeking || !queue.length || repeat === 2 || sleepAfterSong || fadeRequest || fadingOut) return;
  const remaining = (audio.duration - audio.currentTime) / audio.playbackRate;
  if (!Number.isFinite(remaining) || remaining <= 0 || (sleepUntil && sleepUntil <= Date.now() + remaining * 1000)) return;
  const id = queue[0];
  if (failedFade === `${current}:${id}` || id === current) return;
  if (remaining <= sound.settings.crossfade + 8) {
    const incoming = audioDecks.find(element => element !== audio);
    const source = '/api/tracks/' + id + '/audio';
    sound.gain(incoming, 0);
    if (incoming.getAttribute('src') !== source) { incoming.preload = 'auto'; incoming.src = source; }
  }
  if (remaining <= sound.settings.crossfade) playTrack(id, true, {automatic: true, consume: true, cycle: repeat === 1});
}

function advance(ended = false) {
  if (ended && repeat === 2 && current) {
    counted = false;
    playedSeconds = 0;
    lastAudioTime = 0;
    audio.currentTime = 0;
    resumePlayback().catch(() => {});
    return;
  }
  if (ended && fadeRequest) return;
  if (ended && repeat === 1 && current && !queue.length) {
    playTrack(current, false, {noFade: true});
    return;
  }
  if (!queue.length) {
    if (!ended) toast('No more songs in the queue');
    player();
    savePlayback();
    return;
  }
  playTrack(queue[0], true, {consume: true, cycle: ended && repeat === 1});
}

function previous() {
  if (audio.currentTime > 3 || !history.length) {
    if (current) seekPlayback(0);
    return;
  }
  if (current) queue.unshift(current);
  playTrack(history.pop(), false);
}

function toggle() {
  if (!current) {
    if (queue.length) advance();
    else if (tracks.length) start(tracks, 0);
    else addMusic();
  } else if (audio.paused) resumePlayback().catch(() => toast('Could not play this audio. Tap Play again.'));
  else pausePlayback();
}

function player() {
  const track = trackById(current);
  coverArt($('now-cover'), track);
  $('now-title').textContent = track?.title || 'Your next favourite awaits';
  $('now-artist').textContent = track?.artist || (queue.length ? queue.length + ' songs queued' : 'Choose a song to get started');
  $('play').replaceChildren(icon(audio.paused ? 'play' : 'pause'));
  $('play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('queue').replaceChildren(icon('playlist'), node('span', queue.length ? 'Queue · ' + queue.length : 'Queue', 'queue-label'));
  $('queue').setAttribute('aria-label', queue.length ? `Play queue, ${queue.length} songs up next` : 'Play queue');
  $('next').disabled = !queue.length;
  $('prev').disabled = !current;
  updateNowPlaying();
  position();
  for (const row of document.querySelectorAll('.track[data-track-id]')) {
    row.classList.toggle('playing', row.dataset.trackId === current);
  }
  if ('mediaSession' in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.artist, album: track.album});
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  }
}

function position() {
  $('elapsed').textContent = time(audio.currentTime);
  $('duration').textContent = time(audio.duration);
  $('seek').value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
  $('seek').disabled = !current || !Number.isFinite(audio.duration) || audio.duration <= 0;
  $('seek').setAttribute('aria-valuetext', `${time(audio.currentTime)} of ${time(audio.duration)}`);
  if ($('np-seek')) {
    $('np-seek').value = $('seek').value;
    $('np-seek').disabled = $('seek').disabled;
    $('np-seek').setAttribute('aria-valuetext', $('seek').getAttribute('aria-valuetext'));
    $('np-elapsed').textContent = $('elapsed').textContent;
    $('np-duration').textContent = $('duration').textContent;
  }
}

function nowPlaying() {
  if (!current && !queue.length) {
    const empty = node('div', undefined, 'empty');
    empty.append(node('strong', 'Let’s put something on.'), node('p', 'Pick a song from your library, or add something new.'),
      button(tracks.length ? 'Play your library' : 'Add music', () => {
        if (tracks.length) { start(tracks, 0); nowPlaying(); }
        else addMusic();
      }, 'primary'));
    modal('Now Playing', empty);
    return;
  }
  const content = node('div', undefined, 'now-playing');
  const identified = (element, id) => { element.id = id; return element; };
  const cover = identified(node('div', '', 'cover now-art'), 'np-cover');
  const details = node('div', undefined, 'now-details');
  const caption = node('div');
  caption.append(identified(node('h3'), 'np-title'), identified(node('p'), 'np-artist'));
  const like = identified(iconButton('heart', async () => {
    const track = trackById(current);
    if (!track) return;
    await api('tracks/' + track.id, 'PATCH', {liked: !track.liked});
    await refresh();
  }, 'Like current song'), 'np-like');
  details.append(caption, like);
  const progress = node('div', undefined, 'progress');
  const seek = identified(node('input'), 'np-seek');
  seek.type = 'range'; seek.min = 0; seek.max = 100; seek.step = 0.1;
  seek.setAttribute('aria-label', 'Seek current song');
  seek.oninput = event => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      seekPlayback(Number(event.target.value) * audio.duration / 100);
    }
  };
  progress.append(identified(node('small'), 'np-elapsed'), seek, identified(node('small'), 'np-duration'));
  const controls = node('div', undefined, 'controls');
  controls.append(
    identified(iconButton('shuffle', toggleShuffle, 'Shuffle'), 'np-shuffle'),
    identified(iconButton('previous', previous, 'Previous'), 'np-prev'),
    identified(iconButton('play', toggle, 'Play', 'primary play'), 'np-play'),
    identified(iconButton('next', () => advance(), 'Next'), 'np-next'),
    identified(iconButton('repeat', () => setRepeat((repeat + 1) % 3), 'Repeat off'), 'np-repeat')
  );
  const actions = node('div', undefined, 'actions');
  actions.append(button('Queue', queueDialog), identified(button('Sleep', () => $('sleep').click()), 'np-sleep'),
    identified(button('Sound', soundDialog), 'np-sound'), button('Song options', () => { const track = trackById(current); if (track) trackMenu(track); }));
  const next = identified(button('', queueDialog, 'up-next', 'View upcoming songs'), 'np-up-next');
  content.append(cover, details, progress, controls, actions, next);
  modal('Now Playing', content);
  updateNowPlaying();
  position();
}

function updateNowPlaying() {
  if (!$('np-title')) return;
  const track = trackById(current);
  coverArt($('np-cover'), track);
  $('np-title').textContent = track?.title || 'Ready when you are';
  $('np-artist').textContent = [track?.artist, track?.album].filter(Boolean).join(' · ') || 'Press play to start your queue';
  $('np-play').replaceChildren(icon(audio.paused ? 'play' : 'pause'));
  $('np-play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('np-prev').disabled = !current;
  $('np-next').disabled = !queue.length;
  $('np-like').disabled = !track;
  $('np-like').classList.toggle('on', Boolean(track?.liked));
  $('np-like').setAttribute('aria-label', track?.liked ? 'Unlike current song' : 'Like current song');
  $('np-like').setAttribute('aria-pressed', Boolean(track?.liked));
  $('np-shuffle').classList.toggle('on', shuffle);
  $('np-shuffle').setAttribute('aria-pressed', shuffle);
  const repeatLabel = ['Repeat off','Repeat queue','Repeat song'][repeat];
  $('np-repeat').replaceChildren(icon('repeat'));
  if (repeat === 2) $('np-repeat').append(node('sup', '1'));
  $('np-repeat').classList.toggle('on', repeat > 0);
  $('np-repeat').setAttribute('aria-label', repeatLabel);
  $('np-repeat').setAttribute('aria-pressed', repeat > 0);
  $('np-sleep').textContent = $('sleep').textContent;
  $('np-sound').classList.toggle('on', sound.settings.enabled);
  const next = trackById(queue[0]);
  const caption = node('span');
  caption.append(node('small', next ? 'Up next' : 'Make it a longer listen'), document.createTextNode(next ? `${next.title} · ${next.artist}` : 'Add songs from your library'));
  $('np-up-next').replaceChildren(icon('playlist'), caption);
}

function queueDialog() {
  const content = node('div', undefined, 'stack');
  const snapshot = () => { queueUndo = {before: [...queue], current}; };
  const changed = () => {
    queueUndo.after = JSON.stringify(queue);
    savePlayback();
    player();
    queueDialog();
  };
  const canUndo = queueUndo && queueUndo.current === current && queueUndo.after === JSON.stringify(queue);
  if (canUndo) content.append(button('Undo queue change', () => {
    queue = queueUndo.before.filter(trackById);
    queueUndo = null;
    savePlayback();
    player();
    queueDialog();
  }));
  const track = trackById(current);
  if (track) {
    content.append(button('Now playing · ' + track.title, nowPlaying, 'quiet'), button(
      repeat === 2 ? 'Stop looping song' : 'Loop current song', () => {
        setRepeat(repeat === 2 ? 0 : 2);
        queueDialog();
      }
    ));
  }
  if (!queue.length) content.append(node('p','The queue is empty.'));
  const ids = [...new Set([current, ...queue])].filter(trackById);
  if (ids.length) content.append(button('Save as playlist', () => choosePlaylist(ids)));
  if (queue.length) {
    const rows = node('div');
    const duration = queue.reduce((sum, id) => sum + (trackById(id)?.duration || 0), 0);
    content.append(node('small', `${queue.length} up next · ${totalTime(duration)} total`));
    orderedTracks(rows, queue, changed, (id, index) => {
      queue.splice(index, 1);
      playTrack(id);
    }, snapshot);
    content.append(rows, button('Clear queue', () => {
      snapshot();
      queue = [];
      changed();
    }));
  }
  modal('Play queue', content);
}

$('close').onclick = () => dialog.close();
$('add').onclick = addMusic;
function newPlaylist() { modal('New playlist', form('Playlist name', 'Playlist name', 'Create', async name => {
  const result = await api('playlists','POST',{name});
  dialog.close();
  navigate(result.id);
  await refresh();
})); }
$('new-playlist').onclick = newPlaylist;
for (const tab of document.querySelectorAll('[data-view]')) tab.onclick = () => navigate(tab.dataset.view);
$('play').onclick = toggle;
$('next').onclick = () => advance();
$('prev').onclick = previous;
$('queue').onclick = queueDialog;
$('now').onclick = nowPlaying;
function updatePlaybackModes() {
  $('shuffle').classList.toggle('on', shuffle);
  $('shuffle').setAttribute('aria-pressed', shuffle);
  const label = ['Repeat off','Repeat queue','Repeat song'][repeat];
  $('repeat').replaceChildren(icon('repeat'));
  if (repeat === 2) $('repeat').append(node('sup', '1'));
  $('repeat').classList.toggle('on', repeat > 0);
  $('repeat').title = label;
  $('repeat').setAttribute('aria-label', label);
  updateNowPlaying();
}
function toggleShuffle() {
  shuffle = !shuffle;
  if (shuffle) shuffleQueue();
  updatePlaybackModes();
  savePlayback();
}
$('shuffle').onclick = toggleShuffle;
function setRepeat(mode) {
  if (fadeRequest) cancelTransition();
  repeat = mode;
  updatePlaybackModes();
  savePlayback();
}
$('repeat').onclick = () => {
  const options = node('div', undefined, 'stack');
  for (const [mode, label] of ['Off', 'Repeat queue', 'Loop current song'].entries()) {
    const choice = button(label + (repeat === mode ? ' ✓' : ''), () => {
      setRepeat(mode);
      dialog.close();
    }, repeat === mode ? 'primary' : undefined);
    choice.setAttribute('aria-pressed', repeat === mode);
    options.append(choice);
  }
  modal('Repeat', options);
};
function updateSleep() {
  const remaining = Math.max(0, Math.ceil((sleepUntil - Date.now()) / 60000));
  $('sleep').textContent = sleepAfterSong ? 'Sleep · end' : sleepUntil ? `Sleep · ${remaining}m` : 'Sleep';
  $('sleep').classList.toggle('on', Boolean(sleepUntil || sleepAfterSong));
  $('sleep').setAttribute('aria-label', sleepAfterSong ? 'Sleep after current song' : sleepUntil ? `Sleep timer: ${remaining} minutes remaining` : 'Sleep timer');
  if ($('np-sleep')) $('np-sleep').textContent = $('sleep').textContent;
}

function soundDialog() {
  const content = node('div', undefined, 'sound-panel');
  const intro = node('p', 'Shape your sound and let songs flow into each other. These settings affect playback on this browser only.', 'muted sound-intro');
  const toggle = button(sound.settings.enabled ? 'EQ & crossfade on' : 'Enable EQ & crossfade', async () => {
    toggle.disabled = true;
    const enabled = !sound.settings.enabled;
    cancelTransition();
    sound.update({enabled});
    try {
      await sound.activate();
      soundDialog();
    } catch (error) {
      sound.update({enabled: false});
      soundDialog();
      toast(error.message);
    }
  }, sound.settings.enabled ? 'primary' : undefined);
  toggle.setAttribute('aria-pressed', sound.settings.enabled);
  toggle.disabled = !sound.supported;
  const presets = node('div', undefined, 'sound-presets');
  const presetButtons = [];
  for (const [name, values] of Object.entries(MusoSound.presets)) {
    const choice = button(name, () => {
      sound.update({bass: values[0], mid: values[1], treble: values[2]});
      soundDialog();
    });
    choice.disabled = !sound.settings.enabled;
    choice.values = values;
    presetButtons.push(choice);
    presets.append(choice);
  }
  function syncPresets() {
    for (const choice of presetButtons) {
      const selected = ['bass', 'mid', 'treble'].every((key, i) => sound.settings[key] === choice.values[i]);
      choice.classList.toggle('primary', selected);
      choice.setAttribute('aria-pressed', selected);
    }
    $('sound').classList.toggle('on', sound.settings.enabled);
  }
  const slider = (key, title, min, max, step, format, disabled = false) => {
    const label = node('label', undefined, 'sound-slider');
    const heading = node('span', undefined, 'sound-slider-heading');
    const value = node('output', format(sound.settings[key]));
    const input = node('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = sound.settings[key];
    input.id = 'sound-' + key;
    input.setAttribute('aria-label', title);
    input.setAttribute('aria-valuetext', value.textContent);
    input.disabled = disabled;
    value.htmlFor = input.id;
    input.oninput = () => {
      if (key === 'crossfade' || key === 'speed') cancelTransition();
      sound.update({[key]: Number(input.value)});
      value.textContent = format(sound.settings[key]);
      input.setAttribute('aria-valuetext', value.textContent);
      syncPresets();
    };
    heading.append(node('span', title), value);
    label.append(heading, input);
    return label;
  };
  const db = value => (value > 0 ? '+' : '') + value + ' dB';
  const eq = node('div', undefined, 'sound-eq');
  eq.append(slider('bass', 'Bass', -6, 6, 1, db, !sound.settings.enabled),
    slider('mid', 'Mids', -6, 6, 1, db, !sound.settings.enabled),
    slider('treble', 'Treble', -6, 6, 1, db, !sound.settings.enabled));
  const transition = node('div', undefined, 'sound-section');
  transition.append(node('h3', 'Smooth transitions'), slider('crossfade', 'Crossfade', 0, 10, 1, value => value ? value + ' seconds' : 'Off', !sound.settings.enabled),
    node('p', 'Overlap the end of a song with the start of the next. Manual skips use a shorter fade. Loop-song and “After this song” keep the full ending.', 'muted'));
  const levels = node('div', undefined, 'sound-section');
  levels.append(slider('volume', 'Volume', 0, 100, 1, value => value + '%'),
    slider('speed', 'Playback speed', .75, 1.5, .05, value => value.toFixed(2) + '×'),
    node('small', 'Speed changes preserve pitch where supported. Boosted EQ bands use automatic headroom to reduce clipping.'));
  const actions = node('div', undefined, 'actions');
  actions.append(button('Reset sound', () => {
    cancelTransition(); sound.update(MusoSound.defaults); soundDialog();
  }), button('Back to Now Playing', nowPlaying));
  content.append(intro, toggle);
  if (!sound.supported) content.append(node('p', 'This browser does not support EQ or crossfade. Volume and speed controls are still available.', 'muted'));
  content.append(node('h3', 'Equalizer'), presets, eq, transition, levels, actions);
  modal('Sound & transitions', content);
  syncPresets();
}
$('sound').onclick = soundDialog;

function setSleep(until = 0, afterSong = false) {
  cancelTransition();
  sleepUntil = until;
  sleepAfterSong = afterSong;
  try { localStorage.setItem(sleepKey, JSON.stringify({until, afterSong})); } catch {}
  scheduleSleepCheck();
  updateSleep();
}

function scheduleSleepCheck() {
  clearTimeout(sleepTimer);
  sleepTimer = sleepUntil ? setTimeout(() => {
    sleepTimer = null;
    checkSleep();
  }, Math.max(1, sleepUntil - Date.now())) : null;
}

function checkSleep(ended = false) {
  if ((sleepUntil && Date.now() >= sleepUntil) || (ended && sleepAfterSong)) {
    setSleep();
    pausePlayback();
    savePlayback();
    toast('Sleep timer finished');
    return true;
  }
  // Timers can fire just before a wall-clock deadline. Re-arm instead of
  // depending on another timeupdate or visibility event to finish the timer.
  if (sleepUntil && sleepTimer === null) scheduleSleepCheck();
  updateSleep();
  return false;
}

function restoreSleep() {
  try {
    const saved = JSON.parse(localStorage.getItem(sleepKey));
    if (saved?.afterSong === true) setSleep(0, true);
    else if (Number.isFinite(saved?.until) && saved.until > Date.now() && saved.until <= Date.now() + 120 * 60000) setSleep(saved.until);
    else setSleep();
  } catch { setSleep(); }
}

$('sleep').onclick = () => {
  const options = node('div', undefined, 'actions');
  const status = sleepAfterSong ? 'Playback will stop at the end of the song, even with repeat enabled.'
    : sleepUntil ? 'Playback pauses at ' + new Date(sleepUntil).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'Choose when playback should pause.';
  for (const minutes of [15, 30, 60, 90]) options.append(button(minutes + ' min', () => {
    setSleep(Date.now() + minutes * 60000);
    dialog.close();
    toast('Playback will pause in ' + minutes + ' minutes');
  }));
  const endSong = button('After this song', () => {
    setSleep(0, true);
    dialog.close();
    toast('Playback will stop after this song');
  });
  endSong.disabled = !current;
  options.append(endSong, button('Turn off', () => {
    setSleep();
    dialog.close();
  }));
  modal('Sleep timer', node('p', status), options);
};
$('seek').oninput = event => {
  if (Number.isFinite(audio.duration)) seekPlayback(Number(event.target.value) * audio.duration / 100);
};
for (const element of audioDecks) {
element.onended = () => {
  if (element !== audio) { if (element === fadingOut) finishFade(); return; }
  if (!checkSleep(true)) advance(true);
};
element.onpause = () => {
  if (element !== audio) return;
  if (!element.ended) cancelTransition();
  player(); savePlayback();
};
element.onplay = () => { if (element === audio) { checkSleep(); player(); } };
element.onloadedmetadata = () => {
  if (element !== audio) return;
  if (resumeAt !== null) {
    if (Number.isFinite(audio.duration) && resumeAt < audio.duration) audio.currentTime = resumeAt;
    resumeAt = null;
  }
  position();
};
element.onseeking = () => { if (element === audio) cancelTransition(); };
element.onseeked = () => { if (element === audio) { lastAudioTime = audio.currentTime; savePlayback(); } };
element.ontimeupdate = () => {
  if (element !== audio) return;
  if (checkSleep()) return;
  position();
  if (!audio.paused && Date.now() - lastSavedAt > 3000) savePlayback();
  const elapsed = audio.currentTime - lastAudioTime;
  lastAudioTime = audio.currentTime;
  if (!audio.paused && !audio.seeking && elapsed > 0 && elapsed <= 2) playedSeconds += elapsed;
  if (!counted && current && playedSeconds >= Math.min(5, audio.duration / 2)) {
    counted = true;
    const played = trackById(current);
    api('tracks/' + current + '/played', 'POST').then(() => {
      if (played) {
        played.plays++;
        played.last_played = Date.now() / 1000;
      }
    }).catch(() => {});
  }
  prepareTransition();
};
element.onerror = () => {
  if (element === audio && current) { cancelTransition(); toast('This browser could not read the saved audio.'); }
  else if (element === fadingOut) finishFade();
};
}
if ('mediaSession' in navigator) {
  for (const [action, callback] of Object.entries({play: () => resumePlayback().catch(() => {}), pause: pausePlayback, nexttrack: () => advance(), previoustrack: previous, seekto: event => seekPlayback(event.seekTime)})) {
    try { navigator.mediaSession.setActionHandler(action, callback); } catch { /* Browser support varies. */ }
  }
}

function resumeAfterReload() {
  let intent;
  try {
    intent = JSON.parse(sessionStorage.getItem('muso.reloadPlayback'));
    sessionStorage.removeItem('muso.reloadPlayback');
  } catch { return; }
  if (!intent || !current || intent.track !== current || intent.sleepUntil && intent.sleepUntil <= Date.now()) return;
  if (performance.getEntriesByType('navigation')[0]?.type !== 'reload') return;
  resumePlayback().catch(error => {
    if (error.name === 'NotAllowedError') toast('Tap Play to resume where you left off.');
  });
}

const launch = new URLSearchParams(location.search);
if (launch.has('imports')) view = 'imports';
else if (launch.has('discover')) view = 'discover';
initializeLibrary().then(poll).catch(error => toast(error.message));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkSleep();
  initializeLibrary().then(poll).catch(() => {});
});
window.addEventListener('pagehide', () => {
  if (current || queue.length) savePlayback();
  try {
    if (current && !audio.paused && !audio.ended) {
      sessionStorage.setItem('muso.reloadPlayback', JSON.stringify({track: current, sleepUntil}));
    } else {
      sessionStorage.removeItem('muso.reloadPlayback');
    }
  } catch { /* The saved queue remains available when session storage is disabled. */ }
});
setInterval(() => {
  if (document.visibilityState === 'visible') {
    checkSleep();
    initializeLibrary().then(poll).catch(() => {});
  }
}, 3500);
setInterval(async () => {
  if (!libraryReady || discoveryPolling || document.visibilityState !== 'visible') return;
  discoveryPolling = true;
  try {
    const status = await api('discovery');
    if (JSON.stringify(status) !== JSON.stringify(daily)) {
      if (view === 'discover') {
        ({tracks, playlists, discovery: daily} = await api('library'));
        updateDailyControls?.();
      } else {
        await refresh();
      }
    }
  } catch { /* A stopped server will be checked again on the next tick. */ }
  finally { discoveryPolling = false; }
}, 5000);

let installPrompt;
const installButton = $('install');
installButton.hidden = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
});
installButton.onclick = async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') installButton.hidden = true;
  } else {
    modal('Install Muso', node('p', 'Open your browser menu and choose Install app or Add to Home screen.'));
  }
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

