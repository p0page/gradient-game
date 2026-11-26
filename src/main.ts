import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;

if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(new URL('./sw.js', document.baseURI)).catch((error: unknown) => {
    console.warn('无法缓存离线页面。', error);
  });
}
