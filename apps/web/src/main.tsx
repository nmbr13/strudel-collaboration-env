import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// No <StrictMode>: in dev it double-mounts and tears down effects immediately, which
// closes room/Yjs WebSockets mid-handshake and spams "closed before connection is established".
// Production does not double-invoke; re-enable StrictMode locally when auditing effect cleanup.

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
