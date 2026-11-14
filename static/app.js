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
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    current = '';
  }
  queue = queue.filter(trackById);
  render();
  player();
}

function navigate(next) {
  view = next;
  filter = '';
  render();
  if (view === 'imports') poll().catch(error => toast(error.message));
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
  $('heading').textContent = playlist?.name || ({library:'Library', liked:'Liked songs', discover:'Discover', imports:'Imports'}[view] || 'Library');
  $('body').replaceChildren();
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
    const toggle = button('', async () => {
      daily = await api('discovery', 'PATCH', {enabled: !daily.enabled});
      updateDaily();
    });
    function updateDaily() {
      status.textContent = daily.enabled
        ? daily.added + ' of 3 new songs saved today. Muso looks for more while it runs.'
        : 'Automatic additions are paused.';
      toggle.textContent = daily.enabled ? 'Pause daily discovery' : 'Enable daily discovery';
    }
    if (daily) {
      controls.append(node('strong', 'Daily discovery'), status, toggle);
      updateDaily();
      updateDailyControls = updateDaily;
      $('body').append(controls);
    }
    $('body').append(search, results);
    return;
  }
  const collection = playlist ? playlist.tracks.map(trackById).filter(Boolean) : tracks.filter(track => view !== 'liked' || track.liked);
  $('summary').textContent = collection.length + (collection.length === 1 ? ' song saved on this device' : ' songs saved on this device');
  const toolbar = node('div', undefined, 'toolbar');
  const input = node('input');
  input.type = 'search';
  input.placeholder = 'Filter songs…';
  input.setAttribute('aria-label', 'Filter songs');
  input.value = filter;
  const list = node('div');
  function renderList() {
    const query = filter.toLocaleLowerCase();
    const shown = collection.filter(t => [t.title,t.artist,t.album].some(value => value.toLocaleLowerCase().includes(query)));
    list.replaceChildren(...shown.map((track, index) => row(track, () => start(shown, index))));
    if (!shown.length) {
      const empty = node('div', undefined, 'empty');
      empty.append(node('strong', filter ? 'No matching songs' : 'No songs yet'), node('p', filter ? 'Try a different search.' : 'Add a link or import audio from your phone.'));
      if (!filter) empty.append(button('Add music', addMusic, 'primary'));
      list.append(empty);
    }
  }
  input.oninput = () => { filter = input.value; renderList(); };
  toolbar.append(input, button('Play all', () => {
    const query = filter.toLocaleLowerCase();
    const shown = collection.filter(t => [t.title,t.artist,t.album].some(value => value.toLocaleLowerCase().includes(query)));
    if (shown.length) start(shown, 0);
  }));
  if (playlist) toolbar.append(button('Manage', () => managePlaylist(playlist)));
  $('body').append(toolbar, list);
  renderList();
}

function row(track, play) {
  const item = node('div', undefined, 'track');
  const song = button('', play, 'song', 'Play ' + track.title);
  const caption = node('span');
  caption.append(node('strong', track.title), node('small', track.artist + (track.duration ? ' · ' + time(track.duration) : '')));
  song.append(node('span', current === track.id ? '▶' : '♫', 'cover'), caption);
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
    dialog.close();
    toast('Added to play next');
  }), button('Add to end of queue', () => {
    queue.push(track.id);
    dialog.close();
    toast('Added to queue');
  }));
  for (const playlist of playlists) {
    const included = playlist.tracks.includes(track.id);
    options.append(button((included ? 'Remove from ' : 'Add to ') + playlist.name, async () => {
      const ids = included ? playlist.tracks.filter(id => id !== track.id) : [...playlist.tracks, track.id];
      await api('playlists/' + playlist.id, 'PATCH', {tracks: ids});
      dialog.close();
      await refresh();
    }));
  }
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
  const link = node('a', 'Download audio file');
  link.href = '/api/tracks/' + track.id + '/audio?download=1';
  options.append(link, button('Delete song', async () => {
    if (!confirm('Delete this saved audio from Muso?')) return;
    await api('tracks/' + track.id, 'DELETE');
    dialog.close();
    await refresh();
  }));
  modal(track.title, options);
}

