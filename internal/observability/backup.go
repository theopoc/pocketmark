package observability

import (
	"context"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdk "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

var backupInstruments = []string{"enabled", "next_timestamp_seconds", "in_progress", "last_success_timestamp_seconds", "last_size_bytes", "last_duration_seconds", "succeeded_total", "failed_total", "warning_total", "cancelled_total", "deleted_total", "retention_errors_total", "retries_total", "stage_prepare_milliseconds_total", "stage_encrypt_milliseconds_total", "stage_upload_milliseconds_total", "stage_verify_milliseconds_total", "stage_retention_milliseconds_total"}

type BackupMeasurements func(context.Context) (map[string]int64, error)

func WriteBackupMetrics(w io.Writer, m map[string]int64) {
	for _, k := range backupInstruments {
		kind := "gauge"
		if strings.HasSuffix(k, "_total") {
			kind = "counter"
		}
		fmt.Fprintf(w, "# TYPE pocketmark_backup_%s %s\npocketmark_backup_%s %d\n", k, kind, k, m[k])
	}
}
func EnableBackupOTLP(ctx context.Context, c TraceConfig, read BackupMeasurements) (func(context.Context) error, error) {
	if !c.Enabled {
		return func(context.Context) error { return nil }, nil
	}
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
	if endpoint == "" {
		base := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
		if base == "" {
			base = "http://localhost:4318"
		}
		endpoint = strings.TrimRight(base, "/") + "/v1/metrics"
	}
	if e := validateTraceEndpoint(endpoint); e != nil {
		return nil, e
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxResponseHeaderBytes = 8 << 10
	tr.MaxConnsPerHost = 1
	tr.MaxIdleConns = 1
	client := &http.Client{Transport: tr, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	exp, e := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(endpoint), otlpmetrichttp.WithMaxRequestSize(64<<10), otlpmetrichttp.WithMaxResponseSize(64<<10), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}), otlpmetrichttp.WithHTTPClient(client))
	if e != nil {
		return nil, e
	}
	provider := sdk.NewMeterProvider(sdk.WithResource(resource.NewSchemaless(attribute.String("service.name", c.ServiceName))), sdk.WithReader(sdk.NewPeriodicReader(privateMetricExporter{exp}, sdk.WithInterval(30*time.Second), sdk.WithTimeout(5*time.Second))))
	meter := provider.Meter("pocketmark")
	instruments := map[string]metric.Int64Observable{}
	var observable []metric.Observable
	for _, name := range backupInstruments {
		var instrument metric.Int64Observable
		if strings.HasSuffix(name, "_total") {
			instrument, e = meter.Int64ObservableCounter("pocketmark_backup_" + name)
		} else {
			instrument, e = meter.Int64ObservableGauge("pocketmark_backup_" + name)
		}
		if e != nil {
			return nil, e
		}
		instruments[name] = instrument
		observable = append(observable, instrument)
	}
	_, e = meter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		m, e := read(ctx)
		if e != nil {
			return e
		}
		for k, i := range instruments {
			o.ObserveInt64(i, m[k])
		}
		return nil
	}, observable...)
	return func(ctx context.Context) error { defer tr.CloseIdleConnections(); return provider.Shutdown(ctx) }, e
}

// Keep collector-provided URLs and response bodies out of the default SDK log.
type privateMetricExporter struct{ sdk.Exporter }

func (e privateMetricExporter) Export(ctx context.Context, data *metricdata.ResourceMetrics) error {
	if err := e.Exporter.Export(ctx, data); err != nil {
		slog.WarnContext(ctx, "backup_metrics_export_failed", ErrorAttrs(err)...)
	}
	return nil
}
