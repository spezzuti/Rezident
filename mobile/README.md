# Rezident — Android companion (Capacitor shell)

Wraps the existing Rezident web UI (`../frontend`) into an Android APK. The APK
ships the built React app as **bundled static assets** (no dev server, no PWA /
service worker) inside a Capacitor WebView.

- **App ID:** `com.rezident.companion`
- **App name:** `Rezident`
- **Capacitor:** 6.2.1
- **minSdk 24** (Android 7.0) · **compile/target SDK 35** (Android 15)
- **Target device:** Motorola Razr+ 2025 / Android 16 (foldable — orientation is
  intentionally **not** locked; fold/unfold is handled via `configChanges`).

Implemented chunks:

- **C5** — QR/barcode scanner for device pairing (`@capacitor-mlkit/barcode-scanning`).
- **C6** — FCM push + inline Approve/Deny (`@capacitor/push-notifications` for the
  permission + token; a native `RezidentMessagingService` + `ApprovalActionReceiver`
  in `android/app/src/main/java/com/rezident/companion/` build the Approve/Deny
  notification and resolve it without opening the app). The C6 native classes are
  **Java** (matching the existing `MainActivity.java` and the app module's Java-only
  toolchain), not Kotlin. Firebase is wired via the BOM in `android/variables.gradle`
  / `android/app/build.gradle`, applied conditionally so the debug build succeeds
  **without** a `google-services.json`. Push at runtime needs a real Firebase
  project — see **`FIREBASE_SETUP.md`**.

The active connection is mirrored from the WebView into native `SharedPreferences`
(`@capacitor/preferences`, file `CapacitorStorage`) by `frontend/src/lib/nativeBridge.ts`
so the background action receiver can read `{baseUrl, token, device_id}`.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node / npm | 18+ | Verified with Node 24 / npm 11. |
| JDK | **17** | Capacitor 6 targets Java 17. `java -version` must report 17. |
| Android SDK | Platform **35** + build-tools 34/35 | Installed here at `C:\Android\Sdk`. |
| Gradle | wrapper | The `android/gradlew` wrapper downloads the right Gradle; no global install needed. |

Set the SDK location one of two ways:

1. Environment: `ANDROID_HOME` / `ANDROID_SDK_ROOT` → your SDK dir
   (`C:\Android\Sdk` on this machine), **or**
2. `android/local.properties` with `sdk.dir=C\:\\Android\\Sdk` (git-ignored;
   already present on this machine).

To install the SDK from scratch: Android Studio → SDK Manager, or the
command-line tools' `sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"`.

---

## Build pipeline

The whole chain is one script. From `mobile/`:

```bash
npm install          # first time only
npm run build        # web build -> copy -> cap sync
```

`npm run build` runs, in order:

1. `build:web` → `npm --prefix ../frontend run build` (`tsc --noEmit && vite build`, emits `../frontend/dist`)
2. `copy:www` → `node scripts/copy-www.mjs` (cross-platform copy `../frontend/dist` → `www/`)
3. `sync` → `cap sync android` (stages `www/` + plugins into the native project)

Other scripts:

| Script | Does |
|--------|------|
| `npm run build:from-dist` | Skip the web build; copy an already-built `../frontend/dist` → `www` → sync. |
| `npm run copy:www` | Just the cross-platform `dist → www` copy. |
| `npm run sync` | Just `cap sync android`. |
| `npm run add:android` | (Re)generate the native `android/` project. |
| `npm run apk` | Build the debug APK via the Gradle wrapper (see below). |
| `npm run open:android` | Open the project in Android Studio. |

> The copy step uses Node's `fs` (`scripts/copy-www.mjs`) — **not** a bash `cp` —
> so it runs identically on Windows, macOS and Linux.

---

## Build the debug APK

```bash
npm run build        # produce www + sync (once per web change)
npm run apk          # -> gradlew assembleDebug
```

`npm run apk` wraps the Gradle wrapper (`scripts/assemble-debug.mjs`, picks
`gradlew.bat` vs `./gradlew`). Or run Gradle directly:

```bash
cd android
./gradlew assembleDebug          # macOS/Linux
gradlew.bat assembleDebug        # Windows
```

Output APK:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Sideload to the Razr+ (or any device)

1. Enable **Developer options → USB debugging** on the phone; plug it in and
   accept the RSA prompt.
2. Install:

```bash
# adb lives in the SDK's platform-tools (C:\Android\Sdk\platform-tools\adb.exe)
adb devices                 # confirm the phone shows as "device"
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`-r` reinstalls over an existing copy. To wipe first: `adb uninstall com.rezident.companion`.

---

## Targeting Android 16 (API 36)

This scaffold builds against **API 35** because that is the highest platform
installed and Capacitor 6 + JDK 17 + AGP 8.2.x target it cleanly. Android 16
runs API-35 targets without issue. To actually *target* API 36 later:

1. `sdkmanager "platforms;android-36" "build-tools;36.0.0"`
2. Move to **JDK 21** and **Capacitor 7/8** (newer Android Gradle Plugin — AGP
   8.2.x can't compile against SDK 36).
3. Bump `compileSdkVersion`/`targetSdkVersion` to `36` in `android/variables.gradle`.

---

## Layout

```
mobile/
├── capacitor.config.ts     # appId/appName/webDir + plugin seams (C5/C6)
├── package.json            # deps + build-pipeline scripts
├── scripts/
│   ├── copy-www.mjs        # cross-platform dist -> www
│   └── assemble-debug.mjs  # cross-platform gradlew assembleDebug
├── www/                    # built web UI (git-ignored; from ../frontend/dist)
└── android/                # generated native Gradle project (cap add android)
```
