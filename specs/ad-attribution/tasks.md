# Implementation Plan

- [x] 1. 写规格文档
  - 明确需求、设计、验收边界和非目标。
  - _Requirement: 全部_

- [ ] 2. SDK 公共归因上下文
  - 在 analytics SDK 增加 common params API。
  - 确保旧事件结构兼容。
  - _Requirement: 客户端公共归因字段_

- [ ] 3. 花花客户端接入
  - 新增 AttributionManager。
  - 采集冷启动、热启动 query/referrer。
  - 在 `session_start` 前初始化并上报 touchpoint。
  - _Requirement: 首启可归因、开发者工具可验证_

- [ ] 4. 服务端归因模型
  - 新增归因表、回传队列表和 DAO。
  - 从事件流解析 touchpoint 并写 user attribution。
  - _Requirement: 用户级归因_

- [ ] 5. 归因聚合与 API
  - 输出 campaign/adgroup/creative 维度新增、留存、LTV、深层事件。
  - 提供回算和 dry-run postback API。
  - _Requirement: 深层可分析、回传可控_

- [ ] 6. 前端归因看板
  - 展示归因排行、数据质量、最近触点、回传 dry-run。
  - _Requirement: 调试与发行分析_

- [ ] 7. 回传 dry-run adapter
  - 生成腾讯广告候选 payload。
  - 保持 dry-run，不真实发送。
  - _Requirement: 后续广告平台优化投放_

- [ ] 8. 多游戏接入模板
  - 写花花、水果、灵宠消消塔接入 checklist。
  - _Requirement: 标准可复用_
