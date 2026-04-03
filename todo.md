# YouTube Archive Sync Controller TODO (v0.2)

## 当前路线
- [x] 确认架构切换到 Extension-first
- [x] 确认主模式为 `TabSync Mode`（控制现有 tabs）
- [x] 确认可选模式为 `Embed Grid Mode`
- [ ] 冻结 v0.2 需求边界（本周）

## Milestone 1: Extension MVP（主模式）

### A. Extension 基础骨架
- [ ] 初始化 Chrome Extension (MV3) 项目结构
- [ ] 建立 `controller page` / `service worker` / `content script` 三层模块
- [ ] 定义统一类型：Route, SyncState, AudioState, Session
- [ ] 建立消息协议（command/event schema + version）

### B. Tab 导入与路由管理
- [ ] 枚举当前浏览器 YouTube tabs
- [ ] 从 tab 导入到会话（生成 routeId）
- [ ] 路由列表展示（title/url/tabId/status）
- [ ] 删除路由仅移出会话，不关闭 tab
- [ ] 主参考路选择与删除后重选策略

### C. 控制桥接（Content Script）
- [ ] 封装 watch page 播放器控制 adapter
- [ ] 实现 play/pause/seek/getCurrentTime/getDuration
- [ ] 实现 mute/volume/setPlaybackRate
- [ ] 实现状态上报（playing/paused/buffering/error）
- [ ] 注入失败与重试机制

### D. 全局控制
- [ ] Play All
- [ ] Pause All
- [ ] Seek All (T)
- [ ] Sync Now
- [ ] 全局 master time 显示

### E. Offset 与音频
- [ ] 每路 offset（支持正负小数）
- [ ] 每路 mute/volume
- [ ] 单选 solo（不覆盖存储状态）
- [ ] 一键“主路有声，其余静音”

### F. 同步引擎
- [ ] virtual master clock
- [ ] drift 计算：`(master + offset) - current`
- [ ] 稳定区间阈值
- [ ] soft correction：playbackRate（0.98~1.02）
- [ ] hard correction：seek（含 cooldown）
- [ ] 每路 sync status + drift 可视化

### G. 容错与边界
- [ ] 单路异常不阻塞全局
- [ ] tab 关闭/跳转失效处理
- [ ] 广告/状态突变时的降级与恢复
- [ ] 日志与诊断信息面板（最小版）

### H. MVP 验收
- [ ] 2~4 路 tabs 导入稳定
- [ ] 全局控制行为正确
- [ ] offset 与同步行为符合预期
- [ ] audio 语义正确（mute/volume/solo）
- [ ] 异常路不拖垮其他路

## Milestone 2: 可用性增强
- [ ] Session 保存/加载（storage.local）
- [ ] 路由重命名
- [ ] 批量导入与筛选
- [ ] 快捷键体系
- [ ] 更详细同步状态提示

## Milestone 3: 可选模式与扩展
- [ ] `Embed Grid Mode` 设计与实现
- [ ] 主/可选模式共享核心状态与同步引擎
- [ ] 会话导入导出
- [ ] 分享会话配置

## 讨论与决策待办（只讨论，不实现）
- [ ] 是否支持跨窗口分组控制
- [ ] 是否允许“只读路由”（仅观测不控制）
- [ ] ads 场景下的默认策略（暂停同步/继续纠偏）
- [ ] Embed Grid 与 TabSync 的切换 UX
