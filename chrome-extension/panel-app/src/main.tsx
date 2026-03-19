import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App';
import styles from './styles.css?inline';

declare global {
  interface Window {
    __cv_sr?: ShadowRoot;
    __cv_bus?: EventTarget;
    __cv_close?: () => void;
  }
}

function mountApp() {
  const shadowRoot = window.__cv_sr;

  if (!shadowRoot) return;

  const rootElement = shadowRoot.getElementById("root");
  if (!rootElement) return;

  const styleSheet = document.createElement('style');
  styleSheet.textContent = styles;
  shadowRoot.insertBefore(styleSheet, shadowRoot.firstChild);

  const root = ReactDOM.createRoot(rootElement);
  root.render(<App />);
}

mountApp();
