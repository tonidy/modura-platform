// Package ir is the Go reading of the canonical Modura IR document (docs/spec/ir-1.0.md).
// The registry uses it to validate published releases and to run the compatibility
// check. tests/ir-fixtures holds documents this parser and the TypeScript validator
// must judge identically.
package ir

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

type Document struct {
	IRVersion      string              `json:"irVersion"`
	Modules        map[string]Module   `json:"modules"`
	Types          map[string]Type     `json:"types"`
	PlatformErrors map[string]ErrorDef `json:"platformErrors"`
}

type Module struct {
	Version      string                `json:"version"`
	Description  string                `json:"description"`
	Dependencies []string              `json:"dependencies"`
	Permissions  map[string]Permission `json:"permissions"`
	Errors       map[string]ErrorDef   `json:"errors"`
	Operations   map[string]Operation  `json:"operations"`
	Events       map[string]Event      `json:"events"`
	Subscribes   []string              `json:"subscribes"`
}

type Permission struct {
	Description string `json:"description"`
}

type ErrorDef struct {
	Category    string `json:"category"`
	Retryable   bool   `json:"retryable"`
	Description string `json:"description"`
}

type Operation struct {
	Kind        string   `json:"kind"`
	Description string   `json:"description"`
	Requires    []string `json:"requires"`
	Idempotent  bool     `json:"idempotent"`
	Input       Type     `json:"input"`
	Output      Type     `json:"output"`
	Errors      []string `json:"errors"`
	Expose      Expose   `json:"expose"`
}

type Expose struct {
	MCP bool `json:"mcp"`
}

type Event struct {
	Description string `json:"description"`
	Payload     Type   `json:"payload"`
}

// Type is one IR type node. Which fields are set depends on Kind.
type Type struct {
	Kind        string           `json:"kind"`
	Description string           `json:"description,omitempty"`
	MinLength   *int64           `json:"minLength,omitempty"`
	MaxLength   *int64           `json:"maxLength,omitempty"`
	Pattern     *string          `json:"pattern,omitempty"`
	Minimum     *int64           `json:"minimum,omitempty"`
	Maximum     *int64           `json:"maximum,omitempty"`
	Values      []string         `json:"values,omitempty"`
	Items       *Type            `json:"items,omitempty"`
	MinItems    *int64           `json:"minItems,omitempty"`
	MaxItems    *int64           `json:"maxItems,omitempty"`
	Fields      map[string]Field `json:"fields,omitempty"`
	Name        string           `json:"name,omitempty"`
}

type Field struct {
	Required bool `json:"required"`
	Type     Type `json:"type"`
}

var (
	semver       = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	moduleName   = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*$`)
	memberName   = moduleName
	errorCode    = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	typeName     = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*\.[A-Z][a-zA-Z0-9]*$`)
	enumValue    = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	categories   = map[string]bool{"validation": true, "unauthenticated": true, "forbidden": true, "not_found": true, "conflict": true, "unprocessable": true, "rate_limited": true, "internal": true, "unavailable": true}
	errNoVersion = errors.New("irVersion is missing")
)

// Version support. 1.x is the frozen format: a newer minor may only add optional
// fields, which this reader ignores (docs/stability.md). 0.2.0 is still readable so
// releases stored before IR 1.0 can be compared against; it cannot be published.
const (
	currentMinor  = 0
	legacyVersion = "0.2.0"
)

