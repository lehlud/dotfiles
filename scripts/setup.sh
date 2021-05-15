#!/bin/bash

function ipkg {
    pacman -Qs $1 > /dev/null
    if [[ $? -ne 0 ]] ; then
        sudo pacman -S $1 --yes
    fi
}

# update mirrors
sudo pacman -Sy --yes

# update pacman mirrorlist
sudo cp /etc/pacman.d/mirrorlist /etc/pacman.d/mirrorlist-backup
ipkg reflector
sudo reflector -l 50 -c Germany -c Switzerland -c Denmark -c Belgium -p http -p https --sort rate --save /etc/pacman.d/mirrorlist

# update packages
sudo pacman -Su --yes

# setup git
ipkg git
ipkg libsecret

git config --global credential.helper /usr/lib/git-core/git-credential-libsecret

# install zsh, vim, emacs and kitty
ipkg zsh
ipkg vim
ipkg emacs
ipkg kitty

# copy config files
cp .vimrc ~
cp .zshrc ~
cp .emacs ~
cp -r .emacs.d ~
mkdir -p ~/.config/kitty
cp .config/kitty/kitty.conf 

# chsh to zsh
sudo chsh -s /bin/zsh $USER

# setup snap support
ipkg snapd
sudo systemctl enable --now snapd.socket
sudo ln -s /var/lib/snapd/snap /snap

# install brave
ipkg brave-bin

# enable ssh
sudo systemctl enable sshd

# setup gdm
ipkg gdm

