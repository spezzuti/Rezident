package com.rezident.companion;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * C6 — shared native helper for the FCM path.
 *
 * The active Rezident connection ({baseUrl, token, device_id}) is mirrored into
 * Android SharedPreferences by the WebView via @capacitor/preferences. Capacitor's
 * Preferences plugin persists to a SharedPreferences file named "CapacitorStorage"
 * with the keys stored verbatim — so native code reads it directly here, with no
 * bridge and while the app is closed. Used by:
 *   - ApprovalActionReceiver (Approve/Deny → POST resolve)
 *   - RezidentMessagingService.onNewToken (token refresh → POST fcm)
 */
final class RezidentHttp {
    static final String PREFS_FILE = "CapacitorStorage";
    static final String KEY_BASE_URL = "rezident_base_url";
    static final String KEY_TOKEN = "rezident_token";
    static final String KEY_DEVICE_ID = "rezident_device_id";
    static final String KEY_PENDING_NAV = "rezident_pending_nav";
    // Immersive-fullscreen choice, mirrored by the WebView (nativeBridge.setFullscreen)
    // so MainActivity.onCreate can honor it on a cold start before JS loads. "1"/"0".
    static final String KEY_FULLSCREEN = "rezident_fullscreen";

    private RezidentHttp() {}

    static String pref(Context ctx, String key) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
        return sp.getString(key, null);
    }

    static void putPref(Context ctx, String key, String value) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE);
        sp.edit().putString(key, value).apply();
    }

    /**
     * POST a JSON body to {baseUrl}{path} with a Bearer token. Runs on the CALLER's
     * thread — callers MUST invoke this off the main thread. Returns the HTTP status
     * code, or -1 on a transport failure.
     */
    static int postJson(String baseUrl, String path, String bearer, String jsonBody) {
        if (baseUrl == null || bearer == null) return -1;
        HttpURLConnection conn = null;
        try {
            String base = baseUrl.replaceAll("/+$", "");
            URL url = new URL(base + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + bearer);
            byte[] payload = jsonBody.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            return conn.getResponseCode();
        } catch (Exception e) {
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
