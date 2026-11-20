package main

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestProviderTransportProxyIsDroppedForTheGateway checks the sidecar's
// proxy decision: the default transport keeps ProxyFromEnvironment, and for
// the gateway host (or outside the desktop) Proxy is nil.
func TestProviderTransportProxyIsDroppedForTheGateway(t *testing.T) {
	t.Setenv("CODAR_MODE", "desktop")
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("ALL_PROXY", "")
	t.Setenv("http_proxy", "")
	t.Setenv("https_proxy", "")
	t.Setenv("all_proxy", "")

	if tr := newProviderTransport("https://api.claw.speedai.com"); tr.Proxy != nil {
		t.Fatal("gateway transport keeps a proxy function")
	}
	// The sidecar rewrites DialContext alone: it never sets a TLS dial hook,
	// and the clone it starts from is http.DefaultTransport's.
	clone := http.DefaultTransport.(*http.Transport).Clone()
	if clone.DialTLSContext != nil || !clone.ForceAttemptHTTP2 || clone.TLSClientConfig == nil {
		t.Fatal("the Go 1.24 default transport no longer looks like http.DefaultTransport")
	}
	if tr := newProviderTransport("https://api.claw.speedai.com"); tr.DialTLSContext != nil {
		t.Fatal("the proxy set a TLS dial hook; the sidecar leaves DialTLSContext nil")
	}

	other := newProviderTransport("https://api.kuaipaper.com")
	if other.Proxy == nil {
		t.Fatal("a non-gateway host in desktop mode lost its proxy function")
	}
	if other.DialTLSContext != nil {
		t.Fatal("TLS must be net/http's: the sidecar leaves DialTLSContext nil")
	}

	t.Setenv("CODAR_MODE", "")
	if tr := newProviderTransport("https://api.kuaipaper.com"); tr.Proxy != nil {
		t.Fatal("outside desktop mode the proxy function should be dropped")
	}
}

// TestProviderTransportDialsTheLastKnownAddress checks the fallback dialer:
// a failed lookup for a named host retries the address it last answered on.
func TestProviderTransportDialsTheLastKnownAddress(t *testing.T) {
	t.Setenv("CODAR_MODE", "desktop")
	tr := newProviderTransport("https://api.claw.speedai.com")
	if tr.DialContext == nil {
		t.Fatal("DialContext is nil; the sidecar wraps it in dialWithLastKnownAddress")
	}

	var asked []string
	original := func(ctx context.Context, network, addr string) (net.Conn, error) {
		asked = append(asked, addr)
		if addr == "api.claw.speedai.com:443" {
			return nil, &net.DNSError{Err: "no such host", Name: "api.claw.speedai.com"}
		}
		if addr == "203.0.113.7:443" {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
		}
		client, server := net.Pipe()
		go func() { server.Close() }()
		return client, nil
	}
	lastAddresses = addressMap{}
	lastAddresses.Store("api.claw.speedai.com", "198.18.2.59:4443")
	dialCtx := wrapLastKnownAddress(original)
	conn, err := dialCtx(context.Background(), "tcp", "api.claw.speedai.com:443")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.Close()
	if len(asked) != 2 || asked[0] != "api.claw.speedai.com:443" || asked[1] != "198.18.2.59:4443" {
		t.Fatalf("dialed %v, want the host then its last address", asked)
	}

	// A literal address has no lookup to retry.
	asked = nil
	if _, err := dialCtx(context.Background(), "tcp", "203.0.113.7:443"); err == nil {
		t.Fatal("a literal address with no last address should fail")
	}
	if len(asked) != 1 {
		t.Fatalf("dialed %v for a literal address, want one attempt", asked)
	}
	lastAddresses = addressMap{}
	if _, err := dialCtx(context.Background(), "tcp", "api.claw.speedai.com:443"); err == nil || len(asked) != 2 {
		t.Fatalf("without a last address the dial should fail once, asked %v", asked)
	}
}

