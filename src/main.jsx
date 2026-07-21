import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Rekisteröi Service Workerin heti (ei enää vain push-luvan yhteydessä),
// jotta se alkaa välimuistittaa sovellusta ja PDF/Excel-vientikirjastoja
// offline-käyttöä varten heti ensimmäisestä latauksesta lähtien.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
