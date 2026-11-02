# Setup

```
git init .
git remote add -t \* -f origin https://github.com/lehlud/dotfiles
git checkout master
```

## Go

`~/.local/bin/go` installs the latest stable Go SDK for Linux or macOS (x86-64
or ARM64). It checks for updates every three days and keeps using the cached SDK
when offline. SDKs live in `~/.local/cache/go/<os>-<arch>/go`.

The default `GOPATH` is `~/go/<os>-<arch>`, for example `~/go/darwin-aarch64` on
an Apple Silicon host and `~/go/linux-aarch64` in Lubox. Installed tools and module
caches stay separate when the home directory is shared. Fish adds the matching
`GOPATH/bin` to its session's `PATH` without downloading or starting Go.

Custom exported `GOPATH` and `GOBIN` values are honored. The legacy `~/go` default
and inherited platform defaults are replaced by the current platform's default;
existing files are left in place. `go install example.org/tool@latest` installs
tools into the selected `GOBIN` or the first `GOPATH` entry's `bin` directory.
