package ir

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// FuzzParse feeds arbitrary bytes to the parser (plan M6). Whatever it accepts must
// canonicalize, and the canonical form must parse again and keep the same hash: the
// registry stores canonical bytes, so a document must survive that round trip.
// The seed corpus is every shared fixture plus the generated IR.
//
//	go test -run='^$' -fuzz=FuzzParse -fuzztime=30s ./internal/ir
func FuzzParse(f *testing.F) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..", "..", "..")
	seeds, _ := filepath.Glob(filepath.Join(root, "tests", "ir-fixtures", "*", "*.json"))
	seeds = append(seeds, filepath.Join(root, "generated", "ir", "modura.ir.json"))
	for _, seed := range seeds {
		if raw, err := os.ReadFile(seed); err == nil {
			f.Add(raw)
		}
	}

	f.Fuzz(func(t *testing.T, raw []byte) {
		doc, err := Parse(raw)
		if err != nil {
			return
		}
		canonical, hash, err := Canonical(raw)
		if err != nil {
			if IsPublishable(doc.IRVersion) {
				t.Fatalf("accepted a 1.x document that does not canonicalize: %v", err)
			}
			return
		}
		again, err := Parse(canonical)
		if err != nil {
			t.Fatalf("canonical form of an accepted document is rejected: %v", err)
		}
		if again.IRVersion != doc.IRVersion || len(again.Modules) != len(doc.Modules) {
			t.Fatal("canonical form changed the document")
		}
		_, hash2, err := Canonical(canonical)
		if err != nil || hash2 != hash {
			t.Fatalf("canonicalizing twice changed the hash: %s vs %s (%v)", hash, hash2, err)
		}
	})
}
