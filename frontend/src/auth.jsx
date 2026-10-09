import React, { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { hasToken, onAuthChange, clearToken } from './api';

const AuthContext = createContext({ loggedIn: false, logout: () => {} });

/** Follows the officer's session (kept in memory by api.js), including the server ending it. */
export function AuthProvider({ children }) {
  const [loggedIn, setLoggedIn] = useState(hasToken());
  useEffect(() => onAuthChange(setLoggedIn), []);
  return <AuthContext.Provider value={{ loggedIn, logout: clearToken }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** Pages for officers only: anyone else is sent to the login page, and brought back afterwards. */
export function RequireOfficer({ children }) {
  const { loggedIn } = useAuth();
  const location = useLocation();
  if (!loggedIn) return <Navigate to="/officer/login" replace state={{ from: location.pathname }} />;
  return children;
}
