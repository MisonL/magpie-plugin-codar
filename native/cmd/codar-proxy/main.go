// codar-proxy speaks for the plugin's catalog, check-in and points requests
// the way the Codar desktop sidecar speaks for the desktop's.
//
// The desktop never calls the vendor from its Electron processes: gateway
// requests leave through a Go sidecar binary (Resources/bin/codar in the
// 0.3.13 package), and its provider client is
// internal/provider.newProviderHTTPClient, recovered from those binaries:
//
//	t := http.DefaultTransport.(*http.Transport).Clone()
//	t.DialContext = dialWithLastKnownAddress(t.DialContext)
//	if os.Getenv("CODAR_MODE") != "desktop" || providerAPIRequiresDirectConnection(base) {
//		t.Proxy = nil
//		if explicitProxyEnvironmentConfigured() { slog.Info("provider API direct connection enabled", "msg", "proxy_env_detected", ...) }
//	}
//
// dialWithLastKnownAddress substitutes (&net.Dialer{Timeout: 30s, KeepAlive:
// 30s}).DialContext when the one it is given is nil. Read off the macOS
// binary (0.3.13, Go 1.24.3): the nil check and the write are on Transport
// offset 0xb8 — DialContext, whose neighbour Proxy at 0xa8 is what the last
// branch zeroes — and the value written is the closure named
// newProviderHTTPClient.dialWithLastKnownAddress.func1. The function touches
// no other transport field: DialTLSContext (0xc8) stays nil, so TLS is
// net/http's own handshake, as on any Go client. (TLSClientConfig is not the
// function's either: Clone gives the copy DefaultTransport's non-nil one
// before the function runs.) The DefaultTransport clone already carries a
// non-nil DialContext (its own net.Dialer with the same 30s values), so the
// substitution is unreachable in practice; it is kept for the shape.
//
// On macOS 0.3.13 that is the whole function (Go 1.24.3, no DefaultGODEBUG,
// CGO_ENABLED=0). On Windows 0.3.13 (Go 1.26.7, `-gcflags=all=-N -l`) the
// function is the same — Clone, 0xb8, 0xa8 — except that it ends by wrapping
// the transport in internal/cloudnet.DesktopTransport, so this program follows
// the macOS route, whose surface a plugin can replicate exactly.
//
// The go.mod next to this file keeps the module at Go 1.24 for every target:
// on macOS and Linux that matches the sidecars (no DefaultGODEBUG), and on
// Windows it reproduces theirs exactly (the go 1.24 defaults are what a
// 1.26.7 toolchain bakes in for a 1.24 module), which matters because
// tlssecpmlkem=0 alone changes the ClientHello's group list.
// scripts/build-native.mjs checks each finished binary against the sidecar's
// own defaults rather than against "none".
//
// Usage: codar-proxy -listen unix|<tcp> -address <path|host:port> [-token <hex>] [-ready <file>]
//
// The plugin sends plain HTTP/1.1 over the socket or loopback port it started
// with requests the plugin itself wrote the credentials into; the proxy
// forwards each one to https://<Host><path>?<query> over the sidecar's
// transport and relays the answer. Only hosts in officialHosts are forwarded.
// In TCP mode every request must carry X-Codar-Proxy-Token with the token.
//
// What leaves is what the desktop's own requests carry: Host (the name alone:
// the sidecar's provider client is given https://<host> as its base, so no
// :443 is ever in its Host header), User-Agent, Accept-Encoding from the
// transport, and from the plugin only the headers in `forwarded`. Every other
// header the plugin or the host adds is dropped.
//
// The version the request travels over is whatever the server selects, as on
// the sidecar, and the UA follows it: Go's own transport offers ALPN
// [h2 http/1.1] and reads back the choice — against api.claw.speedai.com
// today that is HTTP/1.1 with User-Agent "Go-http-client/1.1"; against
// api.kuaipaper.com it is h2 with "Go-http-client/2.0". Both were captured on
// the wire from this binary and from the 0.3.17 sidecars, and match.
//
// The socket's mode is 0600 and it is removed on exit. When ready-file is
// given, the listener's JSON {"transport", "address", "token"} is written
// there once the listener is up and removed on exit. SIGTERM and SIGINT stop
// it; with a ready-file it also stops when stdin closes, the way the sidecar
// stops when the desktop it serves goes away.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// sidecarMode is the value the desktop gives CODAR_MODE.
const sidecarMode = "desktop"

