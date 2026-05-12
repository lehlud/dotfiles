source ~/.config/fish/functions/fish_prompt.fish

fish_config theme choose custom

if status is-interactive
    if command -q distrobox; and set -q SSH_CONNECTION; and not set -q CONTAINER_ID; and set -q SSH_CONTAINER
        exec distrobox enter "$SSH_CONTAINER"
    end

    if command -q fortune; and command -q cowsay
        fortune -s | cowsay
        echo
    end

    uptime | sed 's/^ //'
    echo
end

if set -qU EDITOR; and set -qg EDITOR
    set -eg EDITOR
end

set -x TERM xterm-256color
set -x COLORTERM truecolor
set -x SSH_AUTH_SOCK /run/user/1000/ssh-agent.socket

alias bash="I_WANT_BASH= $(which bash)"

alias tmux="tmux -2 -u"

alias l="ls -lh --color=auto"
alias ll="ls -lAh --color=auto"

alias json-get="curl --request GET -H 'Content-Type: application/json'"
alias json-post="curl --request POST -H 'Content-Type: application/json'"

alias code="code --ozone-platform=wayland"

alias suspend="systemctl hybrid-sleep"

alias z="zellij"
alias ff="fastfetch"
alias hx="helix"

alias o="xdg-open"

alias enter="run-on-host distrobox enter"
alias host="distrobox-host-exec fish"

alias power-mode="run-on-host powerprofilesctl get"
alias power-saver="run-on-host powerprofilesctl set power-saver"
alias power-balanced="run-on-host powerprofilesctl set balanced"
alias power-performance="run-on-host powerprofilesctl set performance"

alias restart-hyprpaper="echo 'bash -c \'~/.config/hypr/start-hyprpaper.sh & disown\'; exit' | run-on-host fish &>/dev/null"

alias reboot="run-on-host systemctl reboot"
alias hibernate="run-on-host systemctl hibernate"

alias roh="run-on-host"

# setup wasmtime
set -gx WASMTIME_HOME "$HOME/.wasmtime"
string match -r ".wasmtime" "$PATH" >/dev/null; or set -gx PATH "$WASMTIME_HOME/bin" $PATH

set -gx LS_COLORS "di=38;2;74;222;128:$LS_COLORS"
