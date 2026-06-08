source ~/.config/fish/functions/fish_prompt.fish

fish_config theme choose custom

if status is-interactive
    if set -q SSH_CONNECTION; and set -q SSH_CONTAINER; and not set -q CONTAINER_ID; and not set -q LUBOX_CONTAINER_NAME; and not set -q FISH_SSH_CONTAINER_ATTEMPTED
        set -gx FISH_SSH_CONTAINER_ATTEMPTED 1
        set -l lubox_bin "$HOME/.local/bin/lubox"
        set -l host_shell (/usr/bin/python3 -c 'import os,pwd; print(pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh")' 2>/dev/null)
        if test -z "$host_shell"
            if set -q SHELL; and test -n "$SHELL"
                set host_shell "$SHELL"
            else
                set host_shell /bin/sh
            end
        end

        if test -x "$lubox_bin"
            if "$lubox_bin" list 2>/dev/null | awk -v box="$SSH_CONTAINER" 'NR > 1 && $1 == box { found = 1 } END { exit found ? 0 : 1 }'
                "$lubox_bin" enter "$SSH_CONTAINER"
                set -l lubox_status $status
                if test "$lubox_status" -eq 0
                    exit 0
                end
            end
        end

        exec "$host_shell" -l
    end

    if command -q fortune; and command -q cowsay
        fortune -s | cowsay
        echo
    end

    uptime | sed 's/^ //'
    echo
end

set -gx EDITOR "$(which helix)"
set -x TERM xterm-256color
set -x COLORTERM truecolor

alias bash="I_WANT_BASH=1 command bash"

alias tmux="tmux -2 -u"

alias l="ls -lh --color=auto"
alias ll="ls -lAh --color=auto"

alias json-get="curl --request GET -H 'Content-Type: application/json'"
alias json-post="curl --request POST -H 'Content-Type: application/json'"

alias z="zellij"
alias ff="fastfetch"
alias hx="helix"

alias o="xdg-open"

alias host="lubox host-exec bash"

alias power-mode="run-on-host powerprofilesctl get"
alias power-saver="run-on-host powerprofilesctl set power-saver"
alias power-balanced="run-on-host powerprofilesctl set balanced"
alias power-performance="run-on-host powerprofilesctl set performance"

alias restart-hyprpaper="echo 'bash -c \'~/.config/hypr/start-hyprpaper.sh & disown\'; exit' | run-on-host fish &>/dev/null"

alias reboot="run-on-host systemctl reboot"
alias hibernate="run-on-host systemctl hibernate"

alias roh="run-on-host"

alias neohelp="o ~/.local/share/_help/neo2-mapping.pdf"