// gatewayHost is the host providerAPIRequiresDirectConnection names.
const gatewayHost = "api.claw.speedai.com"

// officialHosts are the hosts the desktop's own code accepts (OFFICIAL_HOSTS
// in electron/cloud-network.cjs), the only ones this proxy forwards to.
var officialHosts = map[string]bool{
	"codar-web.speedai.com":  true,
	"api.claw.speedai.com":   true,
	"api.kuaipaper.com":      true,
	"test.api.kuaipaper.com": true,
}

// tokenHeader is how TCP-mode requests prove they come from the plugin.
const tokenHeader = "X-Codar-Proxy-Token"

// forwarded are the plugin headers a forwarded request may carry. A card
// request sends Authorization and Content-Type, and those two are all it ever
// has. A chat request is not the desktop's — the app talks to its sidecar in
// its own shape — and the vendor's Anthropic models authenticate with
// X-Api-Key and state Anthropic-Version, so a chat request that carried them
// would lose its credential and its protocol on the way out. A header the
// plugin did not send is not added: this is a list of what may pass, not what
// is written.
var forwarded = []string{"Authorization", "Content-Type", "X-Api-Key", "Anthropic-Version"}

// requestTimeout bounds the wait for a response head. After the head the body
// is not timed here: the plugin keeps its own silence bound and destroys the
// socket when it passes, and r.Context carries that to this request.
const requestTimeout = 2 * time.Minute

// headTimeout is requestTimeout for one handler. A variable so a test can
// drive the head bound without waiting two minutes for it.
var headTimeout = requestTimeout

func main() {
	log.SetFlags(0)
	log.SetPrefix("codar-proxy: ")

	listen := flag.String("listen", defaultListen(), "unix or tcp")
	address := flag.String("address", "", "socket path, or 127.0.0.1:0 for tcp")
	token := flag.String("token", "", "shared token for tcp mode (generated when empty)")
	ready := flag.String("ready", "", "file to publish the listener's address in")
	flag.Parse()

	if *address == "" {
		log.Fatalf("missing -address")
	}

	var ln net.Listener
	var err error
	network := strings.ToLower(*listen)
	switch network {
	case "unix":
		ln, err = listenUnix(*address)
	case "tcp":
		// The proxy answers on loopback only. It carries the vendor's
		// credential for the life of each request, and an address on any
		// other interface would offer that to the network; the plugin passes
		// 127.0.0.1:0, and this refuses anything else rather than trusting
		// its caller. 0.0.0.0:0 used to be accepted and reported [::]:port.
		if err := loopbackTCPAddress(*address); err != nil {
			log.Fatalf("%v", err)
		}
		ln, err = net.Listen("tcp", *address)
	default:
		log.Fatalf("unknown -listen %q", *listen)
	}
	if err != nil {
		log.Fatalf("listen %s: %v", network, err)
	}
	addr := ln.Addr().String()

	// log.Fatalf exits without running defers, so a startup failure after the
	// listener exists must remove what it created by hand: a socket left in
	// the temp directory would outlive the process that could not start.
	failStartup := func(format string, args ...any) {
		_ = ln.Close()
		if network == "unix" {
			_ = os.Remove(*address)
		}
		if *ready != "" {
			_ = os.Remove(*ready)
		}
		log.Fatalf(format, args...)
	}

	if network == "tcp" && *token == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			failStartup("token: %v", err)
		}
		*token = hex.EncodeToString(b)
	}

	if *ready != "" {
		// pid lets the host tell this proxy's live-but-wedged socket from a
		// dead one: a full accept queue answers ECONNREFUSED on macOS exactly
		// as a dead socket does (measured 2026-11-23), so only the process
		// itself can prove the listener is standing.
		info := map[string]string{"transport": network, "address": addr, "pid": strconv.Itoa(os.Getpid())}
		if network == "tcp" {
			info["token"] = *token
		}
		data, _ := json.Marshal(info)
		if err := os.WriteFile(*ready, data, 0o600); err != nil {
			failStartup("ready file %s: %v", *ready, err)
		}
	}

	server := &http.Server{
		Handler:           &forwarder{token: *token},
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	// Serve returns once the listener closes; the socket and ready file go
	// after that, so whatever waits on them sees the last of them.
	closed := make(chan struct{})
	stop := once(func() {
		_ = ln.Close()
		close(closed)
	})
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		stop()
	}()
	if *ready != "" {
		// The plugin owns this process: its stdin closes when the host ends.
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	err = server.Serve(ln)
	stop()
	<-closed
	if network == "unix" {
		_ = os.Remove(*address)
	}
	if *ready != "" {
		// The directory is the plugin's (it made it with mkdtemp and removes
		// it when this process exits). A plugin that was killed outright
		// never runs that exit handler, so its directory stayed behind —
		// empty once these two files go — for every such death. Removing an
		// empty directory is all that is safe here: a directory holding
		// anything else is not this proxy's to delete.
		_ = os.Remove(*ready)
		_ = os.Remove(filepath.Dir(*ready))
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		log.Printf("serve: %v", err)
		os.Exit(1)
	}
}

