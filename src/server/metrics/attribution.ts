import { getMysqlPool } from '../db';
import {
  initAttributionStorage,
  replaceAttributedUserDaily,
  upsertAttributionTouchpoints,
  upsertPostbackQueue,
  upsertUserAttributions,
  type AttributedUserDailyRow,
  type AttributionTouchpointRow,
  type PostbackQueueRow,
  type UserAttributionRow,
} from '../attribution-db';
import { toLocalDateKey } from './ltv';
import { isPlatformFilterActive } from './platform-filter';
import { buildTencentAdsDryRunPayload } from '../postbacks/tencent-ads';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

/**
 * attribution 相关表（attributed_user_daily / attribution_touchpoints）没有埋点 platform 列，
 * 这里的 platform 字段是广告商 provider，不能用来过滤。改用 EXISTS 关联 analytics_events 的
 * session_start 记录，按 user_key 判断该用户是否属于指定埋点平台。
 * 注意：这里的 platform 是渠道筛选（wechat/douyin/all），不要跟归因表自己的 provider/platform 字段混淆。
 */
function platformExistsFilter(userKeyExpr: string): string {
  return ` AND (? = '' OR EXISTS (
        SELECT 1 FROM analytics_events pfe
         WHERE pfe.game_key = ?
           AND ${USER_KEY_SQL.replace(/\buser_id\b/g, 'pfe.user_id').replace(/\banonymous_id\b/g, 'pfe.anonymous_id')} = ${userKeyExpr}
           AND pfe.event_name = 'session_start'
           AND pfe.platform = ?
      ))`;
}

function platformExistsParams(gameKey: string, platform?: string): unknown[] {
  const normalized = isPlatformFilterActive(platform) ? String(platform) : '';
  return [normalized, gameKey, normalized];
}

interface RawEventRow {
  event_id: string;
  event_name: string;
  event_ts: number;
  user_key: string;
  user_id: string;
  anonymous_id: string;
  session_id: string;
  params_json: string | Record<string, unknown> | null;
}

interface FirstSeenRow {
  user_key: string;
  user_id: string;
  anonymous_id: string;
  first_seen_ts: number;
}

export interface AttributionRecomputeResult {
  game_key: string;
  from_date: string;
  to_date: string;
  touchpoints_upserted: number;
  users_attributed: number;
  user_daily_rows: number;
  postback_rows: number;
}

export interface AttributionOverviewRow {
  key: string;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  users: number;
  new_users: number;
  active_user_days: number;
  d1_retained_users: number;
  d3_retained_users: number;
  d7_retained_users: number;
  d1_retention_rate: number | null;
  d3_retention_rate: number | null;
  d7_retention_rate: number | null;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  avg_ltv_estimated_cny: number | null;
  tutorial_complete_users: number;
  order_deliver_users: number;
  first_ad_show_users: number;
  max_star_level: number;
}

export interface AttributionDailyCohortRow {
  cohort_date: string;
  new_users: number;
  paid_or_known_users: number;
  organic_users: number;
  unknown_users: number;
  click_id_users: number;
}

export interface ReengagementDailyRow {
  touch_date: string;
  reengaged_users: number;
  paid_or_known_users: number;
  click_id_users: number;
  touch_events: number;
}

export interface ReengagementProviderRow {
  key: string;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  reengaged_users: number;
  touch_events: number;
}

export interface AttributionOverview {
  game_key: string;
  from_date: string;
  to_date: string;
  summary: {
    /** 期间内首次出现（注册 cohort）且已完成归因绑定的用户数 */
    attributed_users: number;
    paid_or_known_users: number;
    organic_users: number;
    unknown_users: number;
    click_id_users: number;
    fallback_users: number;
    postback_dry_run: number;
  };
  daily_cohorts: AttributionDailyCohortRow[];
  reengagement_summary: {
    reengaged_users: number;
    paid_or_known_users: number;
    click_id_users: number;
    touch_events: number;
  };
  reengagement_daily: ReengagementDailyRow[];
  reengagement_by_provider: ReengagementProviderRow[];
  rankings: AttributionOverviewRow[];
  quality: Array<{ key: string; label: string; count: number; ratio: number }>;
  recent_touchpoints: Array<Record<string, unknown>>;
  recent_postbacks: Array<Record<string, unknown>>;
}

