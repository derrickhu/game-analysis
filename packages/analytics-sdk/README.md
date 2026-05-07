# @gp/analytics-sdk

标准化游戏经分埋点 SDK，跨小游戏 / H5 / 引擎桥通用，零运行时依赖。

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

## 标准事件名（业务可自定义，下方为推荐常量）

- 通用：`session_start` `session_end` `app_error`
- 关卡：`level_start` `level_clear` `level_fail`
- 广告：`ad_request` `ad_show` `ad_click` `ad_close` `ad_error`
- 经济：`coin_change` `diamond_change`
- SDK 自监控：`sdk_dropped`

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
| 已注册 game_key 白名单 | `hotpot`,`huahua`,`caizhu`（云函数环境变量 `ANALYTICS_GAME_KEYS`） |

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

export function initAnalytics() {
  Analytics.init({
    endpoint: ENDPOINT,
    gameKey: 'gameX',           // 必须先在白名单里注册（见步骤 3）
    appVersion: '1.0.0',
    platform: 'wechat',         // 'wechat' | 'douyin' | 'h5'...
    deviceInfo: { /* 同 hot-pot 写法 */ },
    transport: { request: Platform.request.bind(Platform) },
    storage:   { get: Platform.getStorageSync.bind(Platform), set: ..., remove: ... },
    lifecycle: { onHide: Platform.onHide.bind(Platform) },
    debug: false,
  });
  Analytics.track(EVENT_NAMES.SESSION_START);
}
```

### 3. 把新 game_key 加进云函数白名单（防止上报被拒）

云函数 `analytics-ingest` 的环境变量 `ANALYTICS_GAME_KEYS` 控制允许哪些 game_key。新增一个游戏要把它加进去，否则事件会被 sanitize 过滤掉。两种方式：

**方式 A（推荐）：MCP / SDK 直接更新**

```
manageFunctions updateFunctionConfig
  functionName: analytics-ingest
  envVariables: { ANALYTICS_GAME_KEYS: "hotpot,huahua,caizhu,gameX" }
```

或者 CloudBase CLI：

```bash
tcb fn config update analytics-ingest --envVariables ANALYTICS_GAME_KEYS=hotpot,huahua,caizhu,gameX
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

## 故障排查

| 现象 | 直接原因 | 处理 |
| --- | --- | --- |
| 客户端 `client error 404` + `INVALID_PATH` | endpoint 域名格式错（写了 `*.app.tcloudbase.com` 而非 `*.service.tcloudbase.com`），或 HTTP 访问服务里没建 `/analytics-ingest` 路径 | 检查 endpoint，确认网关路径配置 |
| 客户端 `client error 400` + `ALL_INVALID` | game_key 没在云函数白名单里 / 必填字段缺失（event_id / event_name / event_ts / game_key） | 加白名单或检查 SDK init 的 gameKey 拼写 |
| 客户端 `client error 4xx` 一直丢批 | endpoint 写错或网络异常，**Sender 已自动把这种批走死信队列**，不会无限重试拖垮内存 | 修正 endpoint 后重启游戏，死信队列下次启动会重试 |
| CloudDB 一直没新数据 | 客户端默认 15s 才 flush 一次，或者批太小（<20 条 + 没到 15s）；用 `Analytics.flush()` 手动触发 | 等 15s 或主动 flush；也检查 console 是否有 sender 错误日志 |
| 经分 dashboard 看不到数据 | 后端 `ingest-events` cron（30s 一次）没跑起来或失败 | 看 `analytics_ingest_runs` 表的 last_error；或 `POST /api/realtime/ingest-now` 手动触发一次 |
| 老 game_key 数据不再写入 | 改环境变量后没等生效（< 10s） | 等 10 秒后重试 |

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
