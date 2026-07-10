// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"strings"
	"testing"
)

// sanitizeProductID mirrors the inline sanitisation applied in GetProduct.
// It is extracted here so the logic can be tested independently of the gRPC
// handler and its OpenTelemetry / database dependencies.
func sanitizeProductID(raw string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}
		return -1
	}, raw)
}

func TestSanitizeProductID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "clean alphanumeric ID passes through unchanged",
			input: "OLJCESPC7Z",
			want:  "OLJCESPC7Z",
		},
		{
			name:  "stray trailing brace is stripped",
			input: "OLJCESPC7Z}",
			want:  "OLJCESPC7Z",
		},
		{
			name:  "stray leading brace is stripped",
			input: "{OLJCESPC7Z",
			want:  "OLJCESPC7Z",
		},
		{
			name:  "route-template placeholder braces are stripped",
			input: "{productId}",
			want:  "productId",
		},
		{
			name:  "hyphens are stripped",
			input: "ABC-123",
			want:  "ABC123",
		},
		{
			name:  "lowercase letters are retained",
			input: "abc123",
			want:  "abc123",
		},
		{
			name:  "empty string returns empty string",
			input: "",
			want:  "",
		},
		{
			name:  "all non-alphanumeric returns empty string",
			input: "!@#$%^&*()",
			want:  "",
		},
		{
			name:  "mixed case and digits are retained",
			input: "L9ECAV7KIM",
			want:  "L9ECAV7KIM",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeProductID(tc.input)
			if got != tc.want {
				t.Errorf("sanitizeProductID(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}
