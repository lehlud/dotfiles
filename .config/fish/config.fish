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

alias pacman="pacman --color=auto"

alias emacs="emacs -nw"

function gc
    git add -A
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
    curl wttr.in/
end

set -x ANDROID_SDK_ROOT $HOME/Android/Sdk
set -x PATH $PATH $ANDROID_SDK_ROOT/tools/bin
set -x PATH $PATH $ANDROID_SDK_ROOT/platform-tools
set -x PATH $PATH $ANDROID_SDK_ROOT/emulator
set -x PATH $PATH $HOME/.pub-cache/bin