// TestForwardedRequestCarriesOnlyTheDesktopsHeaders checks what leaves the
// proxy: Go's own Host, User-Agent and Accept-Encoding, the plugin's
// Authorization and Content-Type, and nothing else the plugin or host added.
func TestForwardedRequestCarriesOnlyTheDesktopsHeaders(t *testing.T) {
	type seen struct {
		method, path, query, host string
		header                    http.Header
		body                      string
	}
	got := make(chan seen, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Host, r.Header.Clone(), string(body)}
		w.Header().Set("Content-Type", "application/json")
		// a Connection header names one more field of this hop only
		w.Header().Set("Connection", "X-Leak")
		w.Header().Set("X-Leak", "synthetic")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	tr := newProviderTransport("https://api.claw.speedai.com")
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
	// the forwarder's client map, preseeded: this test's escape hatch is a TLS
	// dial hook to the local test server, which the production construction
	// does not have
	f := &forwarder{clients: map[string]*http.Client{"api.claw.speedai.com": {Transport: tr}}}

	req := httptest.NewRequest("POST", "http://api.claw.speedai.com/v1/daily-sign?tz=Asia%2FShanghai", strings.NewReader(`{"a":1}`))
	req.Host = "api.claw.speedai.com"
	req.Header.Set("Authorization", "Bearer test")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Stagehand/9")
	req.Header.Set("X-Foo", "no")
	req.Header.Set("X-Magpie-Session", "no")
	req.Header.Set("Accept", "*/*")
	rec := httptest.NewRecorder()
	f.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	s := <-got
	if s.method != "POST" || s.path != "/v1/daily-sign" || s.query != "tz=Asia%2FShanghai" || s.body != `{"a":1}` {
		t.Fatalf("upstream saw %s %s?%s body %q", s.method, s.path, s.query, s.body)
	}
	keep := map[string]bool{"Host": true, "User-Agent": true, "Accept-Encoding": true, "Authorization": true, "Content-Type": true, "Content-Length": true}
	for name := range s.header {
		if !keep[http.CanonicalHeaderKey(name)] {
			t.Errorf("upstream saw header %q the desktop never sends", name)
		}
	}
	if ua := s.header.Get("User-Agent"); ua != "Go-http-client/1.1" {
		t.Errorf("User-Agent %q, want Go-http-client/1.1", ua)
	}
	// The sidecar's provider client builds its URL from the base it was
	// given (https://api.claw.speedai.com) plus the request path, so Host
	// carries the name alone; a :443 there is a port no official request has.
	if s.host != "api.claw.speedai.com" {
		t.Errorf("Host %q, want the vendor's name without its default port", s.host)
	}
	if auth := s.header.Get("Authorization"); auth != "Bearer test" {
		t.Errorf("Authorization %q, want the plugin's", auth)
	}
	if ae := s.header.Get("Accept-Encoding"); ae == "" {
		t.Error("Accept-Encoding missing; the transport should add it")
	}
	if leak := rec.Header().Get("X-Leak"); leak != "" {
		t.Errorf("response carried %q, named by Connection as hop-by-hop", leak)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q, want the upstream's", ct)
	}
}

