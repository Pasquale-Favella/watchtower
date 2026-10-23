import './orb.css'

import React from 'react'
import ReactDOM from 'react-dom/client'

import { initializeRendererWindow, RendererRoot } from '../app/renderer-root'
import { OrbApp } from './OrbApp'

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
      <OrbApp />
    </RendererRoot>
  </React.StrictMode>,
)
