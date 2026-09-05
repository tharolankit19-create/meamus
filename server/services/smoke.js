'use strict';

/**
 * Boot a generated game before shipping it.
 *
 * Parsing was never enough. Code that parses fine still throws the moment a
 * scene runs - a helper that does not exist, a texture key nothing created, an
 * undefined variable in create(). The player got a black screen and an error
 * overlay, and was charged for it.
 *
 * So the game is actually run here, in a sandbox, before it is allowed out:
 * the REAL meamus kit is loaded (so calling a helper that does not exist
 * throws exactly as it would in a browser), against a stub Phaser that is
 * permissive about its own surface. That split is deliberate - the aim is to
 * catch the game's mistakes, not to fail it for a gap in the stub.
 *
 * Every scene is constructed and its init/preload/create run, then a few
 * update ticks, because that is where the failures actually live.
 *
 * Nothing here touches the network or the filesystem, and the sandbox has no
 * require, no process and no timers that outlive the run.
 */

const vm = require('node:vm');
const templates = require('./templates');

/** How long the whole boot may take before it is called a hang. */
const TIMEOUT_MS = 4000;

/** How many update() ticks to run once a scene has been created. */
const UPDATE_TICKS = 6;

class SmokeError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SmokeError';
    this.detail = detail || null;
  }
}

/* --------------------------------------------------------------------------
 * A stub that says yes to anything, chainably.
 *
 * Phaser's object surface is enormous and a generated game touches an
 * unpredictable slice of it. Rather than guess, unknown members resolve to
 * chainable no-ops and unknown reads to a number-ish, string-ish value, so the
 * stub never invents a failure the browser would not have.
 * ---------------------------------------------------------------------- */
/**
 * The real Phaser 3 keyboard plugin surface.
 *
 * `loose` invents any member it is asked for, which is right almost everywhere:
 * the aim is to catch the game's mistakes, not to fail it for a gap in the
 * stub. It is wrong here, and a shipped production game showed why. It called
 *
 *     this.input.keyboard.createArrowKeys()
 *
 * which does not exist - the method is createCursorKeys - and the stub happily
 * invented it. The game booted, passed, shipped, and in a real browser create()
 * threw on the first line of input setup, so the scene never started and the
 * player got the black screen this whole test exists to prevent.
 *
 * The keyboard plugin is small enough to write down, so it is written down. A
 * name not on this list is one Phaser does not have, and the sooner that is
 * said the better - the model is told, and rewrites, instead of the player
 * finding out.
 *
 * The rest of the stub stays permissive. This is the surface models actually
 * invent on, and a closed list is only safe where the real one is known.
 */
const KEYBOARD_API = new Set([
  'addKey', 'addKeys', 'createCursorKeys', 'removeKey', 'removeAllKeys',
  'addCapture', 'removeCapture', 'clearCaptures', 'checkDown',
  'enableGlobalCapture', 'disableGlobalCapture', 'resetKeys',
  'on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners',
  'enabled', 'keys', 'manager', 'destroy', 'shutdown'
]);

/** The real method a made-up one was probably reaching for. */
function keyboardHint(name) {
  if (/cursor|arrow|direction|wasd|movement/i.test(name)) return 'createCursorKeys()';
  if (/keys/i.test(name)) return "addKeys('W,A,S,D')";
  if (/key/i.test(name)) return "addKey('SPACE')";
  return 'createCursorKeys() or addKey(...)';
}

/**
 * A stub that refuses to invent members it knows Phaser does not have.
 */
function strict(name, seed, allowed, hint) {
  const target = Object.assign(Object.create(null), seed);
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop in obj) return obj[prop];
      if (allowed.has(prop)) {
        const fn = () => undefined;
        obj[prop] = fn;
        return fn;
      }
      throw new TypeError(
        `this.input.${name}.${String(prop)} is not a function - Phaser has no such method. `
        + `Use ${hint(String(prop))} instead.`
      );
    },
    set(obj, prop, value) { obj[prop] = value; return true; }
  });
}

/**
 * A Web Audio context good enough to synthesise a sound cue against.
 *
 * Games draw their own sprites and synthesise their own audio - there is
 * nothing to download - so this surface is used by nearly every generated game
 * and is worth stubbing properly rather than inventing.
 */