// TestForwardedRequestDropsWhatTheRequestNamesHopByHop checks the other side
// of the Connection rule: a field an incoming Connection header names is for
// this hop only, even when its name is on the forwarded list. Another local
// process with the token could otherwise say `Connection: Authorization` and
// have a value the plugin meant for the proxy reach the vendor.
func TestForwardedRequestDropsWhatTheRequestNamesHopByHop(t *testing.T) {
	got := make(chan http.Header, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Clone()
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	tr := newProviderTransport("https://api.claw.speedai.com")
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
	f := &forwarder{clients: map[string]*http.Client{"api.claw.speedai.com": {Transport: tr}}}

	req := httptest.NewRequest("GET", "http://api.claw.speedai.com/v1/gettoken", nil)
	req.Host = "api.claw.speedai.com"
	req.Header.Set("Authorization", "Bearer local-only")
	req.Header.Set("X-Api-Key", "sent")
	req.Header.Set("Connection", "Authorization")
	rec := httptest.NewRecorder()
	f.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	s := <-got
	if a := s.Get("Authorization"); a != "" {
		t.Errorf("Authorization %q reached the vendor although the request named it hop-by-hop", a)
	}
	if k := s.Get("X-Api-Key"); k != "sent" {
		t.Errorf("X-Api-Key %q: a field the request did not name must still pass", k)
	}
}

// TestForwardedRequestCarriesTheChatCredentials checks the one case the
// desktop's own requests never exercise: a chat request to an Anthropic model,
// which authenticates with X-Api-Key and states Anthropic-Version. Forwarding
// only Authorization and Content-Type would send it with no credential.
func TestForwardedRequestCarriesTheChatCredentials(t *testing.T) {
	got := make(chan http.Header, 1)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Clone()
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	tr := newProviderTransport("https://api.claw.speedai.com")
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}
	f := &forwarder{clients: map[string]*http.Client{"api.claw.speedai.com": {Transport: tr}}}

	req := httptest.NewRequest("POST", "http://api.claw.speedai.com/v1/messages", strings.NewReader(`{}`))
	req.Host = "api.claw.speedai.com"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", "sk-ant")
	req.Header.Set("Anthropic-Version", "2023-06-01")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "Bun/1")
	rec := httptest.NewRecorder()
	f.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	s := <-got
	if key := s.Get("X-Api-Key"); key != "sk-ant" {
		t.Errorf("X-Api-Key %q, want the plugin's", key)
	}
	if v := s.Get("Anthropic-Version"); v != "2023-06-01" {
		t.Errorf("Anthropic-Version %q, want the plugin's", v)
	}
	if a := s.Get("Accept"); a != "" {
		t.Errorf("Accept %q reached the vendor; only the forwarded list may pass", a)
	}
	if ua := s.Get("User-Agent"); ua != "Go-http-client/1.1" {
		t.Errorf("User-Agent %q, want Go's", ua)
	}
}

// TestAStreamedAnswerIsFlushedAsItArrives checks the property a chat answer
// depends on: the head and each piece leave the proxy before the vendor has
// finished, so the host can show the answer as it is written rather than all
// at once when the vendor stops.
func TestAStreamedAnswerIsFlushedAsItArrives(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: second\n\n"))
		w.(http.Flusher).Flush()
	}))
	defer upstream.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	f := &forwarder{}
	client := f.clientFor("api.claw.speedai.com")
	tr := client.Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	// the forwarder behind a real server: a Recorder would hold the whole body
	front := httptest.NewServer(f)
	defer front.Close()

	// the forwarder picks its target from the request's Host, so the test's own
	// connection names an official host and the socket still goes to the front
	req, err := http.NewRequest("GET", front.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "api.claw.speedai.com"
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	// the first piece has to arrive while the vendor is still holding the rest:
	// release stays closed until it does, so a buffered proxy cannot pass
	buf := make([]byte, 64)
	n, err := io.ReadFull(resp.Body, buf[:12])
	if err != nil {
		t.Fatalf("the first piece never arrived: %v", err)
	}
	if string(buf[:n]) != "data: first\n" {
		t.Fatalf("first piece %q", string(buf[:n]))
	}
	close(release)
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read the rest: %v", err)
	}
	if want := "\ndata: second\n\n"; string(rest) != want {
		t.Fatalf("rest %q, want %q", string(rest), want)
	}
}

