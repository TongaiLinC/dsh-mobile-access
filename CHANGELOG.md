# Changelog

## [1.0.0] - 2026-08-16

首版发布。

- PC 审批门禁：手机设备首次访问须 PC 批准（批准/拒绝/撤销/恢复/删除/取消授权并删除）
- 局域网 / VPN / 公网自动识别与网络模式切换弹窗（Tailscale / ZeroTier 支持）
- 网关代理子进程（0.0.0.0:3081 → 127.0.0.1:3080），扫码访问、WebSocket 实时转发
- 设备与策略持久化（$DSH_HOME/dsh-mobile/state.json），与动态版共用
- 移动端 UI 适配：窄屏禁用第三方皮肤、设置模态全屏、输入行重排、模式徽章集成侧边栏、轨迹视图隐藏输入框
- dsh-balance-plugin 全套适配：弹窗层级/位置修复、渲染级校验、iOS 弹窗迁移、明细表格横向滚动
- 非安全上下文 crypto.randomUUID polyfill
- 中英双语 README
