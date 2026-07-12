// Command tailscale-helper is a tiny embedded Tailscale node (tsnet) that Rezident
// bundles for out-of-box remote access. It joins the user's tailnet as its OWN
// userspace node — no wintun driver, no admin prompt — and reverse-proxies the
// tailnet to the loopback FastAPI server (127.0.0.1:8734). Rezident manages it as
// a child process (see backend/agentos/tailscale.py) and reads the structured
// status it prints to stdout (one JSON object per line) to drive the Connect UI
// and to advertise the tailnet address during phone pairing.
//
// The Python side never has to parse Tailscale's own logs: this emits its own
// {state, auth_url, ip, dns, error} envelope on every state change.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

type status struct {
	State   string `json:"state"`
	AuthURL string `json:"auth_url,omitempty"`
	IP      string `json:"ip,omitempty"`
	DNS     string `json:"dns,omitempty"`
	Error   string `json:"error,omitempty"`
}

var emitMu sync.Mutex

func emit(s status) {
	emitMu.Lock()
	defer emitMu.Unlock()
	b, _ := json.Marshal(s)
	fmt.Fprintln(os.Stdout, string(b))
}

func fatal(msg string) {
	emit(status{State: "Error", Error: msg})
	os.Exit(1)
}

func main() {
	dataDir := flag.String("data-dir", "", "tsnet state dir (required; persists node keys so there is no re-auth per boot)")
	target := flag.String("target", "127.0.0.1:8734", "loopback address to reverse-proxy the tailnet to")
	hostname := flag.String("hostname", "rezident", "tailnet node hostname (MagicDNS name)")
	port := flag.Int("port", 8734, "tailnet port to listen on")
	authKey := flag.String("authkey", "", "optional tailscale auth key (headless); omit for interactive auth-URL login")
	flag.Parse()

	if *dataDir == "" {
		fatal("--data-dir is required")
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		fatal("cannot create data-dir: " + err.Error())
	}

	srv := &tsnet.Server{
		Dir:      *dataDir,
		Hostname: *hostname,
		Logf:     func(string, ...any) {}, // quiet Tailscale's own logs; we emit structured status
	}
	if *authKey != "" {
		srv.AuthKey = *authKey
	}
	defer srv.Close()

	if err := srv.Start(); err != nil {
		fatal("tsnet start: " + err.Error())
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fatal("localclient: " + err.Error())
	}

	ctx := context.Background()

	// Status watcher: poll the backend and emit our envelope whenever the
	// (state, auth_url, ip) tuple changes, so the Python watcher sees each
	// transition. tsnet auto-runs StartLoginInteractive when a login is needed,
	// which populates AuthURL — we just surface it.
	go func() {
		var last string
		for {
			st, err := lc.StatusWithoutPeers(ctx)
			if err == nil && st != nil {
				s := status{State: string(st.BackendState)}
				s.AuthURL = st.AuthURL
				if len(st.TailscaleIPs) > 0 {
					s.IP = st.TailscaleIPs[0].String()
				}
				if st.Self != nil && st.Self.DNSName != "" {
					s.DNS = strings.TrimSuffix(st.Self.DNSName, ".")
				}
				key := s.State + "|" + s.AuthURL + "|" + s.IP
				if key != last {
					emit(s)
					last = key
				}
			}
			time.Sleep(1 * time.Second)
		}
	}()

	// Reverse-proxy the tailnet listener to the loopback server. httputil's proxy
	// transparently handles WebSocket upgrades (the /ws channel) since Go 1.12.
	targetURL := &url.URL{Scheme: "http", Host: *target}
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	origDirector := proxy.Director
	proxy.Director = func(r *http.Request) {
		origDirector(r)
		r.Host = targetURL.Host // present loopback's own Host to the FastAPI server
	}

	// Listen on the tailnet. srv.Listen blocks until the node is up (authenticated);
	// the watcher goroutine surfaces the auth URL meanwhile.
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		fatal("tailnet listen: " + err.Error())
	}
	defer ln.Close()

	if err := http.Serve(ln, proxy); err != nil {
		fatal("serve: " + err.Error())
	}
}
