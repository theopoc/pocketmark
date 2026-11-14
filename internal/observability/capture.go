package observability

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"pocketmark/internal/fault"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var captureOutcomes = [...]string{"ready", "failed", "save_failed", "canceled"}

// Capture starts a background root span; no request context is persisted to the database.
// IDs stay in logs only, and URLs/content never enter logs, labels or spans.
func (o *Observer) Capture(ctx context.Context, id int64) (context.Context, func(error, error)) {
	ctx, span := o.tracer.Start(ctx, "capture", trace.WithSpanKind(trace.SpanKindInternal))
	var run [16]byte
	rand.Read(run[:])
	logger := o.logger.With("link_id", id, "capture_id", hex.EncodeToString(run[:]))
	if sc := span.SpanContext(); sc.IsValid() {
		logger = logger.With("trace_id", sc.TraceID().String(), "span_id", sc.SpanID().String())
	}
	ctx = context.WithValue(ctx, loggerKey{}, logger)
	started := time.Now()
	return ctx, func(fetchErr, saveErr error) {
		outcome := 0
		err := fetchErr
		if fetchErr != nil {
			outcome = 1
		}
		if saveErr != nil {
			outcome, err = 2, saveErr
		}
		if ctx.Err() != nil {
			outcome, err = 3, ctx.Err()
		}
		elapsed := time.Since(started)
		o.measurements.mu.Lock()
		o.measurements.captures[outcome].observe(elapsed)
		o.measurements.mu.Unlock()
		attrs := []any{"outcome", captureOutcomes[outcome], "duration_ms", float64(elapsed) / float64(time.Millisecond)}
		level := slog.LevelInfo
		if err != nil {
			level = slog.LevelWarn
			attrs = append(attrs, ErrorAttrs(err)...)
			span.SetStatus(codes.Error, captureOutcomes[outcome])
		}
		if saveErr != nil {
			level = slog.LevelError
		}
		if fetchErr != nil {
			attrs = append(attrs, "fetch_error", attributeMap(ErrorAttrs(fault.Wrap("capture.fetch", fetchErr))))
		}
		if saveErr != nil {
			attrs = append(attrs, "save_error", attributeMap(ErrorAttrs(fault.Wrap("capture.persist", saveErr))))
		}
		attrs = append(attrs, "canceled", ctx.Err() != nil)
		logger.Log(ctx, level, "capture_finished", attrs...)
		span.SetAttributes(attribute.String("capture.outcome", captureOutcomes[outcome]))
		span.End()
	}
}

func (o *Observer) QueueError(ctx context.Context, err error) {
	o.measurements.queueErrors.Add(1)
	Error(ctx, "capture_queue_failed", err)
}

func attributeMap(attrs []any) map[string]any {
	result := make(map[string]any, len(attrs)/2)
	for i := 0; i+1 < len(attrs); i += 2 {
		result[attrs[i].(string)] = attrs[i+1]
	}
	return result
}
