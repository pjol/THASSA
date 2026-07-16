package migrations

import "embed"

// FS holds the SQL migration files, applied in lexical order on boot.
//
//go:embed *.sql
var FS embed.FS
