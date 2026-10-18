// Package compat is the Go port of checkCompatibility in packages/compiler/src/compat.ts.
// Both implementations must produce identical reports for the shared fixtures in
// tests/compat-fixtures and for seeded random pairs (plan M6, ADR-0010), which is
// what keeps them from drifting.
package compat

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/tonidy/modura-platform/apps/registry-go/internal/ir"
)

type Severity string

const (
	Breaking Severity = "breaking"
	Source   Severity = "source"
	Safe     Severity = "safe"
)

type Change struct {
	Module   string   `json:"module"`
	Path     string   `json:"path"`
	Message  string   `json:"message"`
	Severity Severity `json:"severity"`
}

type Report struct {
	Changes    []Change `json:"changes"`
	Violations []string `json:"violations"`
	Warnings   []string `json:"warnings"`
}

type direction int

const (
	input direction = iota
	output
)

type addFunc func(path, message string, severity Severity)

// Check compares two documents. Iteration follows sorted key order, matching the
// TypeScript checker reading canonical JSON, so the reports match line for line.
func Check(previous, next *ir.Document) Report {
	r := Report{Changes: []Change{}, Violations: []string{}, Warnings: []string{}}

	for _, moduleName := range ir.SortedKeys(previous.Modules) {
		add := func(path, message string, severity Severity) {
			r.Changes = append(r.Changes, Change{moduleName, path, message, severity})
		}
		after, ok := next.Modules[moduleName]
		if !ok {
			add(moduleName, "module removed", Breaking)
			continue
		}
		compareModule(moduleName, previous.Modules[moduleName], after, previous, next, add)
	}
	for _, moduleName := range ir.SortedKeys(next.Modules) {
		if _, ok := previous.Modules[moduleName]; !ok {
			r.Changes = append(r.Changes, Change{moduleName, moduleName, "module added", Safe})
		}
	}

	for _, moduleName := range ir.SortedKeys(previous.Modules) {
		before := previous.Modules[moduleName].Version
		updated, ok := next.Modules[moduleName]
		if !ok {
			r.Violations = append(r.Violations, moduleName+": removing a module always breaks its clients")
			continue
		}
		after := updated.Version
		severities := map[Severity]bool{}
		for _, c := range r.Changes {
			if c.Module == moduleName {
				severities[c.Severity] = true
			}
		}
		went := fmt.Sprintf("the version went %s -> %s", before, after)
		switch {
		case compareVersions(after, before) < 0:
			r.Violations = append(r.Violations, fmt.Sprintf("%s: the version went down from %s to %s", moduleName, before, after))
		case severities[Breaking] && !allowsBreakingChange(before, after):
			r.Violations = append(r.Violations, moduleName+": breaking changes need a major version bump (minor while 0.x), but "+went)
		case severities[Source] && !allowsBreakingChange(before, after):
			r.Violations = append(r.Violations, moduleName+": source-breaking changes need a major version bump (minor while 0.x), but "+went)
		case len(severities) > 0 && !severities[Breaking] && !severities[Source] && !bumpsMinor(before, after):
			r.Warnings = append(r.Warnings, moduleName+": compatible changes usually come with a minor version bump, but "+went)
		}
	}
	return r
}

func compareModule(moduleName string, before, after ir.Module, previous, next *ir.Document, add addFunc) {
	for _, name := range ir.SortedKeys(before.Operations) {
		path := moduleName + "." + name
		updated, ok := after.Operations[name]
		if !ok {
			add(path, "operation removed", Breaking)
			continue
		}
		compareOperation(path, before.Operations[name], updated, previous, next, add)
	}
	for _, name := range ir.SortedKeys(after.Operations) {
		if _, ok := before.Operations[name]; !ok {
			add(moduleName+"."+name, "operation added", Safe)
		}
	}

	c := comparer{previous: previous, next: next, add: add}
	for _, name := range ir.SortedKeys(before.Events) {
		path := moduleName + ".events." + name
		updated, ok := after.Events[name]
		if !ok {
			add(path, "event removed", Breaking)
			continue
		}
		// Consumers receive payloads, so they compare like outputs.
		c.compare(before.Events[name].Payload, updated.Payload, output, path+".payload")
	}
	for _, name := range ir.SortedKeys(after.Events) {
		if _, ok := before.Events[name]; !ok {
			add(moduleName+".events."+name, "event added", Safe)
		}
	}

	for _, event := range after.Subscribes {
		if !slices.Contains(before.Subscribes, event) {
			add(moduleName, "now subscribes to "+event, Safe)
		}
	}
	for _, event := range before.Subscribes {
		if !slices.Contains(after.Subscribes, event) {
			add(moduleName, "no longer subscribes to "+event, Safe)
		}
	}
}

func compareOperation(path string, before, after ir.Operation, previous, next *ir.Document, add addFunc) {
	if before.Kind != after.Kind {
		add(path, fmt.Sprintf("kind changed from %s to %s", before.Kind, after.Kind), Breaking)
	}
	for _, p := range after.Requires {
		if !slices.Contains(before.Requires, p) {
			add(path, "now requires "+p, Breaking)
		}
	}
	for _, p := range before.Requires {
		if !slices.Contains(after.Requires, p) {
			add(path, "no longer requires "+p, Safe)
		}
	}
	switch {
	case !before.Idempotent && after.Idempotent:
		add(path, "became idempotent; callers must now send an idempotency key", Breaking)
	case before.Idempotent && !after.Idempotent:
		add(path, "is no longer idempotent", Safe)
	}
	for _, code := range after.Errors {
		if !slices.Contains(before.Errors, code) {
			add(path, "can now return "+code, Safe)
		}
	}
	if before.Expose.MCP != after.Expose.MCP {
		state := "removed"
		if after.Expose.MCP {
			state = "added"
		}
		add(path, "MCP exposure "+state, Safe)
	}

	c := comparer{previous: previous, next: next, add: add}
	c.compare(before.Input, after.Input, input, path+".input")
	c.compare(before.Output, after.Output, output, path+".output")
}

