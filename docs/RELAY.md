# Relay — a public https/wss address for Rezident

Reach your Rezident from anywhere — phone on cellular, a laptop across the
country — without a static IP, a router port-forward, or exposing the box on the
LAN. A tiny reverse-tunnel client on your machine dials **out** to a cheap VPS you
control; the VPS forwards inbound public traffic back down that tunnel to
Rezident's loopback service. A Caddy reverse proxy on the VPS fronts everything
with automatic Let's Encrypt TLS, so `https`/`wss` work and the bearer token
never crosses plaintext.

> **This round ships the drop-in + docs only.** `backend/agentos/relay.py`
> (`start_relay()` / `shutdown_relay()`) is a dormant hook and **nothing
> activates without operator config**. With `relay:config.enabled = false` (the
> default) boot is byte-identical to today. Standing up the VPS below requires
> **no changes to the app** — you provision the server, then flip the desktop
> `relay:config` fields. Tailscale remains the simplest zero-VPS remote path; the
> relay is for when you want a plain public URL (e.g. to hand a phone a QR that
> works off any network).

```
  phone / laptop                    your VPS (public IP + domain)                 this machine
 ┌──────────────┐   https/wss   ┌──────────────────────────────────┐   tunnel   ┌───────────────┐
 │  Rezident    │ ───────────▶  │  Caddy :443  ──▶  rathole/frp     │ ◀───────── │ rathole/frpc  │
 │  companion   │  (Let's       │  (auto-TLS)      server :loopback │  (dials     │   client      │
 └──────────────┘   Encrypt)    └──────────────────────────────────┘   OUT)      │  ──▶ 127.0.0.1│
                                                                                 │      :8734    │
                                                                                 └───────────────┘
```

Two tunnel backends are supported; pick one. **rathole** is the default —
a single Rust binary, minimal config. **frp** is the mature, widely-deployed
alternative. The server config differs; the Caddy front and the desktop fields
are the same.

---

## 1. Provision a cheap VPS

Any $4–6/mo box works (Hetzner CX22, a DigitalOcean/Vultr/Linode nano, an Oracle
free-tier ARM instance). You need:

- a **public IPv4** (and ideally IPv6),
- a **domain or subdomain** you can point at it — e.g. `rez.example.com` — with
  an `A`/`AAAA` DNS record to the VPS IP (Let's Encrypt needs the name to
  resolve before it will issue),
- inbound **443** open (Caddy/TLS) and the tunnel's **control port** open
  (rathole `2333` or frp `7000` in the examples below),
- a non-root sudo user.

Everything below runs on the VPS unless noted. Lock SSH down first (key-only
auth, no root login) — this box is now internet-facing.

```bash
sudo apt update && sudo apt -y upgrade
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp        # Caddy (public TLS)
sudo ufw allow 2333/tcp       # rathole control port  (use 7000/tcp for frp)
sudo ufw enable
```

---

## 2a. Tunnel SERVER — rathole (default)

Install the single binary (grab the latest release for your arch from
`github.com/rapiz1/rathole`):

```bash
curl -L -o rathole.zip https://github.com/rapiz1/rathole/releases/latest/download/rathole-x86_64-unknown-linux-gnu.zip
unzip rathole.zip && sudo install -m 0755 rathole /usr/local/bin/rathole
```

`/etc/rathole/server.toml` — a public control port, plus one service whose
public bind is a **VPS-loopback port** (Caddy will front it, so it is NOT exposed
to the internet directly):

```toml
[server]
bind_addr = "0.0.0.0:2333"          # control port the client dials (open in ufw)

[server.services.rezident]
token = "PUT-A-LONG-RANDOM-SHARED-SECRET-HERE"   # must match the desktop relay token
bind_addr = "127.0.0.1:8734"        # tunneled loopback; Caddy reverse-proxies THIS
```

> The shared `token` here is the **tunnel** secret (authenticates the client to
> the tunnel server). It is unrelated to Rezident's bearer token, which continues
> to gate the app itself end-to-end.

Run it under systemd — `/etc/systemd/system/rathole.service`:

```ini
[Unit]
Description=rathole tunnel server
After=network-online.target

[Service]
ExecStart=/usr/local/bin/rathole /etc/rathole/server.toml
Restart=always
RestartSec=3
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rathole
```

## 2b. Tunnel SERVER — frp (alternative)

Install `frps` from `github.com/fatedier/frp/releases`. `/etc/frp/frps.toml`:

```toml
bindPort = 7000                      # control port the client dials (open in ufw)
auth.method = "token"
auth.token = "PUT-A-LONG-RANDOM-SHARED-SECRET-HERE"   # must match the desktop relay token

# Keep frp's own public proxy ports on loopback so only Caddy is internet-facing.
# The client requests remotePort = 8734 (see §4); bind it to loopback:
allowPorts = [{ start = 8734, single = 8734 }]
```

