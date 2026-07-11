# Firebase / FCM setup (C6)

Native push (the Approve/Deny notification) needs a real **Firebase Cloud Messaging**
project. Firebase is Google-hosted — this is the one external dependency in an otherwise
self-hosted stack, and it's the only reliable Android background-push path. You (the
operator) must create the project; the app and backend are already wired to use it.

**The debug APK builds and installs WITHOUT any of this** — the google-services Gradle
plugin is applied conditionally (`android/app/build.gradle`), so the app runs; only the
*push delivery* is inert until the steps below are done.

There are **two credentials**, for two different sides:

| File | Goes to | Purpose |
|------|---------|---------|
| `google-services.json` | the **app** (`mobile/android/app/`) | lets the app obtain an FCM registration token |
| Service-account JSON | the **backend** (Rezident *Settings ▸ Notifications*) | lets the desktop send messages via the FCM v1 API |

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com/> → **Add project**. Name it anything
   (e.g. `rezident`). Google Analytics is optional; you can disable it.
2. Note the **Project ID** (e.g. `rezident-1a2b3`) — you'll paste it into Rezident's
   backend config as `fcm_project_id`.

## 2. Register the Android app → `google-services.json`

1. In the project, **Add app ▸ Android**.
2. **Android package name** must be exactly:

   ```
   com.rezident.companion
   ```

   (No SHA-1 is required for FCM.)
3. Download the generated **`google-services.json`**.
4. Put it here:

   ```
   mobile/android/app/google-services.json
   ```

   This path is **git-ignored** (it's a secret). A fake structural template lives at
   `mobile/android/app/google-services.json.example` for reference — do not ship it.
5. Rebuild + sideload:

   ```sh
   cd mobile
   npm run build      # vite build → copy to www → cap sync
   npm run apk        # → android/app/build/outputs/apk/debug/app-debug.apk
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```

   With `google-services.json` present, the `com.google.gms.google-services` plugin now
   applies and the app can fetch an FCM token.

## 3. Create the backend service account

The desktop sends pushes with the **FCM HTTP v1 API**, which needs an OAuth2 bearer
minted from a service-account key.

1. Firebase console → **Project settings ▸ Service accounts**.
2. **Generate new private key** → downloads a JSON file (this is the *Firebase Admin
   SDK* service account — keep it secret).
3. In **Rezident ▸ Settings ▸ Notifications**, set:
   - **`fcm_project_id`** = your Project ID from step 1.
   - **`fcm_service_account`** = paste the entire service-account JSON (write-only field,
     stored like the other notifier secrets).
4. Save. The backend now fans out an FCM message on every approval / finish / pipeline
   event to each paired device that has registered an FCM token.

## 4. Pair the phone + grant permission

1. Open the app → pair with the desktop QR (Tailscale MagicDNS URL + code).
2. On first launch the app requests **Notifications** permission (Android 13+). Grant it.
3. The app registers its FCM token to `POST /api/devices/{device_id}/fcm` automatically.
4. **Battery:** to keep pushes prompt when the phone is dozing, grant the app
   **Unrestricted** battery usage: *Settings ▸ Apps ▸ Rezident ▸ App battery usage ▸
   Unrestricted*. Data-only high-priority messages are still subject to Doze; unrestricted
   battery minimizes latency.

---

## Verify end-to-end

1. Start a task on the desktop that hits an approval gate.
2. Within a few seconds the phone shows a **high-importance notification** with
   **Approve** / **Deny** buttons (even with the screen locked / app closed).
3. Tap **Approve** → the desktop task resolves and continues; the notification clears.
   (No app launch required — a native `BroadcastReceiver` posts the resolve.)
4. Tap the notification **body** instead → the app opens to the **Approvals** view.

## Versions used

- `firebase-bom` **33.7.0** → `firebase-messaging` **24.1.0**
  (`android/variables.gradle`, applied in `android/app/build.gradle`).
- `com.google.gms:google-services` **4.4.0** (`android/build.gradle`, applied
  conditionally in `android/app/build.gradle`).
- `@capacitor/push-notifications` **6.0.5**, `@capacitor/preferences` **6.0.4**.

## Troubleshooting

- **No token / no push:** confirm `google-services.json` is in `mobile/android/app/`,
  the package name inside it is `com.rezident.companion`, and you rebuilt after adding it.
- **Notification arrives but Approve does nothing:** the app must have been paired at
  least once (so `{baseUrl, token}` is mirrored to native storage), and the desktop must
  be reachable from the phone (Tailscale up). A failed resolve shows a toast.
- **`409 Already resolved`:** the approval was already handled elsewhere — the app just
  clears the notification. This is expected, not an error.
