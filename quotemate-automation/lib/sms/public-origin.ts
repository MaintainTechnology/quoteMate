/** Customer links always belong to the website, never the engine's API host. */
export function publicWebOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_WEB_ORIGIN?.trim() || env.APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL?.trim()
  if (!configured) throw new Error('PUBLIC_WEB_ORIGIN is required for customer links')
  const url = new URL(configured)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Public web URL must be an origin without credentials, path or query')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) {
    throw new Error('Public web origin must use HTTPS')
  }
  if ((env.NODE_ENV === 'production' && (local || /^[\d.]+$/.test(url.hostname))) ||
      url.hostname.endsWith('.up.railway.app') ||
      (env.ENGINE_BASE_URL && new URL(env.ENGINE_BASE_URL).origin === url.origin)) {
    throw new Error('Public web origin cannot be an engine or local API origin')
  }
  return url.origin
}

export function publicWebUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected a website-relative path')
  return new URL(path, publicWebOrigin(env)).href
}
