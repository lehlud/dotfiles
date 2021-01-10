#!/bin/sh

# install emacs
sudo pacman -S emacs --noconfirm

git clone --depth 1 https://github.com/hlissner/doom-emacs ~/.emacs.d
~/.emacs.d/bin/doom install

cp ../.emacs.d/init.el ~/.emacs.d/init.el
