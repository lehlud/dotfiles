if status is-interactive && type -q pfetch
    # Commands to run in interactive sessions can go here
    echo
    pfetch
end

set -x EDITOR hx
alias tmux="tmux -2"

