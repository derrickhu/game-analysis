#!/usr/bin/env node
/**
 * 给 analytics-ingest 造一批"假的广告测试事件"，用于联调 dashboard 完整效果。
 *
 * 模拟 hot-pot 真实场景：
 *  - scene=level_fail_revive  ad_type=reward  ECPM=35元/千次
 *  - scene=tool_help_free     ad_type=reward  ECPM=30元/千次（fallback hotpot.reward）
 *  - scene=unlock_next_order_plate ad_type=reward ECPM=30元/千次
 *
 * 每个场景每分钟若干 ad_request -> ad_show -> ad_close(completed=true) 三连，
 * 部分追加 ad_click。共覆盖最近 N 分钟，让 dashboard 折线图明显有曲线。
 *
 * 事件 event_id 使用固定前缀 + 索引，方便后面用 cleanup 模式精准删除。
 *
 * 用法：
 *   node scripts/seed-ad-events.mjs                       # 默认 hotpot 30 分钟桶
 *   node scripts/seed-ad-events.mjs --game huahua         # 指定游戏
 *   node scripts/seed-ad-events.mjs --minutes 60 --rate 8 # 60 分钟桶，每分钟每场景 8 次
 *   node scripts/seed-ad-events.mjs --cleanup             # 清理之前 seed 进去的所有事件
 */

const ENDPOINT_BASE = 'https://rosa-env-d7grf78r5dbd37323.service.tcloudbase.com/analytics-ingest';
const SEED_PREFIX = 'seed-ad-'; // 所有种子事件的 event_id 都以此开头，便于清理

const argv = parseArgs(process.argv.slice(2));
const GAME_KEY = argv.game || 'hotpot';
const MINUTES = Number.parseInt(argv.minutes || '30', 10);
const PER_SCENE_PER_MINUTE = Number.parseInt(argv.rate || '5', 10);
const DO_CLEANUP = Boolean(argv.cleanup);

const SCENES = [
  { scene: 'level_fail_revive',       ad_type: 'reward', ad_unit_id: 'adunit-test-revive' },
  { scene: 'tool_help_free',          ad_type: 'reward', ad_unit_id: 'adunit-test-tool' },
  { scene: 'unlock_next_order_plate', ad_type: 'reward', ad_unit_id: 'adunit-test-unlock' },
];

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const k = args[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function nowMinuteFloorMs() {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function genEventId(slot) {
  return `${SEED_PREFIX}${slot}`;
}

function buildBatch() {
  const batch = [];
  const baseMinuteMs = nowMinuteFloorMs();
  const anonymousId = 'seed_anon_001';
  const sessionId = 'seed_sess_001';
  let seq = 0;

  for (let m = MINUTES - 1; m >= 0; m -= 1) {
    // 当前桶 = baseMinuteMs - m 分钟
    const minuteStartMs = baseMinuteMs - m * 60_000;
    for (const sc of SCENES) {
      // 每个 scene 在这分钟里造 PER_SCENE_PER_MINUTE 组 (request -> show -> close)
      for (let n = 0; n < PER_SCENE_PER_MINUTE; n += 1) {
        // 在这一分钟内随机分布
        const offset = Math.floor(Math.random() * 55_000); // 0~55s
        const tsRequest = minuteStartMs + offset;
        const tsShow = tsRequest + 200 + Math.floor(Math.random() * 500);
        const tsClose = tsShow + 15_000 + Math.floor(Math.random() * 5_000);
        const completed = Math.random() > 0.15; // 85% 完播率

        const baseParams = {
          ad_unit_id: sc.ad_unit_id,
          ad_type: sc.ad_type,
          scene: sc.scene,
        };

        seq += 1;
        batch.push(buildEvent('ad_request', tsRequest, anonymousId, sessionId, seq, baseParams));
        seq += 1;
        batch.push(buildEvent('ad_show', tsShow, anonymousId, sessionId, seq, baseParams));
        seq += 1;
        batch.push(buildEvent('ad_close', tsClose, anonymousId, sessionId, seq, { ...baseParams, completed }));

        // 30% 概率再补一条 ad_click（模拟用户在播放过程中点击 CTA）
        if (Math.random() < 0.3) {
          seq += 1;
          batch.push(
            buildEvent('ad_click', tsShow + 5_000 + Math.floor(Math.random() * 5_000), anonymousId, sessionId, seq, baseParams),
          );
        }
      }
    }
  }
  return batch;
}

function buildEvent(eventName, ts, anonymousId, sessionId, seq, params) {
  return {
    event_id: genEventId(`${ts}-${seq}`),
    event_name: eventName,
    event_ts: ts,
    game_key: GAME_KEY,
    app_version: '1.0.0',
    sdk_version: '0.1.0',
    platform: 'wechat-mg',
    user_id: '',
    anonymous_id: anonymousId,
    session_id: sessionId,
    session_seq: seq,
    device: {
      brand: 'seed',
      model: 'seed-script',
      system: 'darwin',
      sdk_version: '3.15.1',
      screen_w: 0,
      screen_h: 0,
      network: 'wifi',
    },
    params,
  };
}

async function postBatch(batch) {
  // 每批最多 100 条（云函数侧硬限），超出就分多批
  let total = 0;
  let acceptedAll = 0;
  let dedupedAll = 0;
  let failedAll = 0;
  for (let i = 0; i < batch.length; i += 100) {
    const slice = batch.slice(i, i + 100);
    const res = await fetch(`${ENDPOINT_BASE}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: slice }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      console.error(`  ! 批 ${i / 100 + 1} 失败 status=${res.status} body=${JSON.stringify(json)}`);
    } else {
      console.log(`  - 批 ${i / 100 + 1}: accepted=${json.accepted} deduped=${json.deduped} failed=${json.failed}`);
      acceptedAll += json.accepted || 0;
      dedupedAll += json.deduped || 0;
      failedAll += json.failed || 0;
    }
    total += slice.length;
  }
  return { total, accepted: acceptedAll, deduped: dedupedAll, failed: failedAll };
}

async function runSeed() {
  console.log(`[seed] target=${ENDPOINT_BASE}/track`);
  console.log(`[seed] game=${GAME_KEY} minutes=${MINUTES} per-scene-per-minute=${PER_SCENE_PER_MINUTE} scenes=${SCENES.length}`);
  const batch = buildBatch();
  console.log(`[seed] generated ${batch.length} events`);
  const result = await postBatch(batch);
  console.log(`[seed] done: total=${result.total} accepted=${result.accepted} deduped=${result.deduped} failed=${result.failed}`);
  console.log(`[seed] 提示：等 30 秒让经分后端 cron 拉取，然后刷新 dashboard 看「广告实时（事件流）」`);
}

async function runCleanup() {
  console.log(`[cleanup] 走经分本地后端代理删除（云函数本身没暴露 delete 接口，云端清理需要用 CloudBase MCP/控制台对 event_id 前缀=${SEED_PREFIX} 删）`);
  console.log(`[cleanup] 客户端这一侧只能告诉你：seed 出去的所有 event_id 都以 "${SEED_PREFIX}" 开头`);
  console.log('[cleanup] 推荐做法：直接用 Cursor agent 跑一句"用 CloudBase MCP 删 analytics_events 集合中 event_id 前缀为 seed-ad- 的所有文档"');
}

async function main() {
  if (DO_CLEANUP) {
    await runCleanup();
    return;
  }
  await runSeed();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
