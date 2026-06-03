# 多游戏广告归因接入模板

## 接入目标

所有游戏统一接入 `@gp/analytics-sdk` 的公共归因参数能力，并在首启时上报 `attribution_touchpoint`。经分平台按 `game_key` 做归因解析、cohort 聚合和回传 dry-run。

## 客户端清单

1. 启动尽早初始化 analytics SDK。
2. 在第一条 `session_start` 前初始化 AttributionManager。
3. 读取冷启动参数：
   - 微信：`wx.getLaunchOptionsSync()`
   - 抖音：等价 launch / enter options API
4. 监听热启动参数：
   - 微信：`wx.onShow(options)`
5. 解析并保存：
   - `scene`
   - `query`
   - `referrerInfo`
   - `gdt_vid` / `click_id` / `cb`
   - `campaign_id` / `adgroup_id` / `creative_id`
   - `utm_source` / `utm_campaign` / `utm_content`
6. 上报：
   - `attribution_touchpoint`
   - `session_start` 携带归因摘要
   - 登录拿到 `user_id` 后上报 `attribution_resolved`
7. 通过 `Analytics.setCommonParams()` 注入公共字段：
   - `attr_provider`
   - `attr_channel`
   - `attr_campaign_id`
   - `attr_adgroup_id`
   - `attr_creative_id`
   - `attr_click_id`
   - `attr_gdt_vid`
   - `attr_launch_scene`
   - `attr_match_source`

## 花花

- 已接入路径：`/Users/huyi/dk_proj/game2D_huahua/src/analytics/AttributionManager.ts`
- 启动挂载：`/Users/huyi/dk_proj/game2D_huahua/src/main.ts`
- 平台方法：`/Users/huyi/dk_proj/game2D_huahua/src/core/PlatformService.ts`

## 水果 / 灵宠消消塔

复用花花模式：

1. 复制或抽象 `AttributionManager`。
2. 确保 `GAME_KEY` 正确。
3. 在 analytics init 后、`session_start` 前调用 `AttributionManager.init()`。
4. 登录后调用 `AttributionManager.bindUser(userId)`。
5. `session_start` 合入 `AttributionManager.sessionParams()`。
6. 经分平台无需新增游戏专属表，按 `game_key` 自动分区。

## 微信开发者工具验证

编译模式启动参数示例：

```text
utm_source=tencent_ads&campaign_id=cmp_test_001&adgroup_id=grp_test_001&creative_id=crt_test_001&click_id=mock_click_001&gdt_vid=mock_gdt_001
```

验证点：

- Network 中 `analytics-ingest/track` 包含 `attribution_touchpoint`。
- `session_start.params` 中包含 `attr_*` 和 `attribution_*` 字段。
- 经分平台原始事件可搜索 `mock_click_001`。
- 商业化分析页中「广告归因」回算后能看到 campaign 行。
- `postback_queue` 只产生 `dry_run`，不会真实发平台。

## 真实广告探针

开发者工具 mock 只能验证工程链路。腾讯广告真实点击是否透传 `gdt_vid` / `click_id` / `cb` 必须小预算测试：

1. 发体验版或小流量正式版。
2. 配一条测试广告，预算 100-300 元。
3. 查看最近启动触点的 `query_keys` 和 `raw_json`。
4. 根据真实字段确认 parser。
5. 再开启深层事件 dry-run，最后才考虑真实回传。

## 后端清单

- 手动拉事件：`POST /api/realtime/ingest-now`
- 回算 LTV：`POST /api/realtime/recompute-ltv`
- 回算归因：`POST /api/realtime/recompute-attribution`
- 查看归因：`GET /api/realtime/attribution`

## 回传策略

首期只生成 dry-run：

- `first_open`
- `tutorial_complete`
- `first_order_deliver`
- `first_ad_show`
- `d1_retained`
- `d3_retained`
- `estimated_ltv_bucket`

真实回传前必须检查：

- 平台事件名映射是否正确。
- `click_id` / `gdt_vid` 是否存在。
- dedupe key 是否稳定。
- 平台是否接受 openid/userId 口径。
- 回传窗口是否仍有效。
