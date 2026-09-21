import tcb from '@cloudbase/node-sdk';

const tcbAppCache = new Map<string, ReturnType<typeof tcb.init>>();

function readOptionalSecrets(): { secretId: string; secretKey: string; sessionToken: string } {
  return {
    secretId: process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '',
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '',
    sessionToken: process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '',
  };
}

/** 云托管同环境内可省略密钥，由运行时注入；本地开发仍走 .env 里的长期密钥 */
export function getTcbApp(envId: string): ReturnType<typeof tcb.init> {
  const cached = tcbAppCache.get(envId);
  if (cached) return cached;

  const { secretId, secretKey, sessionToken } = readOptionalSecrets();
  const app =
    secretId && secretKey
      ? tcb.init({
          env: envId,
          secretId,
          secretKey,
          sessionToken: sessionToken || undefined,
        })
      : tcb.init({
          env: envId || tcb.SYMBOL_CURRENT_ENV,
        });

  tcbAppCache.set(envId, app);
  return app;
}