// TestForwarderDoesNotFollowARedirectOffTheOfficialHosts exercises the
// policy where it matters: on the client the forwarder itself builds, reached
// through clientFor. Without a CheckRedirect the Go client would follow a 302
// to another https host (and keep Authorization for a subdomain of the first),
// so the answer would come from somewhere the allowlist never approved.
//
// The test must not preseed the client map: a client built here would carry its
// own CheckRedirect and keep passing after clientFor stopped wiring one up.
func TestForwarderDoesNotFollowARedirectOffTheOfficialHosts(t *testing.T) {
	// Both are https, so the test's dial hook sees them; the second is what a
	// default policy would treat as the same domain and send Authorization to.
	for _, target := range []string{
		"https://evil.example/collect",
		"https://evil.api.claw.speedai.com/collect",
	} {
		t.Run(target, func(t *testing.T) {
			var mu sync.Mutex
			var paths []string
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				paths = append(paths, r.URL.Path)
				mu.Unlock()
				if r.URL.Path == "/start" {
					http.Redirect(w, r, target, http.StatusFound)
					return
				}
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer upstream.Close()

			f := &forwarder{}
			// clientFor is the production construction; the hook is this test's
			// only escape hatch, and it goes on the transport clientFor returned.
			client := f.clientFor("api.claw.speedai.com")
			tr := client.Transport.(*http.Transport)
			tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
				conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
				if err != nil {
					return nil, err
				}
				tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
				if err := tlsConn.HandshakeContext(ctx); err != nil {
					conn.Close()
					return nil, err
				}
				return tlsConn, nil
			}

			req := httptest.NewRequest("GET", "http://api.claw.speedai.com/start", nil)
			req.Host = "api.claw.speedai.com"
			rec := httptest.NewRecorder()
			f.ServeHTTP(rec, req)

			mu.Lock()
			seen := append([]string(nil), paths...)
			mu.Unlock()
			if len(seen) != 1 {
				t.Fatalf("the redirect was followed: upstream saw %v", seen)
			}
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("a refused redirect answered %d, want 502 from the proxy", rec.Code)
			}
		})
	}
}

// TestCheckRedirectKeepsTheAllowance checks that a redirect cannot leave the
// official hosts or https, the two things the first request was checked for.
func TestCheckRedirectKeepsTheAllowance(t *testing.T) {
	mk := func(raw string) *http.Request {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		return &http.Request{URL: u}
	}
	if err := checkRedirect(mk("https://api.claw.speedai.com/v1/codar/models"), nil); err != nil {
		t.Fatalf("an official https redirect was refused: %v", err)
	}
	for _, raw := range []string{
		"http://api.claw.speedai.com/collect",
		"https://evil.api.claw.speedai.com/collect",
		"https://evil.example/collect",
		"file:///etc/passwd",
		// A port is not the host it names: the first request's URL is checked
		// portless, and a redirect that keeps the name but changes the service
		// is a different place to send the credential.
		"https://api.claw.speedai.com:8443/collect",
		"https://api.claw.speedai.com:80/collect",
	} {
		if err := checkRedirect(mk(raw), nil); err == nil {
			t.Errorf("redirect to %s was followed", raw)
		}
	}
	if err := checkRedirect(mk("https://api.claw.speedai.com/x"), make([]*http.Request, 5)); err == nil {
		t.Error("a sixth hop was followed")
	}
	// A redirect to another official host is where a credential hand-off
	// starts: Go's client copies X-Api-Key to any target and keeps
	// Authorization across subdomains, so only the first host may be
	// followed. A same-host redirect (the vendor moving a path) still is.
	first := mk("https://api.claw.speedai.com/v1/codar/models")
	if err := checkRedirect(mk("https://test.api.kuaipaper.com/x"), []*http.Request{first}); err == nil {
		t.Error("a redirect to another official host was followed")
	}
	if err := checkRedirect(mk("https://api.claw.speedai.com/chat/completions"), []*http.Request{first}); err != nil {
		t.Errorf("a same-host redirect was refused: %v", err)
	}
}

