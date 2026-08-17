<div align="center">

# 📱 dsh-mobile-access

**DeepSeek Harness 移动端访问插件**

让手机 / 平板通过局域网或 VPN 访问 DeepSeek Harness Web GUI，内置 **PC 端审批门禁**、**LAN / VPN / 公网自动识别** 与 **网络模式切换**。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-brightgreen)](https://github.com/topics/dsh-plugin)
[![GitHub repo size](https://img.shields.io/github/repo-size/TongaiLinC/dsh-mobile-access)](https://github.com/TongaiLinC/dsh-mobile-access)
[![中文](https://img.shields.io/badge/%E4%B8%AD%E6%96%87-README-blue.svg)](README.md)
[![English](https://img.shields.io/badge/English-README--en-blue.svg)](README.en.md)

</div>

---

DeepSeek Harness 的 Web 服务器出于安全设计只绑定 `127.0.0.1`，且官方禁止 `--host 0.0.0.0`。本插件通过插件运行时（`webServer` + `subprocess`）实现：PC 端一键启动**网关代理**（监听 `0.0.0.0:<端口>`），手机扫码即可访问；首次访问必须由 PC 端批准，防止未授权设备接入。

## 📑 目录

- [✦ 功能特性](#功能特性)
- [✦ 开始使用（安装）](#开始使用安装)
- [✦ 快速上手](#快速上手)
- [✦ 工作原理](#工作原理)
- [✦ 常见问题](#常见问题)
- [✦ 三方插件适配](#三方插件适配)
- [✦ 文档](#文档)
- [✦ License](#license)

---

## 功能特性

- ✅ **PC 端审批门禁**：手机设备首次访问必须由 PC 端批准后才能使用；支持批准 / 拒绝 / 撤销 / 恢复 / 删除 / **取消授权并删除**（撤销 + 清记录一步到位）
- ✅ **局域网 / VPN / 公网自动识别**：按访问来源自动分类（LAN / VPN / 公网直连），网络环境变化时手机端弹窗询问是否切换
- ✅ **外网安全访问**：公网直连会提示改用 Tailscale / ZeroTier；可开启「禁止公网直连」策略强制走 VPN
- ✅ **手机扫码直达**：PC 面板内嵌二维码（纯 JS 生成的 QR，无任何外部依赖），扫码即访问
- ✅ **实时状态同步**：PC 端「当前会话」自动同步到手机端，两边打开同一个工作区
- ✅ **WebSocket 实时转发**：网关代理完整转发 `/api/events.mux`、`/api/events.host` 两条 WebSocket 通道，消息实时到达，无需手动刷新
- ✅ **主题自适应**：全部颜色走 DSH 主题 token（`--dsw-alias-*`），自动适配浅色 / 深色主题与第三方皮肤（如 dsh-deep-whale）
- ✅ **移动端 UI 适配**：输入栏工具区与操作区自动分行、设置模态全屏化、皮肤角色层避让、字体按手机屏幕优化
- ✅ **状态持久化**：设备、策略、模式选择保存到 `$DSH_HOME/dsh-mobile/state.json`，重启后不丢失

---

## 开始使用（安装）

> 本插件是**静态 cordis 插件包**，随 DSH 启动自动加载，与官方插件（如 dsh-balance-plugin）相同的安装方式。

### 方式一：`dsh plugin` 命令

```bash
# 本地目录安装（开发）
dsh plugin --profile web add dsh-mobile-access

# 或从 GitHub 安装（锁定发布版本 v1.0.0）
dsh plugin --profile web add dsh-mobile-access@github:TongaiLinC/dsh-mobile-access
```

### 方式二：手动编辑 profile（与现有插件一致）

编辑 `$DSH_HOME/profiles/web/package.json`：

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* ... 已有 bundle ... */ "dsh-mobile-access" ] } },
  "dependencies": {
    // 本地开发：link 到仓库目录；正式安装用 GitHub 地址
    "dsh-mobile-access": "github:TongaiLinC/dsh-mobile-access"
  }
}
```

然后在 profile 目录执行 `pnpm install`（或 `npm install`），**重启 DSH**。启动后 PC 页面右下角出现蓝色「📱」悬浮按钮即生效。

> ✅ 正式安装后**无需每次重启重新部署**（与动态版不同）；设备与策略数据仍保存在 `$DSH_HOME/dsh-mobile/state.json`，与动态版共用，不会丢失。

### 方式三：动态版（开发 / 临时使用）

把 `dsh-mobile-access.js` 的内容作为 `code.host` 在 Web GUI 会话中用 `cordis_define` + `cordis_run` 运行。动态版是**进程级**的，DSH 重启后需重新部署；适合快速迭代调试，正式使用建议用方式一 / 二。

### 环境要求

- DeepSeek Harness（Web GUI 版），使用 Cordis 插件体系
- 运行 DSH 的 PC 与本机网络环境（Windows / macOS / Linux 均可，地址枚举自动适配）
- 手机与 PC 处于同一局域网（局域网访问），或两端安装 Tailscale / ZeroTier（VPN 访问）
- Windows 用户：防火墙需放行网关端口（默认 `3081`，TCP 入站）

### 开发环境

本插件使用 DeepSeek Harness 的**创造模式**开发：

- 主要模型：`deepseek-v4-flash`（Max 模式）
- 辅助模型：`deepseek-v4-pro`（Max 模式）

移动端适配均通过 Playwright 真实浏览器（iPhone / 安卓视口）断言验证。

---

## 快速上手

### 1. PC 端：启动网关

点击右下角「📱」打开「移动端访问」面板：

1. 点击 **「启动网关」**（监听 `0.0.0.0:3081`，可改端口）；
2. 面板会生成**二维码**（局域网地址）；
3. Windows 首次使用时防火墙会弹窗，请允许 node 在专用网络入站。

### 2. 手机端：扫码访问

- 手机连接同一 Wi-Fi，用相机 / 微信扫二维码即可打开 GUI；
- 或手动在浏览器输入 `http://<PC局域网IP>:3081`（面板中可复制）。

### 3. 首次访问审批

- 手机首次访问会进入**门禁页**（等待批准），或加载后全屏门禁遮罩；
- 给设备起名后提交申请；
- PC 面板「设备审批」区出现待审批设备 → 点击 **「批准」**；
- 手机端约 3 秒内自动放行进入 GUI。

### 4. 网络模式切换

- 手机端顶部状态栏居中显示**模式徽章**：`局域网` / `VPN` / `公网直连`，点击可查看提示；
- 检测到访问方式变化（如从 Wi-Fi 切到流量）时自动弹窗询问是否切换；
- 公网直连时建议连接 Tailscale / ZeroTier 后切换到 VPN 地址（面板「VPN 地址」区可复制）。

### 5. 设备管理（PC 面板）

| 状态 | 可执行操作 |
|---|---|
| 待审批 | 批准 / 拒绝 |
| 已批准 | 撤销（保留记录）/ 取消授权并删除（撤销 + 删除记录，需确认） |
| 已拒绝 / 已撤销 | 恢复 / 删除记录 |

### 6. 安全策略（PC 面板）

- **禁止公网直连**：开启后，公网来源的设备一律拦截，必须经 VPN 访问；
- **网关端口**：修改后点「保存策略」生效。

### 仓库结构

```
dsh-mobile-access/                  # 本仓库即一个可安装的 DSH 插件包（npm 包结构）
├── package.json                    # 包清单：dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml                # 组合补丁：向 profile 插入插件行
├── lib/index.js                    # Host 插件本体（静态 cordis 插件，ESM）
├── dsh-mobile-access.js            # 动态版源码（code.host 函数体，用于会话内 cordis_define）
├── README.md / README.en.md        # 中英双语说明
└── CHANGELOG.md                    # 版本更新记录
```

---

## 工作原理

```
手机 ──> http://<LAN-IP>:3081 (网关代理, 0.0.0.0)
              │  gate 裁决（x-dshm-real-ip / x-dshm-forwarded-host 仅信任回环来源）
              │  未批准设备 → 302 门禁页；已批准设备 → 转发
              ▼
        127.0.0.1:3080 主服务器（Host 改写为 127.0.0.1 以通过 /api 信任围栏）
              │  注入 boot.js（PC 面板 / 手机门禁 / 模式弹窗 / 徽章 / QR）
              ▼
        状态持久化 $DSH_HOME/dsh-mobile/state.json
```

关键机制：

- `webServer.tapIndex` 向每个 GUI 页面注入 `/dsh-mobile/api/boot.js`（PC 面板、手机门禁、模式弹窗、二维码），并在 `<head>` 顶部注入 `crypto.randomUUID` 补丁（手机经 `http://<IP>` 访问属非安全上下文，产品多处 UI 依赖该 API，缺失会崩溃）；
- `webServer.register` 提供 `/dsh-mobile/api/*` 接口与 `/dsh-mobile/gate.html` 门禁页；
- `subprocess` 派生 node 网关代理进程，转发 HTTP 与 WebSocket（含 101 升级握手）；
- 设备审批、策略、模式选择通过 `fs` 持久化。

---

## 常见问题

**Q：手机打不开 `http://<IP>:3081`？**
检查：PC 与手机是否同一局域网；网关是否在运行（面板可见）；Windows 防火墙是否放行端口（可在「Windows 安全中心 → 防火墙 → 允许应用」中放行 node.exe 的专用网络入站）。

**Q：DSH 重启后插件不见了？**
动态插件为进程级，重启后需按「安装」章节重新部署；设备与策略数据保留在 `$DSH_HOME/dsh-mobile/state.json`。

**Q：手机端部分页面白屏 / 报错？**
确认页面已强制刷新（拉取最新 boot.js）。若仍异常，多为非安全上下文缺少 `crypto.randomUUID`——插件已内置补丁，如仍出现请把 PC 面板底部「boot 版本」反馈给作者。

**Q：公网能直连吗？**
能，但强烈建议用 VPN（Tailscale / ZeroTier）加密访问；可在 PC 面板开启「禁止公网直连」强制拦截公网来源。

**Q：改了网关端口后手机连不上？**
保存策略后需重新**启动网关**（先停止再启动），并确认防火墙放行新端口。

---

## 三方插件适配

[dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin)（DeepSeek 余额监控与用量统计：余额监控 · 官方充值入口 · Miyu 风格用量统计 · 三方插件管理）的弹窗内联渲染在输入栏内，移动端存在弹窗被截断/被侧边栏顶栏覆盖、明细表格溢出等问题——本插件已内置全套适配（弹窗层级与位置修复、渲染级校验、iOS 弹窗迁移、表格横向滚动），安装后无需额外配置。详见文档站「DSH 指南 → 第十七章」8.4 节。

---

## 文档

完整开发与使用文档见文档站《DSH 指南 → 第十七章 移动端访问插件实战》：[https://docs.tongai.vip/docs/dsh/zhinandaodu.html](https://docs.tongai.vip/docs/dsh/zhinandaodu.html)（共 17 章：安装部署、PC 面板、手机端流程、网络识别算法、网关代理、API 参考、持久化、移动端 UI 适配等）。

---

## License

MIT
