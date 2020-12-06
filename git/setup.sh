# install git
sudo apt install git --assume-yes

# install keyring
sudo apt install libsecret-1-0 libsecret-1-dev --assume-yes
cd /usr/share/doc/git/contrib/credential/libsecret
sudo make
git config --global credential.helper /usr/share/doc/git/contrib/credential/libsecret/git-credential-libsecret
