import './orb.css'

import React from 'react'
import ReactDOM from 'react-dom/client'

import { initializeRendererWindow, RendererRoot } from '../app/renderer-root'
import { OrbPanelApp } from './OrbPanelApp'

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
      <OrbPanelApp />
    </RendererRoot>
  </React.StrictMode>,
)