func defaultListen() string {
	if os.PathSeparator == '\\' {
		return "tcp"
	}
	return "unix"
}

// loopbackTCPAddress refuses a TCP listen address on anything but loopback.
// The proxy carries the vendor's credential for the life of each request, and
// the plugin's own caller passes 127.0.0.1:0; an address naming another
// interface (0.0.0.0:0, [::]:0, a LAN address) would offer that to the
// network, so it is refused here rather than trusted to the caller.
func loopbackTCPAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("tcp address %q: %v", address, err)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("tcp address %q is not loopback; the proxy listens on 127.0.0.1:0 only", address)
}

func listenUnix(path string) (net.Listener, error) {
	// A socket left by a killed run would make Listen fail.
	_ = os.Remove(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

// addressMap is a sync.Map keyed by host.
type addressMap struct {
	m sync.Map
}

func (a *addressMap) Load(host string) (string, bool) {
	v, ok := a.m.Load(host)
	if !ok {
		return "", false
	}
	return v.(string), true
}

func (a *addressMap) Store(host, address string) { a.m.Store(host, address) }

func once(f func()) func() {
	var s sync.Once
	return func() { s.Do(f) }
}

// lastAddresses is the sidecar's sync.Map from host to the address that host
// last answered on, so a failed lookup can fall back to it.
var lastAddresses addressMap

// newProviderTransport builds the sidecar's provider transport for base.
func newProviderTransport(base string) *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()

	original := t.DialContext
	if original == nil {
		original = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	t.DialContext = wrapLastKnownAddress(original)
	applyProxyPolicy(t, base)
	return t
}

// wrapLastKnownAddress is the sidecar's dialer: every successful dial of a
// named host records the address it answered on, and a later failed lookup of
// that host retries the recorded address before giving up.
func wrapLastKnownAddress(original func(context.Context, string, string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, splitErr := net.SplitHostPort(addr)
		named := splitErr == nil && net.ParseIP(host) == nil

		conn, err := original(ctx, network, addr)
		if err == nil {
			if named {
				if remote := conn.RemoteAddr(); remote != nil {
					lastAddresses.Store(host, remote.String())
				}
			}
			return conn, nil
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, err
		}
		if !named {
			return nil, err
		}
		if last, ok := lastAddresses.Load(host); ok {
			if conn, retryErr := original(ctx, network, last); retryErr == nil {
				log.Printf("provider host lookup failed; connected to its last address: host=%s err=%v", addr, err)
				return conn, nil
			}
		}
		log.Printf("provider host lookup failed and its last address is unreachable: host=%s err=%v", addr, err)
		return nil, err
	}
}

// applyProxyPolicy is the sidecar's proxy decision for base.
func applyProxyPolicy(t *http.Transport, base string) {
	if os.Getenv("CODAR_MODE") != sidecarMode || providerAPIRequiresDirectConnection(base) {
		t.Proxy = nil
		if explicitProxyEnvironmentConfigured() {
			log.Printf("provider API direct connection enabled: msg=proxy_env_detected host=%s", providerAPIHostname(base))
		}
	} else {
		// Off the gateway in desktop mode the sidecar hands its clone to
		// cloudnet.DesktopTransport, whose routes the desktop's cloud-network
		// settings supply and a plugin has none of. The clone is otherwise
		// what would have been used, so it goes as it is.
		log.Printf("provider API via the environment's proxy: host=%s", providerAPIHostname(base))
	}
}

// providerAPIRequiresDirectConnection reports whether base is the gateway.
func providerAPIRequiresDirectConnection(base string) bool {
	return providerAPIHostname(base) == gatewayHost
}

// providerAPIHostname reads base's host the way the sidecar does: trimmed,
// parsed, lower-cased, less a trailing dot.
func providerAPIHostname(base string) string {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
}

// proxyEnvFlags are the variables explicitProxyEnvironmentConfigured reads.
var proxyEnvFlags = []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"}

func explicitProxyEnvironmentConfigured() bool {
	for _, k := range proxyEnvFlags {
		if strings.TrimSpace(os.Getenv(k)) != "" {
			return true
		}
	}
	return false
}

// forwarder sends each request to the official host its Host header names.
//
// One client per host: newProviderHTTPClient is built for a base, and its
// proxy decision is that base's (the gateway goes direct, anything else in
// desktop mode keeps the environment's proxy). A single client built for the
// gateway would have answered every allowlisted host with the gateway's
// decision, quietly sending the others past HTTPS_PROXY.
type forwarder struct {
	token   string
	mu      sync.Mutex
	clients map[string]*http.Client
}

// clientFor is the provider client for one official host, built on first use.
func (f *forwarder) clientFor(host string) *http.Client {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.clients == nil {
		f.clients = make(map[string]*http.Client, len(officialHosts))
	}
	if c, ok := f.clients[host]; ok {
		return c
	}
	c := &http.Client{
		Transport:     newProviderTransport("https://" + host),
		CheckRedirect: checkRedirect,
	}
	f.clients[host] = c
	return c
}

// checkRedirect keeps a redirect inside the allowance the request started
// with. Go's default policy follows any Location, keeps Authorization for a
// same-domain or subdomain target, and would even follow an https → http
// downgrade: the four-host allowlist would hold for the first request only.
// A redirect is followed only on the host the request started on: the
// credential in `forwarded` belongs to that host, and Go's client copies
// X-Api-Key to any target at all (Authorization it keeps across subdomains),
// so a redirect to another official host would hand one service's credential
// to another. Anything else is returned to the caller as the answer it is.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("codar-proxy: too many redirects")
	}
	if req.URL.Scheme != "https" {
		return errors.New("codar-proxy: redirect leaves https")
	}
	// The first request is checked portless (officialURL), and a redirect that
	// keeps the host name but not the port is a different service.
	if req.URL.Port() != "" {
		return errors.New("codar-proxy: redirect names a port")
	}
	host := strings.TrimSuffix(strings.ToLower(req.URL.Hostname()), ".")
	if !officialHosts[host] {
		return errors.New("codar-proxy: redirect leaves the official hosts")
	}
	if len(via) > 0 && host != strings.TrimSuffix(strings.ToLower(via[0].URL.Hostname()), ".") {
		return errors.New("codar-proxy: redirect changes host")
	}
	return nil
}