frp binds requested `remotePort`s on `0.0.0.0` by default. To keep the tunneled
service private (Caddy-only), either front it as below **and** firewall the port,
or set `proxyBindAddr = "127.0.0.1"` in `frps.toml` so proxies bind loopback.
Run `frps -c /etc/frp/frps.toml` under an equivalent systemd unit.

---

## 3. Caddy reverse proxy — automatic TLS + token redaction

Caddy fronts the tunneled loopback port with a real Let's Encrypt certificate, so
external clients speak `https`/`wss` and the bearer token is encrypted on the
wire. Install Caddy (`caddyserver.com/docs/install`), then `/etc/caddy/Caddyfile`:

```caddy
rez.example.com {
    # WebSockets (the /ws stream) upgrade transparently — no extra directive needed.
    reverse_proxy 127.0.0.1:8734

    # --- token redaction (REQUIRED) --------------------------------------------
    # The WS auth token rides the query string (/ws?token=...) because browsers
    # cannot set WebSocket request headers (backend auth.require_ws_token). Caddy's
    # access log would otherwise persist that live credential in plaintext. Strip
    # the query entirely from the logged URI — mirrors the server-side
    # logfilter.RedactTokenFilter, which scrubs ?token= from uvicorn's own logs.
    log {
        output file /var/log/caddy/rez.access.log
        format json
    }
}
```

Caddy's structured log records the request URI **with** its query. To guarantee
`?token=` never lands on disk, drop the query from the logged field. The robust,
version-stable way is a small log hook that rewrites the `uri`; the minimal,
always-available way is to log only the path by marking the query as a secret to
filter. Use the `filter` encoder to redact the `uri` field's query:

```caddy
rez.example.com {
    reverse_proxy 127.0.0.1:8734

    log {
        output file /var/log/caddy/rez.access.log
        format filter {
            wrap json
            # Replace anything after "?" in the request URI with "?token=REDACTED"
            # so the query — and the token it carries — is never written.
            request>uri query {
                delete token
            }
        }
    }
}
```

The `query { delete token }` filter removes the `token` parameter from the logged
URI before the line is written, so the access log shows `/ws` with no credential.
Keep it: without redaction, anyone who reads or is sent this log gets a live
token. (A token that already leaked should be rotated: delete `<data_dir>/token`
on this machine and restart to regenerate.)

Reload Caddy — it fetches the certificate on first request:

```bash
sudo systemctl reload caddy
```

Confirm from your laptop: `https://rez.example.com` should return the Rezident
login (a valid TLS cert, no warning) once the tunnel client (§4) is up.

---

## 4. Desktop `relay:config`

On this machine, set the `relay:config` key (a JSON object in the settings table,
mirroring the integration slots). Fields:

| field      | meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `enabled`  | master switch. **`false` by default → `start_relay()` no-ops.** Set `true` to activate.   |
| `endpoint` | `host:port` of the tunnel SERVER's control port — e.g. `rez.example.com:2333` (frp: `:7000`). |
| `token`    | the shared tunnel secret from §2 (rathole `default_token` / frp `auth.token`). NOT the bearer token. |
| `client`   | `"rathole"` (default) or `"frp"`.                                                          |
| `bin_path` | explicit path to the `rathole` / `frpc` executable. Blank → resolved on `PATH`.           |

Install the matching client binary on this machine (`rathole` or `frpc`) and
either put it on `PATH` or point `bin_path` at it. When enabled, `start_relay()`
generates the client TOML (forwarding the public endpoint to
`127.0.0.1:<settings.port>`), spawns the client through the same
window-suppressed subprocess path every other child uses, and health-waits for
the loopback service — all guarded, so a bad endpoint/token just logs a warning
and the app still runs. `shutdown_relay()` terminates the client on quit.

Finally, so the QR/pairing advertises the public URL instead of the loopback
default, the desktop passes `base_url = https://rez.example.com` to `/pair/start`
(pairing already supports a `base_url` override; the companion auto-upgrades
`https → wss`, so no client-side relay awareness is needed).

---

## 5. Verify

- With `relay:config.enabled = false` (default), Rezident boots exactly as
  before — `start_relay()` / `shutdown_relay()` are no-ops.
- With it enabled and the VPS up: the client connects, `https://rez.example.com`
  serves the login over TLS, pairing a phone off Wi-Fi (cellular) reaches the
  box, and `/var/log/caddy/rez.access.log` shows `/ws` requests with **no**
  `token=` value.

## Security notes

- **TLS is mandatory.** Never point clients at the tunnel's raw port — only at
  Caddy's `https`. The bearer/device tokens ride the `Authorization` header and
  the WS query string; both must be encrypted end-to-end.
- **Redact the access log** (§3). The WS token is in the query string by
  necessity (browsers can't set WS headers); the redaction filter is what keeps
  it out of any log you might export or attach to a bug report.
- **The VPS is now internet-facing.** Key-only SSH, a firewall, and unattended
  security upgrades. The tunnel server should expose only its control port + 443.
- **Rotate on leak.** A token seen in an un-redacted log is compromised: delete
  `<data_dir>/token` on this machine and restart to mint a fresh one, then
  re-pair devices.
