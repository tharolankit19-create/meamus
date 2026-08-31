/* =============================================================================
 * Neon Dash - one-thumb endless runner
 * Template game for meamus. Requires the meamus kit (MEAMUS global).
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = {
    WIDTH: 800,
    HEIGHT: 600,
    KEY: 'neon-dash',

    GRAVITY: 1500,
    JUMP_VELOCITY: -560,
    DOUBLE_JUMP_VELOCITY: -480,
    MAX_JUMPS: 2,

    GROUND_Y: 470,
    PLAYER_X: 170,
    PLAYER_W: 34,
    PLAYER_H: 46,
    SLIDE_H: 24,
    SLIDE_MS: 520,

    START_SPEED: 300,
    MAX_SPEED: 720,
    SPEED_RAMP_PER_SEC: 7,        // px/s added per second survived

    GAP_MIN: 260,
    GAP_MAX: 470,
    GAP_TIGHTEN: 0.9,             // gaps shrink as speed climbs

    COIN_CHANCE: 0.65,
    COIN_VALUE: 10,
    DISTANCE_PER_POINT: 12,       // px of travel per score point

    SHIELD_CHANCE: 0.12,
    OBSTACLE_POOL: 14,
    COIN_POOL: 26
  };

  // Pastel dusk: peach sky, mint ground, nothing darker than mid-tone.
  var COLORS = {
    sky: 0xfff1e6,         // peach at the horizon
    skyTop: 0xd9ecff,      // soft blue overhead
    ground: 0xe8f3ec,      // pale mint
    groundLine: 0x7fbfa0,  // sage seam
    player: 0xff7a9c,      // rose runner
    spike: 0xef6461,       // soft red hazard
    barrier: 0xf0a04b,     // apricot beam
    coin: 0xffcf5c,        // honey
    shield: 0x7aa6f0,      // periwinkle
    hill: 0xcfe4f5,        // near hills
    hillFar: 0xe3eef8      // far hills
  };

  function bakeTextures(scene) {
    var G = MEAMUS.gfx;

    // TODO: replace with generated sprite: runner - 34x46 neon cyan sprinter
    // silhouette with a trailing light streak.
    G.rect(scene, 'runner', CFG.PLAYER_W, CFG.PLAYER_H, COLORS.player, { radius: 8, stroke: 0xffffff, strokeWidth: 2 });
    G.rect(scene, 'runner-slide', CFG.PLAYER_W + 10, CFG.SLIDE_H, COLORS.player, { radius: 8, stroke: 0xffffff, strokeWidth: 2 });

    // TODO: replace with generated sprite: spike - 40x44 magenta hazard prism.
    G.poly(scene, 'spike', 40, 44, [[0.5, 0], [1, 1], [0, 1]], COLORS.spike, { stroke: 0xffffff, strokeWidth: 2 });
    G.rect(scene, 'spike-wide', 64, 30, COLORS.spike, { radius: 4, stroke: 0xffffff, strokeWidth: 2 });

    // TODO: replace with generated sprite: barrier - 54x30 amber overhead beam.
    G.rect(scene, 'barrier', 54, 30, COLORS.barrier, { radius: 4, stroke: 0xffffff, strokeWidth: 2 });

    G.circle(scene, 'coin', 22, COLORS.coin, { shine: true });
    G.circle(scene, 'shield-pu', 26, COLORS.shield, { glow: true, shine: true });
    G.particle(scene, 'dust', 10, 0xff8fe8);
    G.rect(scene, 'ground-tile', 64, 130, COLORS.ground);
    G.rect(scene, 'grid-line', 2, 130, 0x3a1f70);
    G.gradient(scene, 'sky', 8, CFG.HEIGHT, COLORS.skyTop, COLORS.sky);
    G.poly(scene, 'hill', 260, 160, [[0, 1], [0.5, 0], [1, 1]], COLORS.hill);
    G.poly(scene, 'hill-far', 340, 210, [[0, 1], [0.5, 0], [1, 1]], COLORS.hillFar);
  }

  /* ======================================================================= */
  class MenuScene extends Phaser.Scene {
    constructor() { super({ key: 'MenuScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'sky').setDisplaySize(W, H);
      this.add.image(W * 0.25, CFG.GROUND_Y, 'hill-far').setOrigin(0.5, 1);
      this.add.image(W * 0.75, CFG.GROUND_Y, 'hill').setOrigin(0.5, 1);
      this.add.rectangle(0, CFG.GROUND_Y, W, H - CFG.GROUND_Y, COLORS.ground).setOrigin(0, 0);
      this.add.rectangle(0, CFG.GROUND_Y, W, 3, COLORS.groundLine).setOrigin(0, 0);

      MEAMUS.ui.title(this, W / 2, 120, 'NEON DASH', 52);
      MEAMUS.ui.label(this, W / 2, 168, 'Run forever. Jump the spikes. Slide the beams.', { size: 16 });

      var best = MEAMUS.storage.best(CFG.KEY);
      MEAMUS.ui.label(this, W / 2, 208, 'BEST  ' + best + '        COINS  ' + MEAMUS.currency.get(), {
        size: 15, mono: true, color: MEAMUS.ui.PALETTE.warn
      });

      var play = () => this.scene.start('GameScene');
      MEAMUS.ui.button(this, W / 2, 272, 'RUN', play, { width: 220 });
      var help = MEAMUS.ui.button(this, W / 2, 336, 'HOW TO PLAY', () => this.showHelp(), { width: 220, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      var runner = this.add.image(CFG.PLAYER_X, CFG.GROUND_Y - CFG.PLAYER_H / 2, 'runner');
      this.tweens.add({ targets: runner, y: runner.y - 18, yoyo: true, repeat: -1, duration: 480, ease: 'Sine.easeInOut' });

      MEAMUS.attachDebug(this);
      MEAMUS.ui.anywhereToStart(this, play, [help]);

      // The landing-page demo drops straight into play rather than a menu.
      if (MEAMUS.attractActive) this.time.delayedCall(700, play);
    }

    showHelp() {
      if (this.helpOpen) return;
      this.helpOpen = true;
      var W = this.scale.width;
      var H = this.scale.height;
      var layer = this.add.container(0, 0).setDepth(1000);
      layer.add(MEAMUS.ui.panel(this, W / 2, H / 2, Math.min(520, W - 60), 320));
      layer.add(MEAMUS.ui.title(this, W / 2, H / 2 - 116, 'HOW TO PLAY', 26));
      layer.add(MEAMUS.ui.label(this, W / 2, H / 2 - 20,
        'JUMP    Space / Up / W / tap / click  (tap again to double jump)\n' +
        'SLIDE   Down / S / swipe down / hold the SLIDE button\n' +
        'PAUSE   P or Esc\n\n' +
        'Pink spikes must be jumped. Amber beams must be slid under.\n' +
        'Coins are worth 10 points. Blue orbs give a one-hit shield.\n' +
        'You speed up every second you survive.',
        { size: 15, wrap: Math.min(460, W - 100), lineSpacing: 7 }));
      layer.add(MEAMUS.ui.button(this, W / 2, H / 2 + 112, 'GOT IT', () => {
        layer.destroy(true);
        this.helpOpen = false;
      }, { width: 160, height: 46 }));
    }
  }

  /* ======================================================================= */
  class GameScene extends Phaser.Scene {
    constructor() { super({ key: 'GameScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;

      /* --- run state ---------------------------------------------------- */
      this.speed = CFG.START_SPEED;
      this.distance = 0;
      this.coins = 0;
      this.score = 0;
      this.jumps = 0;
      this.sliding = false;
      this.shield = false;
      this.over = false;
      this.nextSpawnX = W + 120;

      /* --- parallax background ----------------------------------------- */
      this.add.image(W / 2, H / 2, 'sky').setDisplaySize(W, H).setDepth(-30);
      this.hillsFar = this.add.tileSprite(0, CFG.GROUND_Y - 210, W, 210, 'hill-far').setOrigin(0, 0).setDepth(-22).setAlpha(0.7);
      this.hills = this.add.tileSprite(0, CFG.GROUND_Y - 160, W, 160, 'hill').setOrigin(0, 0).setDepth(-20).setAlpha(0.85);
      this.groundTile = this.add.tileSprite(0, CFG.GROUND_Y, W, H - CFG.GROUND_Y, 'ground-tile').setOrigin(0, 0).setDepth(-10);
      this.gridTile = this.add.tileSprite(0, CFG.GROUND_Y, W, H - CFG.GROUND_Y, 'grid-line').setOrigin(0, 0).setDepth(-9).setAlpha(0.6);
      this.add.rectangle(0, CFG.GROUND_Y, W, 3, COLORS.groundLine).setOrigin(0, 0).setDepth(-8);

      /* --- player ------------------------------------------------------- */
      this.player = this.physics.add.sprite(CFG.PLAYER_X, CFG.GROUND_Y - CFG.PLAYER_H / 2, 'runner');
      this.player.body.setSize(CFG.PLAYER_W - 6, CFG.PLAYER_H - 4);
      this.player.setDepth(10);
      this.player.setCollideWorldBounds(false);

      // Invisible floor keeps the runner grounded without a tilemap.
      this.floor = this.physics.add.staticImage(W / 2, CFG.GROUND_Y + 10, 'ground-tile')
        .setDisplaySize(W * 3, 20).refreshBody().setVisible(false);
      this.physics.add.collider(this.player, this.floor, () => { this.jumps = 0; });

      this.shieldRing = this.add.circle(0, 0, 34, COLORS.shield, 0.16)
        .setStrokeStyle(2, COLORS.shield, 0.85).setDepth(11).setVisible(false);

      /* --- pooled hazards + pickups ------------------------------------ */
      this.obstacles = this.physics.add.group({ allowGravity: false, immovable: true, maxSize: CFG.OBSTACLE_POOL });
      this.pickups = this.physics.add.group({ allowGravity: false, maxSize: CFG.COIN_POOL });

      this.dust = this.add.particles(0, 0, 'dust', {
        speed: { min: 40, max: 140 }, lifespan: 420, scale: { start: 0.7, end: 0 },
        blendMode: 'ADD', emitting: false
      }).setDepth(12);

      this.physics.add.overlap(this.player, this.obstacles, this.onCrash, null, this);
      this.physics.add.overlap(this.player, this.pickups, this.onPickup, null, this);

      /* --- input -------------------------------------------------------- */
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keys = this.input.keyboard.addKeys('W,S,SPACE,P,ESC');
      this.input.addPointer(2);
      this.input.keyboard.on('keydown-SPACE', () => this.jump());
      this.input.keyboard.on('keydown-UP', () => this.jump());
      this.input.keyboard.on('keydown-W', () => this.jump());
      this.input.keyboard.on('keydown-DOWN', () => this.slide());
      this.input.keyboard.on('keydown-S', () => this.slide());
      this.input.keyboard.on('keydown-P', () => this.togglePause());
      this.input.keyboard.on('keydown-ESC', () => this.togglePause());

      this.setupPointerInput();

      this.buildHud();
      this.events.once('shutdown', () => this.cleanup());
      MEAMUS.attachDebug(this);
    }

    /**
     * Pointer handling doubles as swipe detection: a downward flick slides,
     * anything else jumps. Works for mouse and touch with one code path.
     */
    setupPointerInput() {
      var SWIPE_MIN = 40;
      var SWIPE_MS = 400;
      this.input.on('pointerdown', (p) => { this.swipeStart = { x: p.x, y: p.y, t: this.time.now }; });
      this.input.on('pointerup', (p) => {
        if (!this.swipeStart) return;
        var dy = p.y - this.swipeStart.y;
        var dx = p.x - this.swipeStart.x;
        var dt = this.time.now - this.swipeStart.t;
        this.swipeStart = null;
        if (this.slideBtnActive) return;              // handled by the button
        if (dt < SWIPE_MS && dy > SWIPE_MIN && Math.abs(dy) > Math.abs(dx)) this.slide();
        else this.jump();
      });

      if (MEAMUS.touch.isTouch()) {
        var H = this.scale.height;
        this.slideBtn = MEAMUS.touch.button(this, 'SLIDE', () => this.slide(), {
          x: 84, y: H - 78, radius: 48
        });
        this.jumpBtn = MEAMUS.touch.button(this, 'JUMP', () => this.jump(), {
          x: this.scale.width - 84, y: H - 78, radius: 48
        });
      }
    }

    buildHud() {
      var W = this.scale.width;
      this.hudScore = MEAMUS.ui.label(this, 14, 14, '0 m', {
        size: 20, mono: true, color: '#2f2a24', originX: 0, originY: 0
      }).setDepth(900);
      this.hudCoins = MEAMUS.ui.label(this, W - 14, 14, '0 coins', {
        size: 18, mono: true, color: '#c9862b', originX: 1, originY: 0
      }).setDepth(900);
      this.hudSpeed = MEAMUS.ui.label(this, W / 2, 14, '', {
        size: 14, mono: true, color: '#7d7469', originY: 0
      }).setDepth(900);
    }

    refreshHud() {
      this.hudScore.setText(Math.floor(this.distance / CFG.DISTANCE_PER_POINT) + ' m');
      this.hudCoins.setText(this.coins + ' coins');
      this.hudSpeed.setText('SPEED ' + Math.round(this.speed));
    }

    togglePause() {
      if (this.over || this.scene.isPaused()) return;
      this.scene.pause();
      this.scene.launch('PauseScene', { parent: 'GameScene' });
    }

    /* --- movement ------------------------------------------------------- */
    jump() {
      if (this.over) return;
      MEAMUS.sfx.resume();
      if (this.sliding) this.endSlide();
      if (this.jumps >= CFG.MAX_JUMPS) return;
      this.player.setVelocityY(this.jumps === 0 ? CFG.JUMP_VELOCITY : CFG.DOUBLE_JUMP_VELOCITY);
      this.jumps += 1;
      MEAMUS.sfx.jump();
      this.dust.explode(6, this.player.x - 12, this.player.y);
    }

    slide() {
      if (this.over || this.sliding) return;
      // Sliding in mid-air becomes a fast drop so the input is never wasted.
      if (!this.player.body.blocked.down && !this.player.body.touching.down) {
        this.player.setVelocityY(Math.max(this.player.body.velocity.y, 420));
        return;
      }
      this.sliding = true;
      this.player.setTexture('runner-slide');
      this.player.body.setSize(CFG.PLAYER_W + 4, CFG.SLIDE_H - 2);
      this.dust.explode(10, this.player.x - 16, this.player.y + CFG.SLIDE_H / 2);
      this.clearTimer('slideTimer');
      this.slideTimer = this.time.delayedCall(CFG.SLIDE_MS, () => this.endSlide());
    }

    endSlide() {
      if (!this.sliding) return;
      this.sliding = false;
      this.player.setTexture('runner');
      this.player.body.setSize(CFG.PLAYER_W - 6, CFG.PLAYER_H - 4);
    }

    /* --- world generation ----------------------------------------------- */
    spawnChunk() {
      var W = this.scale.width;
      // Gaps tighten as speed climbs so difficulty scales with reaction time.
      var speedFactor = this.speed / CFG.START_SPEED;
      var gap = Phaser.Math.Between(
        Math.round(CFG.GAP_MIN * Math.pow(CFG.GAP_TIGHTEN, speedFactor - 1)),
        Math.round(CFG.GAP_MAX * Math.pow(CFG.GAP_TIGHTEN, speedFactor - 1))
      );
      this.nextSpawnX = W + 60;

      var roll = Math.random();
      if (roll < 0.42) this.addObstacle('spike', W + 60, CFG.GROUND_Y - 22, 40, 44);
      else if (roll < 0.68) this.addObstacle('barrier', W + 60, CFG.GROUND_Y - 78, 54, 30);
      else if (roll < 0.86) {
        // Double spike: needs a committed jump, not a tap.
        this.addObstacle('spike', W + 60, CFG.GROUND_Y - 22, 40, 44);
        this.addObstacle('spike', W + 104, CFG.GROUND_Y - 22, 40, 44);
      } else {
        this.addObstacle('spike-wide', W + 60, CFG.GROUND_Y - 15, 64, 30);
      }

      if (Math.random() < CFG.COIN_CHANCE) this.addCoinArc(W + 60 + gap * 0.45);
      if (Math.random() < CFG.SHIELD_CHANCE) this.addPickup('shield-pu', W + 60 + gap * 0.7, CFG.GROUND_Y - 150);

      this.time.delayedCall((gap / this.speed) * 1000, () => {
        if (!this.over) this.spawnChunk();
      });
    }

    addObstacle(key, x, y, w, h) {
      var o = this.obstacles.get(x, y, key);
      if (!o) return null;
      o.setTexture(key).setActive(true).setVisible(true).setDepth(5);
      o.body.enable = true;
      o.body.setAllowGravity(false);
      o.setPosition(x, y);
      o.body.setSize(w - 8, h - 6);
      o.setData('kind', key);
      return o;
    }

    /** Three coins in a shallow arc - rewards a well-timed jump. */
    addCoinArc(x) {
      for (var i = 0; i < 3; i += 1) {
        var offset = (i - 1) * 46;
        var lift = 70 + (i === 1 ? 46 : 0);
        this.addPickup('coin', x + offset, CFG.GROUND_Y - lift);
      }
    }

    addPickup(key, x, y) {
      var p = this.pickups.get(x, y, key);
      if (!p) return null;
      p.setTexture(key).setActive(true).setVisible(true).setDepth(6);
      p.body.enable = true;
      p.body.setAllowGravity(false);
      p.setPosition(x, y);
      p.setData('kind', key);
      return p;
    }

    /* --- collisions ----------------------------------------------------- */
    onCrash(player, obstacle) {
      if (this.over || !obstacle.active) return;

      if (this.shield) {
        this.shield = false;
        this.shieldRing.setVisible(false);
        this.recycle(obstacle);
        MEAMUS.fx.flash(this, [108, 123, 255]);
        MEAMUS.sfx.hurt();
        return;
      }

      this.die();
    }

    /** Single death path, shared by hazard hits and falling out of the world. */
    die() {
      if (this.over) return;
      this.over = true;
      this.physics.pause();
      this.dust.explode(28, this.player.x, this.player.y);
      MEAMUS.sfx.hurt();
      MEAMUS.fx.shake(this, 0.016, 260);
      MEAMUS.fx.flash(this);
      this.player.setTint(0xff4f6d);

      this.time.delayedCall(650, () => {
        this.scene.start('GameOverScene', {
          score: this.score,
          metres: Math.floor(this.distance / CFG.DISTANCE_PER_POINT),
          coins: this.coins
        });
      });
    }

    onPickup(player, pickup) {
      if (!pickup.active) return;
      var kind = pickup.getData('kind');
      var x = pickup.x;
      var y = pickup.y;
      this.recycle(pickup);

      if (kind === 'coin') {
        this.coins += 1;
        this.score += CFG.COIN_VALUE;
        MEAMUS.currency.add(1);
        MEAMUS.sfx.coin();
        MEAMUS.fx.floatText(this, x, y, '+' + CFG.COIN_VALUE, '#c9862b');
      } else {
        this.shield = true;
        this.shieldRing.setVisible(true);
        MEAMUS.sfx.match(2);
        MEAMUS.fx.floatText(this, x, y, 'SHIELD', '#5570c9');
      }
      this.refreshHud();
    }

    recycle(obj) {
      obj.setActive(false).setVisible(false);
      obj.body.enable = false;
      obj.setPosition(-300, -300);
    }

    clearTimer(name) {
      if (this[name]) { this[name].remove(false); this[name] = null; }
    }

    cleanup() {
      this.clearTimer('slideTimer');
      if (this.slideBtn) this.slideBtn.destroy();
      if (this.jumpBtn) this.jumpBtn.destroy();
    }

    /* --- main loop ------------------------------------------------------ */
    update(time, delta) {
      if (this.over) return;

      // Kick off world generation once, after the first frame has a delta.
      if (!this.started) {
        this.started = true;
        this.spawnChunk();
      }

      var dt = delta / 1000;

      // Difficulty ramp: +7 px/s of scroll speed for every second survived.
      this.speed = Math.min(CFG.MAX_SPEED, this.speed + CFG.SPEED_RAMP_PER_SEC * dt);
      var travel = this.speed * dt;
      this.distance += travel;
      this.score = Math.floor(this.distance / CFG.DISTANCE_PER_POINT) + this.coins * CFG.COIN_VALUE;

      // Parallax layers scroll at fractions of the world speed.
      this.hillsFar.tilePositionX += travel * 0.12;
      this.hills.tilePositionX += travel * 0.28;
      this.groundTile.tilePositionX += travel;
      this.gridTile.tilePositionX += travel * 1.4;

      // Held keys keep the slide active for as long as they are down.
      if ((this.cursors.down.isDown || this.keys.S.isDown) && !this.sliding) this.slide();
      if (this.slideBtn && this.slideBtn.isDown() && !this.sliding) this.slide();

      // Move the world past the player rather than moving the camera.
      this.obstacles.children.each((o) => {
        if (!o.active) return;
        o.x -= travel;
        if (o.x < -90) this.recycle(o);
      });
      this.pickups.children.each((p) => {
        if (!p.active) return;
        p.x -= travel;
        p.y += Math.sin((time + p.x) / 220) * 0.35;
        if (p.x < -60) this.recycle(p);
      });

      this.shieldRing.setPosition(this.player.x, this.player.y);
      if (this.player.y > this.scale.height + 60) this.die();

      this.refreshHud();
    }
  }

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
  class GameOverScene extends Phaser.Scene {
    constructor() { super({ key: 'GameOverScene' }); }

    create(data) {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'sky').setDisplaySize(W, H);
      this.add.rectangle(0, CFG.GROUND_Y, W, H - CFG.GROUND_Y, COLORS.ground).setOrigin(0, 0);
      this.add.rectangle(0, CFG.GROUND_Y, W, 3, COLORS.groundLine).setOrigin(0, 0);

      var score = data.score || 0;
      var prevBest = MEAMUS.storage.best(CFG.KEY);
      var best = MEAMUS.storage.best(CFG.KEY, score);
      var isRecord = score > prevBest;

      MEAMUS.ui.title(this, W / 2, 104, isRecord ? 'NEW RECORD!' : 'WIPEOUT', 42);
      MEAMUS.ui.label(this, W / 2, 178,
        'SCORE     ' + score + '\nDISTANCE  ' + (data.metres || 0) + ' m\nCOINS     ' + (data.coins || 0) + '\nBEST      ' + best,
        { size: 19, mono: true, color: '#2f2a24', lineSpacing: 8 });
      if (isRecord) MEAMUS.sfx.win();

      MEAMUS.ui.button(this, W / 2, 300, 'RUN AGAIN', () => this.scene.start('GameScene'), { width: 240 });
      // AD HOOK: rewarded video continues the run from where it ended.
      MEAMUS.ui.button(this, W / 2, 364, 'WATCH AD: CONTINUE', () => {
        MEAMUS.ads.showRewarded('continue',
          () => this.scene.start('GameScene'),
          () => MEAMUS.fx.floatText(this, W / 2, 364, 'No ad available', '#c4503f'));
      }, { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });
      MEAMUS.ui.button(this, W / 2, 428, 'MENU', () => this.scene.start('MenuScene'), { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      if (MEAMUS.ads.countRun()) MEAMUS.ads.showInterstitial('game-over');
      MEAMUS.ui.bannerSlot(this, 'bottom');

      this.input.keyboard.on('keydown-SPACE', () => this.scene.start('GameScene'));
    }
  }

  /* --- boot -------------------------------------------------------------- */
  MEAMUS.boot({
    type: Phaser.AUTO,
    width: CFG.WIDTH,
    height: CFG.HEIGHT,
    parent: 'game-container',
    backgroundColor: '#fff1e6',
    physics: { default: 'arcade', arcade: { gravity: { y: CFG.GRAVITY }, debug: false } },
    scene: [
      MEAMUS.scenes.makeBoot('PreloadScene'),
      MEAMUS.scenes.makePreload({ bake: bakeTextures, title: 'NEON DASH', next: 'MenuScene' }),
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
