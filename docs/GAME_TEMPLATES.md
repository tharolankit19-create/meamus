# Writing a template

A template is a complete game that ships with meamus. It serves two purposes:
it is playable in the gallery, and it is a match target in template mode.

## Layout

```
templates/my-game/
  template.json   metadata: everything in a GameSpec except gameCode.javascript
  game.js         the Phaser 3 code
```

`server/services/templates.js` merges the two into a normalised GameSpec at
load time. Restart the server (or call `templates.reload()`) to pick up a new
one, then `npm run build:demos` to render it into `public/demos/`.

## template.json

```json
{
  "id": "my-game",
  "slug": "my-game",
  "featured": true,
  "keywords": ["tower", "defense", "waves", "turret"],
  "runtime": { "kit": true, "phaserVersion": "3.60.0" },
  "gameConfig": { "title": "...", "genre": "tower defense", "description": "...",
                  "difficulty": "medium", "estimatedPlayTime": "..." },
  "assets": { "sprites": [...], "audio": [...] },
  "controls": { "keyboard": [...], "touch": [...], "mouse": [...] },
  "mechanics": [{ "name": "...", "description": "...", "implementation": "..." }],
  "monetizationHooks": [...],
  "mobileOptimizations": [...],
  "apkReady": false
}
```

`keywords` drive template-mode routing. `rank()` scores a token hit at 2 points,
a `genre` string match at 4, and sorts. Pick words a user would actually type.

`runtime.kit: true` makes the bundler inline `_shared/kit.js` ahead of your
code. Leave it out only if your game is fully standalone.

## game.js

Wrap everything in an IIFE, put your tuning constants in one `CFG` object at the
top, and boot through the kit:

```js
(function () {
  'use strict';
  var CFG = { WIDTH: 800, HEIGHT: 600, KEY: 'my-game', /* … */ };

  function bakeTextures(scene) {
    MEAMUS.gfx.rect(scene, 'player', 32, 32, 0x6cc7ff, { radius: 6 });
    // TODO: replace with generated sprite: player — 32x32 …
  }

  class MenuScene extends Phaser.Scene { /* … */ }
  class GameScene extends Phaser.Scene { /* … */ }
  class GameOverScene extends Phaser.Scene { /* … */ }

  MEAMUS.boot({
    type: Phaser.AUTO,
    width: CFG.WIDTH, height: CFG.HEIGHT,
    parent: 'game-container',
    physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
    scene: [
      MEAMUS.scenes.makeBoot('PreloadScene'),
      MEAMUS.scenes.makePreload({ bake: bakeTextures, title: 'MY GAME', next: 'MenuScene' }),
      MenuScene, GameScene, GameOverScene
    ],
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }
  });
})();
```

## The kit

| Namespace | What it gives you |
|---|---|
| `MEAMUS.gfx` | `rect` `circle` `poly` `rock` `star` `gradient` `particle` `texture` — procedural sprites baked to textures |
| `MEAMUS.sfx` | `laser` `explode` `jump` `coin` `hurt` `click` `match` `win`, plus raw `tone`/`noise`. Web Audio, no files |
| `MEAMUS.ui` | `title` `label` `button` `panel` `bannerSlot` — buttons clear the 44px touch minimum |
| `MEAMUS.fx` | `floatText` `shake` `flash` |
| `MEAMUS.touch` | `isTouch()` `joystick()` `button()` |
| `MEAMUS.storage` | Safe localStorage wrapper with an in-memory fallback; `best(key, score)` |
| `MEAMUS.currency` | Shared coin wallet: `get` `add` `spend` |
| `MEAMUS.ads` | `showBanner` `showInterstitial` `showRewarded` `countRun` — no-ops until an SDK is wired in |
| `MEAMUS.scenes` | `makeBoot(next)` `makePreload({bake, title, next})` |
| `MEAMUS.boot` | Boot wrapper: try/catch, visibility pause, Android back button, resize |

## Rules `npm run check` enforces

- All five scenes present (Boot and Preload can come from the kit)
- Keyboard **and** touch **and** mouse controls documented
- No `eval`, no `new Function`, no `setInterval` game loop, no `alert`
- Score persisted via `localStorage` or `MEAMUS.storage`
- At least three sprite descriptions and one monetization hook
- `apkReady: false`
- Under 2000 lines
- **No external asset beyond the pinned Phaser CDN**

Run `npm run check && npm test` before committing a template.

## Checklist

- [ ] Menu → game → game over → restart all reachable
- [ ] Playable on keyboard alone, and on touch alone
- [ ] Pause works and does not leak timers (clean up on `shutdown`)
- [ ] Repeating objects are pooled, not created and destroyed
- [ ] Every placeholder sprite has a `// TODO: replace with generated sprite:` note
- [ ] A "How to play" screen exists