function audioContext() {
  const node = () => loose('AudioNode', {
    connect: () => node(), disconnect: () => {}, start: () => {}, stop: () => {},
    gain: param(), frequency: param(), detune: param(), Q: param(), type: 'sine'
  });
  const param = () => ({
    value: 0,
    setValueAtTime: () => {}, linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {}, setTargetAtTime: () => {},
    cancelScheduledValues: () => {}
  });

  return loose('AudioContext', {
    state: 'running', currentTime: 0, sampleRate: 44100,
    resume: () => Promise.resolve(), suspend: () => Promise.resolve(), close: () => Promise.resolve(),
    destination: node(),
    listener: loose('AudioListener'),
    createBuffer: (channels = 1, length = 1024, rate = 44100) => loose('AudioBuffer', {
      numberOfChannels: channels, length, sampleRate: rate,
      duration: length / rate,
      getChannelData: () => new Float32Array(Math.max(1, length)),
      copyToChannel: () => {}, copyFromChannel: () => {}
    }),
    createBufferSource: () => node(),
    createOscillator: () => node(),
    createGain: () => node(),
    createBiquadFilter: () => node(),
    createDynamicsCompressor: () => node(),
    createStereoPanner: () => node(),
    createAnalyser: () => node(),
    createDelay: () => node(),
    createWaveShaper: () => node(),
    createChannelMerger: () => node(),
    createChannelSplitter: () => node(),
    createConvolver: () => node(),
    createPeriodicWave: () => loose('PeriodicWave'),
    decodeAudioData: () => Promise.resolve(loose('AudioBuffer', {
      getChannelData: () => new Float32Array(16)
    }))
  });
}

function loose(name, seed = {}) {
  const target = Object.assign(Object.create(null), seed);

  const handler = {
    get(obj, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'then') return undefined;             // never look thenable
      if (prop === 'toString') return () => `[${name}]`;
      if (prop === 'valueOf') return () => 0;
      if (prop in obj) return obj[prop];

      /* Unknown member: callable AND readable.
         
         It used to be a bare function, which made `x.unknown()` work and
         `x.unknown.anything()` fail - so the stub was permissive one level deep
         and strict two levels deep, which is not a rule anybody could rely on.
         Production paid for it: a game asked Phaser for the Web Audio context
         the documented way, `this.sound.context`, got a bare function back, and
         `ctx.createBuffer is not a function` rejected two complete games -
         477 lines and 536 lines - for a gap in this file rather than a mistake
         in theirs. That is precisely the failure this stub is supposed not to
         have.
         
         So an invented member is a proxy around a function: call it and it
         returns another one, read a property off it and you get another one. */
      const fn = (...args) => { void args; return loose(`${name}.${String(prop)}`); };
      fn.__loose = true;
      const member = new Proxy(fn, handler);
      obj[prop] = member;
      return member;
    },
    set(obj, prop, value) { obj[prop] = value; return true; }
    // Deliberately no `has` trap. Claiming every key exists breaks
    // `typeof x === 'undefined'` guards, which games use constantly.
  };

  const proxy = new Proxy(target, handler);
  return proxy;
}

/** A game object: chainable, and carrying the fields games read back. */
function gameObject(extra = {}) {
  return loose('GameObject', {
    x: 0, y: 0, width: 32, height: 32, displayWidth: 32, displayHeight: 32,
    scaleX: 1, scaleY: 1, angle: 0, rotation: 0, alpha: 1, depth: 0,
    visible: true, active: true, text: '', type: 'Sprite',
    body: loose('Body', {
      velocity: { x: 0, y: 0 }, x: 0, y: 0, width: 32, height: 32,
      blocked: { down: false, up: false, left: false, right: false },
      touching: { down: false, up: false, left: false, right: false },
      onFloor: () => false
    }),
    list: [],
    getBounds: () => ({ x: 0, y: 0, width: 32, height: 32, centerX: 0, centerY: 0 }),
    getWorldTransformMatrix: () => ({ tx: 0, ty: 0 }),
    ...extra
  });
}

