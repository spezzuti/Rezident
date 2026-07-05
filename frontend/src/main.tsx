import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { initSkin } from './App'
import './index.css'

initSkin()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
