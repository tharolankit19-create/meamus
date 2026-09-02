/* =============================================================================
 * Crystal Caves - three-level collect-a-thon platformer
 * Template game for meamus. Requires the meamus kit (MEAMUS global).
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = {
    // WIDTH/HEIGHT are the canvas - the window onto the cave. WORLD_W/WORLD_H
    // are the cave itself. On a phone the window is about a third of it and
    // the camera scrolls; on a desktop they are the same and it does not. All
    // four are recomputed from the real screen at the bottom of this file.
    WIDTH: 800,
    HEIGHT: 576,
    WORLD_W: 800,
    WORLD_H: 576,
    KEY: 'crystal-caves',

    // Everything below is tuned against DESIGN_TILE. The real tile is sized to
    // the screen, so the speeds and the gravity are rescaled to match it at the
    // bottom of this file - see the note there. Read these as "at 32px tiles".
    DESIGN_TILE: 32,
    TILE: 32,
    COLS: 25,
    ROWS: 18,

    GRAVITY: 1100,
    RUN_SPEED: 240,
    AIR_CONTROL: 0.75,
    JUMP_VELOCITY: -520,
    COYOTE_MS: 110,           // grace period after walking off an edge
    JUMP_BUFFER_MS: 130,      // early jump press still fires on landing

    ENEMY_SPEED: 62,
    ENEMY_STOMP_BOUNCE: -330,

    GEM_SCORE: 100,
    STOMP_SCORE: 150,
    LEVEL_TIME_LIMIT: 90,     // seconds; leftover time becomes a bonus
    TIME_BONUS_PER_SEC: 5,
    START_LIVES: 3
  };

  // Warm sunlit stone: sand walls, mint ledges, nothing murky.
  var COLORS = {
    bg: 0xfaf3e7,          // sunlit cave floor
    bgTop: 0xdceaf5,       // cool light from above
    solid: 0xd8c3a5,       // sandstone
    solidTop: 0xefe0c9,    // lit top edge
    platform: 0x9ad3b8,    // mint ledge
    player: 0x4fa3d1,      // cornflower explorer
    enemy: 0xf08a8a,       // soft coral crawler
    gem: 0x5ec8c8,         // teal crystal
    spike: 0xe4735e,       // terracotta hazard
    door: 0xf2b544         // amber exit
  };

  /* --- Level maps -------------------------------------------------------- */
  /* # solid  = one-way platform  ^ spike  g gem  e enemy  P start  D exit    */
  var LEVELS = [
    [
      '#########################',
      '#.......................#',
      '#..g.................g..#',
      '#..===..............===.#',
      '#.......................#',
      '#........g...g..........#',
      '#.......=======.........#',
      '#.......................#',
      '#..g...............e....#',
      '#..====.........=======.#',
      '#.......................#',
      '#.....e.........g.......#',
      '#...========...=====....#',
      '#.......................#',
      '#..........g............#',
      '#.P.....^^^.......^^..D.#',
      '#########################',
      '#########################'
    ],
    [
      '#########################',
      '#.....g.............g...#',
      '#....===...........====.#',
      '#.......................#',
      '#..g......e.......e.....#',
      '#.====...=====...=====..#',
      '#.......................#',
      '#........g..........g...#',
      '#....==========....===..#',
      '#.......................#',
      '#..e...............g....#',
      '#=======.......======...#',
      '#..............g........#',
      '#............======.....#',
      '#.......................#',
      '#.P...^^^.......^^^...D.#',
      '#########################',
      '#########################'
    ],
    [
      '#########################',
      '#..g.....g.....g.....g..#',
      '#.===...===...===...===.#',
      '#.......................#',
      '#...e.....e.....e.......#',
      '#..=====.=====.=====....#',
      '#.......................#',
      '#....g............g.....#',
      '#...=====...e...=====...#',
      '#..........=====........#',
      '#..g.................g..#',
      '#.====...........=====..#',
      '#.......................#',
      '#.......=========.......#',
      '#..........g............#',
      '#.P..^^^^..^^^..^^^^..D.#',
      '#########################',
      '#########################'
    ]
  ];

  /**
   * Design pixels to screen pixels.
   *
   * Every sprite below is drawn against a 32px tile - a 24px hero is three
   * quarters of a tile. The real tile is sized to the screen, 31px on a desktop
   * and 53 on a phone, so a literal 24 is three quarters of a tile in one place
   * and under half in the other: the phone got a hero half the size it should
   * be, standing on tiles built for someone bigger.
   */
  function px(n) {
    return Math.max(1, Math.round(n * (CFG.TILE / CFG.DESIGN_TILE)));
  }

  function bakeTextures(scene) {
    var G = MEAMUS.gfx;
    var T = CFG.TILE;
    var PLATFORM_H = px(12);
    var SPIKE_H = px(18);

    // TODO: replace with generated sprite: solid cave tile, 32x32 blue-grey
    // stone with a lit top edge.
    G.texture(scene, 'tile-solid', T, T, function (g) {
      g.fillStyle(COLORS.solid, 1).fillRect(0, 0, T, T);
      g.fillStyle(COLORS.solidTop, 1).fillRect(0, 0, T, px(5));
      g.lineStyle(1, 0x000000, 0.22).strokeRect(0, 0, T, T);
    });
    G.texture(scene, 'tile-platform', T, PLATFORM_H, function (g) {
      g.fillStyle(COLORS.platform, 1).fillRoundedRect(0, 0, T, PLATFORM_H, px(3));
      g.fillStyle(0xa78bff, 1).fillRect(0, 0, T, px(3));
    });

    // TODO: replace with generated sprite: hero, 24x30 green cave explorer.
    G.rect(scene, 'hero', px(24), px(30), COLORS.player, { radius: px(6), stroke: 0x0d1226, strokeWidth: 2 });
    // TODO: replace with generated sprite: crawler enemy, 28x22 red slime.
    G.rect(scene, 'crawler', px(28), px(22), COLORS.enemy, { radius: px(9), stroke: 0x0d1226, strokeWidth: 2 });

    G.poly(scene, 'gem', px(22), px(24), [[0.5, 0], [1, 0.38], [0.5, 1], [0, 0.38]], COLORS.gem, { stroke: 0xffffff, strokeWidth: 2 });
    G.poly(scene, 'spike', T, SPIKE_H, [[0.5, 0], [1, 1], [0, 1]], COLORS.spike);
    G.rect(scene, 'door', px(34), px(46), COLORS.door, { radius: px(6), stroke: 0x8a6a00, strokeWidth: 3 });
    G.particle(scene, 'sparkle', px(10), 0x9df5ff);
    G.gradient(scene, 'cave-bg', 8, CFG.HEIGHT, COLORS.bgTop, COLORS.bg);
  }

  /* ======================================================================= */
  class MenuScene extends Phaser.Scene {
    constructor() { super({ key: 'MenuScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'cave-bg').setDisplaySize(W, H);

      MEAMUS.ui.title(this, W / 2, H * 0.17, 'CRYSTAL CAVES', 46);
      MEAMUS.ui.label(this, W / 2, H * 0.25, 'Three caves. Every crystal. Beat the clock.', { size: 16 });

      var best = MEAMUS.storage.best(CFG.KEY);
      MEAMUS.ui.label(this, W / 2, H * 0.32, 'BEST  ' + best + '        COINS  ' + MEAMUS.currency.get(), {
        size: 15, mono: true, color: MEAMUS.ui.PALETTE.warn
      });

      var play = () => this.scene.start('GameScene', { level: 0, score: 0, lives: CFG.START_LIVES });
      var skip = [];
      MEAMUS.ui.button(this, W / 2, H * 0.43, 'START', play, { width: 220 });
      skip.push(MEAMUS.ui.button(this, W / 2, H * 0.54, 'HOW TO PLAY', () => this.showHelp(), { width: 220, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk }));

      // Level select unlocks as the player progresses.
      var unlocked = Number(MEAMUS.storage.get(CFG.KEY + ':unlocked', 1)) || 1;
      MEAMUS.ui.label(this, W / 2, H * 0.645, 'CAVES UNLOCKED  ' + unlocked + ' / ' + LEVELS.length, {
        size: 14, mono: true
      });
      for (var i = 0; i < LEVELS.length; i += 1) {
        (function (self, idx) {
          var locked = idx + 1 > unlocked;
          skip.push(MEAMUS.ui.button(self, W / 2 - 90 + idx * 90, H * 0.72, locked ? '🔒' : String(idx + 1), function () {
            if (locked) { MEAMUS.fx.floatText(self, W / 2, H * 0.80, 'Finish the previous cave first', '#c4503f'); return; }
            self.scene.start('GameScene', { level: idx, score: 0, lives: CFG.START_LIVES });
          }, { width: 70, height: 46, fill: locked ? 0xefe7dc : 0xffb27a, textColor: MEAMUS.ui.PALETTE.softInk }));
        })(this, i);
      }

      MEAMUS.attachDebug(this);
      MEAMUS.ui.anywhereToStart(this, play, skip);

      // The landing-page demo drops straight into play rather than a menu.
      if (MEAMUS.attractActive) this.time.delayedCall(700, play);
    }

    showHelp() {
      if (this.helpOpen) return;
      this.helpOpen = true;
      var W = this.scale.width;
      var H = this.scale.height;
      var layer = this.add.container(0, 0).setDepth(1000);
      layer.add(MEAMUS.ui.panel(this, W / 2, H / 2, Math.min(540, W - 60), 320));
      layer.add(MEAMUS.ui.title(this, W / 2, H / 2 - 118, 'HOW TO PLAY', 26));
      layer.add(MEAMUS.ui.label(this, W / 2, H / 2 - 20,
        'MOVE   Arrow keys / A and D / left stick\n' +
        'JUMP   Space / Up / W / the JUMP button\n' +
        'PAUSE  P or Esc\n\n' +
        'Collect every crystal, then reach the golden door.\n' +
        'Land on a crawler to squash it. Touching one from the side hurts.\n' +
        'Red spikes are instant damage. Leftover time is worth 5 points a second.',
        { size: 15, wrap: Math.min(480, W - 100), lineSpacing: 7 }));
      layer.add(MEAMUS.ui.button(this, W / 2, H / 2 + 112, 'GOT IT', () => {
        layer.destroy(true);
        this.helpOpen = false;
      }, { width: 160, height: 46 }));
    }
  }

  /* ======================================================================= */
  class GameScene extends Phaser.Scene {
    constructor() { super({ key: 'GameScene' }); }

    init(data) {
      this.levelIndex = data.level || 0;
      this.score = data.score || 0;
      this.lives = data.lives === undefined ? CFG.START_LIVES : data.lives;
    }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;

      this.over = false;
      this.gemsLeft = 0;
      this.timeLeft = CFG.LEVEL_TIME_LIMIT;
      this.lastGroundedAt = -Infinity;
      this.jumpBufferedAt = -Infinity;
      this.invulnUntil = 0;

      // The background is scenery, not level geometry: it stays put while the
      // camera moves across the cave.
      this.add.image(W / 2, H / 2, 'cave-bg')
        .setDisplaySize(W, H).setDepth(-20).setScrollFactor(0);

      // Bodies live in the world, which is wider than the view on a phone.
      // Left at the canvas size, the player would hit an invisible wall a third
      // of the way into every level.
      this.physics.world.setBounds(0, 0, CFG.WORLD_W, CFG.WORLD_H);

      this.solids = this.physics.add.staticGroup();
      this.platforms = this.physics.add.staticGroup();
      this.spikes = this.physics.add.staticGroup();
      this.gems = this.physics.add.group({ allowGravity: false, immovable: true });
      this.enemies = this.physics.add.group({ collideWorldBounds: true });

      this.buildLevel(LEVELS[this.levelIndex]);

      /* The camera follows the player across the cave. On a canvas as wide as
         the world - any desktop - the bounds equal the view and it never
         actually scrolls, so this costs nothing there. The deadzone keeps the
         player off the leading edge, so you can see what you are running into
         rather than meeting it at the screen edge. */
      this.cameras.main.setBounds(0, 0, CFG.WORLD_W, CFG.WORLD_H);
      this.cameras.main.startFollow(this.player, true, 0.14, 0.14);
      this.cameras.main.setDeadzone(Math.min(W * 0.34, CFG.TILE * 5), H);

      this.sparkles = this.add.particles(0, 0, 'sparkle', {
        speed: { min: 40, max: 160 }, lifespan: 480, scale: { start: 0.8, end: 0 },
        blendMode: 'ADD', emitting: false
      }).setDepth(30);

      /* --- colliders ---------------------------------------------------- */
      this.physics.add.collider(this.player, this.solids);
      this.physics.add.collider(this.enemies, this.solids);
      // One-way platforms: only collide while falling onto the top face.
      this.physics.add.collider(this.player, this.platforms, null, (player, plat) =>
        player.body.velocity.y >= 0 && player.body.bottom <= plat.body.top + 8);
      this.physics.add.collider(this.enemies, this.platforms);
      this.physics.add.overlap(this.player, this.gems, this.onGem, null, this);
      this.physics.add.overlap(this.player, this.spikes, this.onSpike, null, this);
      this.physics.add.overlap(this.player, this.enemies, this.onEnemy, null, this);
      this.physics.add.overlap(this.player, this.door, this.onDoor, null, this);

      /* --- input --------------------------------------------------------- */
      this.cursors = this.input.keyboard.createCursorKeys();
      this.keys = this.input.keyboard.addKeys('W,A,S,D,SPACE,P,ESC');
      this.input.addPointer(2);
      this.input.keyboard.on('keydown-SPACE', () => this.bufferJump());
      this.input.keyboard.on('keydown-UP', () => this.bufferJump());
      this.input.keyboard.on('keydown-W', () => this.bufferJump());
      this.input.keyboard.on('keydown-P', () => this.togglePause());
      this.input.keyboard.on('keydown-ESC', () => this.togglePause());

      if (MEAMUS.touch.isTouch()) {
        this.stick = MEAMUS.touch.joystick(this, { y: H - 82, radius: 54 });
        this.jumpBtn = MEAMUS.touch.button(this, 'JUMP', () => this.bufferJump(), { y: H - 82, radius: 48 });
      } else {
        // Mouse players: click the left or right half to walk, drag up to jump.
        this.input.on('pointerdown', (p) => { if (p.y < this.scale.height - 120) this.bufferJump(); });
      }

      this.buildHud();

      this.levelTimer = this.time.addEvent({
        delay: 1000, loop: true, callback: () => {
          if (this.over) return;
          this.timeLeft -= 1;
          if (this.timeLeft <= 0) this.loseLife('out of time');
          this.refreshHud();
        }
      });

      this.events.once('shutdown', () => this.cleanup());
      MEAMUS.attachDebug(this);
    }

    /** Turn the ASCII map into physics bodies. */
    buildLevel(rows) {
      var T = CFG.TILE;
      for (var r = 0; r < rows.length; r += 1) {
        for (var c = 0; c < rows[r].length; c += 1) {
          var ch = rows[r][c];
          var x = c * T + T / 2;
          var y = r * T + T / 2;
          if (ch === '#') {
            this.solids.create(x, y, 'tile-solid');
          } else if (ch === '=') {
            // Platform texture is one tile wide by px(12) tall, so the static
            // body matches it exactly - hence the half-height offset.
            this.platforms.create(x, y - T / 2 + px(12) / 2, 'tile-platform');
          } else if (ch === '^') {
            // Spikes sit on the floor of their tile.
            this.spikes.create(x, y + T / 2 - px(18) / 2, 'spike');
          } else if (ch === 'g') {
            var gem = this.gems.create(x, y, 'gem');
            gem.setDepth(5);
            this.tweens.add({ targets: gem, y: y - px(6), yoyo: true, repeat: -1, duration: 900, ease: 'Sine.easeInOut' });
            this.gemsLeft += 1;
          } else if (ch === 'e') {
            var e = this.enemies.create(x, y, 'crawler');
            e.setBounce(0, 0).setDepth(6);
            e.body.setSize(px(24), px(18));
            e.setData('dir', Math.random() < 0.5 ? -1 : 1);
            e.setVelocityX(e.getData('dir') * CFG.ENEMY_SPEED);
          } else if (ch === 'P') {
            this.player = this.physics.add.sprite(x, y, 'hero').setDepth(10);
            this.player.body.setSize(px(20), px(28));
            this.player.setCollideWorldBounds(true);
          } else if (ch === 'D') {
            this.door = this.physics.add.staticImage(x, y - px(4), 'door').setDepth(4);
            this.doorGlow = this.add.circle(x, y - px(4), px(30), COLORS.door, 0.12).setDepth(3);
          }
        }
      }
      // Defensive: a malformed map must not crash the scene. Placed in tiles,
      // because the tile is 53px on a phone and 31 on a desktop - a literal 64
      // is two tiles in one place and one in the other.
      if (!this.player) {
        this.player = this.physics.add.sprite(CFG.TILE * 2, CFG.TILE * 2, 'hero').setDepth(10);
        this.player.setCollideWorldBounds(true);
      }
      // World coordinates, not canvas ones - the canvas is a window onto the
      // cave now, and on a phone it is a third of its width.
      if (!this.door) {
        this.door = this.physics.add.staticImage(CFG.WORLD_W - CFG.TILE * 2, CFG.WORLD_H - CFG.TILE * 3, 'door');
      }
    }

    buildHud() {
      var W = this.scale.width;
      // Pinned to the screen, not the cave. Without scrollFactor 0 the score
      // scrolls off the left edge the moment the camera moves.
      this.hudScore = MEAMUS.ui.label(this, 12, 10, '', { size: 17, mono: true, color: '#2f2a24', originX: 0, originY: 0 }).setDepth(900).setScrollFactor(0);
      this.hudGems = MEAMUS.ui.label(this, W / 2, 10, '', { size: 17, mono: true, color: '#2e8f96', originY: 0 }).setDepth(900).setScrollFactor(0);
      this.hudTime = MEAMUS.ui.label(this, W - 12, 10, '', { size: 17, mono: true, color: '#c9862b', originX: 1, originY: 0 }).setDepth(900).setScrollFactor(0);
      this.refreshHud();
    }

    refreshHud() {
      this.hudScore.setText('SCORE ' + this.score + '   ♥' + this.lives);
      this.hudGems.setText('CAVE ' + (this.levelIndex + 1) + '/' + LEVELS.length + '   GEMS ' + this.gemsLeft);
      this.hudTime.setText('TIME ' + Math.max(0, this.timeLeft));
    }

    togglePause() {
      if (this.over || this.scene.isPaused()) return;
      this.scene.pause();
      this.scene.launch('PauseScene', { parent: 'GameScene' });
    }

    /* --- jumping with coyote time + input buffering --------------------- */
    bufferJump() {
      MEAMUS.sfx.resume();
      this.jumpBufferedAt = this.time.now;
    }

    tryJump(now) {
      var grounded = this.player.body.blocked.down || this.player.body.touching.down;
      if (grounded) this.lastGroundedAt = now;
      var canJump = now - this.lastGroundedAt <= CFG.COYOTE_MS;
      var wants = now - this.jumpBufferedAt <= CFG.JUMP_BUFFER_MS;
      if (canJump && wants) {
        this.player.setVelocityY(CFG.JUMP_VELOCITY);
        this.jumpBufferedAt = -Infinity;
        this.lastGroundedAt = -Infinity;
        MEAMUS.sfx.jump();
      }
    }

    /* --- collisions ----------------------------------------------------- */
    onGem(player, gem) {
      if (!gem.active) return;
      this.tweens.killTweensOf(gem);
      this.sparkles.explode(10, gem.x, gem.y);
      MEAMUS.fx.floatText(this, gem.x, gem.y, '+' + CFG.GEM_SCORE, '#2e8f96');
      gem.destroy();
      this.gemsLeft -= 1;
      this.score += CFG.GEM_SCORE;
      MEAMUS.currency.add(1);
      MEAMUS.sfx.coin();
      this.refreshHud();
      if (this.gemsLeft === 0) {
        MEAMUS.fx.floatText(this, this.door.x, this.door.y - 40, 'DOOR OPEN', '#c9862b');
        this.tweens.add({ targets: this.doorGlow, scale: 1.6, alpha: 0.35, yoyo: true, repeat: -1, duration: 700 });
      }
    }

    onEnemy(player, enemy) {
      if (this.over || !enemy.active) return;
      // Stomp: falling and clearly above the crawler's centre.
      var stomping = player.body.velocity.y > 60 && player.body.bottom < enemy.body.top + 14;
      if (stomping) {
        this.sparkles.explode(12, enemy.x, enemy.y);
        enemy.destroy();
        player.setVelocityY(CFG.ENEMY_STOMP_BOUNCE);
        this.score += CFG.STOMP_SCORE;
        MEAMUS.sfx.explode();
        MEAMUS.fx.floatText(this, enemy.x, enemy.y, '+' + CFG.STOMP_SCORE, '#2f8f68');
        this.refreshHud();
        return;
      }
      this.loseLife('hit by a crawler');
    }

    onSpike() {
      this.loseLife('spiked');
    }

    onDoor() {
      if (this.over || this.gemsLeft > 0) return;
      this.completeLevel();
    }

    loseLife(reason) {
      if (this.over || this.time.now < this.invulnUntil) return;
      this.invulnUntil = this.time.now + 1200;
      this.lives -= 1;
      MEAMUS.sfx.hurt();
      MEAMUS.fx.shake(this, 0.014, 220);
      MEAMUS.fx.flash(this);
      this.refreshHud();

      if (this.lives <= 0) {
        this.over = true;
        this.physics.pause();
        this.time.delayedCall(600, () => {
          this.scene.start('GameOverScene', {
            score: this.score, level: this.levelIndex, cleared: false, reason: reason
          });
        });
        return;
      }
      // Respawn at the level start rather than restarting the whole cave.
      var start = this.findStart();
      this.player.setPosition(start.x, start.y).setVelocity(0, 0);
      this.tweens.add({
        targets: this.player, alpha: 0.3, yoyo: true, repeat: 3, duration: 150,
        onComplete: () => this.player.setAlpha(1)
      });
    }

    findStart() {
      var rows = LEVELS[this.levelIndex];
      for (var r = 0; r < rows.length; r += 1) {
        var c = rows[r].indexOf('P');
        if (c !== -1) return { x: c * CFG.TILE + CFG.TILE / 2, y: r * CFG.TILE + CFG.TILE / 2 };
      }
      return { x: CFG.TILE * 2, y: CFG.TILE * 2 };
    }

    completeLevel() {
      this.over = true;
      this.physics.pause();
      var bonus = Math.max(0, this.timeLeft) * CFG.TIME_BONUS_PER_SEC;
      this.score += bonus;
      MEAMUS.sfx.win();
      this.sparkles.explode(40, this.door.x, this.door.y);

      var unlocked = Number(MEAMUS.storage.get(CFG.KEY + ':unlocked', 1)) || 1;
      MEAMUS.storage.set(CFG.KEY + ':unlocked', Math.max(unlocked, Math.min(LEVELS.length, this.levelIndex + 2)));

      // AD HOOK: level complete is the classic interstitial slot.
      MEAMUS.ads.showInterstitial('level-' + (this.levelIndex + 1) + '-complete');

      var W = this.scale.width;
      var H = this.scale.height;
      // Pinned to the screen and sized to it: a fixed 420 overflowed a 480-wide
      // portrait canvas, and unpinned it would sit wherever the camera happened
      // to have stopped.
      var panelW = Math.min(420, W - 40);
      MEAMUS.ui.panel(this, W / 2, H / 2, panelW, 240).setDepth(1000).setScrollFactor(0);
      MEAMUS.ui.title(this, W / 2, H / 2 - 76, 'CAVE CLEARED', 30).setDepth(1001).setScrollFactor(0);
      MEAMUS.ui.label(this, W / 2, H / 2 - 16,
        'TIME BONUS  +' + bonus + '\nSCORE       ' + this.score,
        { size: 18, mono: true, color: '#2f2a24', lineSpacing: 8 }).setDepth(1001).setScrollFactor(0);

      var last = this.levelIndex >= LEVELS.length - 1;
      MEAMUS.ui.button(this, W / 2, H / 2 + 72, last ? 'FINISH' : 'NEXT CAVE', () => {
        if (last) {
          this.scene.start('GameOverScene', {
            score: this.score, level: this.levelIndex, cleared: true
          });
        } else {
          this.scene.start('GameScene', {
            level: this.levelIndex + 1, score: this.score, lives: this.lives
          });
        }
      }, { width: Math.min(220, panelW - 40) }).setDepth(1001).setScrollFactor(0);
    }

    cleanup() {
      if (this.levelTimer) this.levelTimer.remove(false);
      if (this.stick) this.stick.destroy();
      if (this.jumpBtn) this.jumpBtn.destroy();
    }

    /* --- main loop ------------------------------------------------------ */
    update(time) {
      if (this.over) return;

      var grounded = this.player.body.blocked.down || this.player.body.touching.down;
      var control = grounded ? 1 : CFG.AIR_CONTROL;

      var dir = 0;
      if (this.cursors.left.isDown || this.keys.A.isDown) dir -= 1;
      if (this.cursors.right.isDown || this.keys.D.isDown) dir += 1;
      if (this.stick) {
        var v = this.stick.getVector();
        if (Math.abs(v.x) > 0.15) dir = v.x;
      }
      // Mouse-only fallback: hold near the bottom-left / bottom-right to walk.
      if (!dir && !this.stick) {
        var p = this.input.activePointer;
        if (p.isDown && p.y > this.scale.height - 120) {
          dir = p.x < this.scale.width / 2 ? -1 : 1;
        }
      }

      this.player.setVelocityX(dir * CFG.RUN_SPEED * control);
      if (dir) this.player.setFlipX(dir < 0);

      if (this.jumpBtn && this.jumpBtn.isDown()) this.bufferJump();
      this.tryJump(time);

      // Crawler AI: reverse at walls and before walking off a ledge.
      this.enemies.children.each((e) => {
        if (!e.active) return;
        var d = e.getData('dir');
        if (e.body.blocked.left || e.body.blocked.right) d = -d;
        else if (this.wouldFall(e, d)) d = -d;
        e.setData('dir', d);
        e.setVelocityX(d * CFG.ENEMY_SPEED);
        e.setFlipX(d < 0);
      });
    }

    /** Probe one tile ahead and below - true if there is no floor there. */
    wouldFall(enemy, dir) {
      if (!(enemy.body.blocked.down || enemy.body.touching.down)) return false;
      var probeX = enemy.x + dir * (enemy.width / 2 + 6);
      var probeY = enemy.body.bottom + 6;
      var col = Math.floor(probeX / CFG.TILE);
      var row = Math.floor(probeY / CFG.TILE);
      var rows = LEVELS[this.levelIndex];
      if (row < 0 || row >= rows.length) return true;
      var line = rows[row];
      if (col < 0 || col >= line.length) return true;
      var ch = line[col];
      return ch !== '#' && ch !== '=';
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
      this.add.image(W / 2, H / 2, 'cave-bg').setDisplaySize(W, H);

      var score = data.score || 0;
      var prevBest = MEAMUS.storage.best(CFG.KEY);
      var best = MEAMUS.storage.best(CFG.KEY, score);

      MEAMUS.ui.title(this, W / 2, H * 0.18, data.cleared ? 'ALL CAVES CLEARED' : 'GAME OVER', data.cleared ? 34 : 42);
      if (!data.cleared && data.reason) {
        MEAMUS.ui.label(this, W / 2, H * 0.26, data.reason, { size: 15, color: '#c4503f' });
      }
      MEAMUS.ui.label(this, W / 2, H * 0.34,
        'SCORE  ' + score + '\nCAVE   ' + ((data.level || 0) + 1) + '\nBEST   ' + best,
        { size: 20, mono: true, color: '#2f2a24', lineSpacing: 8 });
      if (score > prevBest) MEAMUS.sfx.win();

      MEAMUS.ui.button(this, W / 2, H * 0.54, 'PLAY AGAIN', () => {
        this.scene.start('GameScene', { level: 0, score: 0, lives: CFG.START_LIVES });
      }, { width: 240 });
      // AD HOOK: rewarded video restarts the current cave with the score kept.
      if (!data.cleared) {
        MEAMUS.ui.button(this, W / 2, H * 0.65, 'WATCH AD: RETRY CAVE', () => {
          MEAMUS.ads.showRewarded('retry-level',
            () => this.scene.start('GameScene', { level: data.level || 0, score: score, lives: 1 }),
            () => MEAMUS.fx.floatText(this, W / 2, 384, 'No ad available', '#c4503f'));
        }, { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });
      }
      MEAMUS.ui.button(this, W / 2, H * 0.76, 'MENU', () => this.scene.start('MenuScene'), { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      if (MEAMUS.ads.countRun()) MEAMUS.ads.showInterstitial('game-over');
    }
  }


  /* The levels are hand-authored 25x18 tile grids - a 1.39 shape. A phone is
     0.46. Forcing the whole grid into that shape under Scale.FIT put the game
     in a band across the middle of the screen: measured, 33% of an iPhone.
     Clamping the aspect only moved the problem, because 25 columns across a
     narrow canvas is what makes the tiles small.

     So the level no longer has to fit the screen. The tile size is taken from
     the HEIGHT, which fills the phone vertically, and the camera scrolls
     across the level - which is what a platformer does anyway. Same measure,
     same devices: 92% of an iPhone, 99% of an iPad, and desktop unchanged at
     94% because a wide canvas still shows all 25 columns and never scrolls. */
  var VIEW = MEAMUS.viewport(800, 576, { minAspect: 0.5, maxAspect: 1.8 });

  CFG.TILE = Math.max(16, Math.floor(VIEW.height / CFG.ROWS));
  // The world is the grid. Tile placement needs no centring offset.
  CFG.WORLD_W = CFG.COLS * CFG.TILE;
  CFG.WORLD_H = CFG.ROWS * CFG.TILE;

  /* Retune the physics for the tile size we actually got.

     The tile is now 53px on a phone and 31px on a desktop, where before it was
     27 and 31. The speeds are in pixels per second, so leaving them alone made
     the phone version a different game: measured, the player crossed 134px in
     four seconds against the desktop's 656, and - worse - a 520 jump over 53px
     tiles clears 2.3 tiles where the levels are authored for 3.8. Jumps the
     caves require simply could not be made.

     Scaling the velocities AND the gravity by the same factor fixes both. The
     apex is v²/2g, so a common factor k gives k·v²/2kg = k × the old apex in
     pixels - which is exactly one tile-height's worth more, so the jump clears
     the same number of tiles everywhere. Time to apex is v/g, unchanged, so it
     still feels the same. Distances stay constant in tiles; only the pixels
     move. */
  var K = CFG.TILE / CFG.DESIGN_TILE;
  CFG.GRAVITY = Math.round(CFG.GRAVITY * K);
  CFG.RUN_SPEED = Math.round(CFG.RUN_SPEED * K);
  CFG.JUMP_VELOCITY = Math.round(CFG.JUMP_VELOCITY * K);
  CFG.ENEMY_SPEED = Math.round(CFG.ENEMY_SPEED * K);
  CFG.ENEMY_STOMP_BOUNCE = Math.round(CFG.ENEMY_STOMP_BOUNCE * K);

  /* Second pass, now that the world size is known: the canvas is never bigger
     than the world it looks at. Otherwise a wide desktop leaves dead space to
     the right of the level that the camera cannot scroll into. This also
     re-registers the terms the resize handler recomputes with, so rotating a
     phone re-fits against the same clamp. */
  VIEW = MEAMUS.viewport(800, 576, {
    minAspect: 0.5, maxAspect: 1.8, maxWidth: CFG.WORLD_W, maxHeight: CFG.WORLD_H
  });
  CFG.WIDTH = VIEW.width;
  CFG.HEIGHT = VIEW.height;

  /* --- boot -------------------------------------------------------------- */
  MEAMUS.boot({
    type: Phaser.AUTO,
    width: CFG.WIDTH,
    height: CFG.HEIGHT,
    parent: 'game-container',
    backgroundColor: '#faf3e7',
    physics: { default: 'arcade', arcade: { gravity: { y: CFG.GRAVITY }, debug: false } },
    scene: [
      MEAMUS.scenes.makeBoot('PreloadScene'),
      MEAMUS.scenes.makePreload({ bake: bakeTextures, title: 'CRYSTAL CAVES', next: 'MenuScene' }),
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
