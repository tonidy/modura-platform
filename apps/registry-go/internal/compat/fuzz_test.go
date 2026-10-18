package compat

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/ir"
)

// FuzzCheck compares pairs of arbitrary documents (plan M6). For any two documents
// the parser accepts, the check must not panic or loop, and a document compared
// with itself must report nothing. Seeds are the shared fixture pairs.
//
//	go test -run='^$' -fuzz=FuzzCheck -fuzztime=30s ./internal/compat
func FuzzCheck(f *testing.F) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "..", "..")
	if fixtures, err := os.Open(filepath.Join(root, "tests", "compat-fixtures", "fixtures.jsonl")); err == nil {
		scanner := bufio.NewScanner(fixtures)
		scanner.Buffer(make([]byte, 0, 1<<20), 16<<20)
		for scanner.Scan() {
			var pair struct {
				Previous json.RawMessage `json:"previous"`
				Next     json.RawMessage `json:"next"`
			}
			if json.Unmarshal(scanner.Bytes(), &pair) == nil {
				f.Add([]byte(pair.Previous), []byte(pair.Next))
			}
		}
		fixtures.Close()
	}

	f.Fuzz(func(t *testing.T, a, b []byte) {
		previous, err := ir.Parse(a)
		if err != nil {
			return
		}
		next, err := ir.Parse(b)
		if err != nil {
			return
		}
		Check(previous, next)
		Check(next, previous)
		if self := Check(previous, previous); len(self.Changes)+len(self.Violations)+len(self.Warnings) > 0 {
			t.Fatalf("a document differs from itself: %+v", self)
		}
	})
}