/** A physics/display group: iterable, with the callbacks games pass around. */
function group() {
  const members = [];
  return loose('Group', {
    children: {
      entries: members,
      each: (fn) => { members.slice().forEach(fn); },
      iterate: (fn) => { members.slice().forEach(fn); },
      size: 0
    },
    getChildren: () => members,
    getFirstDead: () => null,
    getFirstAlive: () => null,
    countActive: () => 0,
    get: () => gameObject(),
    create: () => { const o = gameObject(); members.push(o); return o; },
    add: (o) => { if (o) members.push(o); return o; },
    clear: () => { members.length = 0; }
  });
}

/** The scene-level factories a game reaches for through `this`. */
function sceneServices(scene, world) {
  const make = (fn) => (...args) => { void args; return fn(); };

  scene.add = loose('add', {
    existing: (o) => o,
    group: () => group(),
    container: () => gameObject({ type: 'Container', add: () => gameObject(), list: [] }),
    graphics: () => gameObject({ type: 'Graphics' }),
    text: (x, y, t) => gameObject({ type: 'Text', text: String(t == null ? '' : t) }),
    bitmapText: make(() => gameObject({ type: 'BitmapText' })),
    image: make(() => gameObject({ type: 'Image' })),
    sprite: make(() => gameObject()),
    tileSprite: make(() => gameObject({ type: 'TileSprite' })),
    rectangle: make(() => gameObject({ type: 'Rectangle' })),
    circle: make(() => gameObject({ type: 'Arc' })),
    zone: make(() => gameObject({ type: 'Zone' })),
    particles: make(() => gameObject({ type: 'ParticleEmitterManager' })),
    line: make(() => gameObject({ type: 'Line' })),
    star: make(() => gameObject({ type: 'Star' })),
    polygon: make(() => gameObject({ type: 'Polygon' })),
    triangle: make(() => gameObject({ type: 'Triangle' })),
    ellipse: make(() => gameObject({ type: 'Ellipse' })),
    grid: make(() => gameObject({ type: 'Grid' }))
  });

  scene.make = loose('make', {
    graphics: () => gameObject({
      type: 'Graphics',
      generateTexture: (key) => { world.textures.add(String(key)); return gameObject(); }
    }),
    text: () => gameObject({ type: 'Text' }),
    image: () => gameObject({ type: 'Image' }),
    sprite: () => gameObject()
  });

  scene.physics = loose('physics', {
    add: loose('physicsAdd', {
      existing: (o) => o,
      group: () => group(),
      staticGroup: () => group(),
      sprite: () => gameObject(),
      image: () => gameObject(),
      staticImage: () => gameObject(),
      collider: () => loose('Collider'),
      overlap: () => loose('Collider')
    }),
    world: loose('world', {
      setBounds: () => {},
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      pause: () => {}, resume: () => {}
    }),
    pause: () => {}, resume: () => {}
  });

  scene.time = loose('time', {
    addEvent: (cfg) => {
      // Timers are recorded, not run: a looping callback would spin forever.
      if (cfg && typeof cfg.callback === 'function') world.timers.push(cfg);
      return loose('TimerEvent', { remove: () => {}, destroy: () => {}, paused: false });
    },
    delayedCall: (delay, cb) => {
      if (typeof cb === 'function') world.timers.push({ callback: cb, delay });
      return loose('TimerEvent');
    },
    now: 0
  });

  scene.tweens = loose('tweens', {
    add: (cfg) => {
      // Run the completion handler so code hanging off it is exercised too.
      if (cfg && typeof cfg.onComplete === 'function') world.callbacks.push(cfg.onComplete);
      return loose('Tween', { stop: () => {}, remove: () => {}, isPlaying: () => false });
    },
    killAll: () => {}, timeline: () => loose('Timeline')
  });

  scene.input = loose('input', {
    on: () => scene.input,
    once: () => scene.input,
    off: () => scene.input,
    setDefaultCursor: () => {},
    activePointer: { x: 0, y: 0, isDown: false, worldX: 0, worldY: 0 },
    keyboard: strict('keyboard', {
      on: () => {}, once: () => {}, off: () => {},
      addKey: () => loose('Key', { isDown: false, isUp: true, on: () => {} }),
      addKeys: () => loose('Keys'),
      createCursorKeys: () => ({
        up: { isDown: false }, down: { isDown: false },
        left: { isDown: false }, right: { isDown: false },
        space: { isDown: false }, shift: { isDown: false }
      })
    }, KEYBOARD_API, keyboardHint)
  });

  scene.cameras = loose('cameras', {
    main: loose('Camera', {
      width: 800, height: 600, scrollX: 0, scrollY: 0, zoom: 1,
      setBackgroundColor: () => {}, shake: () => {}, flash: () => {}, fade: () => {},
      startFollow: () => {}, stopFollow: () => {}, setBounds: () => {},
      setZoom: () => {}, centerOn: () => {}
    })
  });

  scene.scale = loose('scale', {
    width: 800, height: 600, gameSize: { width: 800, height: 600 },
    displaySize: { width: 800, height: 600, setAspectRatio: () => {} },
    parentSize: { width: 800, height: 600 },
    on: () => {}, refresh: () => {}, resize: () => {}, lockOrientation: () => false
  });

  scene.textures = loose('textures', {
    exists: (key) => world.textures.has(String(key)),
    remove: () => {}, get: () => loose('Texture'), addCanvas: () => loose('Texture')
  });

  /* Phaser exposes the Web Audio context as `sound.context`, and games that
     synthesise their own sound reach for it by name. Seeded rather than
     invented so it behaves like the real thing - createBuffer returns
     something whose getChannelData is a Float32Array a game can write into. */
  scene.sound = loose('sound', {
    add: () => loose('Sound', { play: () => {}, stop: () => {}, setVolume: () => {} }),
    play: () => {}, stopAll: () => {},
    get context() { return world.audio; },
    get audioContext() { return world.audio; }
  });
  scene.anims = loose('anims', { create: () => loose('Anim'), generateFrameNumbers: () => [], exists: () => false });
  scene.load = loose('load', { image: () => {}, audio: () => {}, on: () => {}, spritesheet: () => {} });
  scene.children = loose('children', { list: [], each: () => {}, getAll: () => [] });
  scene.events = loose('events', { on: () => {}, once: () => {}, off: () => {}, emit: () => {} });
  scene.registry = loose('registry', { set: () => {}, get: () => null });
  scene.data = loose('data', { set: () => {}, get: () => null });
  scene.game = world.game;

  scene.scene = loose('sceneManager', {
    key: scene.__key,
    start: (key) => { world.started.push(String(key)); },
    launch: (key) => { world.started.push(String(key)); },
    stop: () => {}, pause: () => {}, resume: () => {}, restart: () => {},
    isActive: () => true, isPaused: () => false,
    get: () => null, bringToTop: () => {}
  });

  return scene;
}

