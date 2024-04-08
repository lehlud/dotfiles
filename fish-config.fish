if status is-interactive && type -q pfetch
    # Commands to run in interactive sessions can go here
    echo
    pfetch
end

set -x EDITOR hx
alias tmux="tmux -2"

alias json-get="curl --request GET -H 'Content-Type: application/json'"
alias json-post="curl --request POST -H 'Content-Type: application/json'"

