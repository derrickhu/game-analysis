#!/usr/bin/env node
/**
 * 清理 CloudBase analytics_events 集合里 seed-ad-events 脚本造的所有假数据。
 *
 * 识别条件：anonymous_id === 'seed_anon_001'（脚本里写死的 sentinel 值）
 * 并兜底校验 event_id 以 'seed-ad-' 开头，避免误删真实数据。
 *
 * 走 CloudBase Node SDK 直连数据库分批删除，不走 MCP（MCP 全表 delete 大批量会超时）。
 *
 * 用法：
 *   node scripts/cleanup-seed-events.mjs           # 真删（要确认）
 *   node scripts/cleanup-seed-events.mjs --dry-run # 只查不删
 */

import 'dotenv/config';
import tcb from '@cloudbase/node-sdk';

const COLLECTION = process.env.ANALYTICS_COLLECTION || 'analytics_events';
const ENV_ID = process.env.TCB_ENV;
const SECRET_ID = process.env.TENCENTCLOUD_SECRET_ID;
const SECRET_KEY = process.env.TENCENTCLOUD_SECRET_KEY;
const SEED_ANON_ID = 'seed_anon_001';
const SEED_ID_PREFIX = 'seed-ad-';
const PAGE_SIZE = 100;

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');

if (!ENV_ID || !SECRET_ID || !SECRET_KEY) {
  console.error('缺少 TCB_ENV / TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY 环境变量（请检查 .env）');
  process.exit(1);
}

const app = tcb.init({ env: ENV_ID, secretId: SECRET_ID, secretKey: SECRET_KEY });
const db = app.database();
const _ = db.command;

async function countSeed() {
  const res = await db.collection(COLLECTION).where({ anonymous_id: SEED_ANON_ID }).count();
  return Number(res.total || 0);
}

async function fetchIdsBatch() {
  const res = await db
    .collection(COLLECTION)
    .where({ anonymous_id: SEED_ANON_ID })
    .field({ _id: true, event_id: true })
    .limit(PAGE_SIZE)
    .get();
  const docs = Array.isArray(res.data) ? res.data : [];
  return docs
    .filter((d) => typeof d._id === 'string' && d._id.startsWith(SEED_ID_PREFIX))
    .map((d) => d._id);
}

async function deleteByIds(ids) {
  if (ids.length === 0) return 0;
  const res = await db
    .collection(COLLECTION)
    .where({ _id: _.in(ids) })
    .remove();
  return Number(res.deleted || 0);
}

async function main() {
  console.log(`[cleanup] env=${ENV_ID} collection=${COLLECTION}`);
  console.log(`[cleanup] 识别条件：anonymous_id='${SEED_ANON_ID}' AND event_id startsWith '${SEED_ID_PREFIX}'`);
  const before = await countSeed();
  console.log(`[cleanup] seed events before=${before}`);
  if (before === 0) {
    console.log('[cleanup] 没有需要清理的 seed 数据，直接退出');
    return;
  }
  if (DRY_RUN) {
    const sample = await fetchIdsBatch();
    console.log(`[cleanup] dry-run，未删除。前 ${sample.length} 条样例 _id：`);
    sample.slice(0, 5).forEach((id) => console.log('  -', id));
    return;
  }
  let totalDeleted = 0;
  let page = 0;
  while (true) {
    const ids = await fetchIdsBatch();
    if (ids.length === 0) break;
    page += 1;
    const deleted = await deleteByIds(ids);
    totalDeleted += deleted;
    console.log(`[cleanup] 第 ${page} 批：取到 ${ids.length}，删除 ${deleted}（累计 ${totalDeleted}/${before}）`);
    if (page > 50) {
      console.warn('[cleanup] 已经跑 50 批，安全起见停止；剩余请再次运行脚本');
      break;
    }
  }
  const after = await countSeed();
  console.log(`[cleanup] seed events after=${after}（应为 0）`);
  console.log(`[cleanup] 总共删除 ${totalDeleted} 条`);
}

main().catch((err) => {
  console.error('[cleanup] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
