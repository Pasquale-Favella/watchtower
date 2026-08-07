import React from 'react'
import ReactDOM from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { AppShell } from './app/AppShell'
import './assets/main.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HotkeysProvider>
      <AppShell />
    </HotkeysProvider>
  </React.StrictMode>
)