// TestForwarderKeepsTheCredentialOnItsOwnHost is the redirect above at the
// level that matters: what the second host actually receives. A redirect from
// api.claw.speedai.com to another official host must not be followed at all,
// so the credential never leaves the host it belongs to.
func TestForwarderKeepsTheCredentialOnItsOwnHost(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Host+" "+r.URL.Path+" key="+r.Header.Get("X-Api-Key"))
		mu.Unlock()
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "https://test.api.kuaipaper.com/collect", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	f := &forwarder{}
	client := f.clientFor("api.claw.speedai.com")
	tr := client.Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	req := httptest.NewRequest("GET", "http://api.claw.speedai.com/start", nil)
	req.Host = "api.claw.speedai.com"
	req.Header.Set("X-Api-Key", "synthetic-key")
	rec := httptest.NewRecorder()
	f.ServeHTTP(rec, req)

	mu.Lock()
	got := append([]string(nil), seen...)
	mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("the redirect was followed; the second host saw %v", got)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("a refused cross-host redirect answered %d, want 502", rec.Code)
	}
	for _, line := range got {
		if strings.Contains(line, "synthetic-key") && !strings.HasPrefix(line, "api.claw.speedai.com ") {
			t.Fatalf("a credential reached another host: %v", got)
		}
	}
}

// TestTheTCPListenerIsLoopbackOnly pins the address the proxy will answer on:
// the plugin passes 127.0.0.1:0, and anything on another interface would put
// the credential-bearing listener on the network.
func TestTheTCPListenerIsLoopbackOnly(t *testing.T) {
	for _, address := range []string{"127.0.0.1:0", "127.0.0.1:44567", "[::1]:0", "localhost:0"} {
		if err := loopbackTCPAddress(address); err != nil {
			t.Errorf("%s was refused: %v", address, err)
		}
	}
	for _, address := range []string{"0.0.0.0:0", "[::]:0", ":0", "192.0.2.1:0", "example.com:0", "127.0.0.1"} {
		if err := loopbackTCPAddress(address); err == nil {
			t.Errorf("%s was accepted", address)
		}
	}
}

// TestForwarderRefusesOtherHostsAndBadTokens checks the front door.
func TestForwarderRefusesOtherHostsAndBadTokens(t *testing.T) {
	f := &forwarder{token: "s3cret"}

	req := httptest.NewRequest("GET", "http://evil.example/v1/codar/models", nil)
	req.Header.Set(tokenHeader, "s3cret") // a right token must not excuse the host
	rec := httptest.NewRecorder()
	f.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unknown host answered %d, want 403", rec.Code)
	}

	req = httptest.NewRequest("GET", "http://api.claw.speedai.com/v1/codar/models", nil)
	req.Header.Set(tokenHeader, "wrong")
	rec = httptest.NewRecorder()
	f.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad token answered %d, want 403", rec.Code)
	}

	f = &forwarder{
		token: "s3cret",
		clients: map[string]*http.Client{"api.claw.speedai.com": {Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial refused")
		})}},
	}
	req = httptest.NewRequest("GET", "http://api.claw.speedai.com/v1/codar/models", nil)
	req.Header.Set(tokenHeader, "s3cret")
	rec = httptest.NewRecorder()
	f.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("upstream failure answered %d, want 502", rec.Code)
	}
}

// TestOfficialHostsCoverEveryReportedHost checks that each host the desktop's
// cloud-network controller calls official is one this proxy forwards, and
// that nothing else is.
func TestOfficialHostsCoverEveryReportedHost(t *testing.T) {
	// OFFICIAL_HOSTS in the desktop's electron/cloud-network.cjs, 0.3.13.
	for _, h := range []string{"codar-web.speedai.com", "api.claw.speedai.com", "api.kuaipaper.com", "test.api.kuaipaper.com"} {
		if !officialHosts[h] {
			t.Errorf("%s is official for the desktop but not forwarded here", h)
		}
	}
	if len(officialHosts) != 4 {
		t.Errorf("officialHosts has %d entries, want the desktop's 4", len(officialHosts))
	}
	if officialHosts["evil.example"] || officialHosts["api.claw.speedai.com.evil.example"] {
		t.Error("a non-official host is forwarded")
	}
}

