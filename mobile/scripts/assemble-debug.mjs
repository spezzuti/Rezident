// Cross-platform "build the debug APK" helper.
// Invokes the Gradle wrapper inside android/ (gradlew.bat on Windows,
// ./gradlew elsewhere) so `npm run apk` works on every OS.
//
// Requires the Android toolchain on the machine:
//   - JDK 17 (JAVA_HOME or `java` on PATH)
//   - Android SDK with ANDROID_HOME / ANDROID_SDK_ROOT set (or a
//     local.properties with sdk.dir=... inside android/, which
//     `cap add android` / Android Studio writes for you)
// See README.md for the full prerequisite list.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = resolve(here, "..", "android");

if (!existsSync(androidDir)) {
  console.error(
    `[apk] No android/ project yet. Generate it first: npm run add:android`
  );
  process.exit(1);
}

const isWin = process.platform === "win32";
const wrapper = join(androidDir, isWin ? "gradlew.bat" : "gradlew");
const cmd = isWin ? wrapper : "./gradlew";

const res = spawnSync(cmd, ["assembleDebug"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWin, // .bat needs the shell on Windows
});

if (res.status === 0) {
  const apk = join(
    androidDir,
    "app",
    "build",
    "outputs",
    "apk",
    "debug",
    "app-debug.apk"
  );
  console.log(`\n[apk] Built: ${apk}`);
}
process.exit(res.status ?? 1);
