package compat

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/ir"
	"github.com/tonidy/modura-platform/apps/registry-go/internal/testdb"
)

type fixture struct {
	Name       string      `json:"name"`
	Previous   ir.Document `json:"previous"`
	Next       ir.Document `json:"next"`
	Changes    []Change    `json:"changes"`
	Violations []string    `json:"violations"`
	Warnings   []string    `json:"warnings"`
}

// TestMatchesTheTypeScriptChecker runs the shared fixtures written by the TypeScript
// implementation and demands an identical report for every case.
func TestMatchesTheTypeScriptChecker(t *testing.T) {
	path := filepath.Join(testdb.Root(t), "tests", "compat-fixtures", "fixtures.jsonl")
	if count := compareWithTypeScript(t, path); count < 30 {
		t.Fatalf("only %d fixtures found; the shared suite looks truncated", count)
	}
}

// TestRandomParity compares seeded random pairs written by
// packages/compiler/scripts/random-pairs.ts. scripts/compat-parity.sh sets
// MODURA_PARITY_FILE and runs it; without the variable it is skipped.
func TestRandomParity(t *testing.T) {
	path := os.Getenv("MODURA_PARITY_FILE")
	if path == "" {
		t.Skip("MODURA_PARITY_FILE is not set; run scripts/compat-parity.sh")
	}
	count := compareWithTypeScript(t, path)
	t.Logf("%d random pairs, identical reports", count)
}

func compareWithTypeScript(t *testing.T, path string) int {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 1<<20), 16<<20)
	count := 0
	for scanner.Scan() {
		var f fixture
		if err := json.Unmarshal(scanner.Bytes(), &f); err != nil {
			t.Fatalf("case %d: %v", count+1, err)
		}
		count++
		t.Run(f.Name, func(t *testing.T) {
			got := Check(&f.Previous, &f.Next)
			if !reflect.DeepEqual(got.Changes, orEmpty(f.Changes)) {
				t.Errorf("changes differ\n go: %+v\n ts: %+v", got.Changes, f.Changes)
			}
			if !reflect.DeepEqual(got.Violations, orEmpty(f.Violations)) {
				t.Errorf("violations differ\n go: %q\n ts: %q", got.Violations, f.Violations)
			}
			if !reflect.DeepEqual(got.Warnings, orEmpty(f.Warnings)) {
				t.Errorf("warnings differ\n go: %q\n ts: %q", got.Warnings, f.Warnings)
			}
		})
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return count
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
