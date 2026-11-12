// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/IBM/sarama"
	"github.com/IBM/sarama/mocks"
	"go.opentelemetry.io/otel/attribute"
	otelcodes "go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	pb "github.com/open-telemetry/opentelemetry-demo/src/checkout/genproto/oteldemo"
)

func boolAttr(span sdktrace.ReadOnlySpan, key string) (bool, bool) {
	for _, kv := range span.Attributes() {
		if kv.Key == attribute.Key(key) {
			return kv.Value.AsBool(), true
		}
	}
	return false, false
}

// sendToPostProcessor must return as soon as the message is queued, and each
// message's producer span must carry that message's own outcome.
func TestSendToPostProcessorDoesNotWaitForAck(t *testing.T) {
	logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	recorder := tracetest.NewSpanRecorder()
	tracer = sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)).Tracer("test")

	cfg := mocks.NewTestConfig()
	cfg.Producer.Return.Successes = true
	cfg.Producer.Return.Errors = true
	producer := mocks.NewAsyncProducer(t, cfg)
	producer.ExpectInputAndSucceed()
	producer.ExpectInputAndFail(errors.New("broker unavailable"))

	cs := &checkout{KafkaProducerClient: producer}

	// No result handler is running yet, so nothing reads Successes() or
	// Errors(). Both calls must still return promptly.
	sent := make(chan struct{})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cs.sendToPostProcessor(ctx, &pb.OrderResult{OrderId: "first"})
		cs.sendToPostProcessor(ctx, &pb.OrderResult{OrderId: "second"})
		close(sent)
	}()
	select {
	case <-sent:
	case <-time.After(2 * time.Second):
		t.Fatal("sendToPostProcessor blocked waiting for a Kafka result")
	}
	if n := len(recorder.Ended()); n != 0 {
		t.Fatalf("producer spans ended before their results arrived: %d", n)
	}

	done := make(chan struct{})
	go func() {
		cs.handleKafkaResults()
		close(done)
	}()
	if err := producer.Close(); err != nil {
		t.Fatalf("closing mock producer: %v", err)
	}
	<-done

	ended := recorder.Ended()
	if len(ended) != 2 {
		t.Fatalf("expected 2 ended producer spans, got %d", len(ended))
	}
	if ok, found := boolAttr(ended[0], "messaging.kafka.producer.success"); !found || !ok {
		t.Errorf("first message span: want success=true, got %v (set=%v)", ok, found)
	}
	if ended[0].Status().Code == otelcodes.Error {
		t.Errorf("first message span has error status: %v", ended[0].Status())
	}
	if ok, found := boolAttr(ended[1], "messaging.kafka.producer.success"); !found || ok {
		t.Errorf("second message span: want success=false, got %v (set=%v)", ok, found)
	}
	if ended[1].Status().Code != otelcodes.Error {
		t.Errorf("second message span: want error status, got %v", ended[1].Status())
	}
}

var _ sarama.AsyncProducer = (*mocks.AsyncProducer)(nil)
