package backup

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"

	"filippo.io/age"
)

// The original server secret is the sole recovery credential. Keep the HKDF
// label stable so future releases can recover archives from offline storage.
func archivePassphrase(secret string) (string, error) {
	key, err := hkdf.Key(sha256.New, []byte(secret), nil, "pocketmark/remote-backup/age/v1", 32)
	return base64.RawStdEncoding.EncodeToString(key), err
}

func EncryptArchive(w io.Writer, secret string) (io.WriteCloser, error) {
	pass, err := archivePassphrase(secret)
	if err != nil {
		return nil, err
	}
	key, err := age.NewScryptRecipient(pass)
	if err != nil {
		return nil, err
	}
	// The derived input is a 256-bit key. Bound scrypt memory in the worker.
	key.SetWorkFactor(13)
	return age.Encrypt(w, key)
}

func DecryptArchive(r io.Reader, secret string) (io.Reader, error) {
	pass, err := archivePassphrase(secret)
	if err != nil {
		return nil, err
	}
	key, err := age.NewScryptIdentity(pass)
	if err != nil {
		return nil, err
	}
	key.SetMaxWorkFactor(13)
	return age.Decrypt(r, key)
}

// Custom ZIPs must fit the HTTP restore path. Count plaintext ZIP bytes before
// age encryption, including the directory that zip.Writer emits on Close.
const MaxLibraryZIP = 64 << 30

var ErrLibrarySize = errors.New("custom library ZIP exceeds restore limit")

type limitedZIP struct {
	w         io.Writer
	remaining int64
}

func (z *limitedZIP) Write(b []byte) (int, error) {
	if int64(len(b)) > z.remaining {
		return 0, ErrLibrarySize
	}
	n, err := z.w.Write(b)
	z.remaining -= int64(n)
	return n, err
}

func LibraryZIPWriter(w io.Writer) io.Writer { return &limitedZIP{w: w, remaining: MaxLibraryZIP} }
