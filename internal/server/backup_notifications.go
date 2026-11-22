package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"pocketmark/internal/backup"
	"pocketmark/internal/observability"
	"pocketmark/internal/store"
)

var telegramToken = regexp.MustCompile(`^[0-9]+:[A-Za-z0-9_-]+$`)

func sendBackupTelegram(ctx context.Context, transport http.RoundTripper, token, chat, message string) error {
	if len(token) > 256 || !telegramToken.MatchString(token) {
		return errors.New("invalid Telegram bot token")
	}
	if _, err := strconv.ParseInt(chat, 10, 64); err != nil {
		return errors.New("invalid Telegram chat ID")
	}
	payload, err := json.Marshal(map[string]string{"chat_id": chat, "text": message})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return errors.New("invalid Telegram request")
	}
	req.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 8 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("Telegram connection failed")
	}
	defer res.Body.Close()
	var result struct {
		OK bool `json:"ok"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 32<<10)).Decode(&result) != nil || !result.OK {
		return fmt.Errorf("Telegram rejected message (HTTP %d)", res.StatusCode)
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
	log := observability.Logger(ctx)
	if err != nil {
		log.Warn("backup_notification_failed", "backup_id", n.ID, "cause", err.Error())
	} else {
		log.Info("backup_notification_sent", "backup_id", n.ID)
	}
	return a.Store.CompleteBackupNotification(ctx, n.ID, err == nil)
}
