'use strict';

// Streaming media stays in <audio>; no full-song decoding or file modification.
class MusoSound {
  static defaults = {enabled: false, volume: 100, speed: 1, bass: 0, mid: 0, treble: 0, crossfade: 3};
  static key = 'muso.sound.v1';
  static presets = {Balanced: [0, 0, 0], Warm: [3, 0, -2], Bass: [6, -1, 0], Vocals: [-2, 4, 1], Bright: [-1, 1, 4]};

  constructor(elements) {
    this.elements = elements;
    this.context = null;
    this.gains = new Map();
    this.settings = {...MusoSound.defaults};
    try { this.settings = this.sanitize(JSON.parse(localStorage.getItem(MusoSound.key))); } catch {}
    this.supported = Boolean(window.AudioContext || window.webkitAudioContext);
    if (!this.supported) this.settings.enabled = false;
    this.apply();
  }

  sanitize(value) {
    const result = {...MusoSound.defaults};
    if (!value || typeof value !== 'object') return result;
    result.enabled = value.enabled === true;
    for (const [key, min, max] of [['volume', 0, 100], ['speed', .75, 1.5], ['bass', -6, 6], ['mid', -6, 6], ['treble', -6, 6], ['crossfade', 0, 10]]) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = Math.min(max, Math.max(min, value[key]));
    }
    return result;
  }

  update(values) {
    this.settings = this.sanitize({...this.settings, ...values});
    this.apply();
    try { localStorage.setItem(MusoSound.key, JSON.stringify(this.settings)); } catch {}
  }

  async activate() {
    if (!this.context && this.settings.enabled && this.supported) {
      const Context = window.AudioContext || window.webkitAudioContext;
      this.context = new Context();
      this.filters = [['lowshelf', 180], ['peaking', 1200], ['highshelf', 4500]].map(([type, frequency]) => {
        const filter = this.context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = .7;
        return filter;
      });
      this.headroom = this.context.createGain();
      this.filters[0].connect(this.filters[1]);
      this.filters[1].connect(this.filters[2]);
      this.filters[2].connect(this.headroom);
      this.headroom.connect(this.context.destination);
      for (const element of this.elements) {
        const gain = this.context.createGain();
        gain.connect(this.filters[0]);
        this.context.createMediaElementSource(element).connect(gain);
        this.gains.set(element, gain);
      }
      this.apply();
    }
    // Once routed through Web Audio, even bypass mode needs a running context.
    if (this.context && this.context.state !== 'running') await this.context.resume();
    if (this.context && this.context.state !== 'running') throw new Error('Tap Play to enable sound in this browser.');
  }

  play(element) {
    if (!this.context && !this.settings.enabled) return element.play();
    return this.activate().then(() => element.play());
  }

  apply() {
    for (const element of this.elements) {
      element.volume = this.settings.volume / 100;
      element.playbackRate = this.settings.speed;
      element.preservesPitch = true;
    }
    if (!this.filters) return;
    const values = ['bass', 'mid', 'treble'].map(key => this.settings.enabled ? this.settings[key] : 0);
    const now = this.context.currentTime;
    this.filters.forEach((filter, i) => {
      filter.gain.cancelScheduledValues(now);
      filter.gain.setTargetAtTime(values[i], now, .02);
    });
    // Reserve headroom for boosted bands instead of clipping the output.
    const boost = values.reduce((sum, value) => sum + Math.max(0, value), 0);
    this.headroom.gain.setTargetAtTime(10 ** (-boost / 20), now, .02);
  }

  get canFade() { return this.settings.enabled && this.settings.crossfade > 0 && this.context?.state === 'running'; }

  gain(element, value) {
    const param = this.gains.get(element)?.gain;
    if (!param) return;
    param.cancelScheduledValues(this.context.currentTime);
    param.setValueAtTime(value, this.context.currentTime);
  }

  fade(outgoing, incoming, seconds) {
    const now = this.context.currentTime;
    this.gain(outgoing, 1);
    this.gain(incoming, 0);
    // Complementary ramps keep the combined gain at one, including correlated audio.
    this.gains.get(outgoing).gain.linearRampToValueAtTime(0, now + seconds);
    this.gains.get(incoming).gain.linearRampToValueAtTime(1, now + seconds);
  }
}
window.MusoSound = MusoSound;
