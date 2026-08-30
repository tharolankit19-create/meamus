# Android export

`GET /api/games/:id/export/apk` returns a zip containing a complete Cordova
project. meamus does **not** compile the APK — that needs the Android SDK and
your signing key, neither of which belongs on a web server. What it does is
remove every step that is fiddly to get right by hand.

## What is in the zip

```
www/index.html      the game, single self-contained file
config.xml          package id, name, orientation, icons, CDN allowlist
package.json        cordova 12 dev dependency + build scripts
build.sh            one-command debug or release build
README_APK.md       the same instructions, next to the project
res/icon/icon.png   placeholder icon (replace before publishing)
gamespec.json       the spec the game was built from
.gitignore          excludes platforms/, plugins/, build.json, *.keystore
```

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18+ |
| JDK | 17 |
| Android SDK | platform 34, build-tools 34.0.0 |

Export `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and `JAVA_HOME` first.

## Debug build

```bash
unzip astro-salvage-cordova.zip -d astro-salvage
cd astro-salvage
./build.sh
# platforms/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

## Release build

1. Create a keystore **once**. Losing it means you can never update the listing:

   ```bash
   keytool -genkey -v -keystore astro-salvage.keystore \
     -alias astro-salvage -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Add `build.json` beside `config.xml`:

   ```json
   {
     "android": {
       "release": {
         "keystore": "astro-salvage.keystore",
         "storePassword": "…",
         "alias": "astro-salvage",
         "password": "…"
       }
     }
   }
   ```

   Never commit it, or the keystore. Both are already in `.gitignore`.

3. `./build.sh release`

## Before publishing

**Package id.** Defaults to `com.meamus.<slug>`. Change it in `config.xml` to a
domain you own — it is permanent once the app is on the Play Store.

**Icon.** `res/icon/icon.png` is a 1×1 placeholder that exists so the build
never fails on a missing file. Replace it with a 1024×1024 PNG.

**Orientation.** Puzzles export as `portrait`, everything else as `landscape`.
Override with `?orientation=portrait` on the export request or by editing
`config.xml`.

**Offline build.** The game loads Phaser from jsDelivr, so a fresh install needs
a network on first run. To ship fully offline, drop `phaser.min.js` into `www/`
and change the `<script src>` in `www/index.html` to `phaser.min.js`.

**Ads.** The game calls `MEAMUS.ads.showBanner`, `showInterstitial` and
`showRewarded`. Add your SDK (`cordova-plugin-admob-free` or similar), implement
those three functions, and set `MEAMUS.ads.enabled = true`. Placement is already
decided — wave boundaries, level completes, game over, and a rewarded revive.

**Play Store requirements.** Target SDK 34 is set. You will still need a privacy
policy URL, a content rating questionnaire, and (if you ship ads) a data-safety
declaration covering the advertising ID.

## Generating an AAB instead

The Play Store prefers App Bundles:

```bash
npx cordova build android --release -- --packageType=bundle
# platforms/android/app/build/outputs/bundle/release/app-release.aab
```

## The `apkReady` flag

`spec.apkReady` starts `false` and flips to `true` the first time a Pro account
exports the project. It records that the game has an Android build; it is not a
gate. The gate is `requirePlan('pro')` on the export route.
