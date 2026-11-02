# Match the Go launcher's platform directories without bootstrapping a toolchain.
set --local go_os (string lower -- (uname -s))
set --local go_arch (uname -m)
switch $go_arch
    case x86_64 amd64
        set go_arch x86_64
    case aarch64 arm64
        set go_arch aarch64
end

set --local go_homes "$HOME/go" \
    "$HOME/go/darwin-x86_64" "$HOME/go/darwin-aarch64" \
    "$HOME/go/linux-x86_64" "$HOME/go/linux-aarch64"

if not set --query GOPATH[1]; or test -z "$GOPATH"; or contains -- "$GOPATH" $go_homes
    set --global --export GOPATH "$HOME/go/$go_os-$go_arch"
end

set --local go_bin "$GOPATH[1]/bin"
if set --query GOBIN[1]; and test -n "$GOBIN"
    set go_bin "$GOBIN"
end

# Keep this session's PATH local to its platform, including with shared fish_variables.
set --local go_path
for entry in $PATH
    if contains -- "$entry" $go_homes/bin "$go_bin"
        continue
    end

    set --append go_path "$entry"
end

set --global --export PATH "$go_bin" $go_path
