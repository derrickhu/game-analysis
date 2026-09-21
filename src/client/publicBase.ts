/** 官网 / HTTP 网关挂载前缀。直连云托管根域名时不带此前缀。 */
export const PUBLIC_PREFIX = '/game-analysis';

export function getPublicBase(): string {
  if (typeof window === 'undefined') return '';
  const path = window.location.pathname;
  if (path === PUBLIC_PREFIX || path.startsWith(`${PUBLIC_PREFIX}/`)) {
    return PUBLIC_PREFIX;
  }
  const viteBase = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return viteBase === '/' ? '' : viteBase;
}

/** 静态资源路径：官网后缀下要带 /game-analysis，避免打到官网根目录。 */
export function publicPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${getPublicBase()}${normalized}`;
}

/** 后缀访问时把 /api 请求补到 /game-analysis/api，避免打到官网静态站。 */
export function installPublicApiPrefix(): void {
  const base = getPublicBase();
  if (!base) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(`${base}${input}`, init);
    }
    return nativeFetch(input, init);
  };
}
