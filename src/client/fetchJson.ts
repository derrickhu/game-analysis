/** 解析经分 API 响应；后端未启动或代理失败时给出可读错误，避免空 body 的 JSON.parse 异常 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new Error(`无法连接后端（${url}）：${String(error)}。请确认 npm run api 已在 8787 端口运行。`);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(
      res.ok
        ? `接口返回空响应（${url}）`
        : `后端不可用（HTTP ${res.status}，${url}）。请确认 npm run api 已在 8787 端口运行。`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
}
