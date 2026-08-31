/* =============================================================================
 * Astro Salvage - twin-stick-lite space shooter
 * Template game for meamus. Requires the meamus kit (MEAMUS global).
 * ========================================================================== */
(function () {
  'use strict';

  /* --- Tuning constants. No magic numbers below this block. -------------- */
  var CFG = {
    WIDTH: 800,
    HEIGHT: 600,
    KEY: 'astro-salvage',

    PLAYER_SPEED: 320,
    PLAYER_LIVES: 3,
    PLAYER_INVULN_MS: 1500,

    BULLET_SPEED: -520,
    BULLET_POOL: 40,
    FIRE_RATE_MS: 220,
    RAPID_FIRE_RATE_MS: 110,

    ASTEROID_POOL: 26,
    ASTEROID_MIN_SPEED: 70,
    ASTEROID_MAX_SPEED: 165,
    ASTEROID_BIG: 56,
    ASTEROID_SMALL: 28,

    SPAWN_START_MS: 1100,
    SPAWN_FLOOR_MS: 380,
    SPAWN_RAMP: 0.94,          // multiplier applied each wave
    WAVE_LENGTH_MS: 18000,

    POWERUP_CHANCE: 0.16,
    POWERUP_SPEED: 90,
    POWERUP_DURATION_MS: 7000,

    SCORE_BIG: 20,
    SCORE_SMALL: 35,
    COMBO_WINDOW_MS: 1400,

    STAR_COUNT: 90
  };

  // Soft daylight palette: pale sky, warm accents, nothing near-black.
  var COLORS = {
    bg: 0xfdf6ec,          // warm cream at the horizon
    bgTop: 0xbfe3f5,       // pale sky blue overhead
    ship: 0xff8a5c,        // warm coral hull
    thruster: 0xffd166,    // soft gold flame
    bullet: 0xff6b8a,      // rose bolt, readable on cream
    rock: 0xc9b8a8,        // sandstone
    rockSmall: 0xe0d3c5,   // lighter shard
    powerSpread: 0x6fd6a8, // mint
    powerShield: 0x8fb8f0, // periwinkle
    powerRapid: 0xffc857   // honey
  };

  /* --- Procedural art. Every sprite is baked here at preload time. ------- */
  function bakeTextures(scene) {
    var G = MEAMUS.gfx;

    // TODO: replace with generated sprite: playerShip - 34x40 pixel-art
    // spaceship, cyan hull with orange thruster flame, facing up.
    G.poly(scene, 'ship', 34, 40, [[0.5, 0], [1, 0.85], [0.5, 0.68], [0, 0.85]], COLORS.ship, { stroke: 0xffffff, strokeWidth: 2 });
    G.poly(scene, 'thruster', 14, 18, [[0.5, 1], [1, 0], [0, 0]], COLORS.thruster);

    // TODO: replace with generated sprite: bullet - 6x18 glowing plasma bolt.
    G.rect(scene, 'bullet', 6, 18, COLORS.bullet, { radius: 3 });

    // TODO: replace with generated sprite: asteroid - rocky grey polygon.
    G.rock(scene, 'rock-big', CFG.ASTEROID_BIG, COLORS.rock, 'big', { sides: 10 });
    G.rock(scene, 'rock-small', CFG.ASTEROID_SMALL, COLORS.rockSmall, 'small', { sides: 8 });

    // TODO: replace with generated sprite: powerUp - 26px glowing orb.
    G.circle(scene, 'pu-spread', 26, COLORS.powerSpread, { glow: true, shine: true });
    G.circle(scene, 'pu-shield', 26, COLORS.powerShield, { glow: true, shine: true });
    G.circle(scene, 'pu-rapid', 26, COLORS.powerRapid, { glow: true, shine: true });

    G.particle(scene, 'spark', 10, 0xffd27d);
    G.circle(scene, 'star-dot', 3, 0xffffff);   // drifting motes, not stars
    G.gradient(scene, 'space-bg', 8, CFG.HEIGHT, COLORS.bgTop, COLORS.bg);
  }

  /* ======================================================================= */
  /* Menu                                                                    */
  /* ======================================================================= */
  class MenuScene extends Phaser.Scene {
    constructor() { super({ key: 'MenuScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'space-bg').setDisplaySize(W, H);
      this.starfield = createStarfield(this, 40);

      MEAMUS.ui.title(this, W / 2, 110, 'ASTRO SALVAGE', 48);
      MEAMUS.ui.label(this, W / 2, 158, 'Blast the belt. Bank the salvage. Do not get hit.', { size: 16 });

      var best = MEAMUS.storage.best(CFG.KEY);
      MEAMUS.ui.label(this, W / 2, 196, 'BEST  ' + best + '        COINS  ' + MEAMUS.currency.get(), {
        size: 15, mono: true, color: MEAMUS.ui.PALETTE.warn
      });

      var play = () => this.scene.start('GameScene');
      MEAMUS.ui.button(this, W / 2, 268, 'PLAY', play, { width: 220 });
      var help = MEAMUS.ui.button(this, W / 2, 332, 'HOW TO PLAY', () => this.showHelp(), {
        width: 220, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk
      });
      // SHOP HOOK: coins collected in-run buy hull skins / bullet colours.
      var shop = MEAMUS.ui.button(this, W / 2, 396, 'SHOP  (soon)', () => {
        MEAMUS.fx.floatText(this, W / 2, 396, 'Shop coming soon', '#7d7469');
      }, { width: 220, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      MEAMUS.ui.bannerSlot(this, 'bottom');
      MEAMUS.attachDebug(this);

      // Tapping the artwork or hitting any key starts the run too, so a missed
      // button never reads as a dead game.
      MEAMUS.ui.anywhereToStart(this, play, [help, shop]);

      // The landing-page demo drops straight into play rather than a menu.
      if (MEAMUS.attractActive) this.time.delayedCall(700, () => this.scene.start('GameScene'));
    }

    showHelp() {
      if (this.helpOpen) return;
      this.helpOpen = true;
      var W = this.scale.width;
      var H = this.scale.height;
      var layer = this.add.container(0, 0).setDepth(1000);
      layer.add(MEAMUS.ui.panel(this, W / 2, H / 2, Math.min(520, W - 60), 330));
      layer.add(MEAMUS.ui.title(this, W / 2, H / 2 - 120, 'HOW TO PLAY', 26));
      layer.add(MEAMUS.ui.label(this, W / 2, H / 2 - 26,
        'MOVE    Arrow keys / WASD, drag, or the left stick\n' +
        'SHOOT   Space / click / the right button (hold to auto-fire)\n' +
        'PAUSE   P or Esc\n\n' +
        'Big rocks split into two smaller ones.\n' +
        'Green = spread shot   Blue = shield   Yellow = rapid fire\n' +
        'Chain kills inside 1.4s to build a score combo.',
        { size: 15, wrap: Math.min(460, W - 100), lineSpacing: 7 }));
      var close = MEAMUS.ui.button(this, W / 2, H / 2 + 118, 'GOT IT', () => {
        layer.destroy(true);
        this.helpOpen = false;
      }, { width: 160, height: 46 });
      layer.add(close);
    }
  }

  /* ======================================================================= */
  /* Main game                                                               */
  /* ======================================================================= */
  class GameScene extends Phaser.Scene {
    constructor() { super({ key: 'GameScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;

      this.add.image(W / 2, H / 2, 'space-bg').setDisplaySize(W, H).setDepth(-10);
      this.starfield = createStarfield(this, CFG.STAR_COUNT);

      /* --- run state (scene-local, never global) ------------------------ */
      this.score = 0;
      this.lives = CFG.PLAYER_LIVES;
      this.wave = 1;
      this.combo = 0;
      this.lastKillAt = -Infinity;
      this.spawnDelay = CFG.SPAWN_START_MS;
      this.fireRate = CFG.FIRE_RATE_MS;
      this.nextShotAt = 0;
      this.spread = false;
      this.shield = false;
      this.invulnUntil = 0;
      this.over = false;

      /* --- player ------------------------------------------------------- */
      this.player = this.physics.add.sprite(W / 2, H - 90, 'ship');
      this.player.setCollideWorldBounds(true).setDepth(10);
      this.player.body.setSize(24, 30);
      this.thruster = this.add.image(this.player.x, this.player.y + 24, 'thruster').setDepth(9);
      this.shieldRing = this.add.circle(this.player.x, this.player.y, 30, COLORS.powerShield, 0.18)
        .setStrokeStyle(2, COLORS.powerShield, 0.8).setDepth(11).setVisible(false);

      /* --- pooled groups (perf rule: pool everything that repeats) ------ */
      this.bullets = this.physics.add.group({ defaultKey: 'bullet', maxSize: CFG.BULLET_POOL, runChildUpdate: false });
      this.rocks = this.physics.add.group({ maxSize: CFG.ASTEROID_POOL });
      this.powerups = this.physics.add.group({ maxSize: 6 });

      this.sparks = this.add.particles(0, 0, 'spark', {
        speed: { min: 60, max: 220 }, lifespan: 520, scale: { start: 0.9, end: 0 },
        blendMode: 'ADD', emitting: false
      }).setDepth(20);

      /* --- input: keyboard + pointer + touch --------------------------- */
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keys = this.input.keyboard.addKeys('W,A,S,D,SPACE,P,ESC');
      this.input.addPointer(2);
      this.input.keyboard.on('keydown-P', () => this.togglePause());
      this.input.keyboard.on('keydown-ESC', () => this.togglePause());

      this.usingTouch = MEAMUS.touch.isTouch();
      if (this.usingTouch) {
        this.stick = MEAMUS.touch.joystick(this, { y: H - 96 });
        this.fireBtn = MEAMUS.touch.button(this, 'FIRE', null, { y: H - 96 });
      }

      /* --- collisions --------------------------------------------------- */
      this.physics.add.overlap(this.bullets, this.rocks, this.onBulletHit, null, this);
      this.physics.add.overlap(this.player, this.rocks, this.onPlayerHit, null, this);
      this.physics.add.overlap(this.player, this.powerups, this.onPickup, null, this);

      /* --- timers ------------------------------------------------------- */
      this.spawnTimer = this.time.addEvent({
        delay: this.spawnDelay, loop: true, callback: () => this.spawnRock()
      });
      this.waveTimer = this.time.addEvent({
        delay: CFG.WAVE_LENGTH_MS, loop: true, callback: () => this.nextWave()
      });

      this.buildHud();
      MEAMUS.watchForTakeover(this);
      this.attractBadge = MEAMUS.attractBadge(this);
      MEAMUS.onTakeover = () => {
        if (this.attractBadge) { this.attractBadge.destroy(); this.attractBadge = null; }
      };

      // Scene shutdown must release timers and emitters or they leak on restart.
      this.events.once('shutdown', () => this.cleanup());
      MEAMUS.attachDebug(this);
    }

    /**
     * Demo pilot. Slides toward the nearest power-up, steps away from whatever
     * rock is closest to hitting it, and holds fire. Good enough to look alive
     * and to keep a run going for a while - not good enough to look scripted.
     */
    botInput() {
      var threat = null;
      var threatDistance = Infinity;
      this.rocks.children.each((rock) => {
        if (!rock.active || rock.y > this.player.y) return;
        var dx = Math.abs(rock.x - this.player.x);
        var dy = this.player.y - rock.y;
        // Only rocks roughly in the ship's column can actually hit it.
        if (dx > 90) return;
        var distance = dy + dx * 0.6;
        if (distance < threatDistance) { threatDistance = distance; threat = rock; }
      });

      var target = null;
      this.powerups.children.each((pu) => {
        if (!pu.active) return;
        if (!target || pu.y > target.y) target = pu;
      });

      var vx = 0;
      var vy = 0;

      if (threat && threatDistance < 260) {
        // Dodge sideways, toward whichever edge there is more room.
        var away = threat.x < this.player.x ? 1 : -1;
        if ((away > 0 && this.player.x > this.scale.width - 70) ||
            (away < 0 && this.player.x < 70)) away = -away;
        vx = away;
      } else if (target) {
        vx = Phaser.Math.Clamp((target.x - this.player.x) / 70, -1, 1);
        vy = Phaser.Math.Clamp((target.y - this.player.y) / 90, -1, 1);
      } else {
        // Idle drift keeps the demo from looking frozen between waves.
        vx = Math.sin(this.time.now / 900) * 0.55;
      }

      // Hold station in the lower third of the screen.
      var restY = this.scale.height - 90;
      if (!target) vy = Phaser.Math.Clamp((restY - this.player.y) / 60, -1, 1);

      return { vx: vx, vy: vy, fire: true };
    }

    buildHud() {
      var W = this.scale.width;
      this.hudScore = MEAMUS.ui.label(this, 14, 14, 'SCORE 0', {
        size: 18, mono: true, color: '#2f2a24', originX: 0, originY: 0
      }).setDepth(900).setScrollFactor(0);
      this.hudLives = MEAMUS.ui.label(this, W - 14, 14, '', {
        size: 18, mono: true, color: '#c4503f', originX: 1, originY: 0
      }).setDepth(900).setScrollFactor(0);
      this.hudWave = MEAMUS.ui.label(this, W / 2, 14, 'WAVE 1', {
        size: 16, mono: true, color: '#7d7469', originY: 0
      }).setDepth(900).setScrollFactor(0);
      this.hudCombo = MEAMUS.ui.label(this, W / 2, 40, '', {
        size: 15, mono: true, color: '#c9862b', originY: 0
      }).setDepth(900).setScrollFactor(0);
      this.refreshHud();
    }

    refreshHud() {
      this.hudScore.setText('SCORE ' + this.score);
      this.hudLives.setText('LIVES ' + '♥'.repeat(Math.max(0, this.lives)));
      this.hudWave.setText('WAVE ' + this.wave);
      this.hudCombo.setText(this.combo > 1 ? 'COMBO x' + this.combo : '');
    }

    togglePause() {
      if (this.over) return;
      if (this.scene.isPaused()) return;
      this.scene.pause();
      this.scene.launch('PauseScene', { parent: 'GameScene' });
    }

    /* --- spawning ------------------------------------------------------- */
    spawnRock(opts) {
      opts = opts || {};
      var big = opts.big === undefined ? true : opts.big;
      var key = big ? 'rock-big' : 'rock-small';
      var x = opts.x === undefined ? Phaser.Math.Between(40, this.scale.width - 40) : opts.x;
      var y = opts.y === undefined ? -50 : opts.y;

      var rock = this.rocks.get(x, y, key);
      if (!rock) return null;                       // pool exhausted - skip
      rock.setTexture(key).setActive(true).setVisible(true);
      rock.body.enable = true;
      rock.setCircle(big ? CFG.ASTEROID_BIG / 2 : CFG.ASTEROID_SMALL / 2);
      rock.setData('big', big);
      rock.setData('hp', big ? 2 : 1);

      var speed = Phaser.Math.Between(CFG.ASTEROID_MIN_SPEED, CFG.ASTEROID_MAX_SPEED) + this.wave * 8;
      rock.setVelocity(opts.vx === undefined ? Phaser.Math.Between(-50, 50) : opts.vx, speed);
      rock.setAngularVelocity(Phaser.Math.Between(-90, 90));
      return rock;
    }

    nextWave() {
      this.wave += 1;
      this.spawnDelay = Math.max(CFG.SPAWN_FLOOR_MS, Math.round(this.spawnDelay * CFG.SPAWN_RAMP));
      // Rebuild the spawn timer so the shorter delay takes effect immediately.
      this.spawnTimer.remove(false);
      this.spawnTimer = this.time.addEvent({
        delay: this.spawnDelay, loop: true, callback: () => this.spawnRock()
      });
      MEAMUS.fx.floatText(this, this.scale.width / 2, 120, 'WAVE ' + this.wave, '#3d8fb8');
      // AD HOOK: a wave boundary is the natural interstitial slot.
      if (this.wave % MEAMUS.ads.interstitialEvery === 0) MEAMUS.ads.showInterstitial('wave-' + this.wave);
      this.refreshHud();
    }

    /* --- shooting ------------------------------------------------------- */
    fire(now) {
      if (now < this.nextShotAt) return;
      this.nextShotAt = now + this.fireRate;
      var angles = this.spread ? [-14, 0, 14] : [0];
      for (var i = 0; i < angles.length; i += 1) {
        var b = this.bullets.get(this.player.x, this.player.y - 22, 'bullet');
        if (!b) break;
        b.setActive(true).setVisible(true).setDepth(8);
        b.body.enable = true;
        b.setVelocity(Math.sin(Phaser.Math.DegToRad(angles[i])) * 260, CFG.BULLET_SPEED);
      }
      MEAMUS.sfx.laser();
    }

    /* --- collisions ----------------------------------------------------- */
    onBulletHit(bullet, rock) {
      if (!bullet.active || !rock.active) return;
      this.recycle(bullet);

      var hp = rock.getData('hp') - 1;
      rock.setData('hp', hp);
      this.sparks.explode(8, rock.x, rock.y);

      if (hp > 0) {
        rock.setTint(0xffaaaa);
        this.time.delayedCall(90, () => rock.active && rock.clearTint());
        return;
      }

      var big = rock.getData('big');
      var x = rock.x;
      var y = rock.y;
      this.recycle(rock);
      MEAMUS.sfx.explode();
      this.sparks.explode(big ? 22 : 12, x, y);

      // Combo: kills chained inside the window multiply the score.
      var now = this.time.now;
      this.combo = now - this.lastKillAt < CFG.COMBO_WINDOW_MS ? this.combo + 1 : 1;
      this.lastKillAt = now;
      var base = big ? CFG.SCORE_BIG : CFG.SCORE_SMALL;
      var gained = base * Math.min(this.combo, 5);
      this.score += gained;
      MEAMUS.fx.floatText(this, x, y, '+' + gained, this.combo > 1 ? '#2f8f68' : '#c9862b');

      if (big) {
        // Big rocks split into two smaller ones flung apart.
        this.spawnRock({ big: false, x: x - 14, y: y, vx: -Phaser.Math.Between(40, 110) });
        this.spawnRock({ big: false, x: x + 14, y: y, vx: Phaser.Math.Between(40, 110) });
      } else if (Math.random() < CFG.POWERUP_CHANCE) {
        this.spawnPowerup(x, y);
      }

      if (this.score % 500 < gained) MEAMUS.currency.add(5); // coin drip
      this.refreshHud();
    }

    onPlayerHit(player, rock) {
      if (!rock.active || this.over) return;
      if (this.time.now < this.invulnUntil) return;

      this.sparks.explode(16, rock.x, rock.y);
      this.recycle(rock);

      if (this.shield) {
        this.setShield(false);
        MEAMUS.fx.flash(this, [108, 123, 255]);
        MEAMUS.sfx.hurt();
        return;
      }

      this.lives -= 1;
      this.combo = 0;
      this.invulnUntil = this.time.now + CFG.PLAYER_INVULN_MS;
      MEAMUS.sfx.hurt();
      MEAMUS.fx.shake(this, 0.012, 220);
      MEAMUS.fx.flash(this);
      this.refreshHud();

      if (this.lives <= 0) this.endRun();
      else {
        this.tweens.add({
          targets: this.player, alpha: 0.25, yoyo: true,
          repeat: Math.floor(CFG.PLAYER_INVULN_MS / 300), duration: 150,
          onComplete: () => this.player.setAlpha(1)
        });
      }
    }

    spawnPowerup(x, y) {
      var kinds = ['spread', 'shield', 'rapid'];
      var kind = Phaser.Utils.Array.GetRandom(kinds);
      var pu = this.powerups.get(x, y, 'pu-' + kind);
      if (!pu) return;
      pu.setTexture('pu-' + kind).setActive(true).setVisible(true).setDepth(7);
      pu.body.enable = true;
      pu.setData('kind', kind);
      pu.setVelocity(0, CFG.POWERUP_SPEED);
      this.tweens.add({ targets: pu, scale: 1.18, yoyo: true, repeat: -1, duration: 520 });
    }

    onPickup(player, pu) {
      if (!pu.active) return;
      var kind = pu.getData('kind');
      this.recycle(pu);
      MEAMUS.sfx.coin();
      MEAMUS.currency.add(2);

      if (kind === 'spread') {
        this.spread = true;
        this.clearTimer('spreadTimer');
        this.spreadTimer = this.time.delayedCall(CFG.POWERUP_DURATION_MS, () => { this.spread = false; });
        MEAMUS.fx.floatText(this, player.x, player.y - 30, 'SPREAD SHOT', '#2f8f68');
      } else if (kind === 'rapid') {
        this.fireRate = CFG.RAPID_FIRE_RATE_MS;
        this.clearTimer('rapidTimer');
        this.rapidTimer = this.time.delayedCall(CFG.POWERUP_DURATION_MS, () => { this.fireRate = CFG.FIRE_RATE_MS; });
        MEAMUS.fx.floatText(this, player.x, player.y - 30, 'RAPID FIRE', '#c9862b');
      } else {
        this.setShield(true);
        MEAMUS.fx.floatText(this, player.x, player.y - 30, 'SHIELD UP', '#5570c9');
      }
    }

    setShield(on) {
      this.shield = on;
      this.shieldRing.setVisible(on);
    }

    clearTimer(name) {
      if (this[name]) { this[name].remove(false); this[name] = null; }
    }

    /** Return a pooled body to the pool without destroying it. */
    recycle(obj) {
      obj.setActive(false).setVisible(false);
      obj.body.stop();
      obj.body.enable = false;
      obj.setPosition(-200, -200);
      obj.clearTint();
      obj.setScale(1);
      this.tweens.killTweensOf(obj);
    }

    endRun() {
      if (this.over) return;
      this.over = true;
      this.sparks.explode(30, this.player.x, this.player.y);
      this.player.setVisible(false);
      this.thruster.setVisible(false);
      this.shieldRing.setVisible(false);
      this.physics.pause();
      MEAMUS.sfx.explode();
      this.time.delayedCall(700, () => {
        this.scene.start('GameOverScene', { score: this.score, wave: this.wave });
      });
    }

    cleanup() {
      this.clearTimer('spreadTimer');
      this.clearTimer('rapidTimer');
      if (this.spawnTimer) this.spawnTimer.remove(false);
      if (this.waveTimer) this.waveTimer.remove(false);
      if (this.stick) this.stick.destroy();
      if (this.fireBtn) this.fireBtn.destroy();
    }

    /* --- main loop ------------------------------------------------------ */
    update(time, delta) {
      if (this.over) return;

      var vx = 0;
      var vy = 0;

      if (MEAMUS.attractActive) {
        var bot = this.botInput();
        this.player.setVelocity(bot.vx * CFG.PLAYER_SPEED, bot.vy * CFG.PLAYER_SPEED);
        this.thruster.setPosition(this.player.x, this.player.y + 24)
          .setAlpha(0.55 + Math.random() * 0.45).setVisible(this.player.visible);
        this.shieldRing.setPosition(this.player.x, this.player.y);
        if (bot.fire) this.fire(time);
        this.sweepOffscreen(delta);
        return;
      }

      if (this.cursors.left.isDown || this.keys.A.isDown) vx -= 1;
      if (this.cursors.right.isDown || this.keys.D.isDown) vx += 1;
      if (this.cursors.up.isDown || this.keys.W.isDown) vy -= 1;
      if (this.cursors.down.isDown || this.keys.S.isDown) vy += 1;

      if (this.stick) {
        var v = this.stick.getVector();
        if (v.x || v.y) { vx = v.x; vy = v.y; }
      }

      // Mouse / single-finger drag steers the ship directly.
      var p = this.input.activePointer;
      if (!vx && !vy && p.isDown && !this.usingTouch) {
        var dx = p.x - this.player.x;
        if (Math.abs(dx) > 6) vx = Phaser.Math.Clamp(dx / 60, -1, 1);
        var dy = p.y - this.player.y;
        if (Math.abs(dy) > 6) vy = Phaser.Math.Clamp(dy / 60, -1, 1);
      }

      var len = Math.hypot(vx, vy) || 1;
      this.player.setVelocity((vx / len) * CFG.PLAYER_SPEED, (vy / len) * CFG.PLAYER_SPEED);

      this.thruster.setPosition(this.player.x, this.player.y + 24)
        .setAlpha(0.55 + Math.random() * 0.45)
        .setVisible(this.player.visible);
      this.shieldRing.setPosition(this.player.x, this.player.y);

      var wantsFire = this.keys.SPACE.isDown ||
        (this.fireBtn && this.fireBtn.isDown()) ||
        (p.isDown && !this.usingTouch);
      if (wantsFire) this.fire(time);

      if (this.combo && time - this.lastKillAt > CFG.COMBO_WINDOW_MS && this.combo > 1) {
        this.combo = 0;
        this.refreshHud();
      }

      this.sweepOffscreen(delta);
    }

    /** Recycle anything that has left the play field, and scroll the stars. */
    sweepOffscreen(delta) {
      var H = this.scale.height;
      this.bullets.children.each((b) => { if (b.active && b.y < -30) this.recycle(b); });
      this.rocks.children.each((r) => { if (r.active && r.y > H + 60) this.recycle(r); });
      this.powerups.children.each((pu) => { if (pu.active && pu.y > H + 40) this.recycle(pu); });
      updateStarfield(this.starfield, delta, H);
    }
  }

  /* ======================================================================= */
  /* Pause overlay                                                           */
  /* ======================================================================= */
  class PauseScene extends Phaser.Scene {
    constructor() { super({ key: 'PauseScene' }); }
    create(data) {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.rectangle(0, 0, W, H, 0x000000, 0.6).setOrigin(0, 0);
      MEAMUS.ui.title(this, W / 2, H / 2 - 60, 'PAUSED', 34);
      MEAMUS.ui.button(this, W / 2, H / 2 + 10, 'RESUME', () => {
        this.scene.resume(data.parent);
        this.scene.stop();
      }, { width: 200 });
      MEAMUS.ui.button(this, W / 2, H / 2 + 78, 'QUIT', () => {
        this.scene.stop(data.parent);
        this.scene.stop();
        this.scene.start('MenuScene');
      }, { width: 200, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });
    }
  }

  /* ======================================================================= */
  /* Game over                                                               */
  /* ======================================================================= */
  class GameOverScene extends Phaser.Scene {
    constructor() { super({ key: 'GameOverScene' }); }

    create(data) {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'space-bg').setDisplaySize(W, H);
      this.starfield = createStarfield(this, 30);

      var score = data.score || 0;
      var prevBest = MEAMUS.storage.best(CFG.KEY);
      var best = MEAMUS.storage.best(CFG.KEY, score);
      var isRecord = score > prevBest;

      MEAMUS.ui.title(this, W / 2, 108, isRecord ? 'NEW RECORD!' : 'RUN OVER', 40);
      MEAMUS.ui.label(this, W / 2, 172, 'SCORE  ' + score + '\nWAVE   ' + (data.wave || 1) + '\nBEST   ' + best, {
        size: 20, mono: true, color: '#2f2a24', lineSpacing: 8
      });
      if (isRecord) MEAMUS.sfx.win();

      MEAMUS.ui.button(this, W / 2, 300, 'PLAY AGAIN', () => this.scene.start('GameScene'), { width: 240 });

      // AD HOOK: rewarded video for a revive. Denied while no SDK is wired in.
      MEAMUS.ui.button(this, W / 2, 364, 'WATCH AD: +1 LIFE', () => {
        MEAMUS.ads.showRewarded('revive',
          () => this.scene.start('GameScene'),
          () => MEAMUS.fx.floatText(this, W / 2, 364, 'No ad available', '#c4503f'));
      }, { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      MEAMUS.ui.button(this, W / 2, 428, 'MENU', () => this.scene.start('MenuScene'), {
        width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk
      });

      // AD HOOK: interstitial every N runs.
      if (MEAMUS.ads.countRun()) MEAMUS.ads.showInterstitial('game-over');
      MEAMUS.ui.bannerSlot(this, 'bottom');

      this.input.keyboard.on('keydown-SPACE', () => this.scene.start('GameScene'));

      // The demo loops rather than waiting on a click that will never come.
      MEAMUS.watchForTakeover(this);
      if (MEAMUS.attractActive) this.time.delayedCall(2600, () => {
        if (MEAMUS.attractActive) this.scene.start('GameScene');
      });
    }

    update(time, delta) { updateStarfield(this.starfield, delta, this.scale.height); }
  }

  /* --- shared starfield helper ------------------------------------------ */
  function createStarfield(scene, count) {
    var stars = [];
    for (var i = 0; i < count; i += 1) {
      var s = scene.add.image(
        Phaser.Math.Between(0, scene.scale.width),
        Phaser.Math.Between(0, scene.scale.height),
        'star-dot'
      ).setDepth(-5);
      s.speed = Phaser.Math.Between(18, 90);
      s.setAlpha(Phaser.Math.FloatBetween(0.25, 0.9)).setScale(Phaser.Math.FloatBetween(0.5, 1.4));
      stars.push(s);
    }
    return stars;
  }

  function updateStarfield(stars, delta, height) {
    if (!stars) return;
    for (var i = 0; i < stars.length; i += 1) {
      var s = stars[i];
      s.y += (s.speed * delta) / 1000;
      if (s.y > height + 4) s.y = -4;
    }
  }

  /* --- boot -------------------------------------------------------------- */
  MEAMUS.boot({
    type: Phaser.AUTO,
    width: CFG.WIDTH,
    height: CFG.HEIGHT,
    parent: 'game-container',
    backgroundColor: '#fdf6ec',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
    scene: [
      MEAMUS.scenes.makeBoot('PreloadScene'),
      MEAMUS.scenes.makePreload({ bake: bakeTextures, title: 'ASTRO SALVAGE', next: 'MenuScene' }),
      MenuScene,
      GameScene,
      PauseScene,
      GameOverScene
    ],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
  });

  // DEBUG: uncomment for development
  // MEAMUS.debug = true;
})();
