package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"pocketmark/internal/backup"
	"pocketmark/internal/fault"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

var telegramToken = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]+$`)

func sendBackupTelegram(ctx context.Context, transport http.RoundTripper, token, chat, message string) error {
	if len(token) > 256 || !telegramToken.MatchString(token) {
		return fault.New("notification", "telegram_token_invalid", "invalid Telegram bot token")
	}
	if _, err := strconv.ParseInt(chat, 10, 64); err != nil {
		return fault.New("notification", "telegram_chat_invalid", "invalid Telegram chat ID")
	}
	payload, err := json.Marshal(map[string]string{"chat_id": chat, "text": message})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return fault.New("notification", "telegram_request_invalid", "invalid Telegram request")
	}
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 8 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		// The request URL embeds the bot token: keep the cause for classification only.
		return fault.Cause("notification", "telegram_unreachable", "Telegram connection failed", err)
	}
	defer res.Body.Close()
	var result struct {
		OK bool `json:"ok"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 32<<10)).Decode(&result) != nil || !result.OK {
		switch res.StatusCode {
		case http.StatusUnauthorized, http.StatusNotFound:
			return fault.New("notification", "telegram_token_rejected", fmt.Sprintf("Telegram rejected the bot token (HTTP %d)", res.StatusCode))
		case http.StatusBadRequest:
			return fault.New("notification", "telegram_chat_rejected", "Telegram rejected the message; check the chat ID (HTTP 400)")
		case http.StatusForbidden:
			return fault.New("notification", "telegram_chat_forbidden", "Telegram bot cannot post to this chat; add the bot to the chat (HTTP 403)")
		}
		return fault.New("notification", "telegram_rejected", fmt.Sprintf("Telegram rejected message (HTTP %d)", res.StatusCode))
	}
	return nil
}

func (a *Server) testTelegram(w http.ResponseWriter, r *http.Request) {
	s, ok := a.inputBackup(w, r)
	if !ok {
		return
	}
	if err := sendBackupTelegram(r.Context(), a.telegramTransport, s.keys.TelegramToken, s.effective.TelegramChatID, "Pocketmark backup failure alerts are connected."); err != nil {
		respond(w, http.StatusBadGateway, map[string]string{"error": err.Error(), "code": "telegram_test_failed"})
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func backupFailureMessage(n *store.BackupNotification) string {
	last := "none"
	if n.LastSuccess > 0 {
		last = time.Unix(n.LastSuccess, 0).UTC().Format(time.RFC3339)
	}
	message := fmt.Sprintf("Pocketmark backup %s failed at %s. Stage: %s. Last successful backup: %s.", n.ID, n.Finished.UTC().Format(time.RFC3339), n.Stage, last)
	if n.Verified {
		message += " The new remote copy was verified."
	}
	return message
}

func (a *Server) dispatchBackupNotification(ctx context.Context) error {
	n, err := a.Store.ClaimBackupNotification(ctx)
	if err != nil || n == nil {
		return err
	}
	keys, err := backup.Open(a.token, n.Credentials, n.Config.Binding())
	if err == nil {
		err = sendBackupTelegram(ctx, a.telegramTransport, keys.TelegramToken, n.Config.TelegramChatID, backupFailureMessage(n))
	}
	if err != nil {
		// The owner misses a failure alert: a failed operation worth investigating.
		observability.Log(ctx, slog.LevelError, "backup_notification_failed", observability.Failure("backup_notification_failed", err), append([]any{"backup_id", n.ID}, observability.ErrorAttrs(err)...)...)
	} else {
		observability.Log(ctx, slog.LevelInfo, "backup_notification_sent", "Backup failure alert sent to Telegram", "backup_id", n.ID)
	}
	return a.Store.CompleteBackupNotification(ctx, n.ID, err == nil)
}
