import './assets/main.css'

import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { RouterProvider } from '@tanstack/react-router'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { initializeRendererWindow, RendererRoot } from './app/renderer-root'
import { router } from './app/router'

const disposeRenderer = initializeRendererWindow(window)
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeRenderer()
    window.location.reload()
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RendererRoot>
      <HotkeysProvider>
        <RouterProvider router={router} />
      </HotkeysProvider>
    </RendererRoot>
  </React.StrictMode>,
)