function parseParams(value: RawEventRow['params_json']): Record<string, unknown> {
  return parseJsonObject(value);
}

/** MySQL JSON 列读出来可能是 object，也可能是 string */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value || '{}';
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeDateRange(fromDate?: string, toDate?: string): { fromDate: string; toDate: string } {
  const today = toLocalDateKey(Date.now());
  return {
    fromDate: fromDate || today,
    toDate: toDate || fromDate || today,
  };
}

function dateStartTs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+08:00`).getTime();
}

function dateEndTs(dateKey: string): number {
  return new Date(`${dateKey}T23:59:59.999+08:00`).getTime();
}

function ageDay(firstSeenDate: string, dateKey: string): number {
  return Math.floor((dateStartTs(dateKey) - dateStartTs(firstSeenDate)) / 86_400_000);
}

function attributionType(params: Record<string, unknown>, provider: string): string {
  if (str(params.click_id) || str(params.gdt_vid)) return 'click';
  if (provider === 'share') return 'share';
  if (provider && provider !== 'unknown' && provider !== 'organic') return 'click';
  return provider === 'organic' ? 'organic' : 'unknown';
}

function matchType(params: Record<string, unknown>, provider: string): string {
  const match = str(params.match_source || params.attr_match_source);
  if (match === 'gdt_vid' || match === 'click_id' || match === 'cb') return 'deterministic';
  if (match === 'campaign_params' || match === 'utm') return 'parameter';
  if (provider === 'organic') return 'organic';
  return 'fallback';
}

function confidenceFor(match: string, type: string): number {
  if (match === 'deterministic') return 1;
  if (match === 'parameter') return 0.75;
  if (type === 'share') return 0.7;
  if (type === 'organic') return 0.5;
  return 0.2;
}

function touchpointFromEvent(row: RawEventRow): AttributionTouchpointRow | null {
  const params = parseParams(row.params_json);
  const isTouchEvent = row.event_name === 'attribution_touchpoint';
  const provider = str(params.provider || params.attr_provider || params.attribution_first_provider);
  const campaignId = str(params.campaign_id || params.attr_campaign_id);
  const adgroupId = str(params.adgroup_id || params.attr_adgroup_id);
  const creativeId = str(params.creative_id || params.attr_creative_id);
  const clickId = str(params.click_id || params.attr_click_id);
  const gdtVid = str(params.gdt_vid || params.attr_gdt_vid);
  const launchScene = str(params.launch_scene || params.attr_launch_scene || params.attribution_first_launch_scene);
  const hasSignal =
    isTouchEvent ||
    provider ||
    campaignId ||
    adgroupId ||
    creativeId ||
    clickId ||
    gdtVid ||
    launchScene;
  if (!hasSignal || !row.user_key) return null;

  const source = str(params.touch_source || (isTouchEvent ? 'touchpoint' : row.event_name));
  const touchId = str(params.touch_id) || `${row.event_id}:${source}`;
  const normalizedProvider = provider || (clickId || gdtVid ? 'tencent_ads' : 'unknown');
  return {
    game_key: '',
    touch_id: touchId,
    event_id: row.event_id,
    user_key: row.user_key,
    user_id: row.user_id || '',
    anonymous_id: row.anonymous_id || '',
    session_id: row.session_id || '',
    event_ts: Number(row.event_ts),
    provider: normalizedProvider,
    channel: str(params.channel || params.attr_channel || normalizedProvider),
    campaign_id: campaignId,
    adgroup_id: adgroupId,
    creative_id: creativeId,
    click_id: clickId,
    gdt_vid: gdtVid,
    launch_scene: launchScene,
    match_source: str(params.match_source || params.attr_match_source) || 'none',
    is_first_touch: bool(params.is_first_touch) ? 1 : 0,
    raw_json: JSON.stringify(params),
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

export async function syncAttributionTouchpoints(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  await initAttributionStorage();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_id, event_name, event_ts, ${USER_KEY_SQL} AS user_key,
            user_id, anonymous_id, session_id, params_json
       FROM analytics_events
      WHERE game_key = ?
        AND event_ts BETWEEN ? AND ?
        AND event_name IN ('attribution_touchpoint', 'session_start', 'login')
      ORDER BY event_ts ASC`,
    [gameKey, fromTs, toTs],
  );
  const touchpoints = (rows as RawEventRow[])
    .map(touchpointFromEvent)
    .filter((row): row is AttributionTouchpointRow => !!row)
    .map((row) => ({ ...row, game_key: gameKey }));
  return upsertAttributionTouchpoints(touchpoints);
}

