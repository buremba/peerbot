import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup';

const container = document.getElementById('app');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Popup />
    </StrictMode>
  );
}