/** The smallest Phaser that a generated game can actually boot against. */
function makePhaser(world) {
  class Scene {
    constructor(config) {
      this.__key = typeof config === 'string' ? config : (config && config.key) || 'Scene';
      this.sys = loose('sys', { game: world.game, settings: { key: this.__key } });
      sceneServices(this, world);
    }
  }

  const Phaser = {
    Scene,
    AUTO: 0, CANVAS: 1, WEBGL: 2, HEADLESS: 3,
    Game: function Game(config) {
      world.config = config;
      this.config = config;
      this.scene = loose('gameScene', { getScenes: () => [], getScene: () => null });
      this.scale = loose('gameScale', {
        width: 800, height: 600, resize: () => {}, refresh: () => {},
        displaySize: { setAspectRatio: () => {} }
      });
      this.events = loose('gameEvents', { on: () => {}, once: () => {} });
      this.loop = loose('loop', { sleep: () => {}, wake: () => {}, actualFps: 60 });
      this.canvas = loose('canvas', { width: 800, height: 600, style: {} });
      this.isBooted = true;
      world.game = this;
      return this;
    },
    Math: {
      Between: (min, max) => Math.floor((Number(min) + Number(max)) / 2),
      FloatBetween: (min, max) => (Number(min) + Number(max)) / 2,
      Clamp: (v, min, max) => Math.min(Math.max(Number(v), Number(min)), Number(max)),
      Linear: (a, b, t) => a + (b - a) * t,
      Distance: { Between: () => 10, BetweenPoints: () => 10 },
      Angle: { Between: () => 0, BetweenPoints: () => 0, Wrap: (v) => v },
      DegToRad: (d) => (Number(d) * Math.PI) / 180,
      RadToDeg: (r) => (Number(r) * 180) / Math.PI,
      Wrap: (v, min, max) => { void min; void max; return v; },
      RND: { between: (a, b) => Math.floor((a + b) / 2), pick: (arr) => (arr && arr[0]) || null,
        frac: () => 0.5, integerInRange: (a, b) => Math.floor((a + b) / 2) },
      Vector2: function Vector2(x = 0, y = 0) {
        this.x = x; this.y = y;
        this.set = (nx, ny) => { this.x = nx; this.y = ny; return this; };
        this.setTo = this.set;
        this.normalize = () => this;
        this.scale = () => this;
        this.length = () => 0;
        this.add = () => this;
        this.subtract = () => this;
        this.clone = () => new Vector2(this.x, this.y);
        return this;
      },
      Easing: loose('Easing')
    },
    Scale: { FIT: 'FIT', ENVELOP: 'ENVELOP', RESIZE: 'RESIZE', NONE: 'NONE',
      CENTER_BOTH: 'CENTER_BOTH', CENTER_HORIZONTALLY: 'CH', CENTER_VERTICALLY: 'CV' },
    Geom: {
      Rectangle: Object.assign(
        function Rectangle(x = 0, y = 0, w = 0, h = 0) {
          Object.assign(this, { x, y, width: w, height: h });
          return this;
        },
        { Contains: () => true, Overlaps: () => false }
      ),
      Circle: Object.assign(
        function Circle(x = 0, y = 0, r = 0) { Object.assign(this, { x, y, radius: r }); return this; },
        { Contains: () => true }
      ),
      Point: function Point(x = 0, y = 0) { this.x = x; this.y = y; return this; },
      Line: function Line() { return this; },
      Intersects: loose('Intersects')
    },
    Utils: {
      Array: {
        GetRandom: (arr) => (arr && arr.length ? arr[0] : null),
        Shuffle: (arr) => arr,
        RemoveRandomElement: (arr) => (arr && arr.length ? arr.pop() : null),
        Remove: (arr, item) => { const i = (arr || []).indexOf(item); if (i > -1) arr.splice(i, 1); return item; }
      },
      String: loose('UtilsString'),
      Objects: loose('UtilsObjects')
    },
    Display: {
      Color: Object.assign(
        function Color(r = 0, g = 0, b = 0) { Object.assign(this, { r, g, b, color: 0 }); return this; },
        {
          HexStringToColor: () => ({ color: 0, r: 0, g: 0, b: 0 }),
          IntegerToColor: () => ({ color: 0, r: 0, g: 0, b: 0 }),
          Interpolate: { ColorWithColor: () => ({ r: 0, g: 0, b: 0 }) },
          GetColor: () => 0
        }
      ),
      Align: loose('Align')
    },
    Input: { Keyboard: { KeyCodes: new Proxy({}, { get: () => 65 }), JustDown: () => false } },
    Physics: { Arcade: loose('Arcade') },
    GameObjects: {
      Sprite: class Sprite {}, Image: class Image {}, Container: class Container {},
      Graphics: class Graphics {}, Text: class Text {}, Zone: class Zone {}
    },
    Curves: loose('Curves'),
    Tweens: loose('Tweens'),
    BlendModes: new Proxy({}, { get: () => 0 })
  };

  return Phaser;
}

