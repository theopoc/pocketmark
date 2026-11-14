package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"
	_ "time/tzdata"

	"filippo.io/age"
	"github.com/minio/minio-go/v7/pkg/s3utils"
	"github.com/robfig/cron/v3"
)

type Config struct {
	Enabled                                                       bool
	Cron, Zone, Endpoint, Region, Bucket, Prefix, Recipient, Mode string
	Keep                                                          int
	AllowHTTP, Text, Archives, Files                              bool
}
type Credentials struct{ AccessKey, SecretKey string }
type Settings struct {
	Config
	Credentials
	HasCredentials bool
	Next           *time.Time
	Upcoming       []time.Time
}

func Default() Config {
	return Config{Cron: "0 3 * * *", Zone: "UTC", Region: "us-east-1", Prefix: "backups", Mode: "full", Keep: 7, Text: true, Archives: true, Files: true}
}
func (c Config) Upcoming(now time.Time) ([]time.Time, error) {
	if len(c.Cron) > 128 || len(strings.Fields(c.Cron)) != 5 || strings.Contains(c.Cron, "=") {
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
	times := make([]time.Time, 3)
	for i := range times {
		now = sched.Next(now.In(loc))
		if now.IsZero() {
			return nil, errors.New("Schedule has no upcoming occurrence")
		}
		times[i] = now
	}
	return times, nil
}
func (c Config) DestinationOK() error {
	u, e := url.Parse(c.Endpoint)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(u.Scheme == "http" && c.AllowHTTP)) {
		return errors.New("Enter a valid HTTPS endpoint or explicitly allow HTTP")
	}
	if s3utils.CheckValidBucketNameStrict(c.Bucket) != nil {
		return errors.New("Invalid bucket name")
	}
	if c.Region == "" || len(c.Region) > 64 || strings.ContainsAny(c.Region, "/ \r\n") {
		return errors.New("Invalid region")
	}
	if c.Prefix == "" || len(c.Prefix) > 256 || path.Clean(c.Prefix) != c.Prefix || strings.HasPrefix(c.Prefix, "/") || strings.HasPrefix(c.Prefix, ".") || strings.ContainsAny(c.Prefix, "\\\r\n") {
		return errors.New("Invalid backup prefix")
	}
	return nil
}
func (c Config) Validate() error {
	if err := c.DestinationOK(); err != nil {
		return err
	}
	if _, e := c.Upcoming(time.Now()); e != nil {
		return e
	}
	if c.Keep < 1 || c.Keep > 10000 {
		return errors.New("Retention must be between 1 and 10000")
	}
	if c.Mode != "full" && c.Mode != "library" {
		return errors.New("Choose a backup mode")
	}
	if _, e := age.ParseX25519Recipient(c.Recipient); e != nil {
		return errors.New("Enter an age public recipient key")
	}
	return nil
}
func secretCipher(secret string) cipher.AEAD {
	key := sha256.Sum256([]byte("pocketmark/backup-s3/v1\x00" + secret))
	block, _ := aes.NewCipher(key[:])
	a, _ := cipher.NewGCMWithRandomNonce(block)
	return a
}
func Seal(secret string, c Credentials, binding string) ([]byte, error) {
	if c.AccessKey == "" || c.SecretKey == "" {
		return nil, errors.New("Enter both S3 credentials")
	}
	b, _ := json.Marshal(c)
	return secretCipher(secret).Seal(nil, nil, b, []byte(binding)), nil
}
func Open(secret string, b []byte, binding string) (c Credentials, err error) {
	data, e := secretCipher(secret).Open(nil, nil, b, []byte(binding))
	if e != nil {
		return c, fmt.Errorf("cannot open saved S3 credentials")
	}
	return c, json.Unmarshal(data, &c)
}
func (c Config) Binding() string {
	return c.Endpoint + "|" + c.Region + "|" + c.Bucket + "|" + c.Prefix
}
