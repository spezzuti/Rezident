package com.rezident.companion;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * C6 — the SOLE FirebaseMessagingService for the app.
 *
 * The @capacitor/push-notifications plugin also ships a MessagingService; only one
 * service may win incoming messages, so the plugin's is removed in AndroidManifest.xml
 * (tools:node="remove") and THIS one is registered with the MESSAGING_EVENT filter.
 * The plugin's JS API is still used for the POST_NOTIFICATIONS permission + token
 * retrieval — that path doesn't need the plugin's service.
 *
 * We build the notification ourselves (rather than letting FCM auto-display the
 * optional `notification` block) because inline Approve/Deny action buttons for
 * type=="approval" require a locally-built Notification with Action extras. The
 * backend sends BOTH a `data` block (parsed here) and an optional `notification`
 * block (lockscreen display / delivery priority); we key off `data`.
 *
 * Data contract (all string values, from backend C2):
 *   always:            type ("approval"|"finish"|"pipeline"), title, body
 *   for approvals:     approval_id, task_id, tool, command (command optional)
 */
public class RezidentMessagingService extends FirebaseMessagingService {

    static final String CHANNEL_ID = "rezident_approvals";
    private static final String CHANNEL_NAME = "Rezident Approvals";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (data == null || data.isEmpty()) return;

        String type = orEmpty(data.get("type"));
        String title = orEmpty(data.get("title"));
        String body = orEmpty(data.get("body"));
        if (title.isEmpty()) title = "Rezident";

        ensureChannel();

        if ("approval".equals(type)) {
            showApproval(data, title, body);
        } else {
            showSimple(title, body);
        }
    }

    /**
     * FCM issues/rotates the registration token here. The WebView normally POSTs the
     * token at pairing time, but a mid-session refresh never reaches JS (we removed the
     * plugin's service), so re-register natively using the mirrored creds. Idempotent —
     * the backend upserts the token.
     */
    @Override
    public void onNewToken(String token) {
        final String base = RezidentHttp.pref(this, RezidentHttp.KEY_BASE_URL);
        final String bearer = RezidentHttp.pref(this, RezidentHttp.KEY_TOKEN);
        final String deviceId = RezidentHttp.pref(this, RezidentHttp.KEY_DEVICE_ID);
        if (base == null || bearer == null || deviceId == null) return;
        final String body = "{\"fcm_token\":" + jsonString(token) + "}";
        new Thread(() ->
            RezidentHttp.postJson(base, "/api/devices/" + deviceId + "/fcm", bearer, body)
        ).start();
    }

    // ---- notification builders ----------------------------------------------------

    private void showApproval(Map<String, String> data, String title, String body) {
        String approvalId = orEmpty(data.get("approval_id"));
        String tool = orEmpty(data.get("tool"));
        String command = orEmpty(data.get("command"));

        // Notification id is stable per approval so the action receiver can cancel it,
        // and a re-sent push for the same approval replaces (not stacks) the card.
        int notifId = approvalId.isEmpty() ? (int) System.currentTimeMillis()
                                           : ("approval:" + approvalId).hashCode();

        // Body detail: title line from backend, then tool / command context.
        StringBuilder detail = new StringBuilder();
        if (!body.isEmpty()) detail.append(body);
        if (!tool.isEmpty()) {
            if (detail.length() > 0) detail.append('\n');
            detail.append("Tool: ").append(tool);
        }
        if (!command.isEmpty()) {
            if (detail.length() > 0) detail.append('\n');
            detail.append(command);
        }
        String detailText = detail.toString();

        NotificationCompat.Builder b = baseBuilder(title, detailText.isEmpty() ? "Approval requested" : detailText);

        // Body tap → open the app to the Approvals view (deep link via extra).
        b.setContentIntent(contentPendingIntent(notifId, "/approvals"));

        if (!approvalId.isEmpty()) {
            b.addAction(0, "Approve", actionPendingIntent(approvalId, "approve", notifId));
            b.addAction(0, "Deny", actionPendingIntent(approvalId, "deny", notifId));
        }

        notify(notifId, b);
    }

    private void showSimple(String title, String body) {
        int notifId = (int) System.currentTimeMillis();
        NotificationCompat.Builder b = baseBuilder(title, body);
        b.setContentIntent(contentPendingIntent(notifId, "/")); // tap → open the console
        notify(notifId, b);
    }

    private NotificationCompat.Builder baseBuilder(String title, String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setAutoCancel(true);
    }

    private void notify(int notifId, NotificationCompat.Builder b) {
        try {
            // POST_NOTIFICATIONS is requested at pairing time from JS; if the user
            // declined, notify() is a silent no-op (permission checked internally).
            NotificationManagerCompat.from(this).notify(notifId, b.build());
        } catch (SecurityException ignored) {
            /* notifications not permitted */
        }
    }

    // ---- pending intents ----------------------------------------------------------

    private PendingIntent actionPendingIntent(String approvalId, String action, int notifId) {
        Intent i = new Intent(this, ApprovalActionReceiver.class);
        i.setAction("com.rezident.companion.APPROVAL_" + action.toUpperCase() + "_" + approvalId);
        i.putExtra("approval_id", approvalId);
        i.putExtra("action", action);
        i.putExtra("notif_id", notifId);
        int req = (approvalId + ":" + action).hashCode();
        return PendingIntent.getBroadcast(this, req, i, pendingFlags());
    }

    private PendingIntent contentPendingIntent(int notifId, String nav) {
        Intent i = new Intent(this, MainActivity.class);
        i.setAction("com.rezident.companion.OPEN_" + notifId);
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        i.putExtra("rezident_nav", nav);
        return PendingIntent.getActivity(this, notifId, i, pendingFlags());
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    // ---- channel ------------------------------------------------------------------

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Approval requests and task alerts from your Rezident desktop");
        ch.enableVibration(true);
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }

    // ---- utils --------------------------------------------------------------------

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    /** Minimal JSON string escaper for the fcm_token body. */
    private static String jsonString(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default: sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
