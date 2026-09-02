/* =============================================================================
 * Gem Cascade - match-3 puzzle with cascades, move limit and score targets
 * Template game for meamus. Requires the meamus kit (MEAMUS global).
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = {
    WIDTH: 800,
    HEIGHT: 600,
    KEY: 'gem-cascade',

    COLS: 8,
    ROWS: 8,
    CELL: 56,
    BOARD_X: 176,
    BOARD_Y: 112,

    TYPES: 6,
    MIN_MATCH: 3,

    SWAP_MS: 190,
    FALL_MS_PER_CELL: 70,
    CLEAR_MS: 160,

    BASE_SCORE: 30,          // per gem cleared
    CASCADE_BONUS: 0.5,      // +50% of base per cascade step
    LONG_MATCH_BONUS: 60,    // per gem beyond the third in one run

    START_MOVES: 25,
    TARGET_BASE: 1500,       // level 1 target; grows per level
    TARGET_GROWTH: 1.45,

    HINT_AFTER_MS: 6000      // idle time before the board suggests a move
  };

  // Muted candy tones: distinct in hue, none of them harsh.
  var GEM_COLORS = [0xf2837f, 0x7fc9a3, 0x8fb3e8, 0xf3c96b, 0xc9a3e0, 0x6fc9d4];
  var GEM_KEYS = ['gem0', 'gem1', 'gem2', 'gem3', 'gem4', 'gem5'];

  function bakeTextures(scene) {
    var G = MEAMUS.gfx;
    var s = CFG.CELL - 10;

    // TODO: replace with generated sprites: six 46x46 gem shapes, one per
    // colour, each with a distinct silhouette so the board reads without colour.
    G.poly(scene, 'gem0', s, s, [[0.5, 0], [1, 0.35], [0.8, 1], [0.2, 1], [0, 0.35]], GEM_COLORS[0], { stroke: 0xffffff, strokeWidth: 2 });
    G.circle(scene, 'gem1', s, GEM_COLORS[1], { shine: true, stroke: 0xffffff, strokeWidth: 2 });
    G.rect(scene, 'gem2', s, s, GEM_COLORS[2], { radius: 8, stroke: 0xffffff, strokeWidth: 2 });
    G.poly(scene, 'gem3', s, s, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], GEM_COLORS[3], { stroke: 0xffffff, strokeWidth: 2 });
    G.star(scene, 'gem4', s, GEM_COLORS[4], 5);
    G.poly(scene, 'gem5', s, s, [[0.5, 0], [1, 0.28], [1, 0.72], [0.5, 1], [0, 0.72], [0, 0.28]], GEM_COLORS[5], { stroke: 0xffffff, strokeWidth: 2 });

    G.rect(scene, 'cell', CFG.CELL - 2, CFG.CELL - 2, 0xffffff, { radius: 8 });
    G.rect(scene, 'selector', CFG.CELL, CFG.CELL, 0xffffff, { radius: 10 });
    G.particle(scene, 'shard', 12, 0xffffff);
    G.gradient(scene, 'puzzle-bg', 8, CFG.HEIGHT, 0xeef4fa, 0xfdf7ef);
  }

  /* ======================================================================= */
  class MenuScene extends Phaser.Scene {
    constructor() { super({ key: 'MenuScene' }); }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;
      this.add.image(W / 2, H / 2, 'puzzle-bg').setDisplaySize(W, H);

      MEAMUS.ui.title(this, W / 2, H * 0.17, 'GEM CASCADE', 48);
      MEAMUS.ui.label(this, W / 2, H * 0.25, 'Swap. Match three. Ride the cascade.', { size: 16 });

      // Decorative gem row so the menu shows the actual art.
      for (var i = 0; i < GEM_KEYS.length; i += 1) {
        var g = this.add.image(W / 2 - 140 + i * 56, H * 0.35, GEM_KEYS[i]).setScale(0.85);
        this.tweens.add({ targets: g, y: H * 0.33, yoyo: true, repeat: -1, duration: 700 + i * 90, ease: 'Sine.easeInOut' });
      }

      var best = MEAMUS.storage.best(CFG.KEY);
      MEAMUS.ui.label(this, W / 2, H * 0.44, 'BEST  ' + best + '        COINS  ' + MEAMUS.currency.get(), {
        size: 15, mono: true, color: MEAMUS.ui.PALETTE.warn
      });

      var play = () => this.scene.start('GameScene', { level: 1, score: 0 });
      MEAMUS.ui.button(this, W / 2, H * 0.55, 'PLAY', play, { width: 220 });
      var help = MEAMUS.ui.button(this, W / 2, H * 0.66, 'HOW TO PLAY', () => this.showHelp(), { width: 220, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      MEAMUS.ui.bannerSlot(this, 'bottom');
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
      layer.add(MEAMUS.ui.panel(this, W / 2, H / 2, Math.min(540, W - 60), 330));
      layer.add(MEAMUS.ui.title(this, W / 2, H / 2 - 122, 'HOW TO PLAY', 26));
      layer.add(MEAMUS.ui.label(this, W / 2, H / 2 - 20,
        'SWAP    Tap or click a gem, then tap the one next to it.\n' +
        '        Dragging a gem toward its neighbour works too.\n' +
        'KEYS    Arrow keys move the cursor, Space picks up and drops.\n\n' +
        'Three or more in a row clears them. Gems above fall in, and any\n' +
        'new match chains as a cascade worth progressively more.\n' +
        'Hit the target score before the moves run out to advance.\n' +
        'A swap that makes no match is undone and costs nothing.',
        { size: 15, wrap: Math.min(480, W - 100), lineSpacing: 7 }));
      layer.add(MEAMUS.ui.button(this, W / 2, H / 2 + 118, 'GOT IT', () => {
        layer.destroy(true);
        this.helpOpen = false;
      }, { width: 160, height: 46 }));
    }
  }

  /* ======================================================================= */
  class GameScene extends Phaser.Scene {
    constructor() { super({ key: 'GameScene' }); }

    init(data) {
      this.level = data.level || 1;
      this.score = data.score || 0;
      this.target = Math.round(CFG.TARGET_BASE * Math.pow(CFG.TARGET_GROWTH, this.level - 1));
      this.moves = CFG.START_MOVES;
    }

    create() {
      var W = this.scale.width;
      var H = this.scale.height;

      this.busy = true;              // blocks input during animations
      this.selected = null;
      this.cascade = 0;
      this.lastInputAt = 0;
      this.hintTiles = null;
      this.cursor = { r: 0, c: 0 };

      this.add.image(W / 2, H / 2, 'puzzle-bg').setDisplaySize(W, H).setDepth(-10);
      this.drawBoardFrame();

      this.shards = this.add.particles(0, 0, 'shard', {
        speed: { min: 60, max: 220 }, lifespan: 480, scale: { start: 0.7, end: 0 },
        blendMode: 'ADD', emitting: false
      }).setDepth(60);

      this.grid = [];                // grid[r][c] = { type, sprite }
      this.buildBoard();

      this.selector = this.add.image(0, 0, 'selector')
        .setAlpha(0.22).setVisible(false).setDepth(40);
      this.cursorBox = this.add.rectangle(0, 0, CFG.CELL, CFG.CELL)
        .setStrokeStyle(2, 0xffffff, 0.45).setDepth(41).setVisible(false);

      this.setupInput();
      this.buildHud();

      // Settle any accidental starting matches before handing over control.
      this.time.delayedCall(200, () => this.resolveBoard(true));

      this.events.once('shutdown', () => this.cleanup());
      MEAMUS.attachDebug(this);
    }

    drawBoardFrame() {
      var w = CFG.COLS * CFG.CELL;
      var h = CFG.ROWS * CFG.CELL;
      var g = this.add.graphics().setDepth(-5);
      // A warm off-white tray. The old 35%-black panel turned the board into a
      // grey slab on an otherwise light game.
      g.fillStyle(0x000000, 0.05).fillRoundedRect(CFG.BOARD_X - 10, CFG.BOARD_Y - 6, w + 20, h + 20, 16);
      g.fillStyle(0xfffaf3, 0.96).fillRoundedRect(CFG.BOARD_X - 10, CFG.BOARD_Y - 10, w + 20, h + 20, 16);
      g.lineStyle(1.5, 0xe5d9c8, 1).strokeRoundedRect(CFG.BOARD_X - 10, CFG.BOARD_Y - 10, w + 20, h + 20, 16);
      // Checkerboard so empty cells stay readable while gems fall.
      for (var r = 0; r < CFG.ROWS; r += 1) {
        for (var c = 0; c < CFG.COLS; c += 1) {
          if ((r + c) % 2 === 0) continue;
          this.add.image(this.cellX(c), this.cellY(r), 'cell').setAlpha(0.04).setDepth(-4);
        }
      }
    }

    cellX(c) { return CFG.BOARD_X + c * CFG.CELL + CFG.CELL / 2; }
    cellY(r) { return CFG.BOARD_Y + r * CFG.CELL + CFG.CELL / 2; }

    /* --- board construction --------------------------------------------- */
    buildBoard() {
      for (var r = 0; r < CFG.ROWS; r += 1) {
        this.grid[r] = [];
        for (var c = 0; c < CFG.COLS; c += 1) {
          this.grid[r][c] = { type: this.safeType(r, c), sprite: null };
        }
      }
      // A fresh board must not start pre-matched or dead.
      var guard = 0;
      while (!this.hasValidMove() && guard < 40) {
        this.reseed();
        guard += 1;
      }
      for (r = 0; r < CFG.ROWS; r += 1) {
        for (c = 0; c < CFG.COLS; c += 1) this.spawnSprite(r, c);
      }
    }

    /** Pick a type that does not immediately complete a run of three. */
    safeType(r, c) {
      var banned = {};
      if (c >= 2 && this.grid[r][c - 1] && this.grid[r][c - 2] &&
        this.grid[r][c - 1].type === this.grid[r][c - 2].type) banned[this.grid[r][c - 1].type] = true;
      if (r >= 2 && this.grid[r - 1] && this.grid[r - 2] &&
        this.grid[r - 1][c].type === this.grid[r - 2][c].type) banned[this.grid[r - 1][c].type] = true;
      var options = [];
      for (var t = 0; t < CFG.TYPES; t += 1) if (!banned[t]) options.push(t);
      return Phaser.Utils.Array.GetRandom(options.length ? options : [0]);
    }

    reseed() {
      for (var r = 0; r < CFG.ROWS; r += 1) {
        for (var c = 0; c < CFG.COLS; c += 1) this.grid[r][c].type = this.safeType(r, c);
      }
    }

    spawnSprite(r, c, fromAbove) {
      var cell = this.grid[r][c];
      var startY = fromAbove ? this.cellY(r) - (CFG.ROWS + 1) * CFG.CELL : this.cellY(r);
      var sprite = this.add.image(this.cellX(c), startY, GEM_KEYS[cell.type]).setDepth(20);
      cell.sprite = sprite;
      if (fromAbove) {
        this.tweens.add({
          targets: sprite, y: this.cellY(r),
          duration: CFG.FALL_MS_PER_CELL * (r + 2), ease: 'Cubic.easeIn'
        });
      }
      return sprite;
    }

    /* --- input ----------------------------------------------------------- */
    setupInput() {
      this.input.on('pointerdown', (p) => {
        if (this.busy) return;
        var cell = this.cellAt(p.x, p.y);
        if (!cell) return;
        MEAMUS.sfx.resume();
        this.dragFrom = cell;
        this.dragOrigin = { x: p.x, y: p.y };
        this.select(cell);
      });

      // Drag past half a cell in one direction = swap with that neighbour.
      this.input.on('pointerup', (p) => {
        if (this.busy || !this.dragFrom) return;
        var dx = p.x - this.dragOrigin.x;
        var dy = p.y - this.dragOrigin.y;
        var from = this.dragFrom;
        this.dragFrom = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > CFG.CELL * 0.45) {
          var target = Math.abs(dx) > Math.abs(dy)
            ? { r: from.r, c: from.c + (dx > 0 ? 1 : -1) }
            : { r: from.r + (dy > 0 ? 1 : -1), c: from.c };
          if (this.inBounds(target.r, target.c)) {
            this.selected = null;
            this.selector.setVisible(false);
            this.trySwap(from, target);
          }
          return;
        }
        // A tap keeps the tap-then-tap flow alive.
        var cell = this.cellAt(p.x, p.y);
        if (cell && this.selected && (cell.r !== this.selected.r || cell.c !== this.selected.c)) {
          this.select(cell);
        }
      });

      /* Keyboard play: arrows move a cursor, Space picks up and drops. */
      this.cursorBoxVisible = false;
      this.input.keyboard.on('keydown', (event) => {
        var moved = true;
        if (event.key === 'ArrowLeft') this.cursor.c = Math.max(0, this.cursor.c - 1);
        else if (event.key === 'ArrowRight') this.cursor.c = Math.min(CFG.COLS - 1, this.cursor.c + 1);
        else if (event.key === 'ArrowUp') this.cursor.r = Math.max(0, this.cursor.r - 1);
        else if (event.key === 'ArrowDown') this.cursor.r = Math.min(CFG.ROWS - 1, this.cursor.r + 1);
        else moved = false;

        if (moved) {
          this.cursorBox.setVisible(true).setPosition(this.cellX(this.cursor.c), this.cellY(this.cursor.r));
          event.preventDefault();
          return;
        }
        if (event.code === 'Space' || event.key === 'Enter') {
          event.preventDefault();
          if (this.busy) return;
          this.select({ r: this.cursor.r, c: this.cursor.c });
        }
      });

      this.input.keyboard.on('keydown-P', () => this.togglePause());
      this.input.keyboard.on('keydown-ESC', () => this.togglePause());
    }

    cellAt(x, y) {
      var c = Math.floor((x - CFG.BOARD_X) / CFG.CELL);
      var r = Math.floor((y - CFG.BOARD_Y) / CFG.CELL);
      return this.inBounds(r, c) ? { r: r, c: c } : null;
    }

    inBounds(r, c) { return r >= 0 && r < CFG.ROWS && c >= 0 && c < CFG.COLS; }

    /** Tap-to-select, tap-again-to-swap. Non-adjacent taps just reselect. */
    select(cell) {
      this.lastInputAt = this.time.now;
      this.clearHint();

      if (!this.selected) {
        this.selected = cell;
        this.selector.setVisible(true).setPosition(this.cellX(cell.c), this.cellY(cell.r));
        MEAMUS.sfx.click();
        return;
      }
      if (this.selected.r === cell.r && this.selected.c === cell.c) {
        this.selected = null;
        this.selector.setVisible(false);
        return;
      }
      var adjacent = Math.abs(this.selected.r - cell.r) + Math.abs(this.selected.c - cell.c) === 1;
      if (!adjacent) {
        this.selected = cell;
        this.selector.setPosition(this.cellX(cell.c), this.cellY(cell.r));
        MEAMUS.sfx.click();
        return;
      }
      var from = this.selected;
      this.selected = null;
      this.selector.setVisible(false);
      this.trySwap(from, cell);
    }

    /* --- swapping -------------------------------------------------------- */
    swapCells(a, b) {
      var tmp = this.grid[a.r][a.c];
      this.grid[a.r][a.c] = this.grid[b.r][b.c];
      this.grid[b.r][b.c] = tmp;
    }

    trySwap(a, b) {
      this.busy = true;
      this.swapCells(a, b);

      var spriteA = this.grid[b.r][b.c].sprite;   // sprites moved with the cells
      var spriteB = this.grid[a.r][a.c].sprite;

      this.tweens.add({ targets: spriteA, x: this.cellX(b.c), y: this.cellY(b.r), duration: CFG.SWAP_MS, ease: 'Quad.easeInOut' });
      this.tweens.add({
        targets: spriteB, x: this.cellX(a.c), y: this.cellY(a.r), duration: CFG.SWAP_MS, ease: 'Quad.easeInOut',
        onComplete: () => {
          if (this.findMatches().length) {
            this.moves -= 1;
            this.refreshHud();
            this.cascade = 0;
            this.resolveBoard(false);
          } else {
            // Illegal swap: reverse it and do not charge a move.
            this.swapCells(a, b);
            var backA = this.grid[a.r][a.c].sprite;
            var backB = this.grid[b.r][b.c].sprite;
            this.tweens.add({ targets: backA, x: this.cellX(a.c), y: this.cellY(a.r), duration: CFG.SWAP_MS });
            this.tweens.add({
              targets: backB, x: this.cellX(b.c), y: this.cellY(b.r), duration: CFG.SWAP_MS,
              onComplete: () => { this.busy = false; }
            });
            MEAMUS.sfx.hurt();
            MEAMUS.fx.floatText(this, this.cellX(b.c), this.cellY(b.r) - 20, 'no match', '#c4503f');
          }
        }
      });
    }

    /* --- matching -------------------------------------------------------- */
    /** Returns an array of {r,c} for every gem in a run of MIN_MATCH or more. */
    findMatches() {
      var seen = {};
      var out = [];
      var r;
      var c;
      var run;

      var push = (cells) => {
        if (cells.length < CFG.MIN_MATCH) return;
        for (var i = 0; i < cells.length; i += 1) {
          var k = cells[i].r + ':' + cells[i].c;
          if (!seen[k]) { seen[k] = true; out.push(cells[i]); }
        }
      };

      for (r = 0; r < CFG.ROWS; r += 1) {
        run = [{ r: r, c: 0 }];
        for (c = 1; c < CFG.COLS; c += 1) {
          if (this.grid[r][c].type === this.grid[r][c - 1].type) run.push({ r: r, c: c });
          else { push(run); run = [{ r: r, c: c }]; }
        }
        push(run);
      }
      for (c = 0; c < CFG.COLS; c += 1) {
        run = [{ r: 0, c: c }];
        for (r = 1; r < CFG.ROWS; r += 1) {
          if (this.grid[r][c].type === this.grid[r - 1][c].type) run.push({ r: r, c: c });
          else { push(run); run = [{ r: r, c: c }]; }
        }
        push(run);
      }
      return out;
    }

    /**
     * Clear -> collapse -> refill -> repeat until the board is stable.
     * @param {boolean} silent true while settling the initial board (no score)
     */
    resolveBoard(silent) {
      var matches = this.findMatches();
      if (!matches.length) {
        this.afterSettle(silent);
        return;
      }

      this.cascade += 1;
      var gained = 0;
      if (!silent) {
        var multiplier = 1 + (this.cascade - 1) * CFG.CASCADE_BONUS;
        var extra = Math.max(0, matches.length - CFG.MIN_MATCH) * CFG.LONG_MATCH_BONUS;
        gained = Math.round((matches.length * CFG.BASE_SCORE + extra) * multiplier);
        this.score += gained;
        MEAMUS.sfx.match(this.cascade);
        if (this.cascade > 1) {
          MEAMUS.fx.floatText(this, CFG.WIDTH / 2, 84, 'CASCADE x' + this.cascade, '#2f8f68');
        }
      }

      for (var i = 0; i < matches.length; i += 1) {
        var m = matches[i];
        var cell = this.grid[m.r][m.c];
        var sprite = cell.sprite;
        if (sprite) {
          this.shards.explode(5, sprite.x, sprite.y);
          this.tweens.add({
            targets: sprite, scale: 0, alpha: 0, duration: CFG.CLEAR_MS,
            onComplete: () => sprite.destroy()
          });
        }
        cell.sprite = null;
        cell.type = -1;                       // -1 marks an empty cell
      }

      if (gained) {
        var mid = matches[Math.floor(matches.length / 2)];
        MEAMUS.fx.floatText(this, this.cellX(mid.c), this.cellY(mid.r), '+' + gained, '#c9862b');
      }
      this.refreshHud();

      this.time.delayedCall(CFG.CLEAR_MS + 20, () => this.collapse(silent));
    }

    /** Gravity: existing gems drop into holes, new ones fall in from above. */
    collapse(silent) {
      var longestFall = 0;

      for (var c = 0; c < CFG.COLS; c += 1) {
        var writeRow = CFG.ROWS - 1;
        for (var r = CFG.ROWS - 1; r >= 0; r -= 1) {
          if (this.grid[r][c].type === -1) continue;
          if (writeRow !== r) {
            this.grid[writeRow][c] = this.grid[r][c];
            this.grid[r][c] = { type: -1, sprite: null };
            var sprite = this.grid[writeRow][c].sprite;
            var drop = writeRow - r;
            longestFall = Math.max(longestFall, drop);
            this.tweens.add({
              targets: sprite, y: this.cellY(writeRow),
              duration: CFG.FALL_MS_PER_CELL * drop, ease: 'Cubic.easeIn'
            });
          }
          writeRow -= 1;
        }
        // Everything left above writeRow is empty and needs a new gem.
        for (var nr = writeRow; nr >= 0; nr -= 1) {
          this.grid[nr][c] = { type: Phaser.Math.Between(0, CFG.TYPES - 1), sprite: null };
          var s = this.add.image(this.cellX(c), this.cellY(nr) - (writeRow - nr + 2) * CFG.CELL,
            GEM_KEYS[this.grid[nr][c].type]).setDepth(20);
          this.grid[nr][c].sprite = s;
          longestFall = Math.max(longestFall, writeRow - nr + 2);
          this.tweens.add({
            targets: s, y: this.cellY(nr),
            duration: CFG.FALL_MS_PER_CELL * (writeRow - nr + 2), ease: 'Cubic.easeIn'
          });
        }
      }

      this.time.delayedCall(CFG.FALL_MS_PER_CELL * (longestFall + 1) + 40, () => this.resolveBoard(silent));
    }

    /* --- turn end -------------------------------------------------------- */
    afterSettle(silent) {
      // A dead board is reshuffled rather than ending the run unfairly.
      var guard = 0;
      while (!this.hasValidMove() && guard < 30) {
        this.shuffleBoard();
        guard += 1;
      }
      this.cascade = 0;
      this.lastInputAt = this.time.now;
      this.busy = false;
      this.refreshHud();

      if (silent) return;

      if (this.score >= this.target) this.completeLevel();
      else if (this.moves <= 0) this.endRun();
    }

    /**
     * Redeal the same gems into new positions. Retries until the result has
     * no free matches and at least one legal swap, then repaints the sprites.
     */
    shuffleBoard() {
      var types = [];
      var r;
      var c;
      for (r = 0; r < CFG.ROWS; r += 1) {
        for (c = 0; c < CFG.COLS; c += 1) types.push(this.grid[r][c].type);
      }

      var attempt = 0;
      do {
        Phaser.Utils.Array.Shuffle(types);
        var i = 0;
        for (r = 0; r < CFG.ROWS; r += 1) {
          for (c = 0; c < CFG.COLS; c += 1) {
            this.grid[r][c].type = types[i];
            i += 1;
          }
        }
        attempt += 1;
      } while (attempt < 50 && (this.findMatches().length > 0 || !this.hasValidMove()));

      for (r = 0; r < CFG.ROWS; r += 1) {
        for (c = 0; c < CFG.COLS; c += 1) {
          if (this.grid[r][c].sprite) this.grid[r][c].sprite.setTexture(GEM_KEYS[this.grid[r][c].type]);
        }
      }
      MEAMUS.fx.floatText(this, CFG.WIDTH / 2, 84, 'NO MOVES - RESHUFFLED', '#7d7469');
    }

    /** True if any single adjacent swap would produce a match. */
    hasValidMove() {
      for (var r = 0; r < CFG.ROWS; r += 1) {
        for (var c = 0; c < CFG.COLS; c += 1) {
          if (c + 1 < CFG.COLS && this.swapMakesMatch({ r: r, c: c }, { r: r, c: c + 1 })) return true;
          if (r + 1 < CFG.ROWS && this.swapMakesMatch({ r: r, c: c }, { r: r + 1, c: c })) return true;
        }
      }
      return false;
    }

    swapMakesMatch(a, b) {
      var ta = this.grid[a.r][a.c].type;
      var tb = this.grid[b.r][b.c].type;
      if (ta === tb) return false;
      this.grid[a.r][a.c].type = tb;
      this.grid[b.r][b.c].type = ta;
      var found = this.findMatches().length > 0;
      this.grid[a.r][a.c].type = ta;
      this.grid[b.r][b.c].type = tb;
      return found;
    }

    /** Find one legal swap to pulse as a hint. */
    findHint() {
      for (var r = 0; r < CFG.ROWS; r += 1) {
        for (var c = 0; c < CFG.COLS; c += 1) {
          if (c + 1 < CFG.COLS && this.swapMakesMatch({ r: r, c: c }, { r: r, c: c + 1 })) {
            return [{ r: r, c: c }, { r: r, c: c + 1 }];
          }
          if (r + 1 < CFG.ROWS && this.swapMakesMatch({ r: r, c: c }, { r: r + 1, c: c })) {
            return [{ r: r, c: c }, { r: r + 1, c: c }];
          }
        }
      }
      return null;
    }

    showHint() {
      var pair = this.findHint();
      if (!pair) return;
      this.hintTiles = pair.map((p) => this.grid[p.r][p.c].sprite).filter(Boolean);
      this.tweens.add({
        targets: this.hintTiles, scale: 1.14, yoyo: true, repeat: -1, duration: 480, ease: 'Sine.easeInOut'
      });
    }

    clearHint() {
      if (!this.hintTiles) return;
      this.tweens.killTweensOf(this.hintTiles);
      this.hintTiles.forEach((s) => s && s.setScale(1));
      this.hintTiles = null;
    }

    /* --- HUD + flow ------------------------------------------------------ */
    buildHud() {
      var W = this.scale.width;
      // The HUD rides at a fraction of the canvas so it stays clear of a
      // phone's status bar on a tall portrait canvas.
      var hy = CFG.HUD_Y;
      this.hudScore = MEAMUS.ui.label(this, 22, hy, '', { size: 19, mono: true, color: '#2f2a24', originX: 0, originY: 0 }).setDepth(900);
      this.hudMoves = MEAMUS.ui.label(this, W - 22, hy, '', { size: 19, mono: true, color: '#c9862b', originX: 1, originY: 0 }).setDepth(900);
      this.hudLevel = MEAMUS.ui.label(this, W / 2, hy + 26, '', { size: 16, mono: true, color: '#7d7469', originY: 0 }).setDepth(900);
      this.progressBg = this.add.graphics().setDepth(900);
      this.progressBar = this.add.graphics().setDepth(901);
      this.refreshHud();
    }

    refreshHud() {
      var W = this.scale.width;
      this.hudScore.setText('SCORE ' + this.score);
      this.hudMoves.setText('MOVES ' + Math.max(0, this.moves));
      this.hudLevel.setText('LEVEL ' + this.level + '   TARGET ' + this.target);

      // Proportional, and dark enough to be visible on a light ground. A
      // 10%-white track was invisible once the game stopped being dark.
      var barX = Math.round(W * 0.12);
      var barW = W - barX * 2;
      var barY = Math.round(CFG.HUD_Y + 52);
      var pct = Phaser.Math.Clamp(this.score / this.target, 0, 1);
      this.progressBg.clear().fillStyle(0x2f2a24, 0.10)
        .fillRoundedRect(barX, barY, barW, 10, 5);
      this.progressBar.clear().fillStyle(pct >= 1 ? 0x3fa77e : 0xff8a5c, 1)
        .fillRoundedRect(barX, barY, Math.max(10, barW * pct), 10, 5);
    }

    togglePause() {
      if (this.busy || this.scene.isPaused()) return;
      this.scene.pause();
      this.scene.launch('PauseScene', { parent: 'GameScene' });
    }

    completeLevel() {
      this.busy = true;
      MEAMUS.sfx.win();
      MEAMUS.currency.add(10);
      // AD HOOK: level complete is the standard interstitial slot.
      MEAMUS.ads.showInterstitial('level-' + this.level + '-complete');

      var W = this.scale.width;
      var H = this.scale.height;
      MEAMUS.ui.panel(this, W / 2, H / 2, 420, 250).setDepth(1000);
      MEAMUS.ui.title(this, W / 2, H / 2 - 82, 'LEVEL ' + this.level + ' CLEAR', 28).setDepth(1001);
      MEAMUS.ui.label(this, W / 2, H / 2 - 20,
        'SCORE       ' + this.score + '\nMOVES LEFT  ' + this.moves + '\nNEXT TARGET ' + Math.round(this.target * CFG.TARGET_GROWTH),
        { size: 17, mono: true, color: '#2f2a24', lineSpacing: 8 }).setDepth(1001);
      MEAMUS.ui.button(this, W / 2, H / 2 + 78, 'NEXT LEVEL', () => {
        this.scene.start('GameScene', { level: this.level + 1, score: this.score });
      }, { width: 220 }).setDepth(1001);
    }

    endRun() {
      this.busy = true;
      this.time.delayedCall(400, () => {
        this.scene.start('GameOverScene', { score: this.score, level: this.level, target: this.target });
      });
    }

    cleanup() {
      this.clearHint();
    }

    update(time) {
      if (this.busy) return;
      // Idle nudge: pulse a legal swap so the player is never stuck staring.
      if (!this.hintTiles && time - this.lastInputAt > CFG.HINT_AFTER_MS) this.showHint();
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
      this.add.image(W / 2, H / 2, 'puzzle-bg').setDisplaySize(W, H);

      var score = data.score || 0;
      var prevBest = MEAMUS.storage.best(CFG.KEY);
      var best = MEAMUS.storage.best(CFG.KEY, score);

      MEAMUS.ui.title(this, W / 2, H * 0.20, 'OUT OF MOVES', 40);
      MEAMUS.ui.label(this, W / 2, H * 0.33,
        'SCORE   ' + score + '\nLEVEL   ' + (data.level || 1) + '\nTARGET  ' + (data.target || 0) + '\nBEST    ' + best,
        { size: 19, mono: true, color: '#2f2a24', lineSpacing: 8 });
      if (score > prevBest) MEAMUS.sfx.win();

      MEAMUS.ui.button(this, W / 2, H * 0.54, 'PLAY AGAIN', () => {
        this.scene.start('GameScene', { level: 1, score: 0 });
      }, { width: 240 });
      // AD HOOK: rewarded video grants five extra moves on the same level.
      MEAMUS.ui.button(this, W / 2, H * 0.65, 'WATCH AD: +5 MOVES', () => {
        MEAMUS.ads.showRewarded('extra-moves',
          () => this.scene.start('GameScene', { level: data.level || 1, score: score }),
          () => MEAMUS.fx.floatText(this, W / 2, 384, 'No ad available', '#c4503f'));
      }, { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });
      MEAMUS.ui.button(this, W / 2, H * 0.76, 'MENU', () => this.scene.start('MenuScene'), { width: 240, fill: MEAMUS.ui.PALETTE.soft, textColor: MEAMUS.ui.PALETTE.softInk });

      if (MEAMUS.ads.countRun()) MEAMUS.ads.showInterstitial('game-over');
    }
  }


  /* Size the canvas to the screen it is on, keeping the tuned pixel budget.
     A fixed 4:3 canvas left a phone showing the game in a band with two
     thirds of the display empty. */
  var VIEW = MEAMUS.viewport(800, 600);
  CFG.WIDTH = VIEW.width;
  CFG.HEIGHT = VIEW.height;
  // The board is centred and scaled to fit whatever shape the canvas took,
  // leaving room for the HUD above it.
  CFG.CELL = Math.floor(Math.min(
    (CFG.WIDTH - 48) / CFG.COLS,
    (CFG.HEIGHT - 210) / CFG.ROWS
  ));
  CFG.BOARD_X = Math.round((CFG.WIDTH - CFG.COLS * CFG.CELL) / 2);
  // Centred in the space under the HUD, so a tall canvas does not leave the
  // board stranded at the top with dead space beneath it.
  CFG.HUD_Y = Math.round(CFG.HEIGHT * 0.06);
  CFG.BOARD_Y = Math.round(CFG.HUD_Y + 40 + (CFG.HEIGHT - CFG.HUD_Y - 40 - CFG.ROWS * CFG.CELL - 60) / 2);

  /* --- boot -------------------------------------------------------------- */
  MEAMUS.boot({
    type: Phaser.AUTO,
    width: CFG.WIDTH,
    height: CFG.HEIGHT,
    parent: 'game-container',
    backgroundColor: '#fdf7ef',
    // Match-3 is grid logic, not simulation: arcade physics stays idle here.
    physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
    scene: [
      MEAMUS.scenes.makeBoot('PreloadScene'),
      MEAMUS.scenes.makePreload({ bake: bakeTextures, title: 'GEM CASCADE', next: 'MenuScene' }),
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
