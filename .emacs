;; Ludwig Lehnert (c) 2021

(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)


(custom-set-variables
 ;; auto-generated stuff
 '(custom-safe-themes
   '("d14f3df28603e9517eb8fb7518b662d653b25b26e83bd8e129acea042b774298" default))
 '(package-selected-packages '(projectile dashboard pylint evil gruvbox-theme ##))
 ;; dashboard setup
 '(dashboard-banner-logo-title "Welcome to Emacs Dashboard")
 '(dashboard-center-content t)
 '(dashboard-items
   '((recents . 5)
     (bookmarks . 5)
     (registers . 5)))
 '(dashboard-startup-banner "~/.emacs.d/title.txt")
 '(dashboard-footer-messages nil)
 ;; some general settings
 '(global-display-line-numbers-mode t)
 '(make-backup-files nil)
 '(menu-bar-mode nil)
 '(scroll-bar-mode nil)
 '(tool-bar-mode nil)
 '(tooltip-mode nil))

(custom-set-faces)

;; enable evil mode
(require 'evil)
(evil-mode 1)

;; load gruvbox theme
(load-theme 'gruvbox t)

;; set font size
(set-face-attribute 'default (selected-frame) :height 145)

;; start startup screen
(require 'dashboard)
(dashboard-setup-startup-hook)

;; define custom command
(defun spg ()
  (interactive)
  (fancy-about-screen))

