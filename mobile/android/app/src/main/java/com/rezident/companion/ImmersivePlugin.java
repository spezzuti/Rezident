package com.rezident.companion;

import androidx.appcompat.app.AppCompatActivity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Minimal native bridge for the immersive-fullscreen toggle (System page).
 *
 * The web UI can't touch the window's system bars, so this plugin exposes a single
 * `set({enabled})` method that hands the choice to MainActivity, which enters/exits
 * Android "immersive sticky" (bars hidden, transiently shown on an edge swipe). The
 * toggle therefore applies INSTANTLY — no app restart. Registered in
 * MainActivity.onCreate (registerPlugin) so Capacitor wires it before the bridge loads.
 *
 * Persistence + cold-start apply are handled elsewhere: nativeBridge.setFullscreen
 * mirrors the flag into CapacitorStorage, and MainActivity.onCreate reads it back.
 * There is no web implementation — every JS caller is guarded by isNativePlatform().
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    @PluginMethod
    public void set(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        final AppCompatActivity activity = getActivity();
        if (activity instanceof MainActivity) {
            final MainActivity main = (MainActivity) activity;
            // WindowInsetsController calls must run on the UI thread; plugin methods don't.
            activity.runOnUiThread(() -> main.setImmersive(enabled));
        }
        call.resolve();
    }
}
