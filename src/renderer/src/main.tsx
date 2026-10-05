import React from 'react'
import ReactDOM from 'react-dom/client'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './app/router'
import './assets/main.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HotkeysProvider>
      <RouterProvider router={router} />
    </HotkeysProvider>
  </React.StrictMode>,
)
