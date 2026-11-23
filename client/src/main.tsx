import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { registerPwa } from './pwa/register.ts';
import './styles/main.css';

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
registerPwa();
