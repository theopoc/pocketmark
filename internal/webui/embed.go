package webui

import "embed"

// Files contains the compiled React application and standalone documentation.
//
//go:embed static/*
var Files embed.FS
