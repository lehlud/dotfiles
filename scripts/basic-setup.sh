#!/bin/bash

BASEDIR=$(dirname "$0")
FILEDIR="$BASEDIR/.."

function ipkg {
    pacman -Qs $1 > /dev/null
    if [[ $? -ne 0 ]] ; then
        sudo pacman -S $1 --noconfirm
    fi
}

function ipkg_yay {
    yay -Qs $1 > /dev/null
    if [[ $? -ne 0 ]] ; then
        yay -S $1 --noconfirm
    fi
}

# update mirrors
sudo pacman -Sy --noconfirm

# update pacman mirrorlist
sudo cp /etc/pacman.d/mirrorlist /etc/pacman.d/mirrorlist-backup
ipkg reflector
sudo reflector -l 50 -c Germany -c Switzerland -c Denmark -c Belgium -p http -p https --sort rate --save /etc/pacman.d/mirrorlist

# update packages
sudo pacman -Su --noconfirm

# setup yay
ipkg yay

# setup git
ipkg git
ipkg libsecret

git config --global credential.helper /usr/lib/git-core/git-credential-libsecret

# setup terminal stuff
ipkg zsh
ipkg kitty

cp $FILEDIR/.zshrc ~
mkdir -p ~/.config/kitty
cp $FILEDIR/.config/kitty/kitty.conf ~/.config/kitty/

sudo chsh -s `where zsh` $USER

# setup snap support
ipkg snapd
sudo systemctl enable --now snapd.socket
sudo ln -s /var/lib/snapd/snap /snap

# setup editor stuff
ipkg vim
cp $FILEDIR/.vimrc ~

curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

ipkg nodejs
ipkg npm

vim -c source ~/.vimrc -c PlugInstall -c qa!

ipkg emacs

cp $FILEDIR/.emacs ~
cp -r $FILEDIR/.emacs.d ~

sudo snap install code --classic

# install brave
ipkg_yay brave-bin

# enable ssh support (if not enabled)
sudo systemctl enable sshd

# setup gdm
ipkg gdm

sudo rm -f /etc/systemd/system/display-manager.service
sudo ln -s /usr/lib/systemd/system/gdm.service /etc/systemd/system/display-manager.service

# install keepassxc
ipkg keepassxc
