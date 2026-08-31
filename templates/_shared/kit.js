/* =============================================================================
 * meamus kit - shared runtime for generated / template games (Phaser 3.60)
 *
 * Everything here is procedural: no external images, no external audio, no
 * webfonts. Sprites are built with Phaser.Graphics and baked into textures at
 * preload time, sound effects are synthesised with the Web Audio API.
 *
 * The bundler inlines this file ahead of a game's own code whenever the spec
 * sets runtime.kit = true.
 * ========================================================================== */
(function (global) {
  'use strict';

  var MEAMUS = {
    version: '1.0.0',
    FONT: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
    MONO: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  };

  /**
   * Device pixel ratio, clamped.
   *
   * Scale.FIT stretches a fixed-size canvas with CSS, so on a 2x or 3x screen
   * every glyph is upscaled and reads as blurry. Phaser rasterises Text into
   * its own texture, and `resolution` controls the size of that texture, so
   * passing DPR here is what actually makes menu and HUD copy sharp. Clamped
   * at 2 because 3x triples texture memory for no visible gain.
   */
  MEAMUS.DPR = (function () {
    var d = (global.devicePixelRatio || 1);
    return Math.max(1, Math.min(2, d));
  })();

  /* ---------------------------------------------------------------------- */
  /* Persistence - never throws, even in private mode / sandboxed iframes.   */
  /* ---------------------------------------------------------------------- */
  MEAMUS.storage = {
    prefix: 'meamus:',
    available: (function () {
      try {
        var k = '__meamus_probe__';
        global.localStorage.setItem(k, '1');
        global.localStorage.removeItem(k);
        return true;
      } catch (e) {
        return false;
      }
    })(),
    _memory: {},
    get: function (key, fallback) {
      var full = this.prefix + key;
      try {
        var raw = this.available ? global.localStorage.getItem(full) : this._memory[full];
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      var full = this.prefix + key;
      var raw = JSON.stringify(value);
      try {
        if (this.available) global.localStorage.setItem(full, raw);
        else this._memory[full] = raw;
      } catch (e) {
        this._memory[full] = raw;
      }
      return value;
    },
    best: function (gameKey, score) {
      var key = gameKey + ':best';
      var current = Number(this.get(key, 0)) || 0;
      if (typeof score === 'number' && score > current) {
        this.set(key, score);
        return score;
      }
      return current;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Soft currency - the hook every shop / skin system plugs into.           */
  /* ---------------------------------------------------------------------- */
  MEAMUS.currency = {
    key: 'coins',
    get: function () { return Number(MEAMUS.storage.get(this.key, 0)) || 0; },
    add: function (n) { var v = this.get() + Math.max(0, n | 0); MEAMUS.storage.set(this.key, v); return v; },
    spend: function (n) {
      var v = this.get();
      if (v < n) return false;
      MEAMUS.storage.set(this.key, v - n);
      return true;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Monetization hooks.                                                     */
  /* Deliberate no-ops that log intent. Drop an AdMob / Unity Ads / H5 ad    */
  /* SDK into these four functions and every game inherits the placements.   */
  /* ---------------------------------------------------------------------- */
  MEAMUS.ads = {
    enabled: false,             // flip to true once a real SDK is wired up
    interstitialEvery: 3,       // levels / runs between interstitials
    _runs: 0,
    log: function (kind, reason) {
      if (global.console && console.info) console.info('[meamus.ads] ' + kind + (reason ? ' :: ' + reason : ''));
    },
    // AD HOOK: 320x50 banner in the top or bottom safe zone.
    showBanner: function (position) { this.log('banner', position || 'bottom'); },
    hideBanner: function () { this.log('banner:hide'); },
    // AD HOOK: full-screen interstitial. Called on run end / level complete.
    showInterstitial: function (reason) { this.log('interstitial', reason); },
    // AD HOOK: rewarded video. onReward() runs only if the video completes.
    // With no SDK wired up the reward is denied, so game logic must handle it.
    showRewarded: function (reason, onReward, onDecline) {
      this.log('rewarded', reason);
      if (this.enabled && typeof onReward === 'function') onReward();
      else if (typeof onDecline === 'function') onDecline();
    },
    // Returns true when this run should trigger an interstitial.
    countRun: function () {
      this._runs += 1;
      return this._runs % this.interstitialEvery === 0;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Procedural textures. Every sprite in every template comes from here.    */
  /* ---------------------------------------------------------------------- */
  MEAMUS.gfx = {
    /**
     * Bake a drawing callback into a texture.
     * @param {Phaser.Scene} scene
     * @param {string} key texture key
     * @param {number} w
     * @param {number} h
     * @param {function(Phaser.GameObjects.Graphics)} draw
     */
    texture: function (scene, key, w, h, draw) {
      if (scene.textures.exists(key)) return key;
      var g = scene.make.graphics({ x: 0, y: 0, add: false });
      draw(g);
      g.generateTexture(key, w, h);
      g.destroy();
      return key;
    },

    rect: function (scene, key, w, h, color, opts) {
      opts = opts || {};
      return this.texture(scene, key, w, h, function (g) {
        if (opts.radius) {
          g.fillStyle(color, 1).fillRoundedRect(0, 0, w, h, opts.radius);
          if (opts.stroke !== undefined) g.lineStyle(opts.strokeWidth || 2, opts.stroke, 1).strokeRoundedRect(1, 1, w - 2, h - 2, opts.radius);
        } else {
          g.fillStyle(color, 1).fillRect(0, 0, w, h);
          if (opts.stroke !== undefined) g.lineStyle(opts.strokeWidth || 2, opts.stroke, 1).strokeRect(1, 1, w - 2, h - 2);
        }
      });
    },

    circle: function (scene, key, d, color, opts) {
      opts = opts || {};
      var r = d / 2;
      return this.texture(scene, key, d, d, function (g) {
        if (opts.glow) g.fillStyle(color, 0.25).fillCircle(r, r, r);
        g.fillStyle(color, 1).fillCircle(r, r, opts.glow ? r * 0.72 : r);
        if (opts.stroke !== undefined) g.lineStyle(opts.strokeWidth || 2, opts.stroke, 1).strokeCircle(r, r, r - 1);
        if (opts.shine) g.fillStyle(0xffffff, 0.35).fillCircle(r * 0.68, r * 0.62, r * 0.22);
      });
    },

    /** Points are 0..1 fractions of w/h so shapes scale cleanly. */
    poly: function (scene, key, w, h, points, color, opts) {
      opts = opts || {};
      return this.texture(scene, key, w, h, function (g) {
        var pts = points.map(function (p) { return { x: p[0] * w, y: p[1] * h }; });
        g.fillStyle(color, 1).fillPoints(pts, true);
        if (opts.stroke !== undefined) g.lineStyle(opts.strokeWidth || 2, opts.stroke, 1).strokePoints(pts, true, true);
      });
    },

    /** Irregular n-gon - asteroids, rocks, debris. */
    rock: function (scene, key, d, color, seed, opts) {
      opts = opts || {};
      var rnd = new Phaser.Math.RandomDataGenerator([String(seed || key)]);
      var sides = opts.sides || 9;
      var pts = [];
      for (var i = 0; i < sides; i += 1) {
        var a = (i / sides) * Math.PI * 2;
        var r = (d / 2) * rnd.realInRange(0.68, 1);
        pts.push({ x: d / 2 + Math.cos(a) * r, y: d / 2 + Math.sin(a) * r });
      }
      return this.texture(scene, key, d, d, function (g) {
        g.fillStyle(color, 1).fillPoints(pts, true);
        g.lineStyle(2, opts.stroke === undefined ? 0x000000 : opts.stroke, 0.45).strokePoints(pts, true, true);
        // craters
        for (var c = 0; c < 3; c += 1) {
          g.fillStyle(0x000000, 0.18).fillCircle(rnd.between(d * 0.25, d * 0.75), rnd.between(d * 0.25, d * 0.75), rnd.between(2, Math.max(3, d * 0.11)));
        }
      });
    },

    star: function (scene, key, d, color, points) {
      points = points || 5;
      var r = d / 2;
      return this.texture(scene, key, d, d, function (g) {
        var pts = [];
        for (var i = 0; i < points * 2; i += 1) {
          var rad = i % 2 === 0 ? r : r * 0.45;
          var a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
          pts.push({ x: r + Math.cos(a) * rad, y: r + Math.sin(a) * rad });
        }
        g.fillStyle(color, 1).fillPoints(pts, true);
      });
    },

    /** 1px-wide vertical gradient stretched across the play field. */
    gradient: function (scene, key, w, h, top, bottom) {
      if (scene.textures.exists(key)) return key;
      var canvas = scene.textures.createCanvas(key, w, h);
      var ctx = canvas.getContext();
      var grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, Phaser.Display.Color.IntegerToColor(top).rgba);
      grad.addColorStop(1, Phaser.Display.Color.IntegerToColor(bottom).rgba);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      canvas.refresh();
      return key;
    },

    /** A soft dot used by every particle emitter in the templates. */
    particle: function (scene, key, d, color) {
      var r = d / 2;
      return this.texture(scene, key, d, d, function (g) {
        g.fillStyle(color, 0.35).fillCircle(r, r, r);
        g.fillStyle(color, 1).fillCircle(r, r, r * 0.5);
      });
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Synthesised audio - no files, no CDN, works offline and inside an APK.  */
  /* ---------------------------------------------------------------------- */
  MEAMUS.sfx = {
    ctx: null,
    muted: false,
    _ensure: function () {
      if (this.ctx) return this.ctx;
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null;
      try { this.ctx = new Ctor(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    resume: function () {
      try {
        var ctx = this._ensure();
        if (ctx && ctx.state === 'suspended') ctx.resume();
      } catch (e) { /* autoplay policy, closed context, cross-origin iframe */ }
    },
    /**
     * Run a sound without ever letting it break the caller.
     *
     * Buttons used to call sfx directly and then invoke their handler. Inside a
     * sandboxed iframe, or on a browser that throws from the Web Audio API, the
     * throw happened first and the handler never ran - a button that visibly
     * depressed and did nothing.
     */
    safe: function (name, arg) {
      try { if (typeof this[name] === 'function') this[name](arg); } catch (e) { /* muted, not broken */ }
    },
    /** @param {{freq:number,to:number,dur:number,type:string,gain:number}} o */
    tone: function (o) {
      if (this.muted) return;
      var ctx = this._ensure();
      if (!ctx) return;
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = o.type || 'square';
      osc.frequency.setValueAtTime(o.freq, now);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), now + o.dur);
      gain.gain.setValueAtTime(o.gain === undefined ? 0.08 : o.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + o.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + o.dur + 0.02);
    },
    noise: function (dur, gainValue) {
      if (this.muted) return;
      var ctx = this._ensure();
      if (!ctx) return;
      var frames = Math.floor(ctx.sampleRate * dur);
      var buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      var src = ctx.createBufferSource();
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(gainValue === undefined ? 0.12 : gainValue, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      src.buffer = buffer;
      src.connect(gain).connect(ctx.destination);
      src.start();
    },
    laser: function () { this.tone({ freq: 880, to: 180, dur: 0.16, type: 'sawtooth', gain: 0.06 }); },
    explode: function () { this.noise(0.35, 0.16); },
    jump: function () { this.tone({ freq: 320, to: 640, dur: 0.14, type: 'square', gain: 0.06 }); },
    coin: function () { this.tone({ freq: 780, to: 1180, dur: 0.12, type: 'triangle', gain: 0.07 }); },
    hurt: function () { this.tone({ freq: 240, to: 70, dur: 0.28, type: 'sawtooth', gain: 0.09 }); },
    click: function () { this.tone({ freq: 520, to: 520, dur: 0.05, type: 'square', gain: 0.05 }); },
    match: function (chain) { this.tone({ freq: 480 + (chain || 0) * 90, to: 900 + (chain || 0) * 120, dur: 0.16, type: 'triangle', gain: 0.07 }); },
    win: function () {
      var self = this;
      [523, 659, 784, 1047].forEach(function (f, i) {
        global.setTimeout(function () { self.tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.07 }); }, i * 110);
      });
    }
  };

  /* ---------------------------------------------------------------------- */
  /* UI primitives - buttons meet the 44x44 touch-target minimum.            */
  /* ---------------------------------------------------------------------- */
  MEAMUS.ui = {
    /**
     * Light-ground palette. Games render on pale backgrounds, so the ink is
     * dark and the accents are muted rather than neon - a bright colour on a
     * bright ground is the fastest way to make a game look cheap.
     */
    PALETTE: {
      ink: '#2f2a24',
      dim: '#7d7469',
      accent: '#ff8a5c',
      // Soft secondary fill. Dark navy/purple buttons fought the light grounds.
      soft: 0xffe8d6,
      softInk: '#5b5145',
      good: '#3fa77e',
      warn: '#d9992b',
      bad: '#d4614f'
    },

    title: function (scene, x, y, text, size) {
      return scene.add.text(x, y, text, {
        fontFamily: MEAMUS.FONT,
        resolution: MEAMUS.DPR,
        fontSize: (size || 46) + 'px',
        color: this.PALETTE.ink,
        // A soft white halo instead of a black outline: it separates the text
        // from a light background without the arcade-sticker look.
        stroke: '#ffffff',
        strokeThickness: 5,
        align: 'center'
      }).setOrigin(0.5);
    },

    label: function (scene, x, y, text, opts) {
      opts = opts || {};
      return scene.add.text(x, y, text, {
        fontFamily: opts.mono ? MEAMUS.MONO : MEAMUS.FONT,
        resolution: MEAMUS.DPR,
        fontSize: (opts.size || 18) + 'px',
        color: opts.color || this.PALETTE.dim,
        align: opts.align || 'center',
        wordWrap: opts.wrap ? { width: opts.wrap } : undefined,
        lineSpacing: opts.lineSpacing || 4
      }).setOrigin(opts.originX === undefined ? 0.5 : opts.originX, opts.originY === undefined ? 0.5 : opts.originY);
    },

    /**
     * Rounded button that responds to pointer + keyboard focus.
     * Minimum hit area is 160x48 so it clears the 44px touch guideline.
     */
    button: function (scene, x, y, text, onClick, opts) {
      opts = opts || {};
      var w = Math.max(opts.width || 200, 120);
      var h = Math.max(opts.height || 52, 44);
      var fill = opts.fill === undefined ? 0xff8a5c : opts.fill;
      var container = scene.add.container(x, y);
      var bg = scene.add.graphics();
      var draw = function (color, alpha) {
        bg.clear();
        // Soft shadow under a rounded pill reads smoother than a hard border.
        bg.fillStyle(0x000000, 0.06 * (alpha === undefined ? 1 : alpha))
          .fillRoundedRect(-w / 2, -h / 2 + 3, w, h, 14);
        bg.fillStyle(color, alpha === undefined ? 1 : alpha)
          .fillRoundedRect(-w / 2, -h / 2, w, h, 14);
        bg.lineStyle(1.5, 0xffffff, 0.55).strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
      };
      draw(fill);
      var label = scene.add.text(0, 0, text, {
        fontFamily: MEAMUS.FONT,
        resolution: MEAMUS.DPR,
        fontSize: (opts.size || 20) + 'px',
        color: opts.textColor || '#ffffff',
        fontStyle: 'bold'
      }).setOrigin(0.5);
      container.add([bg, label]);
      container.setSize(w, h);
      container.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h), Phaser.Geom.Rectangle.Contains);
      var armed = false;
      var fired = false;

      /**
       * Fire once, sound first but never at the handler's expense.
       * `fired` guards against a pointerup and the scene-level fallback both
       * landing on the same press.
       */
      function activate() {
        if (fired) return;
        fired = true;
        armed = false;
        container.setScale(1);
        draw(fill);
        MEAMUS.sfx.resume();
        MEAMUS.sfx.safe('click');
        try { onClick(); } catch (err) {
          if (global.console) console.error('[meamus.ui] button handler threw', err);
        }
        // Re-arm on the next tick so a scene that stays put stays clickable.
        scene.time.delayedCall(0, function () { fired = false; });
      }

      container.on('pointerover', function () { draw(fill, 0.85); scene.input.setDefaultCursor('pointer'); });
      container.on('pointerout', function () { draw(fill); scene.input.setDefaultCursor('default'); });
      container.on('pointerdown', function () { armed = true; container.setScale(0.96); });
      container.on('pointerup', activate);

      /**
       * Touch fallback. A finger almost always drifts a few pixels between
       * down and up, and once it leaves the hit area Phaser sends
       * `pointerupoutside` instead of `pointerup` - so the press was armed and
       * then silently dropped. Anything released within a forgiving slop of a
       * button the user actually pressed counts as a tap.
       */
      container.on('pointerupoutside', function (pointer) {
        if (!armed) return;
        armed = false;
        container.setScale(1);
        draw(fill);
        var m = container.getWorldTransformMatrix();
        var slop = 24;
        var withinX = Math.abs(pointer.x - m.tx) <= w / 2 + slop;
        var withinY = Math.abs(pointer.y - m.ty) <= h / 2 + slop;
        if (withinX && withinY) activate();
      });

      container.setLabel = function (next) { label.setText(next); };
      return container;
    },

    /**
     * Last-resort start affordance for a menu scene.
     *
     * Every menu has a PLAY button, but a button is a small target that can be
     * missed on a phone, and a player who taps the artwork and gets nothing
     * concludes the game is broken. This makes the whole scene a start target:
     * tap anywhere that is not another button, or press any key.
     *
     * `ignore` is the list of interactive objects that must keep their own
     * behaviour (HOW TO PLAY, SHOP, and so on).
     */
    anywhereToStart: function (scene, start, ignore) {
      var skip = ignore || [];
      var go = function () {
        MEAMUS.sfx.resume();
        try { start(); } catch (err) {
          if (global.console) console.error('[meamus.ui] start handler threw', err);
        }
      };
      scene.input.on('pointerup', function (pointer, over) {
        // `over` lists the interactive objects under the pointer. If the tap
        // landed on one of the other buttons, that button owns the press.
        for (var i = 0; i < over.length; i += 1) {
          if (skip.indexOf(over[i]) !== -1) return;
        }
        if (over.length) return;
        go();
      });
      if (scene.input.keyboard) {
        scene.input.keyboard.on('keydown', function (event) {
          // Leave the browser's own chrome shortcuts alone.
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          go();
        });
      }
      return MEAMUS.ui.label(scene, scene.scale.width / 2, scene.scale.height - 74,
        'tap anywhere or press any key to start', { size: 13, color: MEAMUS.ui.PALETTE.dim });
    },

    /** Translucent panel used behind menus and dialogs. */
    panel: function (scene, x, y, w, h, opts) {
      opts = opts || {};
      var g = scene.add.graphics();
      g.fillStyle(0x000000, 0.08).fillRoundedRect(x - w / 2, y - h / 2 + 4, w, h, opts.radius || 20);
      g.fillStyle(opts.fill === undefined ? 0xfffaf3 : opts.fill, opts.alpha === undefined ? 0.97 : opts.alpha);
      g.fillRoundedRect(x - w / 2, y - h / 2, w, h, opts.radius || 20);
      g.lineStyle(1.5, opts.stroke === undefined ? 0xe5d9c8 : opts.stroke, 1);
      g.strokeRoundedRect(x - w / 2, y - h / 2, w, h, opts.radius || 20);
      return g;
    },

    /** Reserved ad slot so the layout never shifts when ads switch on. */
    bannerSlot: function (scene, position) {
      var W = scene.scale.width;
      var H = scene.scale.height;
      var h = 50;
      var y = position === 'top' ? h / 2 : H - h / 2;
      var g = scene.add.graphics().setDepth(900).setScrollFactor(0);
      g.fillStyle(0x000000, 0.05).fillRect(0, y - h / 2, W, h);
      var t = scene.add.text(W / 2, y, 'AD SLOT 320x50', {
        fontFamily: MEAMUS.MONO, resolution: MEAMUS.DPR, fontSize: '12px', color: '#b3a999'
      }).setOrigin(0.5).setDepth(901).setScrollFactor(0);
      MEAMUS.ads.showBanner(position || 'bottom');
      return { bg: g, text: t, height: h };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Floating feedback helpers.                                              */
  /* ---------------------------------------------------------------------- */
  MEAMUS.fx = {
    floatText: function (scene, x, y, text, color) {
      var t = scene.add.text(x, y, text, {
        fontFamily: MEAMUS.FONT, resolution: MEAMUS.DPR, fontSize: '20px', color: color || '#c9862b',
        fontStyle: 'bold', stroke: '#ffffff', strokeThickness: 3
      }).setOrigin(0.5).setDepth(800);
      scene.tweens.add({
        targets: t, y: y - 46, alpha: 0, duration: 700, ease: 'Cubic.easeOut',
        onComplete: function () { t.destroy(); }
      });
      return t;
    },
    shake: function (scene, intensity, duration) {
      scene.cameras.main.shake(duration || 160, intensity || 0.008);
    },
    flash: function (scene, color) {
      var c = color || [255, 90, 90];
      scene.cameras.main.flash(180, c[0], c[1], c[2]);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Touch controls. Rendered only when the device reports touch support.    */
  /* ---------------------------------------------------------------------- */
  MEAMUS.touch = {
    isTouch: function () {
      return ('ontouchstart' in global) || (global.navigator && global.navigator.maxTouchPoints > 0);
    },

    /**
     * Left-hand virtual joystick. Returns { x, y } in the -1..1 range via
     * getVector(), plus destroy() for scene shutdown.
     */
    joystick: function (scene, opts) {
      opts = opts || {};
      var radius = opts.radius || 60;
      var baseX = opts.x || radius + 26;
      var baseY = opts.y || scene.scale.height - radius - 26;
      var depth = opts.depth || 950;

      var base = scene.add.circle(baseX, baseY, radius, 0x2f2a24, 0.10).setScrollFactor(0).setDepth(depth);
      var thumb = scene.add.circle(baseX, baseY, radius * 0.42, 0x2f2a24, 0.26).setScrollFactor(0).setDepth(depth + 1);
      var vector = new Phaser.Math.Vector2(0, 0);
      var pointerId = null;

      var zone = scene.add.zone(0, 0, scene.scale.width / 2, scene.scale.height).setOrigin(0, 0)
        .setScrollFactor(0).setInteractive().setDepth(depth - 1);

      function move(pointer) {
        var dx = pointer.x - baseX;
        var dy = pointer.y - baseY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var clamped = Math.min(dist, radius);
        var angle = Math.atan2(dy, dx);
        thumb.setPosition(baseX + Math.cos(angle) * clamped, baseY + Math.sin(angle) * clamped);
        // Dead zone keeps a resting thumb from nudging the player.
        var magnitude = dist < radius * 0.18 ? 0 : Math.min(1, dist / radius);
        vector.set(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
      }

      zone.on('pointerdown', function (pointer) {
        if (pointerId !== null) return;
        pointerId = pointer.id;
        move(pointer);
      });
      scene.input.on('pointermove', function (pointer) {
        if (pointer.id === pointerId) move(pointer);
      });
      scene.input.on('pointerup', function (pointer) {
        if (pointer.id !== pointerId) return;
        pointerId = null;
        vector.set(0, 0);
        thumb.setPosition(baseX, baseY);
      });

      return {
        getVector: function () { return vector; },
        setVisible: function (v) { base.setVisible(v); thumb.setVisible(v); },
        destroy: function () { base.destroy(); thumb.destroy(); zone.destroy(); }
      };
    },

    /** Right-hand action button (fire / jump). 44px+ target enforced. */
    button: function (scene, label, onDown, opts) {
      opts = opts || {};
      var r = Math.max(opts.radius || 46, 30);
      var x = opts.x || scene.scale.width - r - 26;
      var y = opts.y || scene.scale.height - r - 26;
      var depth = opts.depth || 950;
      var circle = scene.add.circle(x, y, r, 0x2f2a24, 0.14).setScrollFactor(0).setDepth(depth)
        .setInteractive(new Phaser.Geom.Circle(r, r, r), Phaser.Geom.Circle.Contains);
      var text = scene.add.text(x, y, label, {
        fontFamily: MEAMUS.FONT, resolution: MEAMUS.DPR, fontSize: '15px', color: '#2f2a24', fontStyle: 'bold'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(depth + 1);
      var held = false;
      circle.on('pointerdown', function () {
        held = true;
        circle.setFillStyle(0x2f2a24, 0.3);
        MEAMUS.sfx.resume();
        try { if (onDown) onDown(); } catch (err) {
          if (global.console) console.error('[meamus.touch] button handler threw', err);
        }
      });
      circle.on('pointerup', function () { held = false; circle.setFillStyle(0x2f2a24, 0.14); });
      circle.on('pointerout', function () { held = false; circle.setFillStyle(0x2f2a24, 0.14); });
      return {
        isDown: function () { return held; },
        destroy: function () { circle.destroy(); text.destroy(); }
      };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Reusable Boot + Preload scenes.                                         */
  /* A game passes a texture-baking callback; the loading bar is drawn even  */
  /* though there is nothing to download, so the flow matches a real asset   */
  /* pipeline once generated art is dropped in.                              */
  /* ---------------------------------------------------------------------- */
  MEAMUS.scenes = {
    makeBoot: function (nextKey) {
      return class BootScene extends Phaser.Scene {
        constructor() { super({ key: 'BootScene' }); }
        init() {
          // Deliberately no orientation lock. These games are played portrait
          // on a phone and windowed on a desktop; forcing landscape made the
          // canvas fight the viewport instead of fitting it.
          MEAMUS.sfx.resume();
        }
        create() {
          // Pause the whole game when the tab / app goes to background.
          this.game.events.on('hidden', () => { this.game.loop.sleep(); });
          this.game.events.on('visible', () => { this.game.loop.wake(); });
          this.scene.start(nextKey || 'PreloadScene');
        }
      };
    },

    makePreload: function (opts) {
      var bake = opts.bake;
      var nextKey = opts.next || 'MenuScene';
      var titleText = opts.title || 'meamus';
      return class PreloadScene extends Phaser.Scene {
        constructor() { super({ key: 'PreloadScene' }); }
        create() {
          var W = this.scale.width;
          var H = this.scale.height;
          this.cameras.main.setBackgroundColor(opts.bg || '#fdf6ec');
          MEAMUS.ui.title(this, W / 2, H / 2 - 60, titleText, 34);
          var barW = Math.min(360, W - 80);
          var barBg = this.add.graphics();
          barBg.fillStyle(0x2f2a24, 0.10).fillRoundedRect(W / 2 - barW / 2, H / 2, barW, 14, 7);
          var bar = this.add.graphics();
          var pct = this.add.text(W / 2, H / 2 + 40, '0%', {
            fontFamily: MEAMUS.MONO, resolution: MEAMUS.DPR, fontSize: '14px', color: '#7d7469'
          }).setOrigin(0.5);

          // Textures are generated synchronously; the bar is stepped so the
          // transition reads as a real load and leaves room for future assets.
          var steps = 12;
          var step = 0;
          this.time.addEvent({
            delay: 40,
            repeat: steps - 1,
            callback: () => {
              step += 1;
              var p = step / steps;
              bar.clear().fillStyle(0xff8a5c, 1)
                .fillRoundedRect(W / 2 - barW / 2, H / 2, Math.max(14, barW * p), 14, 7);
              pct.setText(Math.round(p * 100) + '%');
              if (step === 2 && typeof bake === 'function') bake(this);
              if (step === steps) this.time.delayedCall(120, () => this.scene.start(nextKey));
            }
          });
        }
      };
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Attract mode.                                                           */
  /* With ?attract=1 the game skips its menu, plays itself, and restarts on  */
  /* game over - the demo loop embedded on the landing page. A real pointer  */
  /* or key press hands control back to the player.                          */
  /* ---------------------------------------------------------------------- */
  MEAMUS.attract = (function () {
    try {
      return new URLSearchParams(global.location.search).get('attract') === '1';
    } catch (e) {
      return false;
    }
  })();

  /** True while the bot should drive. Any real input ends it for good. */
  MEAMUS.attractActive = MEAMUS.attract;

  /**
   * Wire the takeover listeners. Call once from a scene that has input.
   * @param {Phaser.Scene} scene
   */
  MEAMUS.watchForTakeover = function (scene) {
    if (!MEAMUS.attract || scene.__meamusTakeoverBound) return;
    scene.__meamusTakeoverBound = true;
    var release = function () {
      if (!MEAMUS.attractActive) return;
      MEAMUS.attractActive = false;
      MEAMUS.sfx.resume();
      if (MEAMUS.onTakeover) MEAMUS.onTakeover();
    };
    scene.input.on('pointerdown', release);
    if (scene.input.keyboard) scene.input.keyboard.on('keydown', release);
  };

  /** A small badge so a self-playing game does not look like a video. */
  MEAMUS.attractBadge = function (scene, label) {
    if (!MEAMUS.attract) return null;
    var text = scene.add.text(scene.scale.width / 2, scene.scale.height - 12,
      label || 'DEMO - click to take over', {
        fontFamily: MEAMUS.MONO, fontSize: '12px', color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.45)', padding: { x: 8, y: 4 }
      }).setOrigin(0.5, 1).setDepth(9998).setScrollFactor(0);
    scene.tweens.add({ targets: text, alpha: 0.45, yoyo: true, repeat: -1, duration: 1400 });
    return text;
  };

  /* ---------------------------------------------------------------------- */
  /* Debug overlay (off by default - flip MEAMUS.debug before boot).         */
  /* ---------------------------------------------------------------------- */
  MEAMUS.debug = false;
  MEAMUS.attachDebug = function (scene) {
    if (!MEAMUS.debug) return null;
    var t = scene.add.text(8, 8, 'FPS 0', {
      fontFamily: MEAMUS.MONO, fontSize: '12px', color: '#38d39f'
    }).setDepth(9999).setScrollFactor(0);
    scene.time.addEvent({
      delay: 500, loop: true,
      callback: function () { t.setText('FPS ' + Math.round(scene.game.loop.actualFps)); }
    });
    return t;
  };

  /* ---------------------------------------------------------------------- */
  /* Boot wrapper: error handling, resize, background pause.                 */
  /* ---------------------------------------------------------------------- */
  MEAMUS.boot = function (config) {
    try {
      if (typeof Phaser === 'undefined') throw new Error('Phaser failed to load (check the CDN or your network)');
      var game = new Phaser.Game(config);

      // Android/iOS: suspend audio + loop when the app is backgrounded.
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.hidden) {
          game.loop.sleep();
          if (MEAMUS.sfx.ctx && MEAMUS.sfx.ctx.suspend) MEAMUS.sfx.ctx.suspend();
        } else {
          game.loop.wake();
          MEAMUS.sfx.resume();
        }
      });

      // Cordova / Capacitor hardware back button.
      global.document.addEventListener('backbutton', function (e) {
        e.preventDefault();
        var active = game.scene.getScenes(true)[0];
        if (active && active.scene.key === 'GameScene') active.scene.start('MenuScene');
        else if (active && active.scene.key !== 'MenuScene') active.scene.start('MenuScene');
      }, false);

      global.addEventListener('resize', function () {
        if (game.isBooted) game.scale.refresh();
      });

      global.MEAMUS_GAME = game;
      return game;
    } catch (err) {
      var host = global.document.getElementById(config.parent) || global.document.body;
      host.innerHTML = '<div style="font:14px/1.5 ' + MEAMUS.MONO +
        ';color:#ff5d6c;padding:24px;text-align:center">Game failed to start.<br><br><code>' +
        String(err && err.message ? err.message : err).replace(/</g, '&lt;') + '</code></div>';
      if (global.console) console.error('[meamus] boot failed', err);
      return null;
    }
  };

  global.MEAMUS = MEAMUS;
})(typeof window !== 'undefined' ? window : this);