// Parse decodes and validates a document: 1.x against ir.schema.json (the same file
// the TypeScript validator uses) plus the semantic rules from docs/spec/ir-1.0.md.
// For IR 1.0 itself unknown fields are rejected, so a registry never stores
// something it does not understand.
func Parse(raw []byte) (*Document, error) {
	var header struct {
		IRVersion string `json:"irVersion"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	var doc Document
	switch {
	case header.IRVersion == "":
		return nil, errNoVersion
	case header.IRVersion == legacyVersion:
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&doc); err != nil {
			return nil, fmt.Errorf("decode: %w", err)
		}
	case IsPublishable(header.IRVersion):
		if err := matchesSchema(raw, minorOf(header.IRVersion) > currentMinor); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("decode: %w", err)
		}
	default:
		return nil, fmt.Errorf("irVersion %q is not supported (want 1.x)", header.IRVersion)
	}

	if err := doc.validate(); err != nil {
		return nil, err
	}
	return &doc, nil
}

// IsPublishable reports whether new releases may use this IR version.
func IsPublishable(version string) bool {
	return strings.HasPrefix(version, "1.") && semver.MatchString(version)
}

func minorOf(version string) int {
	var major, minor, patch int
	fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch)
	return minor
}

//go:embed ir.schema.json
var schemaJSON []byte

var (
	schemaOnce    sync.Once
	strictSchema  *jsonschema.Schema
	lenientSchema *jsonschema.Schema
	schemaErr     error
)

// matchesSchema validates against ir.schema.json. A newer minor version is checked
// against the schema with every `additionalProperties: false` relaxed.
func matchesSchema(raw []byte, newerMinor bool) error {
	schemaOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
		if err != nil {
			schemaErr = err
			return
		}
		if strictSchema, schemaErr = compileSchema(doc); schemaErr != nil {
			return
		}
		lenientSchema, schemaErr = compileSchema(relaxed(doc))
	})
	if schemaErr != nil {
		return fmt.Errorf("load IR schema: %w", schemaErr)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	schema := strictSchema
	if newerMinor {
		schema = lenientSchema
	}
	if err := schema.Validate(instance); err != nil {
		var verr *jsonschema.ValidationError
		if errors.As(err, &verr) {
			return fmt.Errorf("does not match the IR 1.0 schema: %s", mostSpecific(verr))
		}
		return fmt.Errorf("does not match the IR 1.0 schema: %w", err)
	}
	return nil
}

// mostSpecific walks the validator's error tree to the leaf about the deepest
// location: for a document that fails inside a type node, that is the actual
// problem rather than "matched none of the type alternatives". Complaints about
// `kind` come from alternatives that were never meant to match, so they count one
// level shallower.
func mostSpecific(root *jsonschema.ValidationError) string {
	var best *jsonschema.ValidationError
	depth := -1
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			d := len(e.InstanceLocation)
			if keyword := e.ErrorKind.KeywordPath(); len(keyword) > 0 && keyword[len(keyword)-1] == "const" ||
				d > 0 && e.InstanceLocation[d-1] == "kind" {
				d--
			}
			if d > depth {
				best, depth = e, d
			}
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(root)
	if best == nil {
		return root.Error()
	}
	location := best.InstanceLocation
	if n := len(location); n > 0 && location[n-1] == "kind" {
		// Every type alternative was rejected; naming one of them would mislead.
		return fmt.Sprintf("at '/%s': is not a valid type node", strings.Join(location[:n-1], "/"))
	}
	return fmt.Sprintf("at '/%s': %s", strings.Join(location, "/"), best.ErrorKind.LocalizedString(message.NewPrinter(language.English)))
}

func compileSchema(doc any) (*jsonschema.Schema, error) {
	const url = "urn:modura:ir:1.0"
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(url, doc); err != nil {
		return nil, err
	}
	return compiler.Compile(url)
}

func relaxed(node any) any {
	switch v := node.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, value := range v {
			if key == "additionalProperties" && value == false {
				continue
			}
			out[key] = relaxed(value)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = relaxed(item)
		}
		return out
	default:
		return node
	}
}

func (d *Document) validate() error {
	if len(d.Modules) == 0 {
		return errors.New("the document has no modules")
	}
	for _, name := range SortedKeys(d.Types) {
		if !typeName.MatchString(name) {
			return fmt.Errorf("types.%s: type names look like module.PascalCase", name)
		}
		if err := d.validateType(d.Types[name], "types."+name); err != nil {
			return err
		}
	}
	for _, code := range SortedKeys(d.PlatformErrors) {
		if !errorCode.MatchString(code) || !categories[d.PlatformErrors[code].Category] {
			return fmt.Errorf("platformErrors.%s: invalid code or category", code)
		}
	}

	permissions := map[string]bool{}
	errorCodes := map[string]bool{}
	events := map[string]bool{}
	for code := range d.PlatformErrors {
		errorCodes[code] = true
	}
	// Type references were checked above; they must not loop before anything below
	// walks through them.
	if err := d.checkCycles(); err != nil {
		return err
	}
	for _, m := range SortedKeys(d.Modules) {
		module := d.Modules[m]
		if !moduleName.MatchString(m) {
			return fmt.Errorf("%s: module names are lowerCamelCase", m)
		}
		for p := range module.Permissions {
			if !memberName.MatchString(p) {
				return fmt.Errorf("%s.permissions.%s: permission names are lowerCamelCase", m, p)
			}
			permissions[m+"."+p] = true
		}
		for code, def := range module.Errors {
			if !errorCode.MatchString(code) || !categories[def.Category] {
				return fmt.Errorf("%s.errors.%s: invalid code or category", m, code)
			}
			errorCodes[m+"."+code] = true
		}
		for e := range module.Events {
			if !memberName.MatchString(e) {
				return fmt.Errorf("%s.events.%s: event names are lowerCamelCase", m, e)
			}
			events[m+"."+e] = true
		}
	}

	for _, m := range SortedKeys(d.Modules) {
		module := d.Modules[m]
		if !semver.MatchString(module.Version) {
			return fmt.Errorf("%s: version %q is not MAJOR.MINOR.PATCH", m, module.Version)
		}
		for _, opName := range SortedKeys(module.Operations) {
			op := module.Operations[opName]
			path := m + "." + opName
			if !memberName.MatchString(opName) {
				return fmt.Errorf("%s: operation names are lowerCamelCase", path)
			}
			if op.Kind != "query" && op.Kind != "command" {
				return fmt.Errorf("%s: kind %q is neither query nor command", path, op.Kind)
			}
			if len(op.Requires) == 0 {
				return fmt.Errorf("%s: requires no permission", path)
			}
			for _, p := range op.Requires {
				if !permissions[p] {
					return fmt.Errorf("%s: requires undeclared permission %q", path, p)
				}
			}
			for _, code := range op.Errors {
				if !errorCodes[code] {
					return fmt.Errorf("%s: lists undeclared error %q", path, code)
				}
			}
			if op.Input.Kind != "object" {
				return fmt.Errorf("%s: input must be an object", path)
			}
			if err := d.validateType(op.Input, path+".input"); err != nil {
				return err
			}
			if err := d.validateType(op.Output, path+".output"); err != nil {
				return err
			}
		}
		for _, e := range SortedKeys(module.Events) {
			path := m + ".events." + e
			payload := module.Events[e].Payload
			if err := d.validateType(payload, path+".payload"); err != nil {
				return err
			}
			if resolve(payload, d).Kind != "object" {
				return fmt.Errorf("%s.payload: event payloads must be objects", path)
			}
		}
		for _, s := range module.Subscribes {
			if !events[s] {
				return fmt.Errorf("%s.subscribes: unknown event %q", m, s)
			}
			if strings.HasPrefix(s, m+".") {
				return fmt.Errorf("%s.subscribes: %q is the module's own event", m, s)
			}
		}
	}
	return nil
}

// checkCycles rejects a named type that reaches itself. DSL contracts cannot express
// one, but a published document could, and every recursive walk over types (the
// compatibility check, generators) would then loop forever.
func (d *Document) checkCycles() error {
	done := map[string]bool{}
	var visit func(name string, stack []string) []string
	visit = func(name string, stack []string) []string {
		for i, seen := range stack {
			if seen == name {
				return append(append([]string{}, stack[i:]...), name)
			}
		}
		if done[name] {
			return nil
		}
		for _, next := range refsIn(d.Types[name]) {
			if cycle := visit(next, append(stack, name)); cycle != nil {
				return cycle
			}
		}
		done[name] = true
		return nil
	}
	for _, name := range SortedKeys(d.Types) {
		if cycle := visit(name, nil); cycle != nil {
			return fmt.Errorf("types: reference cycle %s", strings.Join(cycle, " -> "))
		}
	}
	return nil
}

func refsIn(t Type) []string {
	switch t.Kind {
	case "ref":
		return []string{t.Name}
	case "array":
		if t.Items == nil {
			return nil
		}
		return refsIn(*t.Items)
	case "object":
		var out []string
		for _, name := range SortedKeys(t.Fields) {
			out = append(out, refsIn(t.Fields[name].Type)...)
		}
		return out
	default:
		return nil
	}
}

func (d *Document) validateType(t Type, path string) error {
	switch t.Kind {
	case "string", "integer", "boolean", "timestamp", "money", "json":
		return nil
	case "enum":
		if len(t.Values) == 0 {
			return fmt.Errorf("%s: enum without values", path)
		}
		for _, v := range t.Values {
			if !enumValue.MatchString(v) {
				return fmt.Errorf("%s: enum value %q is not lower_snake_case", path, v)
			}
		}
		return nil
	case "array":
		if t.Items == nil {
			return fmt.Errorf("%s: array without items", path)
		}
		return d.validateType(*t.Items, path+"[]")
	case "object":
		for _, name := range SortedKeys(t.Fields) {
			if !memberName.MatchString(name) {
				return fmt.Errorf("%s.%s: field names are lowerCamelCase", path, name)
			}
			if err := d.validateType(t.Fields[name].Type, path+"."+name); err != nil {
				return err
			}
		}
		return nil
	case "ref":
		if _, ok := d.Types[t.Name]; !ok {
			return fmt.Errorf("%s: reference to undefined type %q", path, t.Name)
		}
		return nil
	default:
		return fmt.Errorf("%s: unknown type kind %q", path, t.Kind)
	}
}

func resolve(t Type, d *Document) Type {
	for seen := 0; t.Kind == "ref" && seen < 64; seen++ {
		t = d.Types[t.Name]
	}
	return t
}

// Canonical returns the document in the canonical compact form defined in
// docs/spec/ir-1.0.md, plus its SHA-256. The TypeScript implementation (irSha256 in
// @modura/compiler) must produce the same bytes; tests/ir-fixtures/hashes.json
// checks that. The form is what JSON.stringify writes after sorting object keys:
// no whitespace, only `"`, `\` and control characters escaped, integers only.
func Canonical(raw []byte) ([]byte, string, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, "", err
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, value); err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:]), nil
}

func writeCanonical(buf *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		buf.WriteString(strconv.FormatBool(v))
	case json.Number:
		f, err := v.Float64()
		if err != nil || f != math.Trunc(f) || math.Abs(f) > maxSafeInteger {
			return fmt.Errorf("number %s is not a safe integer; IR documents contain integers only", v)
		}
		buf.WriteString(strconv.FormatInt(int64(f), 10))
	case string:
		writeString(buf, v)
	case []any:
		buf.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		buf.WriteByte('{')
		for i, key := range SortedKeys(v) {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeString(buf, key)
			buf.WriteByte(':')
			if err := writeCanonical(buf, v[key]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("unexpected JSON value %T", value)
	}
	return nil
}

const maxSafeInteger = 1<<53 - 1

// writeString escapes exactly what JSON.stringify escapes for valid Unicode.
func writeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
}

// SortedKeys returns a map's keys in byte order. IR keys are ASCII, so this equals
// the UTF-16 code unit order the TypeScript side sorts by.
func SortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
