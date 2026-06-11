import { useState, useCallback } from 'react';

const STORAGE_KEY = 'oceo_user_name';

export function useIdentity() {
  const [userName, setUserNameState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  const setUserName = useCallback((name: string) => {
    const trimmed = name.trim();
    setUserNameState(trimmed);
    try {
      if (trimmed) {
        localStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* no-op */ }
  }, []);

  return { userName, setUserName, hasIdentity: !!userName };
}
