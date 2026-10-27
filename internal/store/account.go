package store

import (
	"context"
	"errors"
	"time"
)

// Account holds persisted credentials; hashing and credential verification belong
// to the authentication module. No raw password or API key enters the store.
type Account struct{ Username, Salt, Hash string }

type SetupState struct {
	SetupRequired   bool `json:"setupRequired"`
	PasswordEnabled bool `json:"passwordEnabled"`
}

type APIKey struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"createdAt"`
	Active     bool   `json:"active"`
	LastUsedAt string `json:"lastUsedAt"`
	Profile    string `json:"profile"`
	ExpiresAt  int64  `json:"expiresAt"`
}

var ErrAPIKeyLimit = errors.New("at most 32 API keys")

const setupEligible = `EXISTS(SELECT 1 FROM account_setup WHERE allowed=1)
 AND NOT EXISTS(SELECT 1 FROM account) AND NOT EXISTS(SELECT 1 FROM links)
 AND NOT EXISTS(SELECT 1 FROM collections) AND NOT EXISTS(SELECT 1 FROM api_tokens)`

func (s *Store) Account(ctx context.Context) (Account, error) {
	var account Account
	err := s.db.QueryRowContext(ctx, "SELECT username,salt,hash FROM account WHERE id=1").Scan(&account.Username, &account.Salt, &account.Hash)
	return account, err
}

func (s *Store) SetupStatus(ctx context.Context) (SetupState, error) {
	var state SetupState
	err := s.db.QueryRowContext(ctx, "SELECT "+setupEligible+",EXISTS(SELECT 1 FROM account WHERE hash!='')").Scan(&state.SetupRequired, &state.PasswordEnabled)
	return state, err
}

// CreateAccount claims an eligible empty instance with one conditional write.
// Competing processes cannot overwrite the owner or a disabled legacy account.
func (s *Store) CreateAccount(ctx context.Context, a Account) (bool, error) {
	r, err := s.db.ExecContext(ctx, "INSERT INTO account(id,username,salt,hash) SELECT 1,?,?,? WHERE "+setupEligible, a.Username, a.Salt, a.Hash)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Store) SaveAccount(ctx context.Context, a Account) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO account(id,username,salt,hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,hash=excluded.hash", a.Username, a.Salt, a.Hash); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return err
	}
	return tx.Commit()
}

// SaveAccountFromSession retains a fully authenticated browser only if that
// session and the enrolled factor still exist at the moment of the change.
func (s *Store) SaveAccountFromSession(ctx context.Context, a Account, oldHash, newHash, device string) (time.Time, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback()
	var expiry int64
	var idleMinutes int
	if err = tx.QueryRowContext(ctx, "SELECT expires_at,idle_minutes FROM sessions WHERE hash=? AND "+liveSession+" AND EXISTS(SELECT 1 FROM mfa WHERE id=1 AND length(secret)>0)", oldHash).Scan(&expiry, &idleMinutes); err != nil {
		return time.Time{}, ErrMFAChanged
	}
	if _, err = tx.ExecContext(ctx, "UPDATE account SET username=?,salt=?,hash=? WHERE id=1", a.Username, a.Salt, a.Hash); err != nil {
		return time.Time{}, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions"); err != nil {
		return time.Time{}, err
	}
	expires := time.Unix(expiry, 0)
	if err = insertSessionTx(ctx, tx, a.Salt, newHash, expires, device, false); err != nil {
		return time.Time{}, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE sessions SET idle_minutes=? WHERE hash=?", idleMinutes, newHash); err != nil {
		return time.Time{}, err
	}
	if err = tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return expires, nil
}

func (s *Store) HasAPIKeyHash(ctx context.Context, hash string) bool {
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM api_tokens WHERE hash=? AND active=1 AND (expires_at=0 OR expires_at>unixepoch())", hash).Scan(&one) == nil
}

// AuthenticateAPIKey checks the current persisted state and records successful
// credential use in one write. Disabled and unknown keys never change history.
func (s *Store) AuthenticateAPIKey(ctx context.Context, hash string) bool {
	_, err := s.AuthenticateAPIKeyProfile(ctx, hash)
	return err == nil
}

func (s *Store) AuthenticateAPIKeyProfile(ctx context.Context, hash string) (string, error) {
	var profile string
	err := s.db.QueryRowContext(ctx, "UPDATE api_tokens SET last_used_at=? WHERE hash=? AND active=1 AND (expires_at=0 OR expires_at>unixepoch()) RETURNING profile", time.Now().UTC().Format(time.RFC3339Nano), hash).Scan(&profile)
	return profile, err
}

func (s *Store) SetAPIKeyActive(ctx context.Context, id int64, active bool) error {
	return s.UpdateAPIKey(ctx, id, nil, &active)
}

// UpdateAPIKey changes only supplied metadata; the credential and usage history
// remain intact, including when a disabled key is renamed.
func (s *Store) UpdateAPIKey(ctx context.Context, id int64, name *string, active *bool) error {
	r, err := s.db.ExecContext(ctx, "UPDATE api_tokens SET name=COALESCE(?,name),active=COALESCE(?,active) WHERE id=?", name, active, id)
	return affected(r, err)
}

func (s *Store) APIKeys(ctx context.Context) ([]APIKey, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,name,created_at,active,last_used_at,profile,expires_at FROM api_tokens ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []APIKey{}
	for rows.Next() {
		var key APIKey
		if err := rows.Scan(&key.ID, &key.Name, &key.CreatedAt, &key.Active, &key.LastUsedAt, &key.Profile, &key.ExpiresAt); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (s *Store) CreateAPIKey(ctx context.Context, name, hash string) (APIKey, error) {
	return s.CreateScopedAPIKey(ctx, name, hash, "full", 0)
}

func (s *Store) CreateScopedAPIKey(ctx context.Context, name, hash, profile string, expires int64) (APIKey, error) {
	key := APIKey{Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Active: true, Profile: profile, ExpiresAt: expires}
	r, err := s.db.ExecContext(ctx, "INSERT INTO api_tokens(name,hash,created_at,profile,expires_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM api_tokens)<32", name, hash, key.CreatedAt, profile, expires)
	if err != nil {
		return key, err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return key, err
	}
	if n == 0 {
		return key, ErrAPIKeyLimit
	}
	key.ID, err = r.LastInsertId()
	return key, err
}

func (s *Store) DeleteAPIKey(ctx context.Context, id int64) error {
	r, err := s.db.ExecContext(ctx, "DELETE FROM api_tokens WHERE id=?", id)
	return affected(r, err)
}

// RotateAPIKey atomically replaces the verifier, preserving permissions and expiry.
func (s *Store) RotateAPIKey(ctx context.Context, id int64, hash string) error {
	r, err := s.db.ExecContext(ctx, "UPDATE api_tokens SET hash=?,last_used_at='' WHERE id=? AND active=1 AND (expires_at=0 OR expires_at>unixepoch())", hash, id)
	return affected(r, err)
}
