if [[ -r /usr/share/zsh/functions/command-not-found.zsh ]]; then
    source /usr/share/zsh/functions/command-not-found.zsh
    export PKGFILE_PROMPT_INSTALL_MISSING=1
fi

if [[ -f /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]]; then
    source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
fi

if [[ -f /usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh ]]; then
    source /usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh
    zmodload zsh/terminfo
fi


setopt correct
setopt extendedglob
setopt appendhistory
setopt inc_append_history
setopt histignoredups


autoload -Uz vcs_info

autoload -U compinit colors zcalc
compinit -d
colors

PS1="%F{blue}%n %F{yellow}%~ %F{red}λ %f"

HISTSIZE=10000
HISTFILE="$HOME/.history"
SAVEHIST=$HISTSIZE

alias ls="ls --color=auto"
alias ll="ls -lah"

alias grep="grep --color=auto"
alias egrep="egrep --color=auto"
alias fgrep="fgrep --color=auto"

alias wget="wget -c"

alias pacman="sudo pacman --color auto"

alias emacs="emacs -nw"

function gc() {
    git add .
    tmp=$(git config user.signingkey)
    if [[ ${#tmp} -gt 2 ]] ; then
        git commit -S -m "$1"
    else
        git commit -m "$1"
    fi
}
alias gp="git push"
alias gl="git pull"
alias gcl="git clone"

function glcp() {
	git pull;
	git commit -m "$1";
	git push;
}

alias rr="curl -s -L http://bit.ly/10hA8iC | bash"

function weather() { curl "wttr.in/$1"; }

bindkey "^[[1;5C" forward-word
bindkey "^[[1;5D" backward-word

