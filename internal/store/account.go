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
	_, err := s.db.ExecContext(ctx, "INSERT INTO account(id,username,salt,hash) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,hash=excluded.hash", a.Username, a.Salt, a.Hash)
	return err
}

func (s *Store) HasAPIKeyHash(ctx context.Context, hash string) bool {
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM api_tokens WHERE hash=? AND active=1", hash).Scan(&one) == nil
}

// AuthenticateAPIKey checks the current persisted state and records successful
// credential use in one write. Disabled and unknown keys never change history.
func (s *Store) AuthenticateAPIKey(ctx context.Context, hash string) bool {
	r, err := s.db.ExecContext(ctx, "UPDATE api_tokens SET last_used_at=? WHERE hash=? AND active=1", time.Now().UTC().Format(time.RFC3339Nano), hash)
	if err != nil {
		return false
	}
	n, err := r.RowsAffected()
	return err == nil && n == 1
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
	rows, err := s.db.QueryContext(ctx, "SELECT id,name,created_at,active,last_used_at FROM api_tokens ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []APIKey{}
	for rows.Next() {
		var key APIKey
		if err := rows.Scan(&key.ID, &key.Name, &key.CreatedAt, &key.Active, &key.LastUsedAt); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (s *Store) CreateAPIKey(ctx context.Context, name, hash string) (APIKey, error) {
	key := APIKey{Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Active: true}
	r, err := s.db.ExecContext(ctx, "INSERT INTO api_tokens(name,hash,created_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM api_tokens)<32", name, hash, key.CreatedAt)
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
