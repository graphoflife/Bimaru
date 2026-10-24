/*
 * Tiny synthesizer for Bimaru's sounds. Everything is generated with the Web
 * Audio API, so there are no sound files to load. Notes come from a major
 * pentatonic scale, which keeps fast taps and drags sounding musical.
 */
(function () {
  'use strict';

  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
  let ctx = null, out = null, verb = null, noiseBuf = null;
  let enabled = true;

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);

    out = ctx.createGain();
    out.gain.value = 0.8;
    out.connect(comp);

    // A short, soft room so every sound gets a little air around it.
    const conv = ctx.createConvolver();
    conv.buffer = impulse(1.8, 3.4);
    verb = ctx.createGain();
    verb.gain.value = 0.28;
    verb.connect(conv);
    conv.connect(comp);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  function impulse(seconds, decay) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const scale = (root, step) => midi(root + PENTA[((step % PENTA.length) + PENTA.length) % PENTA.length]);

  function ready() {
    return enabled && init() && ctx.state !== 'closed';
  }

  // One enveloped oscillator.
  function voice(o) {
    const t0 = ctx.currentTime + (o.at || 0) + 0.005;
    const attack = o.attack || 0.004, decay = o.decay || 0.25, gain = o.gain || 0.2;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + (o.glide || 0.08));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    let node = osc;
    if (o.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(out);
    if (o.send !== 0) {
      const s = ctx.createGain();
      s.gain.value = o.send == null ? 0.5 : o.send;
      g.connect(s);
      s.connect(verb);
    }
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  // Filtered noise burst (splashes, whooshes, clicks).
  function noise(o) {
    const t0 = ctx.currentTime + (o.at || 0) + 0.005;
    const dur = o.dur || 0.1;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.Q.value = o.q || 1.2;
    f.frequency.setValueAtTime(o.freq || 1500, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.05, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s);
      s.connect(verb);
    }
    src.start(t0, Math.random() * 0.4);
    src.stop(t0 + dur + 0.05);
  }

  // Soft bell: fundamental plus a quiet inharmonic partial.
  function bell(freq, at, gain, decay) {
    voice({ freq, at, gain, decay: decay || 0.9, attack: 0.006, send: 0.7 });
    voice({ freq: freq * 2.76, at, gain: gain * 0.18, decay: (decay || 0.9) * 0.4, attack: 0.004, send: 0.6 });
    voice({ freq: freq * 2, at, gain: gain * 0.25, decay: (decay || 0.9) * 0.6, attack: 0.005, send: 0.6 });
  }

  const Sound = {
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (enabled) init(); },

    // Call from a user gesture so mobile browsers allow audio.
    unlock() { if (enabled) init(); },

    // Water drop: a quick rising "plip".
    water(step) {
      if (!ready()) return;
      const f = scale(74, step || 0);
      voice({ freq: f * 0.55, to: f * 1.15, glide: 0.06, attack: 0.003, decay: 0.15, gain: 0.2, send: 0.65 });
      voice({ freq: f * 2.3, attack: 0.002, decay: 0.04, gain: 0.025, send: 0.3 });
      noise({ freq: 2600, to: 900, dur: 0.07, gain: 0.018, q: 0.8 });
    },

    // Ship piece: a warm wooden marimba "tok".
    ship(step) {
      if (!ready()) return;
      const f = scale(60, step || 0);
      voice({ freq: f, attack: 0.003, decay: 0.42, gain: 0.26, send: 0.45 });
      voice({ freq: f * 3.98, attack: 0.002, decay: 0.07, gain: 0.05, send: 0.3 });
      voice({ freq: f * 0.5, type: 'triangle', attack: 0.003, decay: 0.12, gain: 0.07, send: 0.2 });
      noise({ freq: 3200, dur: 0.018, gain: 0.04, q: 2 });
    },

    erase() {
      if (!ready()) return;
      voice({ freq: 640, to: 300, glide: 0.1, type: 'triangle', attack: 0.004, decay: 0.12, gain: 0.08, send: 0.2 });
      noise({ freq: 1800, to: 500, dur: 0.09, gain: 0.025, q: 0.7 });
    },

    tap() {
      if (!ready()) return;
      voice({ freq: 1180, attack: 0.002, decay: 0.045, gain: 0.07, send: 0.15 });
      voice({ freq: 590, type: 'triangle', attack: 0.002, decay: 0.05, gain: 0.05, send: 0 });
    },

    select(step) {
      if (!ready()) return;
      const f = scale(79, step || 0);
      voice({ freq: f, attack: 0.003, decay: 0.16, gain: 0.1, send: 0.5 });
      voice({ freq: f * 2, attack: 0.002, decay: 0.06, gain: 0.02, send: 0.3 });
    },

    nudge() {
      if (!ready()) return;
      voice({ freq: 330, to: 290, glide: 0.06, type: 'triangle', attack: 0.003, decay: 0.09, gain: 0.08, send: 0.15 });
    },

    line() {
      if (!ready()) return;
      bell(midi(88), 0.05, 0.07, 0.7);
      bell(midi(95), 0.12, 0.06, 0.8);
    },

    shipDone(len) {
      if (!ready()) return;
      const n = Math.min(6, (len || 1) + 1);
      for (let k = 0; k < n; k++) bell(scale(72, k * 2), 0.06 + k * 0.065, 0.075, 0.8);
    },

    good() {
      if (!ready()) return;
      bell(midi(76), 0, 0.09, 0.8);
      bell(midi(80), 0.09, 0.08, 0.8);
      bell(midi(83), 0.18, 0.08, 1.1);
    },

    error() {
      if (!ready()) return;
      voice({ freq: 262, to: 220, glide: 0.18, type: 'triangle', attack: 0.006, decay: 0.28, gain: 0.13, send: 0.2, lowpass: 1400 });
      voice({ freq: 196, to: 175, glide: 0.2, type: 'triangle', at: 0.11, attack: 0.006, decay: 0.32, gain: 0.11, send: 0.2, lowpass: 1200 });
    },

    hint() {
      if (!ready()) return;
      [0, 2, 4, 6].forEach((s, k) => voice({ freq: scale(84, s), at: k * 0.05, attack: 0.003, decay: 0.3, gain: 0.05, send: 0.8 }));
      noise({ freq: 6000, dur: 0.3, gain: 0.012, q: 0.6, filter: 'highpass', attack: 0.08, send: 0.4 });
    },

    undo() {
      if (!ready()) return;
      voice({ freq: 760, to: 430, glide: 0.08, attack: 0.003, decay: 0.1, gain: 0.08, send: 0.25 });
    },

    redo() {
      if (!ready()) return;
      voice({ freq: 430, to: 760, glide: 0.08, attack: 0.003, decay: 0.1, gain: 0.08, send: 0.25 });
    },

    // Soft whoosh while a new board deals in.
    deal() {
      if (!ready()) return;
      noise({ freq: 380, to: 2600, dur: 0.45, gain: 0.03, q: 0.9, attack: 0.18, send: 0.5 });
      [0, 2, 4].forEach((s, k) => voice({ freq: scale(67, s), at: 0.12 + k * 0.07, attack: 0.004, decay: 0.35, gain: 0.05, send: 0.7 }));
    },

    win() {
      if (!ready()) return;
      const notes = [60, 64, 67, 72, 76, 79, 84];
      notes.forEach((m, k) => bell(midi(m), 0.05 + k * 0.085, 0.09, 1.2));
      // Gentle pad underneath.
      [48, 55, 64].forEach((m) => voice({ freq: midi(m), attack: 0.25, decay: 1.8, gain: 0.05, send: 0.9, type: 'triangle', lowpass: 1600 }));
      for (let k = 0; k < 10; k++) {
        voice({ freq: scale(91, Math.floor(Math.random() * 8)), at: 0.7 + k * 0.07 + Math.random() * 0.04, attack: 0.002, decay: 0.25, gain: 0.025, send: 0.9 });
      }
    },
  };

  window.Sound = Sound;
})();
