// Package httpapi serves the generated Modura HTTP contract for the registry module.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"

	"golang.org/x/time/rate"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/api"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/store"
)

type Config struct {
	Store      *store.Store
	Identities Identities
	Logger     *slog.Logger

	// ClientIPHeader is a header set by a trusted proxy, such as Fly-Client-IP.
	// Empty means the TCP peer address identifies the client.
	ClientIPHeader string
	// CommandRateLimit is how many commands per second one client IP may send,
	// with CommandBurst on top. Zero disables rate limiting.
	CommandRateLimit rate.Limit
	CommandBurst     int
}

// New returns the complete HTTP handler: generated routes behind the contract
// middleware, and an unauthenticated health check.
func New(cfg Config) (http.Handler, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return nil, err
	}
	var limiter *ipLimiter
	if cfg.CommandRateLimit > 0 {
		limiter = newIPLimiter(cfg.ClientIPHeader, cfg.CommandRateLimit, max(1, cfg.CommandBurst))
	}
	middleware, err := contractMiddleware(spec, cfg.Identities, limiter)
	if err != nil {
		return nil, err
	}

	s := &server{store: cfg.Store, logger: cfg.Logger}
	strict := api.NewStrictHandlerWithOptions(s, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, r, codeValidationFailed, "The request body is not valid JSON.", nil)
		},
		ResponseErrorHandlerFunc: s.handleError,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", about)
	mux.HandleFunc("GET /healthz", s.health)
	api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter: mux,
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeError(w, r, codeValidationFailed, err.Error(), nil)
		},
	})
	return middleware(mux), nil
}

// server implements api.StrictServerInterface, which oapi-codegen derives from the
// contract. Adding an operation to the registry module without implementing it here
// fails to compile. The handlers are in registry.go.
type server struct {
	store  *store.Store
	logger *slog.Logger
}

var _ api.StrictServerInterface = (*server)(nil)

// handleError turns an unexpected handler error into INTERNAL or UNAVAILABLE.
// Details go to the log, keyed by request ID, never to the client.
func (s *server) handleError(w http.ResponseWriter, r *http.Request, err error) {
	code, message := codeInternal, "An unexpected error occurred."
	if store.IsUnavailable(err) {
		code, message = codeUnavailable, "The database is temporarily unavailable."
	}
	requestID, _ := r.Context().Value(requestIDKey).(string)
	s.logger.Error("request failed", "requestId", requestID, "path", r.URL.Path, "error", err)
	writeError(w, r, code, message, nil)
}

// about answers with the service name and the commit it was built from, which
// `go build` records from Git. A binary built outside a checkout, or by `go run`,
// reports "dev".
func about(w http.ResponseWriter, r *http.Request) {
	version := "dev"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" && len(setting.Value) >= 12 {
				version = setting.Value[:12]
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"name": "modura-registry", "version": version})
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{"status": "ok"}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := s.store.Ping(r.Context()); err != nil {
		body["status"] = "database unavailable"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(body)
}