func (f *forwarder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Constant time: the token is the only thing between another local process
	// and the vendor's API on a shared machine, and a byte-by-byte comparison
	// would say how much of a guess was right.
	if f.token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get(tokenHeader)), []byte(f.token)) != 1 {
		http.Error(w, "codar-proxy: bad token", http.StatusForbidden)
		return
	}
	host := strings.TrimSuffix(strings.ToLower(requestHost(r)), ".")
	if !officialHosts[host] {
		http.Error(w, "codar-proxy: host not allowed", http.StatusForbidden)
		return
	}

	// The request lives as long as the plugin's connection does. A chat answer
	// is an event stream and may keep arriving for as long as the model keeps
	// talking, so a deadline on the whole exchange would cut a long answer in
	// half; what is bounded is silence. requestTimeout covers the wait for a
	// response head, and every byte after it pushes the same bound forward.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	idle := time.AfterFunc(headTimeout, cancel)
	defer idle.Stop()

	// The URL is the sidecar's own shape: its provider client joins a request
	// path onto the base it was configured with (https://<host>), so net/http
	// writes Host as the name alone. Spelling the default port out here — as
	// https://<host>:443 — put `:443` in the Host header on every request,
	// which no official request carries. https already means 443.
	target := "https://" + host + r.URL.EscapedPath()
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, target, r.Body)
	if err != nil {
		http.Error(w, "codar-proxy: bad request", http.StatusBadGateway)
		return
	}
	if r.ContentLength >= 0 {
		req.ContentLength = r.ContentLength
	}
	// A Connection header on the request names further hop-by-hop fields
	// (RFC 7230 §6.1): they belong to this hop, whatever their names are, and
	// are not forwarded even when the name is on the list. The response side
	// is read the same way below.
	local := map[string]bool{}
	for _, line := range r.Header.Values("Connection") {
		for _, name := range strings.Split(line, ",") {
			if name = strings.TrimSpace(name); name != "" {
				local[http.CanonicalHeaderKey(name)] = true
			}
		}
	}
	for _, k := range forwarded {
		if local[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range r.Header.Values(k) {
			req.Header.Add(k, v)
		}
	}

	resp, err := f.clientFor(host).Do(req)
	if err != nil {
		// Two ways this context can be done. The plugin's own connection may
		// be gone: nothing is listening, and the handler has nothing to say.
		// Or the head watchdog fired, and the plugin is still waiting — a
		// handler that returns without writing a head makes net/http answer
		// 200 with an empty body, which reads as an answered request rather
		// than the silence it was.
		if r.Context().Err() != nil {
			return
		}
		if ctx.Err() != nil {
			http.Error(w, "codar-proxy: no answer in time", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, "codar-proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// A Connection header names further hop-by-hop fields (RFC 7230 §6.1):
	// those travel with this hop only, whatever their names are.
	drop := map[string]bool{}
	for _, line := range resp.Header.Values("Connection") {
		for _, name := range strings.Split(line, ",") {
			if name = strings.TrimSpace(name); name != "" {
				drop[http.CanonicalHeaderKey(name)] = true
			}
		}
	}
	for k, vs := range resp.Header {
		if isHop(k) || drop[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	// A chat answer is an event stream: the host shows each piece as it
	// arrives, and a buffered copy would turn token-by-token into all at
	// once after the model finishes. Flush the head before the body, then
	// after every write, so each read leaves the moment it was read.
	flush := func() {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	flush()
	// The head is here, so the wait is over. The plugin has its own silence
	// bound on the body (STREAM_IDLE_MS) and destroys the socket when it
	// passes, which cancels this request through r.Context; a second timer
	// here would have to guess the same number, and the one it had measured
	// the client's write instead (a slow reader looked like a dead vendor).
	idle.Stop()
	if _, err := io.Copy(&flushingWriter{w: w, flush: flush}, resp.Body); err != nil {
		// The vendor stopped before it said it was done. Go's server would
		// still close a chunked body with its terminal chunk on the way out,
		// and the reader would take a cut answer for a complete one — a chat
		// stream would end mid-sentence with no error. Aborting the handler
		// closes the connection without that ending, which is the only way
		// left to say "this was truncated".
		panic(http.ErrAbortHandler)
	}
}

// flushingWriter flushes after each write, so a rewritten stream keeps the
// cadence the vendor sent it with.
type flushingWriter struct {
	w     io.Writer
	flush func()
}

func (f *flushingWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	f.flush()
	return n, err
}

// requestHost returns the host r names, without a port.
func requestHost(r *http.Request) string {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
}

// hopHeaders are what a proxy must not forward (RFC 7230 §6.1).
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func isHop(k string) bool {
	for _, h := range hopHeaders {
		if strings.EqualFold(k, h) {
			return true
		}
	}
	return false
}
