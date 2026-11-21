package backup

import (
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Environment is an overlay on the saved settings. Its values (which can
// include credentials) stay private, and only the field names reach the UI.
type Environment struct {
	config  Config
	secrets Credentials
	fields  []envField
}

type envValues struct {
	*Config
	*Credentials
}

type envField struct {
	suffix, name string
	read         func(envValues, string) error
	copy         func(dst, src envValues)
}

func field[T any](suffix, name string, addr func(envValues) *T, parse func(string) (T, error)) envField {
	return envField{
		suffix: suffix, name: name,
		read: func(dst envValues, raw string) error {
			v, err := parse(raw)
			if err == nil {
				*addr(dst) = v
			}
			return err
		},
		copy: func(dst, src envValues) { *addr(dst) = *addr(src) },
	}
}

func textValue(v string) (string, error) { return v, nil }

func windowValue(raw string) (int, error) {
	d, err := time.ParseDuration(raw)
	minutes := int(d / time.Minute)
	if err != nil || d%time.Minute != 0 || !validMinutes(minutes) || time.Duration(minutes)*time.Minute != d {
		return 0, errors.New("expected a positive duration in whole minutes (e.g. 2h)")
	}
	return minutes, nil
}

func retentionValue(raw string) (int, error) {
	days, err := strconv.Atoi(raw)
	if err != nil || !validDays(days) {
		return 0, errors.New("expected a positive number of days within the supported duration")
	}
	return days, nil
}

var backupEnvFields = []envField{
	field("ENABLED", "Enabled", func(v envValues) *bool { return &v.Enabled }, strconv.ParseBool),
	field("CRON", "Cron", func(v envValues) *string { return &v.Cron }, textValue),
	field("TIMEZONE", "Zone", func(v envValues) *string { return &v.Zone }, textValue),
	field("WINDOW", "WindowMinutes", func(v envValues) *int { return &v.WindowMinutes }, windowValue),
	field("RETENTION_DAYS", "RetentionDays", func(v envValues) *int { return &v.RetentionDays }, retentionValue),
	field("S3_ENDPOINT", "Endpoint", func(v envValues) *string { return &v.Endpoint }, textValue),
	field("S3_REGION", "Region", func(v envValues) *string { return &v.Region }, textValue),
	field("S3_BUCKET", "Bucket", func(v envValues) *string { return &v.Bucket }, textValue),
	field("S3_PREFIX", "Prefix", func(v envValues) *string { return &v.Prefix }, textValue),
	field("S3_ACCESS_KEY_ID", "AccessKey", func(v envValues) *string { return &v.AccessKey }, textValue),
	field("S3_SECRET_ACCESS_KEY", "SecretKey", func(v envValues) *string { return &v.SecretKey }, textValue),
	field("S3_ALLOW_HTTP", "AllowHTTP", func(v envValues) *bool { return &v.AllowHTTP }, strconv.ParseBool),
	field("TELEGRAM_BOT_TOKEN", "TelegramToken", func(v envValues) *string { return &v.TelegramToken }, textValue),
	field("TELEGRAM_CHAT_ID", "TelegramChatID", func(v envValues) *string { return &v.TelegramChatID }, textValue),
}

func ReadEnvironment(lookup func(string) string) (Environment, error) {
	var env Environment
	for _, f := range backupEnvFields {
		key := "POCKETMARK_BACKUP_" + f.suffix
		raw := lookup(key)
		if raw == "" {
			continue
		}
		if err := f.read(envValues{&env.config, &env.secrets}, raw); err != nil {
			// Parse errors can include their input. Never echo deployment values.
			return Environment{}, fmt.Errorf("invalid value for %s", key)
		}
		env.fields = append(env.fields, f)
	}
	return env, nil
}

func (e Environment) Managed() map[string]bool {
	fields := make(map[string]bool, len(e.fields))
	for _, f := range e.fields {
		fields[f.name] = true
	}
	return fields
}

func (e Environment) copyManaged(dst, src envValues) {
	for _, f := range e.fields {
		f.copy(dst, src)
	}
}

func (e Environment) Apply(c *Config, secrets *Credentials) {
	e.copyManaged(envValues{c, secrets}, envValues{&e.config, &e.secrets})
}

// PreserveManaged restores the saved values of locked fields before persisting
// a UI draft. Removing an override later reveals the original stored value.
func (e Environment) PreserveManaged(c *Config, secrets *Credentials, stored Config, storedSecrets Credentials) {
	e.copyManaged(envValues{c, secrets}, envValues{&stored, &storedSecrets})
}