async function listFirstSeen(gameKey: string): Promise<FirstSeenRow[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT ${USER_KEY_SQL} AS user_key,
            MAX(user_id) AS user_id,
            MAX(anonymous_id) AS anonymous_id,
            MIN(event_ts) AS first_seen_ts
       FROM analytics_events
      WHERE game_key = ?
      GROUP BY ${USER_KEY_SQL}`,
    [gameKey],
  );
  return rows as FirstSeenRow[];
}

async function listTouchpointsByUser(gameKey: string): Promise<Map<string, AttributionTouchpointRow[]>> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM attribution_touchpoints WHERE game_key = ? ORDER BY user_key, event_ts ASC`,
    [gameKey],
  );
  const out = new Map<string, AttributionTouchpointRow[]>();
  for (const row of rows as AttributionTouchpointRow[]) {
    const list = out.get(row.user_key) || [];
    list.push(row);
    out.set(row.user_key, list);
  }
  return out;
}

/** 首触只认「注册当天」的启动触点，避免老用户投流后回流污染历史 cohort */
function selectRegistrationDayFirstTouch(
  firstSeenTs: number,
  touches: AttributionTouchpointRow[] | undefined,
): AttributionTouchpointRow | undefined {
  if (!touches || touches.length === 0) return undefined;
  const firstSeenDate = toLocalDateKey(firstSeenTs);
  const dayStart = dateStartTs(firstSeenDate);
  const dayEnd = dateEndTs(firstSeenDate);
  const onRegistrationDay = touches.filter((t) => t.event_ts >= dayStart && t.event_ts <= dayEnd);
  if (onRegistrationDay.length === 0) return undefined;
  return onRegistrationDay.reduce((min, t) => (t.event_ts < min.event_ts ? t : min));
}

export async function resolveUserAttribution(gameKey: string): Promise<number> {
  await initAttributionStorage();
  const [firstSeen, touchpointsByUser] = await Promise.all([
    listFirstSeen(gameKey),
    listTouchpointsByUser(gameKey),
  ]);
  const now = Date.now();
  const rows: UserAttributionRow[] = firstSeen.map((user) => {
    const touch = selectRegistrationDayFirstTouch(
      Number(user.first_seen_ts || 0),
      touchpointsByUser.get(user.user_key),
    );
    const raw = touch ? parseJsonObject(touch.raw_json) : {};
    const provider = touch?.provider || 'organic';
    const type = touch ? attributionType(raw, provider) : 'organic';
    const match = touch ? matchType(raw, provider) : 'organic';
    return {
      game_key: gameKey,
      user_key: user.user_key,
      user_id: user.user_id || '',
      anonymous_id: user.anonymous_id || '',
      first_seen_ts: Number(user.first_seen_ts || 0),
      attributed_at: touch?.event_ts || Number(user.first_seen_ts || 0),
      attribution_type: type,
      match_type: match,
      confidence: confidenceFor(match, type),
      provider,
      channel: touch?.channel || provider,
      campaign_id: touch?.campaign_id || '',
      adgroup_id: touch?.adgroup_id || '',
      creative_id: touch?.creative_id || '',
      click_id: touch?.click_id || '',
      gdt_vid: touch?.gdt_vid || '',
      launch_scene: touch?.launch_scene || '',
      touch_id: touch?.touch_id || '',
      raw_json: stringifyJson(touch?.raw_json),
      updated_at: now,
    };
  });
  return upsertUserAttributions(rows);
}

