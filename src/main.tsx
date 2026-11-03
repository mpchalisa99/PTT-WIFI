import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Clean up any legacy conflicting Service Worker registrations that could trigger controllerchange reloads
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const reg of registrations) {
        const scriptUrl =
          reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        if (scriptUrl.includes('tactical-bg-sw.js')) {
          reg.unregister().catch(() => {});
        }
      }
    })
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(<App />);


