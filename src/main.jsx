import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { ErrorBoundary } from './App.jsx'
import DevicePairingGate from './DevicePairingGate.jsx'
import SystemHealthControl from './SystemHealthControl.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DevicePairingGate>
        <App />
        <SystemHealthControl />
      </DevicePairingGate>
    </ErrorBoundary>
  </React.StrictMode>
)

// Регистрация Service Worker для офлайн-режима
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).then(registration => {
      registration.update().catch(() => {});
      navigator.serviceWorker.ready.then(() => {
        navigator.serviceWorker.controller?.postMessage({type:'CHECK_OFFLINE_SHELL'});
      });
    }).catch(err => {
      console.warn('[SW] registration failed:', err);
    });
  });
}
