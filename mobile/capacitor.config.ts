import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rezident.companion",
  appName: "Rezident",
  // Built web UI is copied here from ../frontend/dist by scripts/copy-www.mjs,
  // then staged into the native project by `cap sync`.
  webDir: "www",

  // --- Transport (C6) ----------------------------------------------------
  // Two settings are what let the WebView reach a REMOTE desktop at all.
  android: {
    // WebView origin becomes `http://localhost` (NOT the Capacitor default
    // `https://localhost`). Phase-1 reaches the desktop over Tailscale at
    //   http://<magicdns>:8734   (plaintext, WireGuard-encrypted transport)
    // and the live event socket is a plaintext `ws://`. An `https` WebView
    // origin would classify that `ws://` as MIXED CONTENT and the WebView
    // would silently block it — killing the live console. An `http` origin
    // makes both the http fetches and the ws:// socket same-security, so
    // nothing is blocked. (WebSockets aren't CORS-restricted, so cross-origin
    // WS works once mixed-content is out of the way.)
    allowMixedContent: true,
  },
  server: {
    // See the rationale above: keep the WebView on an http origin.
    androidScheme: "http",
  },

  plugins: {
    // C6 — route the app's browser `fetch()` calls through Capacitor's NATIVE
    // HTTP layer. The FastAPI backend sends NO CORS headers, so a WebView
    // `fetch()` to a cross-origin `http://<magicdns>:8734` would be blocked by
    // the browser's CORS preflight. CapacitorHttp transparently patches
    // `window.fetch`/`XMLHttpRequest` to go through the native OkHttp stack,
    // which is not subject to browser CORS. This covers, with NO app-code
    // change: every call in frontend/src/lib/api.ts (the `api()` fetch) AND
    // PairDevice.tsx's raw `fetch(${base}/api/pair/claim)`. WebSocket traffic
    // (ws.ts) is unaffected — WS is not CORS-gated and stays on the WebView.
    CapacitorHttp: { enabled: true },

    // C6 — FCM push + inline Approve/Deny actions. The JS side of the push
    // plugin is used ONLY to (a) request the Android 13+ POST_NOTIFICATIONS
    // runtime permission and (b) fetch/refresh the FCM registration token
    // (see frontend/src/lib/nativeBridge.ts). The actual incoming-message
    // handling + Approve/Deny notification is built by the native
    // RezidentMessagingService (the plugin's own MessagingService is removed
    // in AndroidManifest.xml so ours is the sole handler).
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },

    // C5 — Barcode / QR scanner for device pairing. Installed; the ML Kit
    // scanner module is fetched from Google Play services on first use.
    BarcodeScanning: {},
  },

  // Capacitor's dev live-reload server. Left unset on purpose: the APK ships
  // the web UI as bundled static assets (no dev server, no PWA/SW). A future
  // developer can point `server.url` at a LAN Vite dev server for live reload,
  // but production/sideload builds must keep this unset.
  // server: { url: "http://192.168.x.x:5173", cleartext: true },
};

export default config;
