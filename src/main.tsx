import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { prepareSound } from './engine/sound'
import './styles.css'

// Fetch the interface sounds now; the audio clock itself starts on the first
// gesture, which is a rule every browser enforces.
prepareSound()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
