# install git
sudo pacman -S git --noconfirm

# setup keyring
sudo pacman -S libsecret --noconfirm
git config --global credential.helper /usr/lib/git-core/git-credential-libsecret
