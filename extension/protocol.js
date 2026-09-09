export const LOCAL_API = 'http://127.0.0.1:8765';

export function stableFormSignature(fingerprints) {
  const text = [...new Set(fingerprints.filter(Boolean))].sort().join('\n');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `form-${(hash >>> 0).toString(16)}`;
}

export function buildApiRequest(path, options = {}, token = '') {
  const headers = {...(options.headers || {})};
  delete headers.Authorization;
  delete headers.authorization;
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return {path, ...options, headers};
}
