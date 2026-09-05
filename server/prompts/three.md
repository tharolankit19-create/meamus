# WRITING A 3D GAME

This game is 3D. Ignore every Phaser instruction: there is no `Phaser`, no
scenes, no arcade physics. You are writing a **classic script** against a global
`THREE` (three.js r149), and `gameCode.javascript` is that script.

Set `"runtime": { "engine": "three" }` in the spec.

## The shape of the file

```js
const CFG = { /* every tunable number, named */ };
const PAL = { /* the palette, as 0x hex */ };

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAL.sky);
scene.fog = new THREE.Fog(PAL.sky, 30, 120);          // depth for free

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));  // never above 2
renderer.shadowMap.enabled = true;
document.getElementById('game-container').appendChild(renderer.domElement);

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize); resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);      // clamp: a backgrounded
  last = now;                                          // tab returns a huge dt
  update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The render loop is the last thing in the file and you must reach it. A game
that never calls `requestAnimationFrame` and `renderer.render()` draws one
frame of nothing.

## Rules that are specific to 3D

1. **Light it, or everything is black.** `MeshStandardMaterial` needs light. One
   `DirectionalLight` (position it high and to one side, `castShadow = true`)
   plus a `HemisphereLight` for fill. Never rely on `MeshBasicMaterial` for
   everything - it is flat and it looks it.
2. **Move with delta time**, never per frame. `pos += speed * dt`. Per-frame
   movement runs at double speed on a 120Hz screen.
3. **Reuse geometries and materials.** Create one `BoxGeometry` and one material
   per block type and share them across every mesh. A new geometry per cube is
   what makes a voxel world drop to 5fps.
4. **`InstancedMesh` past ~200 identical objects.** A voxel field, a crowd, a
   forest: one instanced mesh, not a thousand `Mesh` objects.
5. **Keep the world small and finite.** A 32x32 chunk you can walk across beats
   an infinite world that never finishes generating.
6. **Collision by maths, not a physics engine.** There is no Cannon or Ammo
   here. Sphere-vs-box and axis-aligned box overlap are a few lines each and
   enough for a walker, a shooter or a driver.
7. **Dispose nothing mid-game.** Build the world once; hide with `.visible`.

## Controls - both, always

- **Desktop**: WASD + mouse look via `renderer.domElement.requestPointerLock()`
  on click, `mousemove` for yaw/pitch. Clamp pitch to +/- 85 degrees. Show a
  "click to look around" prompt until pointer lock is taken.
- **Touch**: two on-screen sticks as HTML elements over the canvas - move on the
  left, look on the right - plus a large action button. Track them with
  `pointerdown`/`pointermove`/`pointerup` and multiple `pointerId`s, so moving
  and looking work at the same time. This is the difference between a 3D game
  that is playable on a phone and one that is not.
- Detect with `matchMedia('(pointer: coarse)')`; ship both, show the one that
  fits. A pause button in a corner, always.

## Look

The same art direction as everything else, in three dimensions:

- **Light ground.** A pale sky, fog in the same colour, a soft floor. Not a
  black void with neon cubes - that is what every generated 3D demo looks like.
- Colour by material, one accent for the player, one for objectives, one for
  danger, and a few muted tones for the world.
- Soft shadows (`renderer.shadowMap.type = THREE.PCFSoftShadowMap`), a ground
  plane that receives them, and a slight camera ease rather than a rigid lock:
  `camera.position.lerp(target, 1 - Math.pow(0.001, dt))`.
- Something moving in the background - drifting clouds, swaying grass, a slow
  sun. A static world reads as a screenshot.

## Scope

A 3D game costs more lines than a 2D one, so cut scope, not the ending:
one mechanic, one small world, one clear goal, one fail state. **Aim for
350-600 lines.** A voxel patch you can walk on, dig and build in is a real
game. A survival-crafting-multiplayer world is not going to arrive at all.