// TestProviderAPIHostname checks the host reading the sidecar uses.
func TestProviderAPIHostname(t *testing.T) {
	cases := map[string]string{
		"https://api.claw.speedai.com":         "api.claw.speedai.com",
		"  HTTPS://API.Claw.SpeedAI.com./v1 ":  "api.claw.speedai.com",
		"https://api.claw.speedai.com:8443/v1": "api.claw.speedai.com",
		"not a url":                            "",
	}
	for in, want := range cases {
		if got := providerAPIHostname(in); got != want {
			t.Errorf("providerAPIHostname(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRequestHost checks the Host reading of the front door.
func TestRequestHost(t *testing.T) {
	for host, want := range map[string]string{"api.claw.speedai.com": "api.claw.speedai.com", "api.claw.speedai.com:443": "api.claw.speedai.com", "[::1]:80": "::1"} {
		req := httptest.NewRequest("GET", "http://x/", nil)
		req.Host = host
		if got := requestHost(req); got != want {
			t.Errorf("requestHost(%q) = %q, want %q", host, got, want)
		}
	}
}

// TestForwarderBuildsOneClientPerHost checks the proxy decision is each
// host's own: the gateway goes direct, everything else keeps the
// environment's proxy in desktop mode. A single client built for the gateway
// answered every host with the gateway's decision.
func TestForwarderBuildsOneClientPerHost(t *testing.T) {
	t.Setenv("CODAR_MODE", "desktop")
	t.Setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
	t.Setenv("https_proxy", "http://proxy.invalid:3128")

	f := &forwarder{}
	gw := f.clientFor("api.claw.speedai.com")
	other := f.clientFor("api.kuaipaper.com")
	if gw == other {
		t.Fatal("one client answered two hosts; the proxy decision would be the gateway's for both")
	}
	if gw.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("the gateway client kept a proxy function")
	}
	if other.Transport.(*http.Transport).Proxy == nil {
		t.Fatal("a non-gateway client lost the environment's proxy")
	}
	if again := f.clientFor("api.kuaipaper.com"); again != other {
		t.Fatal("a second request for the same host built another client")
	}
}

// helpers

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

var _ = os.Getenv
var _ = time.Second
var _ = url.Parse

// TestProviderTransportKeepsTheEnvironmentProxyOutsideTheGateway checks the
// other half of the sidecar's decision: off the gateway in desktop mode the
// clone keeps ProxyFromEnvironment (the desktop's cloud-network routes are
// not a plugin's to supply).
func TestProviderTransportKeepsTheEnvironmentProxyOutsideTheGateway(t *testing.T) {
	t.Setenv("CODAR_MODE", "desktop")
	tr := newProviderTransport("https://api.kuaipaper.com")
	if tr.Proxy == nil {
		t.Fatal("a non-gateway host in desktop mode lost ProxyFromEnvironment")
	}
	if tr.DialContext == nil || tr.DialTLSContext != nil {
		t.Fatal("the clone lost the sidecar's transport settings")
	}
}

// TestProxyEnvFlagsAreTheSidecars checks the variable names and that a value
// of spaces alone does not count (the sidecar trims before comparing).
func TestProxyEnvFlagsAreTheSidecars(t *testing.T) {
	for _, k := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(k, "")
	}
	if explicitProxyEnvironmentConfigured() {
		t.Fatal("empty variables read as a proxy configuration")
	}
	t.Setenv("https_proxy", "   ")
	if explicitProxyEnvironmentConfigured() {
		t.Fatal("a blank https_proxy read as a proxy configuration")
	}
	t.Setenv("all_proxy", "socks5://127.0.0.1:1080")
	if !explicitProxyEnvironmentConfigured() {
		t.Fatal("all_proxy was not read")
	}
}

// TestLastKnownAddressIsRecordedOnASuccessfulDial checks the half that makes
// the fallback real: the sidecar stores where a host answered each time it
// answered, and a later failed lookup dials that record.
func TestLastKnownAddressIsRecordedOnASuccessfulDial(t *testing.T) {
	lastAddresses = addressMap{}
	remote := &net.TCPAddr{IP: net.IPv4(198, 18, 2, 59), Port: 443}
	var asked []string
	original := func(ctx context.Context, network, addr string) (net.Conn, error) {
		asked = append(asked, addr)
		if addr == "api.claw.speedai.com:443" {
			return &connWithRemote{remote: remote}, nil
		}
		if addr == remote.String() {
			return &connWithRemote{remote: remote}, nil
		}
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("refused")}
	}
	dial := wrapLastKnownAddress(original)
	c, err := dial(context.Background(), "tcp", "api.claw.speedai.com:443")
	if err != nil {
		t.Fatalf("successful dial: %v", err)
	}
	c.Close()
	if got, ok := lastAddresses.Load("api.claw.speedai.com"); !ok || got != remote.String() {
		t.Fatalf("recorded %q, want %q", got, remote.String())
	}

	// the lookup now fails: the recorded address is the one retried
	asked = nil
	failing := func(ctx context.Context, network, addr string) (net.Conn, error) {
		asked = append(asked, addr)
		if addr == remote.String() {
			return &connWithRemote{remote: remote}, nil
		}
		return nil, &net.DNSError{Err: "no such host", Name: "api.claw.speedai.com"}
	}
	if _, err := wrapLastKnownAddress(failing)(context.Background(), "tcp", "api.claw.speedai.com:443"); err != nil {
		t.Fatalf("fallback dial: %v (asked %v)", err, asked)
	}
	if len(asked) != 2 || asked[1] != remote.String() {
		t.Fatalf("asked %v, want the host then its recorded address", asked)
	}

	// a literal address is not recorded
	asked = nil
	_, _ = dial(context.Background(), "tcp", "203.0.113.7:443")
	if _, ok := lastAddresses.Load("203.0.113.7"); ok {
		t.Fatal("a literal address was recorded")
	}
}

// connWithRemote is a net.Conn that only names its peer.
type connWithRemote struct{ remote net.Addr }

func (c *connWithRemote) Read([]byte) (int, error)        { return 0, io.EOF }
func (c *connWithRemote) Write(b []byte) (int, error)     { return len(b), nil }
func (c *connWithRemote) Close() error                    { return nil }
func (c *connWithRemote) LocalAddr() net.Addr             { return c.remote }
func (c *connWithRemote) RemoteAddr() net.Addr            { return c.remote }
func (c *connWithRemote) SetDeadline(time.Time) error     { return nil }
func (c *connWithRemote) SetReadDeadline(time.Time) error { return nil }
func (c *connWithRemote) SetWriteDeadline(time.Time) error {
	return nil
}

// TestATruncatedUpstreamAbortsTheConnection checks the one thing a proxy can
// still say with HTTP/1.1 when the vendor stops mid-body: nothing. Go's server
// would otherwise close a chunked body with its terminal chunk, and the reader
// would take a cut answer for a complete one. Aborting the handler drops the
// connection instead, which the client sees as an error.
func TestATruncatedUpstreamAbortsTheConnection(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		// the vendor dies here, with no terminal chunk and no close_notify
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	defer upstream.Close()

	f := &forwarder{}
	tr := f.clientFor("api.claw.speedai.com").Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	front := httptest.NewServer(f)
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "api.claw.speedai.com"
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 64)
	n, err := io.ReadFull(resp.Body, buf[:13])
	if err != nil {
		t.Fatalf("the first piece never arrived: %v", err)
	}
	if string(buf[:n]) != "data: first\n\n" {
		t.Fatalf("first piece %q", string(buf[:n]))
	}
	// the rest never comes: reading on must fail, not end cleanly
	_, err = io.ReadAll(resp.Body)
	if err == nil {
		t.Fatal("a truncated answer was read as a complete one")
	}
}