type comparer struct {
	previous, next *ir.Document
	add            addFunc
}

func (c comparer) compare(before, after ir.Type, dir direction, path string) {
	// Which named type is used is invisible on the wire but shapes generated code.
	switch {
	case before.Kind == "ref" && after.Kind == "ref":
		if before.Name != after.Name {
			c.add(path, fmt.Sprintf("type name changed from %s to %s", before.Name, after.Name), Source)
		}
	case before.Kind == "ref":
		c.add(path, fmt.Sprintf("type %s is no longer used here", before.Name), Source)
	case after.Kind == "ref":
		c.add(path, "now uses the named type "+after.Name, Source)
	}

	a := resolve(before, c.previous)
	b := resolve(after, c.next)
	if a.Kind != b.Kind {
		c.add(path, fmt.Sprintf("type changed from %s to %s", a.Kind, b.Kind), Breaking)
		return
	}
	switch a.Kind {
	case "string":
		c.bound(path, "minLength", true, a.MinLength, b.MinLength, dir)
		c.bound(path, "maxLength", false, a.MaxLength, b.MaxLength, dir)
		if !equalPtr(a.Pattern, b.Pattern) {
			c.add(path, fmt.Sprintf("pattern changed from %s to %s", strOrNone(a.Pattern), strOrNone(b.Pattern)), Breaking)
		}
	case "integer":
		c.bound(path, "minimum", true, a.Minimum, b.Minimum, dir)
		c.bound(path, "maximum", false, a.Maximum, b.Maximum, dir)
	case "enum":
		for _, v := range a.Values {
			if !slices.Contains(b.Values, v) {
				c.add(path, fmt.Sprintf("enum value %q removed", v), pick(dir == input))
			}
		}
		for _, v := range b.Values {
			if !slices.Contains(a.Values, v) {
				c.add(path, fmt.Sprintf("enum value %q added", v), pick(dir == output))
			}
		}
	case "array":
		c.bound(path, "minItems", true, a.MinItems, b.MinItems, dir)
		c.bound(path, "maxItems", false, a.MaxItems, b.MaxItems, dir)
		c.compare(*a.Items, *b.Items, dir, path+"[]")
	case "object":
		for _, name := range ir.SortedKeys(a.Fields) {
			field := a.Fields[name]
			fieldPath := path + "." + name
			updated, ok := b.Fields[name]
			if !ok {
				// Inputs are closed objects, so clients still sending the field get rejected.
				c.add(fieldPath, "field removed", Breaking)
				continue
			}
			if field.Required != updated.Required {
				if updated.Required {
					c.add(fieldPath, "became required", pick(dir == input))
				} else {
					c.add(fieldPath, "became optional", pick(dir == output))
				}
			}
			c.compare(field.Type, updated.Type, dir, fieldPath)
		}
		for _, name := range ir.SortedKeys(b.Fields) {
			if _, ok := a.Fields[name]; !ok {
				if dir == input && b.Fields[name].Required {
					c.add(path+"."+name, "required field added", Breaking)
				} else {
					c.add(path+"."+name, "field added", Safe)
				}
			}
		}
	}
}

// bound reports a changed limit. Narrowing an input rejects old requests; widening
// an output surprises old clients.
func (c comparer) bound(path, label string, isMin bool, before, after *int64, dir direction) {
	if equalPtr(before, after) {
		return
	}
	open := math.Inf(1)
	if isMin {
		open = math.Inf(-1)
	}
	b, a := orOpen(before, open), orOpen(after, open)
	narrowed := a < b
	if isMin {
		narrowed = a > b
	}
	breaking := narrowed
	if dir == output {
		breaking = !narrowed
	}
	c.add(path, fmt.Sprintf("%s changed from %s to %s", label, intOrNone(before), intOrNone(after)), pick(breaking))
}

func pick(breaking bool) Severity {
	if breaking {
		return Breaking
	}
	return Safe
}

func parseVersion(v string) [3]int {
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		out[i], _ = strconv.Atoi(part)
	}
	return out
}

func compareVersions(a, b string) int {
	x, y := parseVersion(a), parseVersion(b)
	for i := range 3 {
		if x[i] != y[i] {
			return x[i] - y[i]
		}
	}
	return 0
}

func allowsBreakingChange(before, after string) bool {
	b, a := parseVersion(before), parseVersion(after)
	if a[0] > b[0] {
		return true
	}
	return b[0] == 0 && a[0] == 0 && a[1] > b[1]
}

func bumpsMinor(before, after string) bool {
	b, a := parseVersion(before), parseVersion(after)
	return a[0] > b[0] || (a[0] == b[0] && a[1] > b[1])
}

func resolve(t ir.Type, doc *ir.Document) ir.Type {
	for t.Kind == "ref" {
		t = doc.Types[t.Name]
	}
	return t
}

func equalPtr[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func orOpen(v *int64, open float64) float64 {
	if v == nil {
		return open
	}
	return float64(*v)
}

func intOrNone(v *int64) string {
	if v == nil {
		return "none"
	}
	return strconv.FormatInt(*v, 10)
}

func strOrNone(v *string) string {
	if v == nil {
		return "none"
	}
	return *v
}
