if has("syntax")
    syntax on
endif

nnoremap qt :vert term<CR><C-w><C-r>

noremap qq <Esc>:q<CR>
noremap qaq <Esc>:qa<CR>
noremap qq1 <Esc>:q!<CR>
noremap qaq1 <Esc>:qa!<CR>

noremap qf <Esc>:NERDTreeToggle<CR>

noremap vs <Esc>:e $MYVIMRC<CR>

inoremap qw <Esc>:w<CR>i<Right>
inoremap ii <Esc><Right>

imap <C-@> <C-n>

inoremap ( ()<Left>
inoremap { {}<Left>
inoremap [ []<Left>
inoremap " ""<Left>
inoremap ' ''<Left>

nnoremap qw :w<CR>

set number

call plug#begin()
    " coding
    Plug 'lervag/vimtex'
    Plug 'neoclide/coc.nvim'
    " ui
    Plug 'scrooloose/nerdtree'
    Plug 'itchyny/lightline.vim'
call plug#end()

set encoding=UTF-8
set expandtab
set tabstop=4

set laststatus=2
set noshowmode

colors darkblue
