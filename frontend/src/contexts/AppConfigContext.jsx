import { createContext, useContext } from 'react';

export const AppConfigContext = createContext({ dbTimezone: null });

export function useAppConfig() {
  return useContext(AppConfigContext);
}