export async function recomputeAttributedUserDaily(
  gameKey: string,
  fromDate?: string,
  toDate?: string,
): Promise<number> {
  await initAttributionStorage();
  const { fromDate: from, toDate: to } = normalizeDateRange(fromDate, toDate);
  const pool = await getMysqlPool();
  const [userRows] = await pool.query(
    `SELECT
       ud.game_key, ud.date_key, ud.user_key, ud.first_seen_date, ud.is_new_user, ud.is_active,
       ud.session_cnt, ud.ad_show_cnt, ud.ad_revenue_estimated_cny,
       ua.user_id, ua.anonymous_id, ua.provider, ua.channel, ua.campaign_id, ua.adgroup_id,
       ua.creative_id, ua.attribution_type, ua.match_type, ua.confidence
     FROM analytics_user_daily ud
     LEFT JOIN user_attribution ua ON ud.game_key = ua.game_key AND ud.user_key = ua.user_key
     WHERE ud.game_key = ? AND ud.date_key BETWEEN ? AND ?`,
    [gameKey, from, to],
  );

  const [deepRows] = await pool.query(
    `SELECT
       ${USER_KEY_SQL} AS user_key,
       DATE_FORMAT(FROM_UNIXTIME(event_ts / 1000), '%Y-%m-%d') AS date_key,
       SUM(CASE WHEN event_name = 'tutorial_step'
                  AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.step_id')) = 'tutorial_completed'
                THEN 1 ELSE 0 END) AS tutorial_complete_cnt,
       SUM(CASE WHEN event_name = 'order_deliver' THEN 1 ELSE 0 END) AS order_deliver_cnt,
       MAX(CASE WHEN event_name = 'star_level_up'
                THEN COALESCE(CAST(JSON_EXTRACT(params_json, '$.new_level') AS SIGNED), 0)
                ELSE 0 END) AS max_star_level
     FROM analytics_events
     WHERE game_key = ?
       AND event_ts BETWEEN ? AND ?
       AND event_name IN ('tutorial_step', 'order_deliver', 'star_level_up')
     GROUP BY user_key, date_key`,
    [gameKey, dateStartTs(from), dateEndTs(to)],
  );
  const deepMap = new Map<string, { tutorial_complete_cnt: number; order_deliver_cnt: number; max_star_level: number }>();
  for (const row of deepRows as Array<Record<string, unknown>>) {
    deepMap.set(`${row.user_key}|${row.date_key}`, {
      tutorial_complete_cnt: num(row.tutorial_complete_cnt),
      order_deliver_cnt: num(row.order_deliver_cnt),
      max_star_level: num(row.max_star_level),
    });
  }

  const now = Date.now();
  const out: AttributedUserDailyRow[] = (userRows as Array<Record<string, unknown>>).map((row) => {
    const deep = deepMap.get(`${row.user_key}|${row.date_key}`) || {
      tutorial_complete_cnt: 0,
      order_deliver_cnt: 0,
      max_star_level: 0,
    };
    const provider = str(row.provider) || 'organic';
    return {
      game_key: gameKey,
      date_key: str(row.date_key),
      user_key: str(row.user_key),
      user_id: str(row.user_id),
      anonymous_id: str(row.anonymous_id),
      first_seen_date: str(row.first_seen_date),
      is_new_user: num(row.is_new_user),
      is_active: num(row.is_active),
      provider,
      channel: str(row.channel) || provider,
      campaign_id: str(row.campaign_id),
      adgroup_id: str(row.adgroup_id),
      creative_id: str(row.creative_id),
      attribution_type: str(row.attribution_type) || 'organic',
      match_type: str(row.match_type) || 'organic',
      confidence: Number(row.confidence ?? 0.5),
      session_cnt: num(row.session_cnt),
      ad_show_cnt: num(row.ad_show_cnt),
      ad_revenue_estimated_cny: Number(row.ad_revenue_estimated_cny || 0),
      tutorial_complete_cnt: deep.tutorial_complete_cnt,
      order_deliver_cnt: deep.order_deliver_cnt,
      max_star_level: deep.max_star_level,
      updated_at: now,
    };
  });
  return replaceAttributedUserDaily(gameKey, from, to, out);
}

