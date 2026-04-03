# TODO - YouTube Archive Sync Controller (v0.2)

## 0. 目标与范围对齐
- [x] 丢弃旧 `src` 实现，从 `manifest` 开始按 v0.2 架构全新重做
- [ ] 禁止“迁移 v0.1 页面组件”作为任务路径，功能一律按 Extension 三层重新实现
- [ ] 将当前实现目标固定为 `TabSync Mode`（主模式），明确当前版本不交付 `Embed Grid Mode`
- [ ] 在 README 或项目说明中写明 `M1/M2/M3` 范围边界，避免需求漂移

Done when:
- [ ] 文档中明确 `M1 = Extension MVP`，并写明“重做不迁移旧 src 代码”
- [ ] 列出非目标（自动识别联动、自动 offset、跨平台、云端）

## 1. Extension 基础骨架（M1 阻塞项）
- [x] 新建 `manifest.json`（Manifest V3）
- [x] 配置权限：`tabs`、`scripting`、`storage`、`host_permissions: https://www.youtube.com/*`
- [x] 建立 3 个运行单元：`Controller Page`、`Background Service Worker`、`Content Script`
- [x] 打通本地开发与打包流程（Vite + CRX plugin，可加载 `dist/`）

Done when:
- [ ] Extension 可在 Chrome 成功加载
- [ ] Controller Page 能启动并与 Background 双向通信
- [ ] 在 YouTube watch 页面可注入 Content Script

## 2. 核心数据模型与消息协议（M1）
- [ ] 定义统一实体：`Route`、`Session`、`MasterClock`、`RouteRuntime`
- [ ] 定义消息协议（建议按命令和事件分层）：
  - [ ] `Controller -> Background`
  - [ ] `Background -> Content`
  - [ ] `Content -> Background -> Controller`
- [ ] 约定错误码与失败语义（单路失败不阻塞全局）
- [ ] 所有消息增加 `routeId` 与必要时间戳字段

Done when:
- [ ] 类型定义覆盖全链路消息
- [ ] 未知消息、超时、目标 tab 不存在等情况有可观察错误

## 3. Tab 扫描与导入（M1）
- [ ] 实现扫描：当前窗口 / 全部窗口的 YouTube watch tabs
- [ ] UI 支持多选导入到当前 session
- [ ] 导入后展示基础信息：`tab title`、`video title`、`url`、`status`
- [ ] 实现“移出会话”（不关闭 tab）

Done when:
- [ ] 能稳定导入多个 watch tabs
- [ ] 导入后每路都能被独立识别与控制

## 4. Content Script 播放器控制层（M1）
- [ ] 在 watch page 内定位并控制原生播放器（play/pause/seek/volume/mute/rate）
- [ ] 周期上报状态：`currentTime`、`duration`、`player state`
- [ ] 处理广告/缓冲/暂时不可控状态，并上报异常原因
- [ ] 注入失败时支持重试

Done when:
- [ ] 单 tab 内控制指令可重复成功执行
- [ ] 状态上报频率与性能可接受（默认 500ms 级）

## 5. Controller 全局控制（M1）
- [ ] 实现全局按钮：`Play All`、`Pause All`、`Seek All(T)`、`Sync Now`
- [ ] 行为规则：`Seek All` 时每路跳到 `T + offset`
- [ ] 单路执行失败只标记该路，不中断其他路

Done when:
- [ ] 多路全局控制在异常场景下仍可部分成功并正确反馈

## 6. Offset / Audio / Solo 语义（M1）
- [ ] 每路支持正负 `offset`（小数秒）并即时生效
- [ ] 执行层对极端目标时间做边界裁切（0 ~ duration）
- [ ] 每路支持 `mute`、`volume(0~100)`
- [ ] 实现 `solo`（MVP 单选）：
  - [ ] 开启某路 solo 时其他路强制静音
  - [ ] 不覆盖其他路原 `mute/volume` 持久状态
  - [ ] 取消 solo 后恢复各路原状态效果

Done when:
- [ ] `solo` 开关前后的音频状态恢复正确
- [ ] `offset` 改动能在下一轮同步中可观察到

## 7. 同步引擎（M1 核心）
- [ ] 实现 `virtual master clock`
- [ ] 目标时间模型：`targetTime = masterTime + offset`
- [ ] 漂移检测（建议 500ms）：`drift = targetTime - currentTime`
- [ ] 纠偏策略分层：
  - [ ] 稳定区间：`|drift| < 100ms` 不处理
  - [ ] 中误差：`soft correction`（`playbackRate` 约 0.98~1.02）
  - [ ] 大误差：`hard correction`（`seek`，阈值约 1.0s）
- [ ] `hard correction cooldown` + 防震荡策略

Done when:
- [ ] 长时间播放下，漂移可被持续拉回
- [ ] 不出现高频 seek 抖动

## 8. 状态可视化与可观测性（M1）
- [ ] 每路展示：
  - [ ] `loading/ready/playing/paused/buffering/error`
  - [ ] `currentTime`
  - [ ] `offset`
  - [ ] `drift`
  - [ ] `sync status`（`synced/minor-drift/soft-correcting/hard-correcting/severe-drift`）
- [ ] 增加基础诊断信息（最近一次控制失败原因）

Done when:
- [ ] 用户可直接从 UI 判断每路当前是否可控、是否同步

## 9. 生命周期与异常处理（M1）
- [ ] 监听 tab `create/update/remove/activate`
- [ ] tab 被关闭或跳出 YouTube 时自动失效/移出
- [ ] 主参考路失效时自动重选或提示用户
- [ ] 单路异常隔离，不影响全局调度

Done when:
- [ ] 在多窗口和频繁切 tab 场景下状态一致性可保持

## 10. M1 验收清单（必须全部通过）
- [ ] 能导入多个 YouTube tabs
- [ ] 多路可统一 play/pause/seek/sync
- [ ] 每路 offset 生效且同步结果可观察
- [ ] `mute/volume/solo` 语义正确
- [ ] 小误差软纠偏 + 大误差硬拉回可工作
- [ ] 单路异常不影响其他路

## 11. M2 Backlog（可用性增强）
- [ ] session 保存/加载（`chrome.storage`）
- [ ] 批量导入与筛选
- [ ] 更强状态可视化与故障诊断
- [ ] 快捷操作（如“主路有声”）

## 12. M3 Backlog（可选模式与高级增强）
- [ ] `Embed Grid Mode`（复用主模式同步逻辑）
- [ ] 配置导入导出
- [ ] 会话配置分享
