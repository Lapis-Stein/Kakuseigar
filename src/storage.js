export const STORAGE_KEY = 'kakuseigar:session:v1';

export function createStorage(provider = () => window.sessionStorage, key = STORAGE_KEY) {
  let available = true;
  return {
    get available() { return available; },
    read() {
      try {
        const value = provider().getItem(key);
        return value === null ? null : JSON.parse(value);
      } catch { available = false; return null; }
    },
    write(state) {
      try { provider().setItem(key, JSON.stringify(state)); return true; }
      catch { available = false; return false; }
    },
    clear() {
      try { provider().removeItem(key); return true; }
      catch { available = false; return false; }
    },
  };
}

export function fingerprint(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}
