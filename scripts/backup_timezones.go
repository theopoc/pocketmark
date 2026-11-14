//go:build ignore

// Generate backup-zones.tsv after updating IANA tzdata:
// go run scripts/backup_timezones.go /usr/share/zoneinfo > frontend/src/features/settings/backup-zones.tsv
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type group struct {
	offsets []string
	places  []string
}

func formatOffset(seconds int) string {
	sign := "+"
	if seconds < 0 {
		sign = "-"
		seconds = -seconds
	}
	return fmt.Sprintf("%s%02d%02d", sign, seconds/3600, seconds%3600/60)
}

// Compare transition instants and civil offsets, independent of abbreviations.
// A POSIX extension may expose a synthetic year boundary without changing offset.
func transitions(loc *time.Location) (string, []string) {
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	until := time.Date(2101, 1, 1, 0, 0, 0, 0, time.UTC)
	var key strings.Builder
	var offsets []string
	previous := 1 << 30
	for t := from; t.Before(until); {
		local := t.In(loc)
		_, offset := local.Zone()
		if offset != previous {
			fmt.Fprintf(&key, "%d/%d;", t.Unix(), offset)
			label := formatOffset(offset)
			if !slices.Contains(offsets, label) {
				offsets = append(offsets, label)
			}
			previous = offset
		}
		_, next := local.ZoneBounds()
		if next.IsZero() {
			break
		}
		if !next.After(t) {
			next = t.Add(time.Hour)
		}
		t = next
	}
	return key.String(), offsets
}

func main() {
	if len(os.Args) != 2 {
		panic("usage: go run scripts/backup_timezones.go ZONEINFO_DIR")
	}
	dir := os.Args[1]
	rows, err := os.ReadFile(filepath.Join(dir, "zone.tab"))
	if err != nil {
		panic(err)
	}
	groups := map[string]*group{}
	var ordered []*group
	for row := range strings.SplitSeq(string(rows), "\n") {
		if row == "" || strings.HasPrefix(row, "#") {
			continue
		}
		fields := strings.Fields(row)
		code, name := fields[0], fields[2]
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			panic(err)
		}
		loc, err := time.LoadLocationFromTZData(name, data)
		if err != nil {
			panic(err)
		}
		key, offsets := transitions(loc)
		g := groups[key]
		if g == nil {
			g = &group{offsets: offsets}
			groups[key] = g
			ordered = append(ordered, g)
		}
		g.places = append(g.places, code+"\t"+name)
	}
	for _, g := range ordered {
		fmt.Println(strings.Join(g.offsets, " "))
		for _, place := range g.places {
			fmt.Println(place)
		}
	}
}
