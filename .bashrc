# .bashrc

case ":$PATH:" in
    *":$HOME/.local/bin:"*)
        ;;
    *)
        PATH="$PATH:$HOME/.local/bin"
        ;;
esac
export PATH

export EDITOR="$HOME/.local/bin/helix"

if [[ "$-" == *i* ]] && [ -z "${I_WANT_BASH+x}" ] && [ -x "$HOME/.local/bin/fish" ]; then
    "$HOME/.local/bin/fish"
    fish_status=$?

    if [ "$fish_status" -ne 125 ]; then
        exit "$fish_status"
    fi
fi

# Source global definitions
if [ -f /etc/bashrc ]; then
    . /etc/bashrc
fi

# User specific environment
case ":$PATH:" in
    *":$HOME/bin:"*)
        ;;
    *)
        PATH="$PATH:$HOME/bin"
        ;;
esac

if [ -n "${I_WANT_BASH+x}" ] && [ -n "${BASH_VERSION:-}" ]; then
    unset I_WANT_BASH
fi
export PATH

# Uncomment the following line if you don't like systemctl's auto-paging feature:
# export SYSTEMD_PAGER=

# User specific aliases and functions
if [ -d ~/.bashrc.d ]; then
    for rc in ~/.bashrc.d/*; do
        if [ -f "$rc" ]; then
            . "$rc"
        fi
    done
fi
unset rc
