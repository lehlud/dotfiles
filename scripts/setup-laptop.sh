#!/bin/bash

BASEDIR=$(dirname "$0")
source $BASEDIR/basic-setup.sh

# setup picom
ipkg picom

cp $FILEDIR/.config/picom/picom-laptop.conf ~/.config/picom/picom.conf

# setup wm
ipkg xmonad
ipkg xmonad-utils
ipkg xmonad-contrib
ipkg xmobar

cp $FILEDIR/.xmonad/xmonad-laptop.hs ~/.xmonad/xmonad.hs
cp $FILEDIR/.config/xmobar/xmobar-laptop.config ~/.config/xmobar/xmobar.config

sudo reboot