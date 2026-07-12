# Remote access with Tailscale (bundled)

Rezident bundles a tiny embedded **Tailscale** node so you can reach it from your
phone (or another machine) anywhere — with **no VPS, no router port-forward, and no
public exposure**. It's the recommended remote-access path, and the simplest: click
**Connect** in Settings, approve one link, done.

It replaces the older [relay](RELAY.md) approach (which needed you to rent and
maintain a VPS). The relay is still present but dormant; prefer this.

## How it works

The app ships `tailscale-helper.exe` — a self-contained **userspace** Tailscale node
built on [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet). It joins *your* private
tailnet as its own device (named `rezident`) and reverse-proxies the tailnet to
Rezident's loopback server. Crucially, it runs **in userspace**: no `wintun` network
driver is installed and there's no admin/UAC prompt — only Rezident's own traffic
rides the tailnet, not your whole machine.

```
   phone (on your tailnet)                     this PC
   ┌───────────────┐                     ┌────────────────────────────────┐
   │ Rezident app  │  WireGuard-encrypted│  tailscale-helper.exe (tsnet)  │
   │  (webview)    │ ═══════════════════▶│   node "rezident" 100.x.y.z    │
   └───────────────┘   over the tailnet  │            │ reverse-proxy      │
                                         │            ▼ 127.0.0.1:8734     │
                                         │   Rezident (FastAPI, loopback) │
                                         └────────────────────────────────┘
```

Because the tailnet leg is WireGuard-encrypted and only the final hop is loopback,
the Rezident server **stays bound to 127.0.0.1** — you do *not* need to enable LAN
exposure, and the bearer token never crosses a plaintext network.

## Connect

1. Create a free **Tailscale account** at <https://tailscale.com> (personal use is
   free) and install Tailscale on the devices you want to reach Rezident *from* (your
   phone, a laptop). The Rezident PC itself does **not** need the Tailscale app —
   the bundled helper is its node.
2. In Rezident open **Settings → Remote Access (Tailscale)** and click **Connect**.
3. After a few seconds an **Authorize** link appears. Open it, sign in, and approve
   the `rezident` device into your tailnet.
4. The panel turns green and shows the node's address (e.g.
   `rezident.<your-tailnet>.ts.net`). That's it.
5. **Pair your phone as usual** (Settings → pairing QR). While Tailscale is
   connected, the QR automatically advertises the tailnet address, so the phone pairs
   over the tailnet and keeps working anywhere — home, cellular, another network.

Disconnecting is one click; the node's identity is kept on disk, so reconnecting
later re-joins instantly with no re-auth.

## Configuration

State lives in the `settings` table under `tailscale:config` (JSON) and the tsnet
node keys under `<data_dir>/tailscale/`. Fields:

| field      | default      | meaning |
|------------|--------------|---------|
| `enabled`  | `false`      | master switch; **off by default** — the app is untouched until you Connect |
| `hostname` | `"rezident"` | the tailnet node name (its MagicDNS label) |
| `authkey`  | `""`         | optional [auth key](https://tailscale.com/kb/1085/auth-keys) for headless/kiosk join; blank = the normal interactive Authorize-link login |

For an unattended install you can pre-seed `authkey` (and `enabled: true`) so the
node joins on first boot with no interactive step.

## Security notes

- **No public surface.** There is no open port on the internet and no VPS in the
  path. Only devices *you've* added to *your* tailnet can reach the node at all —
  Tailscale's ACLs gate that, on top of Rezident's own bearer-token auth.
- **Loopback-bound server.** The FastAPI server never leaves `127.0.0.1`; the helper
  is the only thing on the tailnet, and it forwards to loopback. Enabling LAN
  exposure is neither needed nor recommended alongside this.
- **Encrypted transport.** The phone↔helper leg is WireGuard (Tailscale); the
  helper↔server hop is loopback on the same machine.
- **Credential lifetime still matters.** A device on your tailnet that holds a paired
  phone token can still reach the app — de-enrolling a lost device from the Tailscale
  admin *and* revoking its Rezident device token are both worth doing. Paired device
  tokens also expire by default (see `devices:token_ttl_days`).
- The node appears as a device (`rezident`) in your Tailscale admin console; remove
  it there to fully revoke the machine's tailnet access.

## Building the helper (developers)

The helper source is `desktop/tailscale-helper/` (Go, `tailscale.com/tsnet`). Build
it with Go installed:

```powershell
desktop\tailscale-helper\build.ps1   # → <repo>\bin\tailscale-helper.exe (GOOS=windows GOARCH=amd64)
```

`Rezident.spec` bundles `bin/tailscale-helper.exe` when present; `agentos.tailscale`
resolves it via `paths.resource_dir()/"bin"/…` (the frozen `_MEIPASS` or the repo
root in dev). A build without the helper still succeeds — the panel just reports the
helper missing.
