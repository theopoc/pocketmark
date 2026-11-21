package observability

import (
	"context"
	collector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBackupOTLPExportsStoredCounter(t *testing.T) {
	received := make(chan int64, 1)
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req collector.ExportMetricsServiceRequest
		b, e := io.ReadAll(r.Body)
		if e != nil || proto.Unmarshal(b, &req) != nil {
			t.Error("invalid OTLP metrics payload")
			return
		}
		for _, resource := range req.ResourceMetrics {
			for _, scope := range resource.ScopeMetrics {
				for _, m := range scope.Metrics {
					if m.Name == "pocketmark_backup_failed_total" && m.GetSum().GetIsMonotonic() {
						received <- m.GetSum().DataPoints[0].GetAsInt()
					}
				}
			}
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer sink.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", sink.URL+"/v1/metrics")
	ctx := context.Background()
	stop, e := EnableBackupOTLP(ctx, TraceConfig{Enabled: true, ServiceName: "pocketmark"}, func(context.Context) (map[string]int64, error) { return map[string]int64{"failed_total": 7}, nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = stop(ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case n := <-received:
		if n != 7 {
			t.Fatal(n)
		}
	default:
		t.Fatal("missing backup counter")
	}
}
