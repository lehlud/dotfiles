# install curl
sudo apt install curl --assume-yes

# install vim
sudo apt install vim --assume-yes

# setup vim-plug
curl -fLo ~/.vim/autoload/plug.vim --create-dirs \
    https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

# copy vimrc
cp vimrc ~/.vimrc

ex -c source ~/.vimrc -c qa!
ex -c PlugInstall coc.nvim -c PlugInstall coc.nvim -c PlugInstall vimtex -c PlugInstall auto-pairs -c PlugInstall lightline.vim -c PlugInstall vim-colors-solarized -c PlugInstall nerdtree -c qa!


