package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/minio/minio-go/v7/pkg/s3utils"
	"github.com/robfig/cron/v3"
)

type Config struct {
	Enabled                                            bool
	Cron, Zone, Endpoint, Region, Bucket, Prefix, Mode string
	WindowMinutes, RetentionDays                       int
	AllowHTTP, Text, Archives, Files                   bool
	TelegramChatID                                     string
}
type Credentials struct {
	AccessKey     string `json:",omitempty"`
	SecretKey     string `json:",omitempty"`
	TelegramToken string `json:",omitempty"`
	Destination   string `json:",omitempty"`
}

func (c Credentials) HasS3() bool { return c.AccessKey != "" && c.SecretKey != "" }

type Settings struct {
	SetupError string  `json:",omitempty"`
	Revision   *string `json:",omitempty"`
	Config
	Credentials
	HasCredentials, HasTelegramToken, ClearTelegram bool
	Managed                                         map[string]bool
	Next                                            *time.Time
	Upcoming                                        []time.Time
}

func Default() Config {
	return Config{Cron: "0 3 * * *", Region: "us-east-1", Prefix: "backups", Mode: "full", RetentionDays: 7, WindowMinutes: 120, Text: true, Archives: true, Files: true}
}

// Preserve civil clock fields while changing how they are interpreted.
func inClock(t time.Time, loc *time.Location) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), loc)
}

// time.Date can choose either offset in a fold, and either side of a gap.
// Resolve a civil occurrence to the first matching instant in a fold, or
// to the transition itself when the requested local time did not exist.
func resolveOccurrence(wall time.Time, loc *time.Location) time.Time {
	t := inClock(wall, loc)
	start, end := t.ZoneBounds()
	clock := inClock(t, time.UTC)
	if clock.Equal(wall) {
		if !start.IsZero() {
			_, previous := start.Add(-time.Nanosecond).Zone()
			_, current := t.Zone()
			if current < previous {
				earlier := t.Add(time.Duration(current-previous) * time.Second)
				if inClock(earlier, time.UTC).Equal(wall) {
					return earlier
				}
			}
		}
		return t
	}
	if clock.Before(wall) {
		return end
	}
	return start
}

func (c Config) Upcoming(now time.Time) ([]time.Time, error) {
	if len(c.Cron) > 128 || len(strings.Fields(c.Cron)) != 5 || strings.ContainsAny(c.Cron, "=@") {
		return nil, errors.New("Use five cron fields")
	}
	if c.Zone == "" || c.Zone == "Local" {
		return nil, errors.New("Choose an IANA time zone")
	}
	loc, err := time.LoadLocation(c.Zone)
	if err != nil {
		return nil, errors.New("Unknown time zone")
	}
	sched, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(c.Cron)
	if err != nil {
		return nil, errors.New("Invalid cron expression")
	}
	// Ask the parser for civil matches on a clock without transitions. Advancing
	// that clock to the resolved time also coalesces multiple matches in a gap.
	wall := inClock(now.In(loc), time.UTC)
	times := make([]time.Time, 0, 3)
	for len(times) < cap(times) {
		match := sched.Next(wall)
		if match.IsZero() {
			return nil, errors.New("Schedule has no upcoming occurrence")
		}
		wall = match
		due := resolveOccurrence(match, loc)
		if due.After(now) {
			times = append(times, due)
			now = due
			wall = inClock(due, time.UTC)
		}
	}
	return times, nil
}
func (c Config) DestinationOK() error {
	return c.validateDestination(true)
}

func (c Config) validateDestination(complete bool) error {
	if complete || c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.Hostname() == "" || u.User != nil || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(u.Scheme == "http" && c.AllowHTTP)) {
			return errors.New("Enter a valid HTTPS endpoint or explicitly allow HTTP")
		}
	}
	if (complete || c.Bucket != "") && s3utils.CheckValidBucketNameStrict(c.Bucket) != nil {
		return errors.New("Invalid bucket name")
	}
	if (complete && c.Region == "") || len(c.Region) > 64 || strings.ContainsAny(c.Region, "/ \t\r\n\x00") {
		return errors.New("Invalid region")
	}
	if complete || c.Prefix != "" {
		if len(c.Prefix) > 256 || path.Clean(c.Prefix) != c.Prefix || strings.HasPrefix(c.Prefix, "/") || strings.HasPrefix(c.Prefix, ".") || strings.ContainsAny(c.Prefix, "\\\r\n\x00") {
			return errors.New("Invalid backup prefix")
		}
	}
	return nil
}

// A paused draft can be saved in stages. Check every supplied field, even
// when other fields needed to preview the schedule or run a backup are empty.
func (c Config) ValidateDraft() error {
	if c.Enabled {
		return c.Validate()
	}
	if err := c.validateFields(false); err != nil {
		return err
	}
	if c.Cron == "" && c.Zone == "" {
		return nil
	}
	if c.Cron == "" {
		c.Cron = Default().Cron
	}
	if c.Zone == "" {
		c.Zone = "UTC"
	}
	_, err := c.Upcoming(time.Now())
	return err
}

func (c Config) Validate() error {
	if err := c.validateFields(true); err != nil {
		return err
	}
	if c.Enabled {
		_, err := c.Upcoming(time.Now())
		return err
	}
	return nil
}

func (c Config) validateFields(complete bool) error {
	if err := c.validateDestination(complete); err != nil {
		return err
	}
	if (complete || c.RetentionDays != 0) && !validDays(c.RetentionDays) {
		return errors.New("Retention must be a positive whole number of days within the supported duration")
	}
	if (complete || c.WindowMinutes != 0) && !validMinutes(c.WindowMinutes) {
		return errors.New("Window must be a positive whole number of minutes within the supported duration")
	}
	if (complete || c.Mode != "") && c.Mode != "full" && c.Mode != "library" {
		return errors.New("Choose a backup mode")
	}
	if c.TelegramChatID != "" {
		if _, e := strconv.ParseInt(c.TelegramChatID, 10, 64); e != nil {
			return errors.New("Enter a numeric Telegram chat ID")
		}
	}
	return nil
}

// Bound conversions to time.Duration, including on 32-bit installations.
func validMinutes(n int) bool { return n > 0 && int64(n) <= (1<<63-1)/int64(time.Minute) }
func validDays(n int) bool    { return n > 0 && int64(n) <= (1<<63-1)/int64(24*time.Hour) }

func secretCipher(secret string) cipher.AEAD {
	key := sha256.Sum256([]byte("pocketmark/backup-s3/v1\x00" + secret))
	block, _ := aes.NewCipher(key[:])
	a, _ := cipher.NewGCMWithRandomNonce(block)
	return a
}
func Seal(secret string, c Credentials, binding string) ([]byte, error) {
	if c == (Credentials{}) {
		return []byte{}, nil
	}
	b, _ := json.Marshal(c)
	return secretCipher(secret).Seal(nil, nil, b, []byte(binding)), nil
}
func Open(secret string, b []byte, binding string) (c Credentials, err error) {
	if len(b) == 0 {
		return c, nil
	}
	data, e := secretCipher(secret).Open(nil, nil, b, []byte(binding))
	if e != nil {
		return c, errors.New("cannot open saved backup credentials")
	}
	err = json.Unmarshal(data, &c)
	return c, err
}
func (c Config) Binding() string {
	b, _ := json.Marshal([4]string{c.Endpoint, c.Region, c.Bucket, c.Prefix})
	return string(b)
}
