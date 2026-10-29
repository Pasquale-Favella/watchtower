import './assets/main.css'

import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { RouterProvider } from '@tanstack/react-router'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { initializeRendererWindow, RendererRoot } from './app/renderer-root'
import { router } from './app/router'

const reactRoot = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
const disposeRenderer = initializeRendererWindow(window, { beforeDispose: () => reactRoot.unmount() })
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeRenderer()
    window.location.reload()
  })
}

reactRoot.render(
  <React.StrictMode>
    <RendererRoot>
      <HotkeysProvider>
        <RouterProvider router={router} />
      </HotkeysProvider>
    </RendererRoot>
  </React.StrictMode>,
)
