package webui

import "embed"

// Files contains the dependency-free browser application.
//
//go:embed static/*
var Files embed.FS
