import { createContext } from 'react';

// A wide Shell owns global navigation and window insets once for all its panes.
export const ShellNavigationContext = createContext(false);
export const PaneInsetsContext = createContext(false);
// How far below the window's top the Shell's screen starts (pane edge plus any Pausa general strip). A KeyboardAvoidingView measures
// itself against its parent, not the window, so it needs this to know where the keyboard really is.
export const PaneTopContext = createContext(0);
