import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register Service Worker immediately so the Vercel app works 100% offline on Wi-Fi / Hotspot without internet
registerSW({immediate: true});

createRoot(document.getElementById('root')!).render(<App />);

