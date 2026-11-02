import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register Service Worker immediately in production so the app works 100% offline on Wi-Fi / Hotspot without internet
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  try {
    registerSW({immediate: true});
  } catch {
    // Ignore SW registration errors in restricted preview environments
  }
}

createRoot(document.getElementById('root')!).render(<App />);

