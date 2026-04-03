# TODO - YouTube Archive Sync Controller (v0.2)

## 0. 目标与范围对齐
- [x] 丢弃旧 `src` 实现，从 `manifest` 开始按 v0.2 架构全新重做
- [x] 禁止“迁移 v0.1 页面组件”作为任务路径，功能按 Extension 三层重新实现
- [x] 当前版本目标固定为 `TabSync Mode`（主模式），`Embed Grid Mode` 仅后续
- [x] 在项目说明中写明 `M1/M2/M3` 范围边界，避免需求漂移

Done when:
- [x] 文档中明确 `M1 = Extension MVP`，并写明“重做不迁移旧 src 代码”
- [x] 列出非目标（自动识别联动、自动 offset、跨平台、云端）

## 1. Extension 基础骨架（M1 阻塞项）
- [x] `manifest.json`（Manifest V3）
- [x] 权限配置：`tabs`、`scripting`、`storage`、`windows`、`host_permissions`
- [x] 三个运行单元：`Controller Page`、`Background Service Worker`、`Content Script`
- [x] 本地开发与打包流程（Vite + CRX plugin）
- [x] Controller 采用 compact popup window（非 action popup）
- [x] 前端迁移到 React + TSX（strict TS）

Done when:
- [x] Extension 可在 Chrome 成功加载
- [x] Controller Page 能启动并与 Background 双向通信
- [x] 在 YouTube watch 页面可注入 Content Script

## 2. 核心数据模型与消息协议（M1）
- [x] 定义核心实体：`Route`、`Session`
- [x] 补充实体：`MasterClock`、`RouteRuntime`（供后续 `Auto Sync Correction` 使用）
- [x] 定义消息协议分层：
- [x] `Controller -> Background`
- [x] `Background -> Content`
- [x] `Content -> Background -> Controller`
- [ ] 约定统一错误码（目前为字符串错误）
- [ ] 统一超时语义（目前未做 timeout policy）
- [x] 路由类消息带 `routeId`，关键状态带时间戳

Done when:
- [x] 类型定义覆盖全链路消息
- [ ] 未知消息、超时、目标 tab 不存在等情况全部有一致错误语义

## 3. Tab 扫描与导入（M1）
- [x] 扫描：当前窗口 / 全部窗口的 YouTube watch tabs
- [ ] UI 多选导入（当前为逐条导入）
- [x] 导入后展示基础信息：`tab title`、`video title`、`url`、`status`
- [x] “移出会话”（不关闭 tab）

Done when:
- [x] 能稳定导入多个 watch tabs
- [x] 导入后每路都能被独立识别与控制

## 4. Content Script 播放器控制层（M1）
- [x] 在 watch page 内控制原生播放器（play/pause/seek/volume/mute/rate）
- [x] 周期上报状态（500ms 级）
- [ ] 广告/特殊状态细分与专门错误语义（目前仅基础 buffering/异常）
- [x] 注入失败重试与 ping 校验

Done when:
- [x] 单 tab 内控制指令可重复成功执行
- [x] 状态上报频率与性能可接受（默认 500ms 级）

## 5. Controller 全局控制（M1）
- [x] 全局按钮：`Play All`、`Pause All`、`Seek All(T)`、`Sync Now`
- [x] 新增：`Read Offsets`（从 tabs 反向读取并回写 offset）
- [x] 新增：`Auto Focus`（可选开启；卡片非交互区点击触发 tab/window 聚焦）
- [x] 行为规则：`Seek All` 时每路跳到 `T + offset`
- [x] 单路执行失败不阻塞其他路（`Promise.allSettled`）

Done when:
- [x] 多路全局控制在异常场景下仍可部分成功并正确反馈

## 6. Offset / Audio / Solo 语义（M1）
- [x] 每路支持正负 `offset`（小数秒）并即时生效
- [x] 执行层对极端目标时间做边界裁切（0 ~ duration）
- [x] 每路 `mute`、`volume(0~100)` UI 与会话语义
- [x] `volume` 改为 slider，拖动实时反映并以 debounce 下发
- [x] `solo`（MVP 单选）
- [x] 开启某路 solo 时其他路强制静音
- [x] 不覆盖其他路原 `mute/volume` 持久状态
- [x] 取消 solo 后恢复各路原状态效果

Done when:
- [x] `offset` 改动与反向读取结果可观察
- [x] `solo` 开关前后的音频状态恢复正确

## 7. 同步纠偏引擎（Auto Sync Correction, M1 核心）
- [x] 实现 `virtual master clock`
- [x] 目标时间模型：`targetTime = masterTime + offset`
- [x] 漂移检测（建议 500ms）：`drift = targetTime - currentTime`
- [x] 纠偏策略分层：
- [x] 稳定区间：`|drift| < 100ms` 不处理
- [x] 中误差：`soft correction`（`playbackRate` 约 0.98~1.02）
- [x] 大误差：`hard correction`（`seek`，阈值约 1.0s）
- [x] `hard correction cooldown` + 防震荡策略

Done when:
- [x] 长时间播放下，漂移可被持续拉回
- [x] 不出现高频 seek 抖动

## 8. 状态可视化与可观测性（M1）
- [x] 每路展示：`status`、`currentTime`、`offset`
- [x] 每路展示：`drift`
- [x] 每路展示：`sync status`（`synced/minor-drift/soft-correcting/hard-correcting/severe-drift`）
- [x] 展示基础诊断信息（最近一次控制失败原因）

Done when:
- [x] 用户可直接从 UI 判断每路当前是否可控、是否同步

## 9. 生命周期与异常处理（M1）
- [ ] 监听 tab `create/update/remove/activate`（当前已覆盖 `update/remove`）
- [x] tab 被关闭或跳出 YouTube 时自动失效/移出
- [x] 主参考路失效时自动重选
- [x] 单路异常隔离，不影响全局调度

Done when:
- [ ] 在多窗口和频繁切 tab 场景下状态一致性可保持

## 10. M1 验收清单（必须全部通过）
- [x] 能导入多个 YouTube tabs
- [x] 多路可统一 play/pause/seek/sync
- [x] 每路 offset 生效且同步结果可观察
- [x] `mute/volume/solo` 语义正确
- [x] `Auto Sync Correction`（软纠偏 + 硬拉回）可工作
- [x] 单路异常不影响其他路

## 11. M2 Backlog（可用性增强）
- [ ] session 保存/加载（`chrome.storage`）
- [ ] 批量导入与筛选（含多选导入）
- [ ] 更强状态可视化与故障诊断
- [ ] 快捷操作（如“主路有声”）

## 12. M3 Backlog（可选模式与高级增强）
- [ ] `Embed Grid Mode`（复用主模式同步逻辑）
- [ ] 配置导入导出
- [ ] 会话配置分享
