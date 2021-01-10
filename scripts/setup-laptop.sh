#!/usr/bin/bash

# install curl
sudo pacman -S curl --noconfirm

sh update-pacman-mirrors.sh
sh vim-setup.sh
sh git-setup.sh

# install python as a dependency for kitty
sudo pacman -S python --noconfirm

# install kitty, i3-gaps, picom, polybar, nitrogen and rofi
sudo pacman -S kitty i3-gaps picom polybar nitrogen rofi  --noconfirm

# full system upgrade
sudo pacman -Syu --noconfirm

mkdir ~/.config/kitty ~/.config/i3 ~/.config/picom ~/.config/polybar

cp ../.config/kitty/kitty.conf ~/.config/kitty/kitty.conf
cp ../.config/i3/config-laptop ~/.config/i3/config
cp ../.config/picom/picom.conf ~/.config/picom/picom.conf
cp ../.config/polybar/config-laptop ~/.config/polybar/config

cp ../.bashrc ~/.bashrc

sudo echo "#!/bin/sh -e" > /etc/rc.local
sudo echo "chown $USER /sys/class/backlight/amdgpu_bl0/brightness" >> /etc/rc.local
sudo echo "exit 0" >> /etc/rc.local

sh doom-emacs-setup.sh
