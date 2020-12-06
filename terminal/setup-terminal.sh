# install python3 and pip3
sudo apt install python3 python3-pip --assume-yes

# install pip3 powerline
sudo pip3 install git+git://github.com/powerline/powerline
wget https://github.com/Lokaltog/powerline/raw/develop/font/PowerlineSymbols.otf https://github.com/Lokaltog/powerline/raw/develop/font/10-powerline-symbols.conf
sudo mv PowerlineSymbols.otf /usr/share/fonts/
sudo fc-cache -vf
sudo mv 10-powerline-symbols.conf /etc/fonts/conf.d/

# install kitty
sudo apt install kitty --assume-yes

# copy kitty config
cp kitty.conf ~/.config/kitty/kitty.conf

