// Package fault carries safe diagnostic codes without logging private messages.
package fault

import "errors"

// Error separates a developer-owned diagnostic from its human-readable message.
// Kind and Code must be static application identifiers, never external input.
type Error struct {
	Kind, Code string
	message    string
	cause      error
}

func (e *Error) Error() string { return e.message }
func (e *Error) Unwrap() error { return e.cause }

func New(kind, code, message string) error {
	return &Error{Kind: kind, Code: code, message: message}
}

func Invalid(message string) error { return New("validation", "invalid_input", message) }

// Input marks errors originating from a request body, preserving the cause.
// It must not be used for destination writes or other internal I/O.
func Input(err error) error {
	if err == nil {
		return nil
	}
	return &Error{Kind: "validation", Code: "input_read_failed", message: err.Error(), cause: err}
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
