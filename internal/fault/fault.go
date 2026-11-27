// Package fault carries developer-owned diagnostics: stable codes plus a static
// message that explains the failure. External input never becomes a message.
package fault

import "errors"

// Error separates a developer-owned diagnostic from its human-readable message.
// Kind, Code and the message must be static application text, never external
// input, because the message is written to logs (see docs/LOGGING.md).
type Error struct {
	Kind, Code string
	message    string
	cause      error
	external   bool
}

func (e *Error) Error() string { return e.message }
func (e *Error) Unwrap() error { return e.cause }

// Message returns the developer-owned message, or false when the message was
// copied from external input and must stay out of logs.
func (e *Error) Message() (string, bool) { return e.message, !e.external }

// New defines a deterministic failure with a message that explains what
// happened, for example "S3 bucket does not exist".
func New(kind, code, message string) error {
	return &Error{Kind: kind, Code: code, message: message}
}

// Cause is New for a failure caused by a lower-level error. The cause stays
// available to errors.Is/As and to log classification; its text is never used.
func Cause(kind, code, message string, cause error) error {
	return &Error{Kind: kind, Code: code, message: message, cause: cause}
}

func Invalid(message string) error { return New("validation", "invalid_input", message) }

// Input marks errors originating from a request body, preserving the cause.
// It must not be used for destination writes or other internal I/O.
func Input(err error) error {
	if err == nil {
		return nil
	}
	return &Error{Kind: "validation", Code: "input_read_failed", message: err.Error(), cause: err, external: true}
}

type operationError struct {
	operation string
	err       error
}

func (e *operationError) Error() string { return e.err.Error() }
func (e *operationError) Unwrap() error { return e.err }

// Wrap preserves errors.Is/As. Operation must name code, not a URL, path or query.
func Wrap(operation string, err error) error {
	if err == nil {
		return nil
	}
	return &operationError{operation, err}
}

func Operation(err error) string {
	operation := ""
	for i := 0; err != nil && i < 16; i++ {
		if op, ok := err.(*operationError); ok {
			operation = op.operation
		}
		err = errors.Unwrap(err)
	}
	return operation
}
