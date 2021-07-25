#!/bin/bash

BASEDIR=$(dirname "$0")
source $BASEDIR/basic-setup.sh

# setup picom
ipkg picom

cp $FILEDIR/.config/picom/picom-pc.conf ~/.config/picom/picom.conf

# setup wm
ipkg xmonad
ipkg xmonad-utils
ipkg xmonad-contrib
ipkg xmobar

cp $FILEDIR/.xmonad/xmonad-pc.hs ~/.xmonad/xmonad.hs
cp $FILEDIR/.config/xmobar/xmobar-pc.config ~/.config/xmobar/xmobar.config

# setup nvidia driver
# ipkg nvidia
sudo reboot