/** Browser globals a game and the kit both assume exist. */
function makeWindow(world) {
  const store = new Map();
  const listeners = [];

  // A plain object, NOT a proxy. This becomes the sandbox's global, and a
  // proxy there intercepts the language's own built-ins - Math, JSON, Object -
  // so the game gets a chainable stub where it expected Math.min.
  const win = Object.assign(Object.create(null), {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    location: { search: '', href: 'https://meamus.local/play', hash: '' },
    navigator: { userAgent: 'meamus-smoke', maxTouchPoints: 0 },
    localStorage: {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); },
      clear: () => store.clear()
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => { if (typeof fn === 'function') world.callbacks.push(fn); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    AudioContext: function AudioContext() { return world.audio; },
    webkitAudioContext: function webkitAudioContext() { return world.audio; },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} }
  });

  const element = () => loose('Element', {
    style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    appendChild: () => {}, append: () => {}, remove: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    innerHTML: '', textContent: ''
  });

  win.document = loose('document', {
    hidden: false,
    body: element(),
    documentElement: element(),
    getElementById: () => element(),
    querySelector: () => element(),
    querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {}
  });

  win.window = win;
  win.self = win;
  win.globalThis = win;
  return win;
}

/**
 * Run a generated game and report the first thing that breaks.
 *
 * @param {string} code   the game's JavaScript
 * @param {object} [opts]
 * @param {boolean} [opts.withKit=true] load the real meamus kit first
 * @returns {{ok:true, scenes:string[], textures:number}}
 * @throws {SmokeError} with the failure and the phase it happened in
 */
