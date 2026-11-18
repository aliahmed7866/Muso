'use strict';
// Only injected by the APK. The website keeps its existing browser audio engine.
(() => {
  if (!window.MusoBridge) return;
  let sequence = 0, busy = 0, polling = false, lastError = '';
  const pending = new Map();
  const call = (action, args = {}) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Muso is taking longer than expected. Please retry.')); }, ['import', 'backup'].includes(action) ? 3600000 : 30000);
    pending.set(id, {resolve, reject, timer});
    window.MusoBridge.postMessage(JSON.stringify({id, action, args}));
  });
  const native = window.MusoAndroid = {
    state: {}, onState: null, shared: '',
    resolve(id, result, error) {
      const task = pending.get(String(id));
      if (!task) return;
      clearTimeout(task.timer); pending.delete(String(id));
      if (error) task.reject(new Error(error)); else task.resolve(result);
    },
    async api(path, method, body) {
      const result = await call('api', {path, method, body});
      if (result.status >= 400) throw new Error(result.data?.error || 'Muso could not complete that action.');
      return result.data;
    },
    async command(op, args = {}) {
      busy++;
      try {
        const state = await call('playback', {op, ...args});
        native.accept(state);
        return state;
      } finally { busy--; }
    },
    accept(state) {
      native.state = state;
      native.audio.currentTime = state.position || 0;
      native.audio.duration = state.duration || 0;
      native.audio.paused = !state.playing;
      native.onState?.(state);
      if (state.error && state.error !== lastError) window.dispatchEvent(new CustomEvent('muso-native-error', {detail: state.error}));
      lastError = state.error || '';
    },
    async poll() {
      if (busy || polling || document.visibilityState === 'hidden') return;
      polling = true;
      try { const state = await call('playback', {op: 'state'}); if (!busy) native.accept(state); }
      catch (error) { window.dispatchEvent(new CustomEvent('muso-native-error', {detail: error.message})); }
      finally { polling = false; }
    },
    sync(current, queue, history, repeat, shuffle) {
      if (!current && !queue.length) return;
      native.command('queue', {current, ids: [...history, ...(current ? [current] : []), ...queue], index: history.length, repeat, shuffle}).catch(error => {
        window.dispatchEvent(new CustomEvent('muso-native-error', {detail: error.message}));
      });
    },
    audio: {
      currentTime: 0, duration: 0, paused: true, ended: false, seeking: false,
      pause() { native.command('pause').catch(() => {}); },
      play() { return native.command('play'); },
      removeAttribute() { native.command('clear').catch(() => {}); }, load() {}
    },
    createSound(Base) {
      return new class {
        settings = {...Base.defaults, crossfade: 0};
        supported = true; canFade = false; context = null;
        update(values) {
          const sanitize = Base.prototype.sanitize;
          this.settings = sanitize.call(this, {...this.settings, ...values, crossfade: 0});
          native.command('sound', {settings: this.settings}).catch(error => window.dispatchEvent(new CustomEvent('muso-native-error', {detail: error.message})));
        }
        activate() { return Promise.resolve(); }
        gain() {}
      }();
    },
    importAudio: () => call('import'),
    transfer: (op, args = {}) => call('transfer', {op, ...args})
  };
  setInterval(() => native.onState && native.poll(), 500);
  document.addEventListener('visibilitychange', () => native.onState && native.poll());
})();
