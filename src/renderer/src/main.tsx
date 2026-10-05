import React from 'react'
import ReactDOM from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { RouterProvider } from '@tanstack/react-router'
import { navigateToSection } from './app/navigation'
import { router } from './app/router'
import { onAppNavigate } from './shared/lib/api'
import './assets/main.css'

// The background orb reopens the app on a section — through the same
// navigation entry point as the sidebar and shortcuts (ADR 0014).
onAppNavigate(navigateToSection)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HotkeysProvider>
      <RouterProvider router={router} />
    </HotkeysProvider>
  </React.StrictMode>,
)
