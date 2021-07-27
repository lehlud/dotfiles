if status is-interactive
    # Commands to run in interactive sessions can go here
end

function fish_prompt
    set ppwd (pwd)
    echo -e "\033[0;34m$USER \033[0;33m$ppwd \033[0;31mλ\033[0m "
end

set fish_greeting

alias ls="ls --color=auto"
alias ll="ls -lah"

alias grep="grep --color=auto"
alias egrep="egrep --color=auto"
alias fgrep="fgrep --color=auto"

alias wget="wget -c"

alias pacman="sudo pacman --color=auto"

alias emacs="emacs -nw"

function gc
    git add -a
    git commit -S -m $argv
end

alias gp="git push"
alias gl="git pull"
alias gcl="git clone"

function gh_gcl
    gcl https://github.com/$argv
end

alias rr="curl -s -L http://bit.ly/10hA8iC | bash"

function weather
    curl wttr.in/$argv
end

