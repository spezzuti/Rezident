package com.rezident.companion;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * C6 deep link: tapping the BODY of an FCM notification launches this activity with a
 * `rezident_nav` extra (e.g. "/approvals"). Native code can't call the React router, so
 * we stash the target in the same "CapacitorStorage" SharedPreferences the WebView reads
 * via @capacitor/preferences; the app consumes it (nativeBridge.consumePendingNav) on
 * mount / resume and navigates. We also nudge the WebView to re-check immediately for the
 * already-foreground case. launchMode is singleTask, so warm taps arrive via onNewIntent.
 */
public class MainActivity extends BridgeActivity {

    /** Dark app-shell tone used for the system bars (== --wl-bg-0, the deepest
     *  wasteland-theme background / bottom of the shell gradient). Keep in sync
     *  with the color passed to StatusBar.setBackgroundColor in nativeBridge.ts. */
    private static final int SYSTEM_BAR_COLOR = 0xFF181F26;

    /** Current immersive-fullscreen state. When true the system bars are hidden and
     *  reappear transiently on an edge swipe; when false the window keeps the fitted,
     *  inset layout set up in onCreate. Toggled live from the WebView via ImmersivePlugin
     *  and re-asserted on focus (Android drops immersive when focus returns). */
    private boolean immersiveEnabled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin — must be registered BEFORE super.onCreate builds the bridge.
        registerPlugin(ImmersivePlugin.class);

        super.onCreate(savedInstanceState);

        // Android 15 (targetSdk 35) ENFORCES edge-to-edge: without this the WebView
        // draws BEHIND the status and navigation bars. This is a full productivity
        // UI (not an immersive game), so opt back into fitted, inset windows.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        // Belt-and-suspenders for Android 15, where setDecorFitsSystemWindows(true)
        // no longer reliably insets on its own: pad the root content view by the
        // system-bar insets so the WebView sits strictly BETWEEN the bars. When the
        // decor already fits, these insets arrive as zero, so there is no double pad.
        final View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });

        // Paint the bars (and any exposed inset strip) the dark app tone. The status
        // bar color/style/overlay is (re)asserted from JS via @capacitor/status-bar;
        // the navigation bar is native-only, so we color it here. Light bar icons are
        // the default (we never set the light-bar flags), which suits the dark tone.
        getWindow().setBackgroundDrawable(new ColorDrawable(SYSTEM_BAR_COLOR));
        getWindow().setStatusBarColor(SYSTEM_BAR_COLOR);
        getWindow().setNavigationBarColor(SYSTEM_BAR_COLOR);

        // Persisted immersive choice, mirrored by the WebView into CapacitorStorage
        // (nativeBridge.setFullscreen). Read + apply it here so a cold start honors the
        // user's choice with no flash of bars before the WebView boots. Default OFF.
        String fs = RezidentHttp.pref(this, RezidentHttp.KEY_FULLSCREEN);
        setImmersive("1".equals(fs) || "true".equals(fs));
    }

    /**
     * Enter/exit Android "immersive sticky". When enabled we HIDE both system bars and
     * ask that they reappear only transiently on an edge swipe
     * (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE) — the transient bars float over content and
     * don't reflow it, so the WebView stays full-bleed. When disabled we SHOW the bars and
     * restore BEHAVIOR_DEFAULT; the onCreate inset listener then re-pads the content below/
     * above them, i.e. exactly the fullscreen-OFF behavior. Called from ImmersivePlugin (UI
     * thread), on cold-start from onCreate, and re-asserted from onWindowFocusChanged.
     */
    public void setImmersive(boolean enabled) {
        immersiveEnabled = enabled;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (enabled) {
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_DEFAULT);
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Android drops immersive when focus returns (keyboard dismissed, a transient bar,
        // task-switch back). Re-hide the bars so immersive stays "sticky".
        if (hasFocus && immersiveEnabled) {
            setImmersive(true);
        }
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        stashNav(intent);
        nudgeWebView();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Cold start delivers the launch intent here after the bridge is ready.
        stashNav(getIntent());
    }

    private void stashNav(Intent intent) {
        if (intent == null) return;
        String nav = intent.getStringExtra("rezident_nav");
        if (nav != null && !nav.isEmpty()) {
            RezidentHttp.putPref(this, RezidentHttp.KEY_PENDING_NAV, nav);
            // Consume once: clear the extra so a later resume doesn't re-navigate.
            intent.removeExtra("rezident_nav");
        }
    }

    private void nudgeWebView() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().post(() ->
                    getBridge().getWebView().evaluateJavascript(
                        "document.dispatchEvent(new Event('visibilitychange'))", null));
            }
        } catch (Exception ignored) {
            /* bridge not ready — the resume/mount consumer still catches it */
        }
    }
}
