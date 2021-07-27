import qualified Data.Map as M
import Data.Monoid
import System.Exit

import XMonad

import XMonad.Util.Run
import XMonad.Util.SpawnOnce
import XMonad.Util.EZConfig

import XMonad.Layout.Spacing
import XMonad.Hooks.ManageDocks

import qualified XMonad.StackSet as W

myTerminal :: String
myTerminal = "kitty"

myBrowser :: String
myBrowser = "firefox"
myAltBrowser :: String
myAltBrowser = "brave"

myAppMenu :: String
myAppMenu = "rofi -show run"
myAppMenuThemes :: String
myAppMenuThemes = "rofi-theme-selector"

myFocusFollowsMouse :: Bool
myFocusFollowsMouse = True

myClickJustFocuses :: Bool
myClickJustFocuses = False

myModMask = mod4Mask

myWorkspaces = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

myBorderWidth = 5
myNormalBorderColor = "#dddddd"
myFocusedBorderColor = "#ff8700"

-- screen spacing, then window spacing
mySpacing x y = spacingRaw False (Border x x x x) True (Border y y y y) True

myKeys :: [(String, X ())]
myKeys = [
    -- spawning keybindings
    ("M-<Return>"   , spawn myTerminal),
    ("M-d"          , spawn myAppMenu),
    ("M-S-d"        , spawn myAppMenuThemes),
    ("M-i"          , spawn myBrowser),
    ("M-S-i"        , spawn myAltBrowser),
    
    -- killing, exiting and suspending keybindings
    ("M-q"          , kill),
    ("M-S-q"        , io (exitWith ExitSuccess)),
    ("M-S-s"        , spawn "systemctl suspend"),

    -- restarting and recompiling keybindings
    ("M-r"          , spawn "xmonad --restart"),
    ("M-S-r"        , spawn "xmonad --recompile; xmonad --restart"),

    -- window keybindings
    ("M-<Tab>"      , windows W.focusDown),
    ("M-S-<Tab>"    , windows W.focusMaster),

    -- spacing keybindings
    ("M4-S-<Up>"    , incWindowSpacing 1),
    ("M4-S-<Down>"  , decWindowSpacing 1),
    ("M1-S-<Up>"    , incScreenSpacing 1),
    ("M1-S-<Down>"  , decScreenSpacing 1),

    -- multimedia keybindings
    ("<XF86AudioRaiseVolume>"   , spawn "amixer set Master 2%+"),
    ("<XF86AudioLowerVolume>"   , spawn "amixer set Master 2%-"),
    ("<XF86AudioMute>"          , spawn "amixer set Master toggle"),
    ("M-<Print>"                , spawn clipBoardScreenshotCommand),
    ("M-<Page_Down>"            , spawn clipBoardScreenshotCommand) ]

clipBoardScreenshotCommand = "bash -c \"gnome-screenshot -af /tmp/screenshot && cat /tmp/screenshot | xclip -i -selection clipboard -target image/png\""

------------------------------------------------------------------------
-- Mouse bindings: default actions bound to mouse events
--
myMouseBindings (XConfig {XMonad.modMask = modm}) =
  M.fromList $
    -- mod-button1, Set the window to floating mode and move by dragging
    [ ( (modm, button1),
        ( \w ->
            focus w >> mouseMoveWindow w
              >> windows W.shiftMaster
        )
      ),
      -- mod-button2, Raise the window to the top of the stack
      ((modm, button2), (\w -> focus w >> windows W.shiftMaster)),
      -- mod-button3, Set the window to floating mode and resize by dragging
      ( (modm, button3),
        ( \w ->
            focus w >> mouseResizeWindow w
              >> windows W.shiftMaster
        )
      )
      -- you may also bind events to the mouse scroll wheel (button4 and button5)
    ]



myLayoutHook = avoidStruts (tiled ||| Mirror tiled ||| Full)
  where
     tiled   = mySpacing 32 8 $ Tall nmaster delta ratio
     nmaster = 1
     ratio   = 1/2
     delta   = 3/100

myManageHook = composeAll [
    className =? "Gimp" --> doFloat,
    resource =? "desktop_window" --> doIgnore ]

myEventHook = mempty

myLogHook = return ()

myStartupHook = do
    spawnOnce "xsetroot -cursor_name left_ptr"
    spawnOnce "xrandr --output DP-0 --primary --left-of HDMI-0 --auto"

main = do
  xmproc0 <- spawnPipe "nitrogen --restore"
  xmproc1 <- spawnPipe "killall picom; picom &"
  xmproc2 <- spawnPipe "killall xmobar; xmobar ~/.config/xmobar/xmobar.config"
  xmonad $ docks defaults

defaults = def {
    terminal = myTerminal,
    focusFollowsMouse = myFocusFollowsMouse,
    clickJustFocuses = myClickJustFocuses,
    borderWidth = myBorderWidth,
    modMask = myModMask,
    workspaces = myWorkspaces,
    normalBorderColor = myNormalBorderColor,
    focusedBorderColor = myFocusedBorderColor,
    
    -- bindings
    mouseBindings = myMouseBindings,
    
    -- hooks
    layoutHook = myLayoutHook,
    manageHook = myManageHook,
    handleEventHook = myEventHook,
    logHook = myLogHook,
    startupHook = myStartupHook
  } `additionalKeysP` myKeys