export async function generatePostbackDryRun(
  gameKey: string,
  fromDate?: string,
  toDate?: string,
): Promise<number> {
  await initAttributionStorage();
  const { fromDate: from, toDate: to } = normalizeDateRange(fromDate, toDate);
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT d.*, ua.click_id, ua.gdt_vid, ua.touch_id
       FROM attributed_user_daily d
       LEFT JOIN user_attribution ua ON d.game_key = ua.game_key AND d.user_key = ua.user_key
      WHERE d.game_key = ? AND d.date_key BETWEEN ? AND ?
        AND d.provider NOT IN ('organic', 'unknown')`,
    [gameKey, from, to],
  );
  const now = Date.now();
  const postbacks: PostbackQueueRow[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const events: string[] = [];
    if (num(row.is_new_user) === 1) events.push('first_open');
    if (num(row.tutorial_complete_cnt) > 0) events.push('tutorial_complete');
    if (num(row.order_deliver_cnt) > 0) events.push('first_order_deliver');
    if (num(row.ad_show_cnt) > 0) events.push('first_ad_show');
    const age = ageDay(str(row.first_seen_date), str(row.date_key));
    if (age === 1 && num(row.is_active) > 0) events.push('d1_retained');
    if (age === 3 && num(row.is_active) > 0) events.push('d3_retained');
    if (Number(row.ad_revenue_estimated_cny || 0) >= 0.1) events.push('estimated_ltv_bucket');
    for (const eventName of events) {
      const dedupe = `${gameKey}:${row.user_key}:${eventName}:${row.date_key}`;
      const eventTs = now;
      const { platformEventName, payload } = buildTencentAdsDryRunPayload({
        gameKey,
        userKey: str(row.user_key),
        userId: str(row.user_id),
        anonymousId: str(row.anonymous_id),
        eventName,
        eventTs,
        provider: str(row.provider),
        campaignId: str(row.campaign_id),
        adgroupId: str(row.adgroup_id),
        creativeId: str(row.creative_id),
        clickId: str(row.click_id),
        gdtVid: str(row.gdt_vid),
      });
      postbacks.push({
        game_key: gameKey,
        user_key: str(row.user_key),
        event_name: eventName,
        platform: str(row.provider) || 'tencent_ads',
        platform_event_name: platformEventName,
        dedupe_key: dedupe,
        status: 'dry_run',
        event_ts: eventTs,
        payload_json: JSON.stringify(payload),
        attribution_json: JSON.stringify({
          provider: row.provider,
          campaign_id: row.campaign_id,
          adgroup_id: row.adgroup_id,
          creative_id: row.creative_id,
          touch_id: row.touch_id,
          match_type: row.match_type,
          confidence: row.confidence,
        }),
        retry_count: 0,
        last_error: '',
        created_at: now,
        updated_at: now,
      });
    }
  }
  return upsertPostbackQueue(postbacks);
}

export async function recomputeAttribution(
  gameKey: string,
  options: { fromDate?: string; toDate?: string } = {},
): Promise<AttributionRecomputeResult> {
  const { fromDate, toDate } = normalizeDateRange(options.fromDate, options.toDate);
  const touchpoints = await syncAttributionTouchpoints(gameKey, dateStartTs(fromDate), dateEndTs(toDate));
  const users = await resolveUserAttribution(gameKey);
  const daily = await recomputeAttributedUserDaily(gameKey, fromDate, toDate);
  const postbacks = await generatePostbackDryRun(gameKey, fromDate, toDate);
  return {
    game_key: gameKey,
    from_date: fromDate,
    to_date: toDate,
    touchpoints_upserted: touchpoints,
    users_attributed: users,
    user_daily_rows: daily,
    postback_rows: postbacks,
  };
}

/** 拉新/触点同步：有广告参数或非 organic/unknown 的来源 */
function isAdTouchSignal(provider: string, clickId: string, gdtVid: string): boolean {
  if (clickId || gdtVid) return true;
  return provider !== 'organic' && provider !== 'unknown' && provider !== '';
}

/** 回流归因：仅统计广告再触达（投流/点击标识），不含 referrer_app、share 等跳转 */
function isReengagementAdTouch(provider: string, clickId: string, gdtVid: string): boolean {
  if (clickId || gdtVid) return true;
  return provider === 'tencent_ads';
}

function isReengagementTouch(firstSeenTs: number, touchTs: number): boolean {
  return toLocalDateKey(firstSeenTs) < toLocalDateKey(touchTs);
}

async function computeReengagementMetrics(
  gameKey: string,
  from: string,
  to: string,
  platform?: string,
): Promise<{
  summary: AttributionOverview['reengagement_summary'];
  daily: ReengagementDailyRow[];
  byProvider: ReengagementProviderRow[];
}> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT t.user_key, t.event_ts, t.provider, t.channel, t.campaign_id, t.adgroup_id,
            t.creative_id, t.click_id, t.gdt_vid, ua.first_seen_ts
       FROM attribution_touchpoints t
       INNER JOIN user_attribution ua
         ON t.game_key = ua.game_key AND t.user_key = ua.user_key
      WHERE t.game_key = ?
        AND t.event_ts BETWEEN ? AND ?${platformExistsFilter('t.user_key')}`,
    [gameKey, dateStartTs(from), dateEndTs(to), ...platformExistsParams(gameKey, platform)],
  );

  const dailyMap = new Map<string, {
    users: Set<string>;
    paidUsers: Set<string>;
    clickUsers: Set<string>;
    touchEvents: number;
  }>();
  const providerMap = new Map<string, {
    provider: string;
    channel: string;
    campaign_id: string;
    adgroup_id: string;
    creative_id: string;
    users: Set<string>;
    touchEvents: number;
  }>();
  const periodUsers = new Set<string>();
  const periodPaidUsers = new Set<string>();
  const periodClickUsers = new Set<string>();
  let periodTouchEvents = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
    const provider = str(row.provider);
    const clickId = str(row.click_id);
    const gdtVid = str(row.gdt_vid);
    if (!isReengagementAdTouch(provider, clickId, gdtVid)) continue;

    const touchTs = num(row.event_ts);
    const firstSeenTs = num(row.first_seen_ts);
    if (!isReengagementTouch(firstSeenTs, touchTs)) continue;

    const touchDate = toLocalDateKey(touchTs);
    if (touchDate < from || touchDate > to) continue;

    const userKey = str(row.user_key);
    periodUsers.add(userKey);
    periodTouchEvents += 1;
    if (provider === 'tencent_ads') periodPaidUsers.add(userKey);
    if (clickId || gdtVid) periodClickUsers.add(userKey);

    let daily = dailyMap.get(touchDate);
    if (!daily) {
      daily = { users: new Set(), paidUsers: new Set(), clickUsers: new Set(), touchEvents: 0 };
      dailyMap.set(touchDate, daily);
    }
    daily.users.add(userKey);
    daily.touchEvents += 1;
    if (provider === 'tencent_ads') daily.paidUsers.add(userKey);
    if (clickId || gdtVid) daily.clickUsers.add(userKey);

    const providerKey = [provider, str(row.channel), str(row.campaign_id), str(row.adgroup_id), str(row.creative_id)].join('|');
    let bucket = providerMap.get(providerKey);
    if (!bucket) {
      bucket = {
        provider,
        channel: str(row.channel),
        campaign_id: str(row.campaign_id),
        adgroup_id: str(row.adgroup_id),
        creative_id: str(row.creative_id),
        users: new Set(),
        touchEvents: 0,
      };
      providerMap.set(providerKey, bucket);
    }
    bucket.users.add(userKey);
    bucket.touchEvents += 1;
  }

  const daily = [...dailyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([touch_date, bucket]) => ({
      touch_date,
      reengaged_users: bucket.users.size,
      paid_or_known_users: bucket.paidUsers.size,
      click_id_users: bucket.clickUsers.size,
      touch_events: bucket.touchEvents,
    }));

  const byProvider = [...providerMap.values()]
    .map((bucket) => ({
      key: [bucket.provider, bucket.channel, bucket.campaign_id, bucket.adgroup_id, bucket.creative_id].join('|'),
      provider: bucket.provider,
      channel: bucket.channel,
      campaign_id: bucket.campaign_id,
      adgroup_id: bucket.adgroup_id,
      creative_id: bucket.creative_id,
      reengaged_users: bucket.users.size,
      touch_events: bucket.touchEvents,
    }))
    .sort((a, b) => b.reengaged_users - a.reengaged_users || b.touch_events - a.touch_events)
    .slice(0, 200);

  return {
    summary: {
      reengaged_users: periodUsers.size,
      paid_or_known_users: periodPaidUsers.size,
      click_id_users: periodClickUsers.size,
      touch_events: periodTouchEvents,
    },
    daily,
    byProvider,
  };
}

