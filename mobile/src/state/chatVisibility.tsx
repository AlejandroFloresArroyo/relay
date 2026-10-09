import { createContext, useContext } from 'react';

const ChatVisibilityContext = createContext(false);
export const ChatVisibilityProvider = ChatVisibilityContext.Provider;

export function useChatVisible(): boolean {
  return useContext(ChatVisibilityContext);
}
