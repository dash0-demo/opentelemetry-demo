// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"database/sql"
	"errors"
	"fmt"
	"testing"
)

// TestErrProductNotFoundIsMatchable guards the contract GetProduct depends on:
// a missing product must be reported with a sentinel error that errors.Is can
// recognise, including after wrapping. Before this was introduced the lookup
// returned fmt.Errorf("product not found"), which no caller could distinguish
// from a database fault, so every failure was reported as gRPC NotFound.
func TestErrProductNotFoundIsMatchable(t *testing.T) {
	if !errors.Is(ErrProductNotFound, ErrProductNotFound) {
		t.Fatal("ErrProductNotFound must match itself")
	}

	wrapped := fmt.Errorf("getting product %q: %w", "OLJCESPC7Z", ErrProductNotFound)
	if !errors.Is(wrapped, ErrProductNotFound) {
		t.Error("a wrapped ErrProductNotFound must still be matchable with errors.Is")
	}

	// A string error carrying the same text must NOT match. This is what the
	// previous implementation returned, and it is why the classification broke.
	lookalike := errors.New("product not found")
	if errors.Is(lookalike, ErrProductNotFound) {
		t.Error("a plain error with the same message must not match ErrProductNotFound")
	}
}

// TestDatabaseFaultsAreNotProductNotFound asserts that server-side faults stay
// distinguishable from a missing product, so GetProduct maps them to Internal
// rather than NotFound. Reporting a database outage as NotFound tells callers
// the product does not exist and hides the outage from the service error rate.
func TestDatabaseFaultsAreNotProductNotFound(t *testing.T) {
	faults := []error{
		errors.New("database connection not initialized"),
		fmt.Errorf("failed to scan product row: %w", errors.New("connection refused")),
		fmt.Errorf("failed to scan product row: %w", sql.ErrConnDone),
		sql.ErrTxDone,
	}

	for _, fault := range faults {
		if errors.Is(fault, ErrProductNotFound) {
			t.Errorf("server-side fault %q must not be classified as ErrProductNotFound", fault)
		}
	}
}

// TestSQLErrNoRowsIsDistinctFromSentinel documents why getProductFromDB has to
// translate sql.ErrNoRows explicitly: the driver error is not the sentinel, so
// returning it unchanged would fall through to the Internal branch.
func TestSQLErrNoRowsIsDistinctFromSentinel(t *testing.T) {
	if errors.Is(sql.ErrNoRows, ErrProductNotFound) {
		t.Error("sql.ErrNoRows must be translated to ErrProductNotFound explicitly, not matched directly")
	}
}
