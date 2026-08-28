# @gp/analytics-sdk

标准化游戏经分埋点 SDK，跨小游戏 / H5 / 引擎桥通用，零运行时依赖。

## 怎么读这份文档

| 你要做的事 | 去哪看 |
| --- | --- |
| 30 分钟把新游戏接上经分 | [新游戏接入步骤](#新游戏接入步骤约-30-分钟) |
| 微信 + 抖音双端怎么拆数据 | [多平台接入规范](#多平台接入规范微信--抖音)（必读，最容易踩坑） |
| 该打哪些事件、字段叫什么 | [SOP 标准事件清单](#sop-标准事件清单) + [字段命名规范](#字段命名规范) |
| 上线前对一遍 | [接入自检清单](#接入自检清单联调上线前对一遍) |
| 出了问题对照现象 | [故障排查](#故障排查) |

**一句话原则：** `gameKey` 用基础名区分游戏，`platform` 区分微信/抖音，存档集合用 `{gameKey}_tt_*` 隔离抖音——三套名字不要混。

## 特性

- 三层 Adapter 抽象（Transport / Storage / Lifecycle），SDK 包代码完全不出现 `wx` / `tt` / `document`，保证跨平台
- 双层事件队列：内存 + 持久化兜底，进程异常退出不丢数据
- 定时定量批量上报：默认 15s 或 20 条触发一次，云函数批量 add 50:1 缩调用次数
- 指数退避重试 + 死信队列回收：失败事件不会一直堆积，下次启动重试一次
- 客户端采样 + 限流：高频事件自动降采样，单事件名 1s 超过 50 条丢尾，dropped 计数自监控
- 标准事件模型：参考 GA4 / 神策，event_id 服务端去重幂等

## 使用

```ts
import { Analytics, EVENT_NAMES } from '@gp/analytics-sdk';
import { Platform } from '@/core/PlatformService';

Analytics.init({
  endpoint: 'https://xxx.service.tcloudbase.com/track',
  gameKey: 'hotpot',
  appVersion: '1.0.0',
  platform: 'wechat',
  deviceInfo: {
    brand: 'iPhone', model: 'iPhone 14', system: 'iOS 17.0',
    sdkVersion: '8.0.71', screenWidth: 393, screenHeight: 852, network: 'wifi',
  },
  transport: { request: Platform.request.bind(Platform) },
  storage: {
    get: Platform.getStorageSync.bind(Platform),
    set: Platform.setStorageSync.bind(Platform),
    remove: Platform.removeStorageSync.bind(Platform),
  },
  lifecycle: { onHide: Platform.onHide.bind(Platform) },
  debug: false,
});

Analytics.track(EVENT_NAMES.AD_SHOW, {
  ad_unit_id: 'adunit-xxx',
  ad_type: 'reward',
  scene: 'level_fail_revive',
  level_id: 12,
});

Analytics.setUserId('openid_xxx');
```

## SOP 标准事件清单

> 经分团队定义的「标准操作规程」事件，**所有接入 SDK 的游戏必须按以下口径打点**，
> 否则 dashboard 的 DAU / 留存 / 关卡 / 广告等公共指标无法对齐。
> 业务自定义事件（命名建议 snake_case）不受限制，但**先把 SOP 必接的打全**。
>
> 事件等级：
> - **必接 ★**：经分公共指标依赖，每个游戏都要接
> - **关卡 ◆**：有「关卡 / 闯关」概念的游戏必接（消除、闯关射击、解谜）
> - **进度 ☐**：合成经营 / 模拟养成 / 签到等无关卡型游戏用，替代关卡三件套
> - **按需 ○**：业务需要时再接，不强制
> - **SDK 自动 ⚙**：SDK 内部触发，业务**不要**手工打

### 1. 通用生命周期（每个游戏都接）

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ★ | `session_start` | `initAnalytics` 完成 **且** `setAnalyticsUserId` 之后打 1 次（一次冷启动） | — | `entry`(从哪进入)、`with_user_id`(bool) | DAU / 留存 / 新增的锚点 |
| ★ | `session_end` | `Platform.onHide` 切后台时 | `reason` | — | 反向校验异常退出比例 |
| ★ ⚙ | `login` | `setAnalyticsUserId(uid)` 内部自动打 + 立即 flush | `from_anonymous`(bool) | — | 业务侧**不需要**手工 track，SDK 内部已处理 |
| ○ | `app_show` | `Platform.onShow` 切回前台。**SDK 不会自动打**，也不重置 session_id | `from_background`(bool)、`background_ms` | — | 看「切后台再回来」留存形态。**不要**用它顶替 session_start |
| ○ | `app_error` | 客户端致命异常 | `err_code`, `err_msg` | `stack`(裁剪) | 业务侧装一个全局 try/catch 触发 |
| ⚙ | `sdk_dropped` | SDK 降采样 / 限流 / 队列溢出时自动打 | — | — | 自监控用，业务**不要**手工 track |

### 2. 关卡型游戏（hot-pot / 消除闯关）

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ◆ | `level_start` | 关卡开始（玩家点开始 / 自动重开） | `level_id`(number, 1 起) | `level_name` | 关卡漏斗 / 失败率 |
| ◆ | `level_clear` | 关卡通关 | `level_id`, `duration_ms` | `level_name` | 平均通关时长、最高关 |
| ◆ | `level_fail` | 关卡失败 / 玩家放弃 | `level_id`, `duration_ms`, `reason` | `level_name`、业务进度字段（如 `orders_remaining`） | `reason` 取值见下方「字段命名规范」 |

### 3. 无关卡型游戏（花花合成经营 / 模拟养成 / 任务签到）

> 没有"关卡通关 / 失败"的游戏走这一组。同一个 `quest_id` 必须能从 `quest_start` 串到 `quest_complete` 或 `quest_abandon`。

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ☐ | `quest_start` | 玩家接受任务 / 进入挑战 / 开启签到 | `quest_id`(string), `quest_type` | `step` | 任务漏斗起点 |
| ☐ | `quest_complete` | **领奖完成**（不是 UI 显示完成时） | `quest_id`, `quest_type`, `duration_ms` | `reward_kind`、`reward_amount` | 任务完成率 / 时长 |
| ☐ | `quest_abandon` | 玩家主动放弃 / 离开未领奖 | `quest_id`, `quest_type`, `reason` | `step`(中途到哪一步) | 区别于失败：玩家行为 |

`quest_type` 团队约定取值：`daily`（日常）/ `weekly`（周常）/ `event`（活动）/ `tutorial_chain`（新手引导链）/ `checkin`（签到）/ `merge`（合成阶段）/ `building`（建造）/ `collection`（收集）。新增类型先在团队 wiki 登记再用。

### 4. 新手引导漏斗（每个游戏都接）

> 新手流失是新游戏第一周必看的指标。漏完一遍才能定位卡点，**不接=新手期决策瞎子**。

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ★ | `tutorial_step` | 教学每一步「完成」或「跳过」时打 1 条 | `step_id`(string, snake_case)、`step_index`(number, 1 起)、`status`(`done`/`skip`) | `duration_ms`(本步停留)、`is_force`(bool, 是否强制) | 新手流失漏斗 / 步骤平均耗时 |

`step_id` 团队约定：每个步骤起一个稳定的英文标识（如 `tap_first_fruit` / `unlock_workbench` / `place_first_decoration`），**不要**改名也不要随版本变；UI 文案改了 step_id 也要保持稳定。`step_index` 用于按顺序排序。

### 5. 广告（核心：广告收益估算的数据来源）

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ★ | `ad_request` | 调 `wx.createRewardedVideoAd().load()` 时 | `ad_unit_id`, `ad_type`, `scene` | 关卡型可带 `level_id` | 广告收益估算源数据 |
| ★ | `ad_show` | 广告真正展示成功（show 的 then 回调里） | `ad_unit_id`, `ad_type`, `scene` | 关卡型可带 `level_id` | **eCPM × 曝光数 = 估算广告收入** |
| ★ | `ad_close` | 广告 onClose | `ad_unit_id`, `ad_type`, `scene`, `is_ended`(完整看完=true) | 同上 | 是否发奖励的判定锚 |
| ★ | `ad_error` | 广告 onError / load fail / show().catch | `ad_unit_id`, `ad_type`, `scene`, `err_code`, `err_msg` | — | 广告位健康度（**双通路去重见下文实现要点**） |
| ○ | `ad_click` | 广告点击（部分平台拿不到） | `ad_unit_id`, `ad_type`, `scene` | — | 微信小游戏当前无回调，可忽略 |

`scene` 必须传业务化字符串（如 `level_fail_revive` / `stamina_recover` / `cd_speedup`），**不能**填 `unknown` 或常量字符串；这是经分按场景拆收益的唯一维度。`level_id` 是关卡型可选字段，无关卡游戏（花花）**不要**填占位值，留空即可。

### 6. 分享传播（只代表"发起分享"，不代表回流）

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ★ | `share_app_message` | 转发给好友 / 群（wx.shareAppMessage / onShareAppMessage / tt.shareAppMessage） | `entry_point` | `title`、`image_url`、`query`、业务字段（`reward_type` 等） | 分享渗透率、按入口拆分 |
| ○ | `share_timeline` | 朋友圈分享（**仅微信** `onShareTimeline`，抖音无对等通道） | `entry_point` | `title`、`image_url`、`query` | 朋友圈传播口径与 `share_app_message` 拆分 |

`entry_point` 团队约定取值：

- 微信被动分享（`onShareAppMessage` / `onShareTimeline` 回调内）：`wx_button` / `wx_menu` / `wx_other` / `wx_timeline`
- 抖音被动分享：`dy_button` / `dy_menu` / `dy_other`
- 业务主动调 `shareAppMessage`：`api_share_game`（通用兜底）或业务化命名（如 `badge_unlock_reward` / `gift_stamina` / `flower_card`），命名规则：`<业务模块>_<动作>`，全 snake_case
- 入口名一旦上线**不要改名**，否则 dashboard 历史数据断档

### 7. 经济（业务自定义货币沿用 `*_change`）

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ○ | `coin_change` | 金币增减（默认 10% 采样） | `amount`(±, number)、`balance_after`(number)、`source`(string) | `reason` | 经济模型分析 |
| ○ | `diamond_change` | 钻石增减（默认 10% 采样） | 同上 | 同上 | 同上 |
| ○ | `<业务货币>_change` | 业务自定义货币（体力 `stamina_change` / 票券 `ticket_change` / 心愿 `wish_change`） | `amount`、`balance_after`、`source` | `reason` | **沿用相同语义结构**，不要自创 `addStamina` / `useTicket` 之类 |

`source` 团队约定取值：`reward`（任务奖励）/ `purchase`（付费）/ `ad`（看广告）/ `gift`（社交赠送）/ `consume`（消耗）/ `refund`（回退）/ `system`（系统补发）；其它业务专属来源用 `event_<活动名>` 形式扩展，**不要**写 `'获得了一个金币'` 这类描述性字符串。高频自定义 `*_change` 事件建议在 `init` 时通过 `samplingRules` 加 0.1 采样，跟 coin/diamond 对齐（[采样规则注入示例](#采样规则注入示例)）。

### 8. 付费（Phase 2 占位，MVP 可不接）

> 命名先占住，避免后续接入散打成 `pay_done` / `iap_ok` 各种风格。**MVP 不强求接**，但接入时一定走这套名字。

| 等级 | 事件名 | 触发时机 | 必带 params | 推荐 params | 用途 |
| --- | --- | --- | --- | --- | --- |
| ○ | `purchase_initiate` | 弹起平台付费弹窗（`wx.requestMidasPayment` 调用前） | `product_id`、`price_amount`(分)、`currency`(默认 `CNY`) | `scene` | 付费漏斗起点 |
| ○ | `purchase_complete` | 平台返回付费成功 | `product_id`、`price_amount`、`currency`、`order_id` | `scene` | ARPU / 付费率 |
| ○ | `purchase_fail` | 用户取消 / 余额不足 / 平台异常 | `product_id`、`reason` | `err_code`、`err_msg` | 付费失败归因 |

### 接入自检清单（联调上线前对一遍）

#### 通用必查（所有游戏）

- [ ] `initAnalytics` 在主流程一开始就调用，确保 SDK 开始接收事件
- [ ] `setAnalyticsUserId` 在 CloudSync / 登录拿到 openid 后**立即**调用
- [ ] `session_start` **必须**在 `setAnalyticsUserId` 之后再 track，且带 `with_user_id`
      （否则 user_id='' 与登录后 user_id=xxx 会被算成两个不同 uk，DAU 翻倍）
- [ ] `session_end` 在 `Platform.onHide` 触发，未漏接
- [ ] **不要**在 `Platform.onShow` 重新打 `session_start`（会让 DAU 虚高）。如有"前后台切换"埋点需求，用 `app_show`
- [ ] `app_version` 不是硬编码 `'1.0.0'`，已经从构建期注入（[最佳实践见下](#app_version-注入最佳实践)）
- [ ] 所有广告位都通过统一封装（参考 hot-pot `src/utils/rewardedAd.ts`）走，`ad_request/show/close/error` 一处打齐，**不要**散在多个文件
- [ ] `ad_error` 已对 onError 与 show().catch() 双通路去重（hot-pot 用 `errorReportedThisCycle` cycle 标志，照抄）
- [ ] 新手引导每一步打了 `tutorial_step`，`step_id` 全 snake_case 且**版本间稳定不改名**
- [ ] dashboard 选中本游戏后，能在「原始事件」Tab 看到自己的事件，且 `user_id` 字段非空（除登录失败的离群样本外）

#### 关卡型游戏（hot-pot 这类）

- [ ] 关卡三件套（`level_start` / `level_clear` / `level_fail`）都打，且 `level_id` **统一 number 类型、从 1 开始**
- [ ] `duration_ms` 是「玩家进入这一关到结算」的真实时长，不是会话累计
- [ ] `reason` 在团队内统一取值：`give_up` / `time_out` / `hp_zero` / `quit_to_home`，避免每个游戏写不同字符串

#### 无关卡型游戏（花花 / 合成经营 / 模拟养成）

- [ ] 用 `quest_start` / `quest_complete` / `quest_abandon` 替代关卡三件套，所有任务 / 签到 / 活动都覆盖
- [ ] `quest_id` 在版本间稳定（不要每周活动都换新 id 让 dashboard 拼不起漏斗）
- [ ] 业务货币（体力 / 票券 / 心愿等）沿用 `xxx_change` 命名，并在 init 时加 0.1 采样
- [ ] 朋友圈分享按 `share_timeline` 上报（不是混进 `share_app_message`）

#### 双平台（同时发微信 + 抖音）— 详见下文「多平台接入规范」

- [ ] `Analytics.init({ gameKey })` 用**基础名**（`huahua` / `hotpot` / `petTower`），**不要**写成 `huahua_tt` / `petTower_tt`
- [ ] `Analytics.init({ platform })` 按宿主设为 `'wechat'` 或 `'douyin'`（经分大盘靠这个字段分流）
- [ ] 云存档集合按约定隔离：微信 `{gameKey}_playerData`，抖音 `{gameKey}_tt_playerData`
- [ ] 登录 `userId` 带平台前缀：`wx:openid` / `dy:openid`（与集合隔离配套）
- [ ] 抖音激励广告 `is_ended: res?.isEnded === true`（勿把 undefined 当完看）
- [ ] 抖音分享不依赖 `query`；朋友圈事件仅微信打 `share_timeline`

## 数据流

```
client track() -> EventQueue -> Batcher (15s / 20 条) -> Sender (HTTP)
                                                            ↓
                                             云函数 analytics-ingest
                                                            ↓
                                             CloudDB analytics_events 集合
                                                            ↓
                                             经分后端 30s cron 增量拉走 -> SQLite/MySQL
                                                            ↓
                                             实时大盘 (echarts)
```

## 服务端基础设施（已部署 / 多游戏共用）

> 这一节是给团队其它游戏接入用的「现状速查表」，不需要再重复部署。

| 项目 | 值 |
| --- | --- |
| CloudBase 环境 | `rosa-env-d7grf78r5dbd37323`（ap-shanghai） |
| 上报域名 | `https://rosa-env-d7grf78r5dbd37323.service.tcloudbase.com` |
| 上报路径 | `POST /analytics-ingest/track` |
| 健康检查路径 | `POST /analytics-ingest/health` |
| 云函数名 | `analytics-ingest`（Nodejs18.15，handler `index.main`） |
| CloudDB 集合 | `analytics_events`（已建索引：`game_key+event_ts`、`ingest_ts`、`game_key+user_id+event_ts`、`game_key+event_name+event_ts`） |
| 已注册 game_key 白名单 | `hotpot`,`huahua`,`caizhu`,`petTower`,`xiaochu`,`cunkou`（云函数环境变量 `ANALYTICS_GAME_KEYS`；以线上实际配置为准） |

**重要架构特性：**

- 走的是 CloudBase「HTTP 访问服务」公网网关，**不依赖 wx.cloud SDK，因此不锁 AppID**，任何小游戏 / H5 / 引擎都可以调
- 一份云函数代码三家游戏共用，新增游戏不需要再部署函数，只需要把 game_key 加进白名单（见下文）
- 云函数代码在 `hot-pot/cloudfunctions/analytics-ingest/`（hot-pot 仓库托管）

## 新游戏接入步骤（约 30 分钟）

> 假设要接入一个新游戏 `gameX`。

### 1. 在游戏项目里安装 SDK

monorepo 内引用：

```json
// gameX/package.json
"dependencies": {
  "@gp/analytics-sdk": "file:../game-analysis/packages/analytics-sdk"
}
```

非 monorepo（独立仓库）：把 `packages/analytics-sdk/src` 整个目录复制过去，作为内部源码引用即可，**SDK 零运行时依赖、可直接源码 import**。

### 2. 在游戏入口实现一层 Adapter 注入

参考 [hot-pot 的写法](../../../../hot-pot/src/analytics/index.ts)，一个 30 行左右的胶水文件就够了。核心是把 game 平台层（小游戏 / H5 / Cocos / Unity 桥）封装成 SDK 要求的三组接口：

```ts
import { Analytics, EVENT_NAMES } from '@gp/analytics-sdk';
import { Platform } from '@/core/PlatformService'; // 或者自己游戏的等价物

const ENDPOINT = 'https://rosa-env-d7grf78r5dbd37323.service.tcloudbase.com/analytics-ingest/track';

function mapPlatform(): 'wechat' | 'douyin' | 'h5' {
  if (Platform.isDouyin) return 'douyin';
  if (Platform.isWechat) return 'wechat';
  return 'h5';
}

export function initAnalytics() {
  Analytics.init({
    endpoint: ENDPOINT,
    // 必须用基础名（先在白名单注册，见步骤 3）。双端也不要改成 gameX_tt。
    gameKey: 'gameX',
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0',
    platform: mapPlatform(),    // 经分靠这个字段拆微信/抖音，禁止写死 'wechat'
    deviceInfo: { /* 同 hot-pot 写法 */ },
    transport: { request: Platform.request.bind(Platform) },
    storage:   { get: Platform.getStorageSync.bind(Platform), set: ..., remove: ... },
    lifecycle: { onHide: Platform.onHide.bind(Platform) },
    debug: false,
  });
  // 注意：不要在 initAnalytics 里立刻 track(SESSION_START)！
  // 此时业务还没拿到 openid，事件 user_id='' 只会挂在 anonymous_id 上，
  // 后端会把同一玩家算成 anonymous + user_id 两个 uk，DAU 直接翻倍。
  // 正确做法见游戏入口 main 里的「先 setUserId，再 track session_start」。
}

export function setAnalyticsUserId(uid: string) {
  Analytics.setUserId(uid);     // SDK 内部会自动 track(LOGIN) 并立即 flush
}

export const analytics = Analytics;
```

**游戏入口 `main.ts` 的标准启动顺序（务必按此顺序）：**

```ts
initAnalytics();
// ... 启动 CloudSync / 登录 ...
const startup = await CloudSyncManager.awaitAuthoritativeStartup();
if (CloudSyncManager.userId) {
  setAnalyticsUserId(CloudSyncManager.userId);  // 自动打 login + flush
}
// 等到这一步再打 session_start，session_start 就直接带 user_id 入库
analytics.track(EVENT_NAMES.SESSION_START, {
  entry: 'main',
  with_user_id: !!CloudSyncManager.userId,
});

Platform.onHide(() => {
  analytics.track(EVENT_NAMES.SESSION_END, { reason: 'app-hide' });
});
```

### 3. 把新 game_key 加进云函数白名单（防止上报被拒）

云函数 `analytics-ingest` 的环境变量 `ANALYTICS_GAME_KEYS` 控制允许哪些 game_key。新增一个游戏要把它加进去，否则事件会被 sanitize 过滤掉。两种方式：

**方式 A（推荐）：MCP / SDK 直接更新**

```
manageFunctions updateFunctionConfig
  functionName: analytics-ingest
  envVariables: { ANALYTICS_GAME_KEYS: "hotpot,huahua,caizhu,petTower,xiaochu,cunkou,gameX" }
```

或者 CloudBase CLI：

```bash
tcb fn config update analytics-ingest --envVariables ANALYTICS_GAME_KEYS=hotpot,huahua,caizhu,petTower,xiaochu,cunkou,gameX
```

**方式 B：CloudBase 控制台手工改**

云函数 → analytics-ingest → 函数配置 → 环境变量 → 编辑 `ANALYTICS_GAME_KEYS` → 保存（约 10 秒生效）。

### 4. 在经分后端注册新游戏（可选，要在 dashboard 看 gameX 数据时才需要）

`game-analysis/src/server/config/analytics-games.ts`：

```ts
export const ANALYTICS_GAMES: AnalyticsGameConfig[] = [
  { gameKey: 'hotpot', displayName: '别捞水果', cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323' },
  { gameKey: 'huahua', displayName: '花花妙屋', cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323' },
  { gameKey: 'caizhu', displayName: '猜主',     cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323' },
  { gameKey: 'gameX',  displayName: 'GameX',    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323' }, // 新增一行
];
```

接着在 `config/ecpm.ts` 里给 `gameX` 配 eCPM 估值表（不配也能跑，估算收益按全局默认值给）。

### 5. 微信小游戏请求合法域名（其它平台同理）

如果你的游戏是新独立 AppID，需要在「小游戏管理后台 → 开发设置 → request 合法域名」加上：

```
https://rosa-env-d7grf78r5dbd37323.service.tcloudbase.com
```

如果已经接入了 hotpot-api 等同 env 的服务，这个域名应该已经加过，本步可跳过。

### 6. 联调验证

- 客户端跑起来，看 console 是否还有 `[analytics-sdk:sender] client error`
- 用 MCP/curl 查 CloudDB 数据：

  ```
  readNoSqlDatabaseContent
    collectionName: analytics_events
    query: { game_key: "gameX" }
    sort:  [{ key: "ingest_ts", direction: -1 }]
    limit: 5
  ```

- 经分 dashboard 的「广告实时（事件流）」标签页选游戏 `gameX` 应该能看到分钟级数据（30s 增量同步）

## 工程规范（接入前必读）

### 字段命名规范

新接入容易出现的偏差：每家自创 `levelId`、`errorCode`、`addStamina` 等驼峰 / 描述式字段名，dashboard 聚合时必须为每家写适配，长期不可维护。**所有 params 字段、所有事件名都按本节规则写**。

- **事件名**：snake_case，动词在后或动词为主（`level_clear`、`tutorial_step`、`stamina_change`）；不要用驼峰 / 中划线 / 中文
- **字段名**：snake_case；id 类字段必须是 number（`level_id` / `step_index` / `price_amount`）；时长字段统一 `_ms` 结尾（`duration_ms` / `background_ms`）；金额字段统一**分**单位（`price_amount: 600` 表示 6 元）
- **错误码 `err_code`**：number 类型；wx / tt 真实错误码透传（含负数 `-1` 等），SDK 自定义错误码用 **-100 段负数**与平台真实码区分（参考 hot-pot `rewardedAd.ts` 的 `SDK_ERR_UNAVAILABLE = -100`）
- **`reason` / `source` / `scene` 等枚举字符串**：团队字典统一取值，**不允许**写成「玩家放弃了」「奖励来源是签到」这类描述性字符串。当前已约定取值见上方 SOP 表各事件行
- **bool 字段**：直接传 `true` / `false`，**不要**传 `'true'` 字符串（SDK 不会做转换，dashboard 聚合时会算成两个不同值）
- **`null` 表示"无值"**，**不要**用空串 `""` 表示无值（这两个在 JSON_EXTRACT 时含义不同，会污染聚合）

### `app_version` 注入最佳实践

**反面教材**：hot-pot 的 `src/analytics/index.ts` 当前是 `const APP_VERSION = '1.0.0'` 硬编码，多个版本上线后大盘上**完全分不开版本**。新游戏接入务必用构建期注入：

**Vite（hot-pot / 花花用）：**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import pkg from './package.json' assert { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TS__: JSON.stringify(new Date().toISOString()),
  },
});

// src/analytics/index.ts
declare const __APP_VERSION__: string;
Analytics.init({ appVersion: __APP_VERSION__, /* ... */ });
```

**或直接读环境变量**（CI 友好）：

```ts
const APP_VERSION = import.meta.env.VITE_APP_VERSION || pkg.version;
```

每次发版只需要 bump `package.json` 的 `version`，dashboard 自然能按版本拆分留存 / 失败率。

### Session 边界与 `onShow` 语义

- **Session 定义 = 一次冷启动**。SDK 的 `session_id` 在 `Analytics.init` 时一次性生成，**不会**因为 `onHide`/`onShow` 切换而重置；玩家切后台 30 分钟回来仍算同一个 session
- 如果业务需要"切后台再回来"的留存埋点：**业务自己** track `app_show`（建议在 `Platform.onShow` 里），**不要**重新打 `session_start`，否则 DAU 翻倍
- `session_end` 在 `onHide` 触发；不需要在 `onShow` 时打"session_resume"，留存形态用 `app_show` 自带的 `background_ms` 字段还原即可
- 如果产品强需"30 分钟后切回算新会话"，应在数据层（dashboard）按 session_id + event_ts 间隔自行切分，**不**改 SDK，避免每个游戏对会话定义不一致

### 多平台接入规范（微信 + 抖音）

> 经分大盘顶部有「微信 / 抖音」切换，默认微信。  
> **同一游戏两端数据必须能分开算**；混在一起会把 DAU、留存、玩家档案全部算歪。  
> 参考实现：`game2D_huahua`（完整闭环）、`xiaochu2`（存档已分集合）。

#### 先分清三套名字（最容易搞错）

| 概念 | 微信示例 | 抖音示例 | 谁用 |
| --- | --- | --- | --- |
| **经分 `gameKey`** | `huahua` | `huahua`（**不变**） | SDK `Analytics.init`、云函数白名单、dashboard 游戏下拉 |
| **埋点 `platform`** | `wechat` | `douyin` | SDK 每条事件字段；dashboard 平台下拉靠它过滤 |
| **云存档集合 / 本地 key 命名空间** | `huahua_playerData` / `huahua_*` | `huahua_tt_playerData` / `huahua_tt_*` | 云函数 `getCollectionName`、客户端 `gameKeyScope` |
| **登录 `userId` 前缀** | `wx:openid` | `dy:openid` | JWT / 存档主键 / 玩家档案筛选 |

**铁律：**

1. 经分 `gameKey` **永远是基础名**，禁止 `huahua_tt` / `petTower_tt` 当 gameKey 上报（会被白名单拒，或拆成两个「假游戏」）。
2. 端差异只走 `platform` 字段 + 存档集合 / `userId` 前缀，**不要**靠改 gameKey 区分端。
3. 存档集合命名固定为：`{gameKey}_playerData`（微信）与 `{gameKey}_tt_playerData`（抖音）。

```ts
// ✅ 正确
Analytics.init({
  gameKey: 'huahua',                 // 或 BASE_GAME_KEY，不要用 getScopedGameKey()
  platform: Platform.isDouyin ? 'douyin' : 'wechat',
  // ...
});

// ❌ 错误：抖音把 scoped key 写进 gameKey
Analytics.init({
  gameKey: getScopedGameKey(),       // 抖音会变成 huahua_tt / petTower_tt → 经分对不上
  platform: 'douyin',
});
```

#### 云函数 / 存档侧要做的事

与 `huahua-api/lib/config.js` 同模式：

```js
// PLATFORM_SCOPE: 后端 platform 码 → 集合命名段
const PLATFORM_SCOPE = { dy: 'tt' };

function getScopedGameKey(platform) {
  const scope = PLATFORM_SCOPE[String(platform || '').toLowerCase()] || '';
  return scope ? `${GAME_KEY}_${scope}` : GAME_KEY;
}

function getCollectionName(suffix, platform) {
  // 微信: huahua_playerData
  // 抖音: huahua_tt_playerData
  return `${getScopedGameKey(platform)}_${suffix}`;
}
```

登录签发的 `userId` 必须是 `` `${platform}:${openid}` ``（`wx:` / `dy:`），这样即使历史数据曾进同一集合，经分也能按前缀切开。

#### 经分 dashboard 怎么读

| 页面 | 过滤依据 |
| --- | --- |
| 大盘 / 留存 / 商业化 / 玩法 / 原始事件 | `analytics_events.platform = wechat\|douyin` |
| 玩家档案 | 拉取对应云集合 + MySQL 里 `user_id LIKE 'wx:%'\|'dy:%'` |
| 投放消耗 / 微信流量主收入 | 仍是微信投放/流量主口径；看抖音时不要拿它当抖音真实收入 |

玩家档案「立即拉取」会按当前平台拉集合：微信拉 `{game}_playerData`，抖音拉 `{game}_tt_playerData`（若抖音集合尚未建好，部分游戏会回退扫主集合里的 `dy:` 用户，但**目标态仍是独立 `_tt_` 集合**）。

#### 宿主 API 差异（接入层兜底）

| 维度 | 微信 (wx) | 抖音 (tt) | 接入处理 |
| --- | --- | --- | --- |
| 平台标识 | `platform: 'wechat'` | `platform: 'douyin'` | `Platform.isWechat` / `isDouyin` 映射，勿写死 |
| 激励广告 onClose | 可靠 `{ isEnded }` | 部分版本无 `isEnded` | `is_ended: res?.isEnded === true` |
| 朋友圈 | `onShareTimeline` | 无对等通道 | 仅微信打 `share_timeline` |
| `shareAppMessage.query` | 支持 | 部分版本忽略 | 抖音勿依赖 query 做归因 |
| Storage / request | `wx.*` | `tt.*` | Adapter 注入即可，SDK 内核不出现 wx/tt |

#### 现状对照（接入前先看自己落在哪一档）

| 游戏 | 埋点 platform | 存档 `_tt_` 分集合 | 经分档案双端 |
| --- | --- | --- | --- |
| huahua | ✅ | ✅ `huahua_tt_playerData` | ✅ |
| petTower (xiaochu2) | ✅（gameKey 须用 `petTower`） | ✅ `petTower_tt_playerData` | 暂无档案页（事件流可分） |
| hotpot | ✅ | ⚠️ 尚未分集合（同表 `dy:` 前缀） | ✅ 按前缀筛；建议后续补 `_tt_` |
| caizhu / xiaochu | ✅ | ⚠️ 尚未分集合 | 无档案页 |

新开双端游戏：**直接按 huahua 模式做分集合**，不要再走「同集合 + 前缀」的过渡方案。

### debug 模式自查

接入完成后做一遍下面流程，确认 SDK 真的在跑：

```ts
Analytics.init({
  /* ... */
  debug: true,                  // 打开后 console 会打 [analytics] track xxx 日志
  flushIntervalMs: 3000,        // 调试期把 15s 调成 3s 验证更快
});

// 验证手动 flush 走通：
void Analytics.flush('debug-manual');
```

期望看到的 console 日志（按时间顺序）：

1. `[analytics] inited gameKey=gameX sdk=0.1.0 endpoint=https://...`
2. `[analytics] track session_start`（在登录之后才能看到）
3. `[analytics-sdk:sender] sent batch=N` （没看到说明请求没发出 → 检查 endpoint）
4. CloudDB `analytics_events` 集合里查到对应 `game_key=gameX` 的事件（用 MCP `readNoSqlDatabaseContent`，见上文「联调验证」章节）
5. dashboard 的「原始事件」Tab 选 gameX，1 分钟内可见

任一环节断了就停下来排查，**不要**把 debug 关掉裸跑。

### 采样规则注入示例

业务高频自定义 `*_change` 事件如果不限速，会浪费上报配额。建议接入时统一加 0.1 采样：

```ts
Analytics.init({
  /* ... */
  samplingRules: {
    // 默认已有 coin_change=0.1 / diamond_change=0.1，下面是花花预期接入的扩展：
    stamina_change: 0.1,
    ticket_change: 0.1,
    wish_change: 0.1,
    // 业务高频但又关键的事件可以保留 0.5：
    merge_completed: 0.5,
  },
  maxPerSecond: 50,             // 单事件名每秒最大上报，超出走 sdk_dropped 自监控
});
```

被采样丢弃的量会聚合成 `sdk_dropped` 事件每分钟自动上报一次（`sampling_total` / `rate_total` 字段），dashboard 上反向监控降采样比例。

## 故障排查

| 现象 | 直接原因 | 处理 |
| --- | --- | --- |
| 客户端 `client error 404` + `INVALID_PATH` | endpoint 域名格式错（写了 `*.app.tcloudbase.com` 而非 `*.service.tcloudbase.com`），或 HTTP 访问服务里没建 `/analytics-ingest` 路径 | 检查 endpoint，确认网关路径配置 |
| 客户端 `client error 400` + `ALL_INVALID` | game_key 没在云函数白名单里 / 必填字段缺失（event_id / event_name / event_ts / game_key） | 加白名单或检查 SDK init 的 gameKey 拼写 |
| 客户端 `client error 4xx` 一直丢批 | endpoint 写错或网络异常，**Sender 已自动把这种批走死信队列**，不会无限重试拖垮内存 | 修正 endpoint 后重启游戏，死信队列下次启动会重试 |
| CloudDB 一直没新数据 | 客户端默认 15s 才 flush 一次，或者批太小（<20 条 + 没到 15s）；用 `Analytics.flush()` 手动触发 | 等 15s 或主动 flush；也检查 console 是否有 sender 错误日志 |
| 经分 dashboard 看不到数据 | 后端 `ingest-events` cron（30s 一次）没跑起来或失败 | 看 `analytics_ingest_runs` 表的 last_error；或 `POST /api/realtime/ingest-now` 手动触发一次 |
| 老 game_key 数据不再写入 | 改环境变量后没等生效（< 10s） | 等 10 秒后重试 |
| 事件入库了但 `user_id` **一直为空** | `session_start` 在 `setAnalyticsUserId` 之前就被 track 了；首批事件挂在 `anonymous_id` 上 | 调整 main.ts 启动顺序：先 `await CloudSyncManager.awaitAuthoritativeStartup()` → `setAnalyticsUserId(uid)` → 再 `track(SESSION_START)`（参考 hot-pot `src/main.ts`） |
| dashboard `app_version` **永远是 `1.0.0`** | hot-pot 残留写法：`Analytics.init({ appVersion: '1.0.0' })` 硬编码 | 切换到构建期注入（[app_version 注入最佳实践](#app_version-注入最佳实践)） |
| `share_app_message` 入口表里出现 **大量 `unknown`** | 业务调用 `wx.shareAppMessage` 但没在我们封装层经过，`entry_point` 缺失 | 业务方所有 `shareAppMessage` 都走统一封装（参考 hot-pot `src/utils/wechatShare.ts` 的 `trackShareAppMessage`），强制传 `entry_point` |
| `ad_error` 比真实失败次数 **多一倍** | onError 与 show().catch() 双通路同时上报 | 用 cycle 标志去重（参考 hot-pot `rewardedAd.ts` 的 `errorReportedThisCycle`），同一次播放周期只允许打一次 |
| 抖音端 `is_ended=true` **比微信高很多** | `tt` 部分版本不返回 `isEnded`，业务用 `res.isEnded !== false` 判定时把 undefined 也算成完看 | 改成 `is_ended: res?.isEnded === true`，只有显式 true 才算完整看完 |
| DAU 在切前台时段 **明显跳高** | 在 `Platform.onShow` 里重新 track 了 `session_start` | session_start 只在冷启动后打一次；切前台需求改用 `app_show` 事件 |
| 同一玩家被算成两个 `uk` (DAU 翻倍) | `setAnalyticsUserId` 没调用 / 调用太晚（被前面事件抢先打了） | 走标准启动顺序：登录拿 openid 后**立即**调 `setAnalyticsUserId`，让 SDK 自动 track LOGIN + flush，后端按 LOGIN 事件做 anonymous↔user_id 归一 |

## 安全风险与升级路径

当前 MVP 是**公网开放 + game_key 白名单 + 字段校验**，可防误用、不防恶意攻击（伪造事件、DDoS）。

要进一步加固按成本从低到高有以下选项，**Phase 2 才做，MVP 不阻塞**：

1. **HMAC 签名校验（推荐第一步）**：每个游戏一个独立 secret 存在云函数环境变量 `ANALYTICS_SECRET_<GAMEKEY>`，客户端 SDK 加请求头 `x-game-key` + `x-ts` + `x-sign`，云函数按 game_key 查 secret 校验签名 + 时间戳防重放。一个游戏的 secret 泄漏不影响其它游戏。
2. **腾讯云 WAF 限流**：CloudBase 控制台「访问控制」按 IP / anonymous_id 限流，QPS 超阈值自动 ban，主要防 DDoS。
3. **wx.cloud.callContainer 改造**：要求按 AppID 鉴权，但代价是要拆三份云函数（每个 env 一份），失去共享能力。**不建议**，除非项目政策强制要求。

详细方案见 [hot-pot/docs/analytics-deploy-guide.md](../../../../hot-pot/docs/analytics-deploy-guide.md) 第 9 节。

## 部署历史与负责人

- 2026-05-07：首次部署完成（rosa-env-d7grf78r5dbd37323），共用 hot-pot/huahua/caizhu 三家
- 后续接入新游戏只需走「新游戏接入步骤」，**不需要再部署云函数 / 集合 / 索引**