function managePlaylist(playlist) {
  modal('Manage playlist', form('Playlist name', 'Playlist name', 'Rename', async name => {
    await api('playlists/' + playlist.id, 'PATCH', {name});
    dialog.close();
    await refresh();
  }, playlist.name), button('Delete playlist', async () => {
    if (!confirm('Delete this playlist? Its songs will remain in your library.')) return;
    await api('playlists/' + playlist.id, 'DELETE');
    dialog.close();
    view = 'library';
    await refresh();
  }));
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
  history = [];
  playTrack(collection[index].id);
}

function playTrack(id, recordHistory = true) {
  const track = trackById(id);
  if (!track) return;
  if (recordHistory && current && current !== id) history.push(current);
  current = id;
  counted = false;
  audio.src = '/api/tracks/' + id + '/audio';
  player();
  audio.play().catch(() => toast('Tap play to start audio.'));
}

function advance(ended = false) {
  if (ended && repeat === 2 && current) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (ended && repeat === 1 && current) queue.push(current);
  if (!queue.length) {
    if (!ended) toast('No more songs in the queue');
    player();
    return;
  }
  const index = shuffle ? Math.floor(Math.random() * queue.length) : 0;
  playTrack(queue.splice(index, 1)[0]);
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
  $('now-title').textContent = track?.title || 'Nothing playing';
  $('now-artist').textContent = track?.artist || (queue.length ? queue.length + ' songs queued' : 'Your queue is empty');
  $('play').textContent = audio.paused ? '▶' : '⏸';
  $('play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
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
  if (track) content.append(node('p', 'Now playing · ' + track.title));
  if (!queue.length) content.append(node('p','The queue is empty.'));
  queue.forEach((id, index) => {
    const next = trackById(id);
    if (!next) return;
    const actions = node('div', undefined, 'actions');
    actions.append(button(next.title, () => { queue.splice(index, 1); playTrack(id); queueDialog(); }),
      button('Remove', () => { queue.splice(index, 1); queueDialog(); }));
    content.append(actions);
  });
  if (queue.length) content.append(button('Clear queue', () => { queue = []; queueDialog(); }));
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
$('shuffle').onclick = () => {
  shuffle = !shuffle;
  $('shuffle').classList.toggle('on', shuffle);
  $('shuffle').setAttribute('aria-pressed', shuffle);
};
$('repeat').onclick = () => {
  repeat = (repeat + 1) % 3;
  const label = ['Repeat off','Repeat queue','Repeat song'][repeat];
  $('repeat').textContent = repeat === 2 ? '↻¹' : '↻';
  $('repeat').classList.toggle('on', repeat > 0);
  $('repeat').title = label;
  $('repeat').setAttribute('aria-label', label);
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
audio.onpause = player;
audio.onplay = player;
audio.onloadedmetadata = position;
audio.ontimeupdate = () => {
  position();
  if (!counted && current && audio.currentTime >= Math.min(5, audio.duration / 2)) {
    counted = true;
    api('tracks/' + current + '/played', 'POST').catch(() => {});
  }
};
audio.onerror = () => { if (current) toast('This browser could not read the saved audio.'); };
if ('mediaSession' in navigator) {
  for (const [action, callback] of Object.entries({play: () => audio.play().catch(() => {}), pause: () => audio.pause(), nexttrack: () => advance(), previoustrack: previous, seekto: event => { if (Number.isFinite(audio.duration)) audio.currentTime = event.seekTime; }})) {
    try { navigator.mediaSession.setActionHandler(action, callback); } catch { /* Browser support varies. */ }
  }
}

const fromShare = new URLSearchParams(location.search).has('imports');
if (fromShare) view = 'imports';
refresh().then(poll).catch(error => toast(error.message));
setInterval(() => {
  if (document.visibilityState === 'visible') poll().catch(() => {});
}, 3500);
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  try {
    const status = await api('discovery');
    if (status.added !== daily?.added || status.enabled !== daily?.enabled) {
      if (view === 'discover') {
        ({tracks, playlists, discovery: daily} = await api('library'));
        updateDailyControls?.();
      } else {
        await refresh();
      }
    }
  } catch { /* A stopped server will be checked again on the next tick. */ }
}, 15000);
