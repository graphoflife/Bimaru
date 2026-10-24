/* Lightweight particle effects on a full-screen canvas: confetti, bubbles, sparkles. */
(function () {
  'use strict';

  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, parts = [], running = false, last = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    return ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'].map((v) => cs.getPropertyValue(v).trim() || '#a7a0f7');
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = Math.min(2.5, (now - last) / 16.67);
    last = now;
    ctx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vx *= Math.pow(p.drag, dt);
      p.vy = p.vy * Math.pow(p.drag, dt) + p.g * dt;
      p.x += p.vx * dt + (p.wobble ? Math.sin((now / 1000) * p.wobbleSpeed + p.phase) * p.wobble * dt : 0);
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0 || p.y > H + 40 || p.y < -200) { parts.splice(i, 1); continue; }
      draw(p, now);
    }
    if (parts.length) requestAnimationFrame(frame);
    else { running = false; ctx.clearRect(0, 0, W, H); }
  }

  function draw(p, now) {
    const a = Math.min(1, p.life * 2.2);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    switch (p.shape) {
      case 'rect': {
        // Flip around one axis so confetti looks like it tumbles.
        const flip = Math.cos(now / 160 + p.phase);
        ctx.scale(1, flip);
        roundRect(-p.w / 2, -p.h / 2, p.w, p.h, Math.min(p.w, p.h) * 0.35);
        ctx.fill();
        break;
      }
      case 'circle':
        ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'ring':
        ctx.lineWidth = Math.max(1.2, p.w * 0.18);
        ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'star':
        star(p.w / 2);
        ctx.fill();
        break;
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function star(r) {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const rr = k % 2 ? r * 0.36 : r;
      const ang = (k * Math.PI) / 4;
      ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.closePath();
  }

  function base(x, y, color) {
    return {
      x, y, vx: 0, vy: 0, g: 0, drag: 0.99, rot: rand(0, Math.PI * 2), vr: 0,
      life: 1, decay: 0.01, w: 6, h: 6, color, shape: 'circle', wobble: 0, wobbleSpeed: 3, phase: rand(0, 6.28),
    };
  }

  const FX = {
    // Celebration burst from a point.
    confetti(x, y, count) {
      const colors = palette();
      const n = reduce.matches ? 0 : count || 140;
      for (let i = 0; i < n; i++) {
        const p = base(x, y, colors[i % colors.length]);
        const ang = rand(-Math.PI * 0.95, -Math.PI * 0.05);
        const sp = rand(5, 17);
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
        p.g = rand(0.25, 0.38);
        p.drag = 0.975;
        p.vr = rand(-0.25, 0.25);
        p.decay = rand(0.0045, 0.008);
        p.shape = Math.random() < 0.65 ? 'rect' : Math.random() < 0.6 ? 'circle' : 'star';
        p.w = rand(7, 12);
        p.h = p.shape === 'rect' ? rand(10, 16) : p.w;
        p.wobble = rand(0.3, 1.2);
        parts.push(p);
      }
      start();
    },

    // Gentle confetti rain from the top of the screen.
    rain(count) {
      const colors = palette();
      const n = reduce.matches ? 0 : count || 90;
      for (let i = 0; i < n; i++) {
        const p = base(rand(0, W), rand(-H * 0.6, -10), colors[i % colors.length]);
        p.vx = rand(-1, 1);
        p.vy = rand(2, 5);
        p.g = 0.04;
        p.drag = 0.995;
        p.vr = rand(-0.12, 0.12);
        p.decay = rand(0.003, 0.005);
        p.shape = Math.random() < 0.75 ? 'rect' : 'circle';
        p.w = rand(6, 10);
        p.h = p.shape === 'rect' ? rand(9, 14) : p.w;
        p.wobble = rand(0.6, 1.6);
        parts.push(p);
      }
      start();
    },

    // Little bubbles rising from a finished ship.
    bubbles(x, y, count, spread) {
      if (reduce.matches) return;
      const cs = getComputedStyle(document.documentElement);
      const colors = [cs.getPropertyValue('--wave').trim(), cs.getPropertyValue('--ship').trim(), '#ffffff'];
      for (let i = 0; i < (count || 14); i++) {
        const p = base(x + rand(-spread, spread), y + rand(-6, 6), colors[i % colors.length]);
        p.vx = rand(-0.6, 0.6);
        p.vy = rand(-3.2, -1.2);
        p.g = 0.02;
        p.drag = 0.97;
        p.decay = rand(0.018, 0.03);
        p.shape = Math.random() < 0.5 ? 'ring' : 'circle';
        p.w = rand(4, 9);
        p.wobble = rand(0.4, 1);
        p.wobbleSpeed = rand(5, 9);
        parts.push(p);
      }
      start();
    },

    // Twinkly stars, used for hints and line completions.
    sparkle(x, y, count, radius) {
      if (reduce.matches) return;
      const colors = palette();
      for (let i = 0; i < (count || 10); i++) {
        const ang = rand(0, Math.PI * 2);
        const sp = rand(1, 3.6);
        const p = base(x + Math.cos(ang) * (radius || 0), y + Math.sin(ang) * (radius || 0), colors[i % colors.length]);
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
        p.drag = 0.92;
        p.vr = rand(-0.2, 0.2);
        p.decay = rand(0.025, 0.04);
        p.shape = 'star';
        p.w = rand(6, 11);
        parts.push(p);
      }
      start();
    },
  };

  window.FX = FX;
})();