export async function getAttributionOverview(
  gameKey: string,
  fromDate?: string,
  toDate?: string,
  platform?: string,
): Promise<AttributionOverview> {
  await initAttributionStorage();
  const { fromDate: from, toDate: to } = normalizeDateRange(fromDate, toDate);
  const fromTs = dateStartTs(from);
  const toTs = dateEndTs(to);
  const pool = await getMysqlPool();
  const [rankingRows] = await pool.query(
    `SELECT
       provider, channel, campaign_id, adgroup_id, creative_id,
       COUNT(DISTINCT user_key) AS users,
       COUNT(DISTINCT user_key) AS new_users,
       COUNT(*) AS active_user_days,
       COUNT(DISTINCT CASE WHEN DATEDIFF(date_key, first_seen_date) = 1 AND is_active = 1 THEN user_key END) AS d1_retained_users,
       COUNT(DISTINCT CASE WHEN DATEDIFF(date_key, first_seen_date) = 3 AND is_active = 1 THEN user_key END) AS d3_retained_users,
       COUNT(DISTINCT CASE WHEN DATEDIFF(date_key, first_seen_date) = 7 AND is_active = 1 THEN user_key END) AS d7_retained_users,
       SUM(ad_show_cnt) AS ad_show_cnt,
       SUM(ad_revenue_estimated_cny) AS ad_revenue_estimated_cny,
       COUNT(DISTINCT CASE WHEN tutorial_complete_cnt > 0 THEN user_key END) AS tutorial_complete_users,
       COUNT(DISTINCT CASE WHEN order_deliver_cnt > 0 THEN user_key END) AS order_deliver_users,
       COUNT(DISTINCT CASE WHEN ad_show_cnt > 0 THEN user_key END) AS first_ad_show_users,
       MAX(max_star_level) AS max_star_level
     FROM attributed_user_daily
     WHERE game_key = ? AND first_seen_date BETWEEN ? AND ?${platformExistsFilter('user_key')}
     GROUP BY provider, channel, campaign_id, adgroup_id, creative_id
     ORDER BY new_users DESC, users DESC
     LIMIT 200`,
    [gameKey, from, to, ...platformExistsParams(gameKey, platform)],
  );
  const rankings: AttributionOverviewRow[] = (rankingRows as Array<Record<string, unknown>>).map((row) => {
    const newUsers = num(row.new_users);
    const revenue = Number(row.ad_revenue_estimated_cny || 0);
    return {
      key: [row.provider, row.channel, row.campaign_id, row.adgroup_id, row.creative_id].map(str).join('|'),
      provider: str(row.provider),
      channel: str(row.channel),
      campaign_id: str(row.campaign_id),
      adgroup_id: str(row.adgroup_id),
      creative_id: str(row.creative_id),
      users: num(row.users),
      new_users: newUsers,
      active_user_days: num(row.active_user_days),
      d1_retained_users: num(row.d1_retained_users),
      d3_retained_users: num(row.d3_retained_users),
      d7_retained_users: num(row.d7_retained_users),
      d1_retention_rate: newUsers > 0 ? round4(num(row.d1_retained_users) / newUsers) : null,
      d3_retention_rate: newUsers > 0 ? round4(num(row.d3_retained_users) / newUsers) : null,
      d7_retention_rate: newUsers > 0 ? round4(num(row.d7_retained_users) / newUsers) : null,
      ad_show_cnt: num(row.ad_show_cnt),
      ad_revenue_estimated_cny: round2(revenue),
      avg_ltv_estimated_cny: newUsers > 0 ? round4(revenue / newUsers) : null,
      tutorial_complete_users: num(row.tutorial_complete_users),
      order_deliver_users: num(row.order_deliver_users),
      first_ad_show_users: num(row.first_ad_show_users),
      max_star_level: num(row.max_star_level),
    };
  });

  const [summaryRows] = await pool.query(
    `SELECT
       COUNT(*) AS attributed_users,
       SUM(CASE WHEN provider NOT IN ('organic', 'unknown') THEN 1 ELSE 0 END) AS paid_or_known_users,
       SUM(CASE WHEN provider = 'organic' THEN 1 ELSE 0 END) AS organic_users,
       SUM(CASE WHEN provider = 'unknown' THEN 1 ELSE 0 END) AS unknown_users,
       SUM(CASE WHEN click_id <> '' OR gdt_vid <> '' THEN 1 ELSE 0 END) AS click_id_users,
       SUM(CASE WHEN match_type IN ('fallback', 'parameter') THEN 1 ELSE 0 END) AS fallback_users
     FROM user_attribution
     WHERE game_key = ?
       AND first_seen_ts >= ? AND first_seen_ts <= ?${platformExistsFilter('user_key')}`,
    [gameKey, fromTs, toTs, ...platformExistsParams(gameKey, platform)],
  );
  const summary = (summaryRows as Array<Record<string, unknown>>)[0] || {};
  const [dailyCohortRows] = await pool.query(
    `SELECT
       d.first_seen_date AS cohort_date,
       COUNT(DISTINCT d.user_key) AS new_users,
       COUNT(DISTINCT CASE WHEN d.provider NOT IN ('organic', 'unknown') THEN d.user_key END) AS paid_or_known_users,
       COUNT(DISTINCT CASE WHEN d.provider = 'organic' THEN d.user_key END) AS organic_users,
       COUNT(DISTINCT CASE WHEN d.provider = 'unknown' THEN d.user_key END) AS unknown_users,
       COUNT(DISTINCT CASE WHEN ua.click_id <> '' OR ua.gdt_vid <> '' THEN d.user_key END) AS click_id_users
     FROM attributed_user_daily d
     LEFT JOIN user_attribution ua ON d.game_key = ua.game_key AND d.user_key = ua.user_key
     WHERE d.game_key = ?
       AND d.first_seen_date BETWEEN ? AND ?
       AND d.date_key = d.first_seen_date${platformExistsFilter('d.user_key')}
     GROUP BY d.first_seen_date
     ORDER BY d.first_seen_date DESC`,
    [gameKey, from, to, ...platformExistsParams(gameKey, platform)],
  );
  const daily_cohorts: AttributionDailyCohortRow[] = (dailyCohortRows as Array<Record<string, unknown>>).map((row) => ({
    cohort_date: str(row.cohort_date),
    new_users: num(row.new_users),
    paid_or_known_users: num(row.paid_or_known_users),
    organic_users: num(row.organic_users),
    unknown_users: num(row.unknown_users),
    click_id_users: num(row.click_id_users),
  }));
  const [postbackRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM postback_queue
      WHERE game_key = ? AND status = 'dry_run' AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  const postbackDryRun = num((postbackRows as Array<Record<string, unknown>>)[0]?.c);
  const total = num(summary.attributed_users);
  const quality = [
    { key: 'known', label: '付费/已知来源', count: num(summary.paid_or_known_users) },
    { key: 'organic', label: '自然量', count: num(summary.organic_users) },
    { key: 'unknown', label: '未知来源', count: num(summary.unknown_users) },
    { key: 'click_id', label: '带点击标识', count: num(summary.click_id_users) },
    { key: 'fallback', label: '参数/兜底归因', count: num(summary.fallback_users) },
  ].map((item) => ({
    ...item,
    ratio: total > 0 ? round4(item.count / total) : 0,
  }));

  const reengagement = await computeReengagementMetrics(gameKey, from, to, platform);

  const [recentTouchpoints] = await pool.query(
    `SELECT touch_id, event_ts, user_key, provider, channel, campaign_id, adgroup_id,
            creative_id, click_id, gdt_vid, launch_scene, match_source, raw_json
       FROM attribution_touchpoints
      WHERE game_key = ?
      ORDER BY event_ts DESC
      LIMIT 50`,
    [gameKey],
  );
  const [recentPostbacks] = await pool.query(
    `SELECT id, user_key, event_name, platform, platform_event_name, dedupe_key,
            status, event_ts, payload_json, attribution_json, updated_at
       FROM postback_queue
      WHERE game_key = ?
      ORDER BY updated_at DESC
      LIMIT 50`,
    [gameKey],
  );

  return {
    game_key: gameKey,
    from_date: from,
    to_date: to,
    summary: {
      attributed_users: total,
      paid_or_known_users: num(summary.paid_or_known_users),
      organic_users: num(summary.organic_users),
      unknown_users: num(summary.unknown_users),
      click_id_users: num(summary.click_id_users),
      fallback_users: num(summary.fallback_users),
      postback_dry_run: postbackDryRun,
    },
    daily_cohorts,
    reengagement_summary: reengagement.summary,
    reengagement_daily: reengagement.daily,
    reengagement_by_provider: reengagement.byProvider,
    rankings,
    quality,
    recent_touchpoints: recentTouchpoints as Array<Record<string, unknown>>,
    recent_postbacks: recentPostbacks as Array<Record<string, unknown>>,
  };
}
