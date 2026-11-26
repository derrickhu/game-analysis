import 'dotenv/config';

import { initializeStorage } from '../src/server/db';
import { ensureAllGameIcons } from '../src/server/game-icons';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check-only');
  const forceRefresh = args.has('--force');
  const strict = args.has('--strict');

  // 若需要拉取缺失图标或强制刷新，尝试初始化存储以便复用 MySQL 中的微信 access_token 缓存；
  // 在离线/容器构建阶段若无法连接数据库则静默降级为 iconUrl + 本地工作区目录提取。
  const preCheck = await ensureAllGameIcons({ autoPull: false });
  if (!checkOnly && (forceRefresh || preCheck.missing.length > 0)) {
    try {
      await initializeStorage();
    } catch {
      // ignore DB connection failure during offline build
    }
  }

  const report = checkOnly
    ? preCheck
    : await ensureAllGameIcons({ autoPull: true, forceRefresh });

  for (const item of report.items) {
    const tag =
      item.status === 'ok'
        ? 'OK    '
        : item.status === 'pulled'
          ? 'PULLED'
          : 'MISS  ';
    const extra = item.message ? ` (${item.message})` : '';
    console.log(
      `[icons] ${tag} ${item.gameKey.padEnd(16)} ${item.displayName.padEnd(8)} ` +
        `bytes=${String(item.bytes).padStart(7)} format=${(item.format || '-').padEnd(4)} ` +
        `source=${item.source || '-'}${extra}`,
    );
  }

  console.log(
    `[icons] summary: ready=${report.ready}/${report.total}, pulled=${report.pulled}, missing=${report.missing.length}`,
  );

  if (report.missing.length > 0) {
    console.warn(
      `[icons] WARNING: 以下游戏缺少有效图标: ${report.missing.join(', ')}（前端将回退 default.svg，建议补充 wechatAppId / iconUrl / public/game-icons/{gameKey}.png）`,
    );
    if (strict) {
      process.exit(1);
    }
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('[icons] 检测脚本执行失败:', error);
  process.exit(1);
});