// TestAClientThatLeavesStopsTheBodyCopy checks the mechanism the head-time
// idle.Stop relies on: after the head, silence is bounded by the plugin, which
// destroys its socket; that cancels this request's context, and the context is
// what ends a body copy stuck on a vendor that stopped talking. If it did not,
// every abandoned chat would leave a handler and a vendor connection behind.
func TestAClientThatLeavesStopsTheBodyCopy(t *testing.T) {
	stalled := make(chan struct{})
	upstreamGone := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(upstreamGone)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		// nothing more is said; the fallback keeps a broken proxy's handler
		// from pinning this server's Close forever, and is long past the 5s
		// the test allows the copy to end in
		select {
		case <-stalled:
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	// the release comes before the close: Close waits for its handlers, and
	// this one is waiting on the channel
	defer func() {
		close(stalled)
		upstream.Close()
	}()

	f := &forwarder{}
	tr := f.clientFor("api.claw.speedai.com").Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	front := httptest.NewServer(f)
	defer front.Close()

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", front.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "api.claw.speedai.com"
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 13)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("the first piece never arrived: %v", err)
	}
	// The plugin gives up on a silent body and drops its socket. What must be
	// proven is that the upstream is let go: the client's own read ends either
	// way (its connection was cut), so watching it would pass even with the
	// handler still pinned on the vendor.
	go func() { _, _ = io.ReadAll(resp.Body) }()
	cancel()
	select {
	case <-upstreamGone:
	case <-time.After(5 * time.Second):
		t.Fatal("the vendor's handler outlived the client: the request context did not reach it")
	}
}

