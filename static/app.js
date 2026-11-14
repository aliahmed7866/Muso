'use strict';
const $ = id => document.getElementById(id);
const audio = $('audio');
const dialog = $('dialog');
const token = document.querySelector('meta[name=muso-token]').content;
let tracks = [], playlists = [], jobs = [], view = 'library', filter = '';
let daily = null;
let updateDailyControls;
let queue = [], current = '', history = [], shuffle = false, repeat = 0, counted = false;
let sleepTimer, toastTimer, importing = false;
let sortOrder = 'default', resumeAt = null, lastSavedAt = 0;
let playedSeconds = 0, lastAudioTime = 0;
const recapMonth = new Date();
recapMonth.setDate(1);
const playbackKey = 'muso.playback.v1';
const trackOrder = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const trackById = id => tracks.find(track => track.id === id);
const time = value => Number.isFinite(value) ? Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0') : '0:00';

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
  const response = await fetch('/api/' + path, {method, body: data, headers});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Muso could not complete that action.');
  return result;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}

function modal(title, ...content) {
  $('dialog-title').textContent = title;
  $('dialog-body').replaceChildren(...content);
  if (!dialog.open) dialog.showModal();
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

async function refresh() {
  ({tracks, playlists, discovery: daily} = await api('library'));
  if (current && !trackById(current)) {
    current = '';
    resumeAt = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  queue = queue.filter(trackById);
  history = history.filter(trackById);
  render();
  player();
}

function navigate(next) {
  view = next;
  filter = '';
  sortOrder = 'default';
  render();
  if (view === 'imports') poll().catch(error => toast(error.message));
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
    for (const artist of data.top_artists) {
      const entry = node('li');
      const bar = node('progress');
      bar.max = data.top_artists[0].plays;
      bar.value = artist.plays;
      bar.setAttribute('aria-label', artist.artist + ' plays');
      entry.append(node('span', artist.artist), node('small', artist.plays + ' plays'), bar);
      artistList.append(entry);
    }
    const songList = node('ol', undefined, 'recap-ranks');
    for (const track of data.top_tracks) {
      const entry = node('li');
      const title = track.title + ' · ' + track.artist;
      entry.append(track.available ? button(title, () => playTrack(track.id), 'quiet') : node('span', title),
        node('small', track.plays + ' plays'));
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

function render() {
  updateDailyControls = null;
  for (const tab of document.querySelectorAll('[data-view]')) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', selected);
  }
  $('playlists').replaceChildren(...playlists.map(playlist =>
    button(playlist.name, () => navigate(playlist.id), view === playlist.id ? 'selected' : '')));
  const playlist = playlists.find(item => item.id === view);
  $('heading').textContent = playlist?.name || ({library:'Library', liked:'Liked songs', discover:'Discover', finds:'Daily Finds', imports:'Imports', recap:'Monthly Recap'}[view] || 'Library');
  $('body').replaceChildren();
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
      try {
        daily = await api('discovery/run', 'POST');
      } finally {
        updateDaily();
      }
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
  const collection = playlist ? playlist.tracks.map(trackById).filter(Boolean) : tracks.filter(track => {
    if (view === 'liked') return track.liked;
    if (view === 'finds') return track.discovered_on;
    return true;
  });
  $('summary').textContent = collection.length + (collection.length === 1 ? ' song saved on this device' : ' songs saved on this device');
  const toolbar = node('div', undefined, 'toolbar');
  const input = node('input');
  input.type = 'search';
  input.placeholder = 'Filter songs…';
  input.setAttribute('aria-label', 'Filter songs');
  input.value = filter;
  const sort = node('select');
  sort.setAttribute('aria-label', 'Sort songs');
  for (const [value, label] of [
    ['default', playlist ? 'Playlist order' : 'Newest added'],
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
  const playAll = button('Play all', () => { if (shown.length) start(shown, 0); });
  const list = node('div');
  let shown = [];
  function renderList() {
    const words = filter.toLocaleLowerCase().trim().split(/\s+/);
    shown = collection.filter(track => {
      const searchable = [track.title, track.artist, track.album].join(' ').toLocaleLowerCase();
      return words.every(word => searchable.includes(word));
    });
    if (comparators[sortOrder]) shown.sort(comparators[sortOrder]);
    playAll.disabled = !shown.length;
    list.replaceChildren(...shown.map((track, index) => row(track, () => start(shown, index))));
    if (!shown.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('strong', filter ? 'No matching songs' : 'No songs yet'));
      if (filter) empty.append(node('p', 'Try a different search.'));
      else if (view === 'finds') empty.append(node('p', 'Songs saved by Daily Discovery will appear here.'), button('Back to Discover', () => navigate('discover')));
      else empty.append(node('p', 'Add a link or import audio from your phone.'), button('Add music', addMusic, 'primary'));
      list.append(empty);
    }
  }
  input.oninput = () => { filter = input.value; renderList(); };
  sort.onchange = () => { sortOrder = sort.value; renderList(); };
  toolbar.append(input, sort, playAll);
  if (playlist) {
    toolbar.append(button('Edit playlist', () => managePlaylist(playlist), undefined, 'Edit ' + playlist.name));
    toolbar.append(button('Queue playlist', () => {
      queue.push(...playlist.tracks.filter(trackById));
      savePlayback();
      player();
      toast('Playlist added to the queue');
    }));
  }
  $('body').append(toolbar, list);
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
  const song = button('', play, 'song', 'Play ' + track.title);
  const caption = node('span');
  const detail = [track.artist];
  if (track.duration) detail.push(time(track.duration));
  if (view === 'finds') detail.push(track.discovered_on);
  caption.append(node('strong', track.title), node('small', detail.join(' · ')));
  const cover = node('span', '', 'cover');
  coverArt(cover, track);
  song.append(cover, caption);
  const actions = node('div', undefined, 'actions');
  actions.append(button(track.liked ? '♥' : '♡', async () => {
    await api('tracks/' + track.id, 'PATCH', {liked: !track.liked});
    await refresh();
  }, 'icon' + (track.liked ? ' on' : ''), track.liked ? 'Unlike ' + track.title : 'Like ' + track.title),
  button('⋯', () => trackMenu(track), 'icon', 'Options for ' + track.title));
  item.append(song, actions);
  return item;
}

function trackMenu(track) {
  const options = node('div', undefined, 'stack');
  options.append(button('Play next', () => {
    queue.unshift(track.id);
    savePlayback();
    player();
    dialog.close();
    toast('Added to play next');
  }), button('Add to end of queue', () => {
    queue.push(track.id);
    savePlayback();
    player();
    dialog.close();
    toast('Added to queue');
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
    for (const key of ['title','artist']) {
      const label = node('label', key === 'title' ? 'Title' : 'Artist');
      const input = node('input');
      input.required = true;
      input.value = track[key];
      label.append(input);
      fields[key] = input;
      edit.append(label);
    }
    edit.append(node('button','Save','primary'));
    edit.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('tracks/' + track.id, 'PATCH', {title: fields.title.value, artist: fields.artist.value});
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

function choosePlaylist(track) {
  const options = node('div', undefined, 'stack');
  for (const playlist of playlists) {
    const included = playlist.tracks.includes(track.id);
    const choice = button(playlist.name + (included ? ' ✓' : ''), async () => {
      await api('playlists/' + playlist.id, 'PATCH', {
        tracks: [...playlist.tracks, track.id], expected_tracks: playlist.tracks
      });
      dialog.close();
      await refresh();
      toast('Added to ' + playlist.name);
    });
    choice.disabled = included;
    options.append(choice);
  }
  options.append(form('New playlist name', 'New playlist name', 'Create & add', async name => {
    await api('playlists', 'POST', {name, tracks: [track.id]});
    dialog.close();
    await refresh();
    toast('Added to ' + name);
  }));
  modal('Add to playlist', options);
}

function orderedTracks(container, ids, onChange, play) {
  const rows = document.createDocumentFragment();
  let dragged = null;
  ids.forEach((id, index) => {
    const track = trackById(id);
    if (!track) return;
    const entry = node('div', undefined, 'ordered-track');
    const label = play ? button(track.title, () => play(id, index), 'ordered-title') : node('span', track.title, 'ordered-title');
    const controls = node('div', undefined, 'actions');
    const move = destination => {
      if (destination === index) return;
      ids.splice(destination, 0, ids.splice(index, 1)[0]);
      onChange();
    };
    const up = button('↑', () => move(index - 1), 'icon', 'Move ' + track.title + ' up');
    const down = button('↓', () => move(index + 1), 'icon', 'Move ' + track.title + ' down');
    up.disabled = index === 0;
    down.disabled = index === ids.length - 1;
    controls.append(up, down, button('✕', () => {
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
    const failures = [];
    for (const file of files) {
      status.textContent = 'Importing ' + file.name + '…';
      const data = new FormData();
      data.append('file', file);
      try { await api('upload', 'POST', data); saved++; }
      catch (error) { failures.push(file.name + ': ' + error.message); }
    }
    upload.disabled = false;
    upload.value = '';
    status.textContent = saved + ' imported. ' + failures.join(' ');
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
  try {
    const data = await api('search', 'POST', {query});
    results.replaceChildren(candidates(data.results, job));
  } catch (error) {
    results.replaceChildren(node('p', error.message));
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
    const pending = jobs.filter(job => ['queued','working','needs_match'].includes(job.status)).length;
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

function playTrack(id, recordHistory = true) {
  const track = trackById(id);
  if (!track) return;
  if (recordHistory && current && current !== id) history.push(current);
  current = id;
  counted = false;
  playedSeconds = 0;
  lastAudioTime = 0;
  resumeAt = null;
  audio.src = '/api/tracks/' + id + '/audio';
  savePlayback();
  player();
  audio.play().catch(() => toast('Tap play to start audio.'));
  if (dialog.open && $('dialog-title').textContent === 'Play queue') queueDialog();
}

function advance(ended = false) {
  if (ended && repeat === 2 && current) {
    counted = false;
    playedSeconds = 0;
    lastAudioTime = 0;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (ended && repeat === 1 && current) queue.push(current);
  if (!queue.length) {
    if (!ended) toast('No more songs in the queue');
    player();
    savePlayback();
    return;
  }
  playTrack(queue.shift());
}

function previous() {
  if (audio.currentTime > 3 || !history.length) {
    if (current) audio.currentTime = 0;
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
  } else if (audio.paused) audio.play().catch(() => toast('Could not play this audio.'));
  else audio.pause();
}

function player() {
  const track = trackById(current);
  coverArt($('now-cover'), track);
  $('now-title').textContent = track?.title || 'Nothing playing';
  $('now-artist').textContent = track?.artist || (queue.length ? queue.length + ' songs queued' : 'Your queue is empty');
  $('play').textContent = audio.paused ? '▶' : '⏸';
  $('play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('queue').textContent = queue.length ? 'Queue · ' + queue.length : 'Queue';
  if ('mediaSession' in navigator && track) {
    navigator.mediaSession.metadata = new MediaMetadata({title: track.title, artist: track.artist, album: track.album});
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  }
}

function position() {
  $('elapsed').textContent = time(audio.currentTime);
  $('duration').textContent = time(audio.duration);
  $('seek').value = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
}

function queueDialog() {
  const content = node('div', undefined, 'stack');
  const track = trackById(current);
  if (track) {
    content.append(node('p', 'Now playing · ' + track.title), button(
      repeat === 2 ? 'Stop looping song' : 'Loop current song', () => {
        setRepeat(repeat === 2 ? 0 : 2);
        queueDialog();
      }
    ));
  }
  if (!queue.length) content.append(node('p','The queue is empty.'));
  if (queue.length) {
    const rows = node('div');
    const changed = () => { savePlayback(); player(); queueDialog(); };
    orderedTracks(rows, queue, changed, (id, index) => {
      queue.splice(index, 1);
      playTrack(id);
    });
    content.append(rows, button('Clear queue', () => {
      queue = [];
      changed();
    }));
  }
  modal('Play queue', content);
}

$('close').onclick = () => dialog.close();
$('add').onclick = addMusic;
$('new-playlist').onclick = () => modal('New playlist', form('Playlist name', 'Playlist name', 'Create', async name => {
  const result = await api('playlists','POST',{name});
  dialog.close();
  view = result.id;
  await refresh();
}));
for (const tab of document.querySelectorAll('[data-view]')) tab.onclick = () => navigate(tab.dataset.view);
$('play').onclick = toggle;
$('next').onclick = () => advance();
$('prev').onclick = previous;
$('queue').onclick = $('now').onclick = queueDialog;
function updatePlaybackModes() {
  $('shuffle').classList.toggle('on', shuffle);
  $('shuffle').setAttribute('aria-pressed', shuffle);
  const label = ['Repeat off','Repeat queue','Repeat song'][repeat];
  $('repeat').textContent = repeat === 2 ? '↻¹' : '↻';
  $('repeat').classList.toggle('on', repeat > 0);
  $('repeat').title = label;
  $('repeat').setAttribute('aria-label', label);
}
$('shuffle').onclick = () => {
  shuffle = !shuffle;
  if (shuffle) shuffleQueue();
  updatePlaybackModes();
  savePlayback();
};
function setRepeat(mode) {
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
$('sleep').onclick = () => {
  const options = node('div', undefined, 'actions');
  for (const minutes of [15,30,60]) options.append(button(minutes + ' min', () => {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => { audio.pause(); $('sleep').classList.remove('on'); }, minutes * 60000);
    $('sleep').classList.add('on');
    dialog.close();
    toast('Playback will pause in ' + minutes + ' minutes');
  }));
  options.append(button('Turn off', () => {
    clearTimeout(sleepTimer);
    $('sleep').classList.remove('on');
    dialog.close();
  }));
  modal('Sleep timer', options);
};
$('seek').oninput = event => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value) * audio.duration / 100;
};
audio.onended = () => advance(true);
audio.onpause = () => { player(); savePlayback(); };
audio.onplay = player;
audio.onloadedmetadata = () => {
  if (resumeAt !== null) {
    if (Number.isFinite(audio.duration) && resumeAt < audio.duration) audio.currentTime = resumeAt;
    resumeAt = null;
  }
  position();
};
audio.onseeked = () => { lastAudioTime = audio.currentTime; savePlayback(); };
audio.ontimeupdate = () => {
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
};
audio.onerror = () => { if (current) toast('This browser could not read the saved audio.'); };
if ('mediaSession' in navigator) {
  for (const [action, callback] of Object.entries({play: () => audio.play().catch(() => {}), pause: () => audio.pause(), nexttrack: () => advance(), previoustrack: previous, seekto: event => { if (Number.isFinite(audio.duration)) audio.currentTime = event.seekTime; }})) {
    try { navigator.mediaSession.setActionHandler(action, callback); } catch { /* Browser support varies. */ }
  }
}

const launch = new URLSearchParams(location.search);
if (launch.has('imports')) view = 'imports';
else if (launch.has('discover')) view = 'discover';
refresh().then(() => {
  restorePlayback();
  return poll();
}).catch(error => toast(error.message));
window.addEventListener('pagehide', () => {
  if (current || queue.length) savePlayback();
});
setInterval(() => {
  if (document.visibilityState === 'visible') poll().catch(() => {});
}, 3500);
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
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
