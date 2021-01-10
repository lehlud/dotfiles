#!/bin/sh

# install curl
sudo pacman -S curl --noconfirm

sh update-pacman-mirrors.sh



# git and vim setup
sh vim-setup.sh
sh git-setup.sh

# install python as a dependency for kitty
sudo pacman -S python --noconfirm

# install kitty, i3-gaps, picom, polybar and nitrogen
sudo pacman -S kitty i3-gaps picom polybar nitrogen --noconfirm

# full system upgrade
sudo pacman -Syu --noconfirm

mkdir ~/.config/kitty ~/.config/i3 ~/.config/picom ~/.config/polybar

cp ../.config/kitty/kitty.conf ~/.config/kitty/kitty.conf
cp ../.config/i3/config-pc ~/.config/i3/config
cp ../.config/picom/picom.conf ~/.config/picom/picom.conf
cp ../.config/polybar/config-pc ~/.config/polybar/config
cp ../.bashrc ~/.bashrc

# setup doom emacs
sh doom-emacs-setup.sh
sudo systemctl unmask snapd.service
sudo systemctl enable snapd.service
sudo systemctl start snapd.service
sudo ln -s /var/lib/snapd/snap /snap
sudo snap install core

# setup snap package manager
sudo pacman -S snapd --noconfirm


# install rtl8821ce WiFi driver
# cd ~/Downloads
# git clone https://github.com/tomaspinho/rtl8821ce
# cd rtl8821ce
# makepkg -si --noconfirm