// TestASilentUpstreamIsSaidToHaveTimedOut checks what the head watchdog says
// when it fires. The upstream context was cancelled and the handler returned
// without writing a head; Go's finishRequest then wrote 200 with an empty
// body, which the plugin read as an answered request. The silence is a
// gateway failure with a word for it.
func TestASilentUpstreamIsSaidToHaveTimedOut(t *testing.T) {
	saved := headTimeout
	headTimeout = 80 * time.Millisecond
	defer func() { headTimeout = saved }()
	release := make(chan struct{})
	defer close(release)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()

	f := &forwarder{}
	tr := f.clientFor("api.claw.speedai.com").Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	front := httptest.NewServer(f)
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/v1/gettoken", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "api.claw.speedai.com"
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("a silent upstream was answered as %d %q", resp.StatusCode, body)
	}
	if resp.StatusCode != http.StatusGatewayTimeout || !strings.Contains(string(body), "no answer in time") {
		t.Fatalf("got %d %q, want 504 naming the silence", resp.StatusCode, body)
	}
}

// TestASlowButLiveStreamIsNotCutAtTheHeadTimeout checks what stopping the
// head watchdog after the head buys: a stream that keeps arriving is alive
// however long it runs. While the same timer stayed armed for the body, an
// answer lasting longer than requestTimeout was cut mid-stream.
func TestASlowButLiveStreamIsNotCutAtTheHeadTimeout(t *testing.T) {
	// the head bound is shortened for the test: what is being driven is the
	// timer's lifetime, not the two minutes it is set to
	saved := headTimeout
	headTimeout = 80 * time.Millisecond
	defer func() { headTimeout = saved }()
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		// past the head timeout, one piece at a time: the vendor is slow, not
		// silent, and the answer must arrive whole
		for i := 0; i < 8; i++ {
			time.Sleep(headTimeout / 2)
			_, _ = w.Write([]byte("data: piece\n\n"))
			w.(http.Flusher).Flush()
		}
	}))
	defer upstream.Close()

	f := &forwarder{}
	tr := f.clientFor("api.claw.speedai.com").Transport.(*http.Transport)
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := net.Dial("tcp", strings.TrimPrefix(upstream.URL, "https://"))
		if err != nil {
			return nil, err
		}
		tlsConn := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, NextProtos: []string{"http/1.1"}})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	front := httptest.NewServer(f)
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "api.claw.speedai.com"
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("a live stream was cut: %v", err)
	}
	if want, got := 8, strings.Count(string(body), "data: piece"); got != want {
		t.Fatalf("%d pieces arrived, want %d: the stream was cut at the head timeout", got, want)
	}
}
