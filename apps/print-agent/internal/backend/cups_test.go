//go:build !windows

package backend

import "testing"

func TestParseQueueNames(t *testing.T) {
	got := parseQueueNames("Bixolon\n\nOffice  \n")
	if len(got) != 2 || got[0] != "Bixolon" || got[1] != "Office" {
		t.Fatalf("names = %#v", got)
	}
}

func TestParseDefaultQueue(t *testing.T) {
	got := parseDefaultQueue("system default destination: Bixolon\n")
	if got != "Bixolon" {
		t.Fatalf("default = %q", got)
	}
}

func TestParseDevices(t *testing.T) {
	devices := parseDevices("device for Bixolon: usb://BIXOLON/SRP-350III\ndevice for Office: ipp://printer.local/ipp/print\n")
	if devices["Bixolon"] != "usb://BIXOLON/SRP-350III" {
		t.Fatalf("devices = %#v", devices)
	}
	if devices["Office"] != "ipp://printer.local/ipp/print" {
		t.Fatalf("devices = %#v", devices)
	}
}

func TestParseRequestID(t *testing.T) {
	if got := parseRequestID("request id is Bixolon-42 (1 file(s))\n"); got != "Bixolon-42" {
		t.Fatalf("request id = %q", got)
	}
	if got := parseRequestID("no id here"); got != "" {
		t.Fatalf("request id = %q", got)
	}
}

func TestContainsJob(t *testing.T) {
	if !containsJob("Bixolon-42 user 1024 Wed\n", "Bixolon-42") {
		t.Fatal("job not found")
	}
	if containsJob("Bixolon-41 user 1024 Wed\n", "Bixolon-42") {
		t.Fatal("wrong job found")
	}
}