function boot(code, opts = {}) {
  const world = {
    config: null,
    game: null,
    timers: [],
    callbacks: [],
    started: [],
    textures: new Set(),
    /* One audio context for the run, so `this.sound.context` is the same object
       every scene sees - which is what a browser does, and what a game that
       caches it expects. */
    audio: audioContext()
  };

  const win = makeWindow(world);
  const Phaser = makePhaser(world);
  win.Phaser = Phaser;

  const sandbox = vm.createContext(win);
  // The sandbox is the window: no require, no process, no fs, no network.
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.Phaser = Phaser;

  const run = (source, label) => {
    try {
      new vm.Script(source, { filename: `${label}.js` }).runInContext(sandbox, { timeout: TIMEOUT_MS });
    } catch (err) {
      throw new SmokeError(
        `${label} threw while loading: ${err.message}`,
        firstGameFrame(err)
      );
    }
  };

  if (opts.withKit !== false) run(templates.readKit(), 'kit');
  run(code, 'game');

  if (!world.config) {
    throw new SmokeError('The game never called new Phaser.Game(), so nothing would start.');
  }

  const sceneList = [].concat(world.config.scene || []);
  if (!sceneList.length) {
    throw new SmokeError('The Phaser config has no scenes, so the canvas would stay blank.');
  }

  const names = [];
  for (const entry of sceneList) {
    let scene;
    const label = describeScene(entry);
    try {
      scene = typeof entry === 'function' ? new entry() : entry;
      if (!scene || typeof scene !== 'object') continue;
      if (!scene.__key) sceneServices(scene, world);
    } catch (err) {
      throw new SmokeError(`Scene ${label} could not be constructed: ${err.message}`, firstGameFrame(err));
    }

    names.push(scene.__key || label);

    for (const hook of ['init', 'preload', 'create']) {
      if (typeof scene[hook] !== 'function') continue;
      try {
        // create(data) is normal; an empty object is the safest stand-in.
        scene[hook]({});
      } catch (err) {
        throw new SmokeError(
          `${scene.__key || label}.${hook}() threw: ${err.message}`,
          firstGameFrame(err)
        );
      }
    }

    if (typeof scene.update === 'function') {
      for (let i = 0; i < UPDATE_TICKS; i += 1) {
        try {
          scene.update(16 * i, 16);
        } catch (err) {
          throw new SmokeError(
            `${scene.__key || label}.update() threw on tick ${i + 1}: ${err.message}`,
            firstGameFrame(err)
          );
        }
      }
    }
  }

  // Anything deferred - timer callbacks, tween completions - runs last, since
  // that is where "works for ten seconds then dies" hides.
  for (const timer of world.timers.slice(0, 40)) {
    try {
      timer.callback.call(timer.callbackScope || null);
    } catch (err) {
      throw new SmokeError(`A timed callback threw: ${err.message}`, firstGameFrame(err));
    }
  }
  for (const cb of world.callbacks.slice(0, 40)) {
    try { cb(); } catch (err) {
      throw new SmokeError(`A deferred callback threw: ${err.message}`, firstGameFrame(err));
    }
  }

  return { ok: true, scenes: names, textures: world.textures.size };
}

function describeScene(entry) {
  if (typeof entry === 'function') return entry.name || 'anonymous';
  if (entry && typeof entry === 'object') return entry.key || 'object';
  return String(entry);
}

/** The first stack line inside the generated file, so the fix has an address. */
function firstGameFrame(err) {
  const line = String((err && err.stack) || '')
    .split('\n')
    .find((l) => /game\.js:\d+/.test(l));
  const match = line && line.match(/game\.js:(\d+):(\d+)/);
  return match ? { line: Number(match[1]), column: Number(match[2]) } : null;
}

module.exports = { boot, SmokeError, TIMEOUT_MS };
