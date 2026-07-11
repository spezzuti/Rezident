package com.rezident.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import androidx.core.app.NotificationManagerCompat;

/**
 * C6 — handles the Approve/Deny action buttons on an approval notification, WITHOUT
 * opening the app.
 *
 * Reads the mirrored active connection ({baseUrl, token}) from the "CapacitorStorage"
 * SharedPreferences (written by the WebView via @capacitor/preferences), then
 *   POST {baseUrl}/api/approvals/{approval_id}/resolve  {"action":"approve"|"deny"}
 * with the Bearer device token. The device token's `approvals` scope authorizes it.
 *
 * Responses:
 *   200 → resolved; cancel the notification.
 *   409 → already resolved / orphaned; cancel the notification (nothing left to do).
 *   other/-1 → transport or auth error; cancel + a toast so the tap is never a dead end.
 */
public class ApprovalActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        final String approvalId = intent.getStringExtra("approval_id");
        final String action = intent.getStringExtra("action"); // "approve" | "deny"
        final int notifId = intent.getIntExtra("notif_id", -1);
        final Context app = context.getApplicationContext();

        // Cancel the card immediately for a responsive feel; the POST runs in the
        // background. (If the POST fails we surface a toast below.)
        if (notifId != -1) {
            NotificationManagerCompat.from(app).cancel(notifId);
        }

        if (approvalId == null || action == null) return;

        final PendingResult pending = goAsync(); // keep the receiver alive for the network call
        new Thread(() -> {
            int status = -1;
            try {
                String base = RezidentHttp.pref(app, RezidentHttp.KEY_BASE_URL);
                String bearer = RezidentHttp.pref(app, RezidentHttp.KEY_TOKEN);
                String body = "{\"action\":\"" + action + "\"}";
                status = RezidentHttp.postJson(
                        base, "/api/approvals/" + approvalId + "/resolve", bearer, body);
            } finally {
                final int finalStatus = status;
                toastForStatus(app, action, finalStatus);
                pending.finish();
            }
        }).start();
    }

    private void toastForStatus(Context app, String action, int status) {
        final String msg;
        if (status == 200) {
            msg = "approve".equals(action) ? "Approved" : "Denied";
        } else if (status == 409 || status == 404) {
            // 409 = already resolved/orphaned; 404 = the approval no longer exists
            // (already handled, or a stale/test notification). Either way it reached
            // the server — not a connectivity failure.
            msg = "Already resolved";
        } else if (status == 401 || status == 403) {
            msg = "Not authorized — re-pair the device";
        } else {
            msg = "Couldn't reach Rezident — open the app to retry";
        }
        new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(app, msg, Toast.LENGTH_SHORT).show());
    }
}
