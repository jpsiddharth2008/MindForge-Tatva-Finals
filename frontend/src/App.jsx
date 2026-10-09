import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { RequireOfficer } from './auth';
import Home from './pages/Home';
import Verify from './pages/Verify';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Issue from './pages/Issue';
import DocumentDetail from './pages/DocumentDetail';
import NotFound from './pages/NotFound';

/** The routes. Verification is public; everything under /officer needs a login (the server enforces it too, this only decides what to show). */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/verify" element={<Verify />} />
      <Route path="/officer/login" element={<Login />} />
      <Route path="/officer" element={<RequireOfficer><Dashboard /></RequireOfficer>} />
      <Route path="/officer/issue" element={<RequireOfficer><Issue /></RequireOfficer>} />
      <Route path="/officer/documents/:id" element={<RequireOfficer><DocumentDetail /></RequireOfficer>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
