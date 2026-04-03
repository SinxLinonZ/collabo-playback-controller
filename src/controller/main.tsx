import { MantineProvider, createTheme } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import '@mantine/core/styles.css';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing #root mount element.');
}

const theme = createTheme({
  primaryColor: 'blue',
  fontFamily: '"SF Pro Text", "Segoe UI", sans-serif',
  defaultRadius: 'md',
});

createRoot(rootElement).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <App />
  </MantineProvider>,
);
