/**
 * dsh-mobile-access —— DeepSeek Harness 动态插件源码（Host 半）
 *
 * 用途：为 DeepSeek Harness Web GUI 提供移动端访问支持
 *   1. PC 端审批门禁：手机设备首次访问必须由 PC 端批准后才能使用；
 *   2. 局域网 / 外网自动识别与模式切换：检测访问方式变化并在手机端弹窗询问是否切换；
 *   3. 外网访问建议/强制使用 Tailscale、ZeroTier 等 VPN 提高安全性。
 *
 * 安装方式：在 DSH Web GUI 会话中调用 cordis_define（code.host 填本文件中的函数体），
 * 再用 cordis_run 运行返回的 pluginId/packageId。本文件内容即 code.host 的完整函数体。
 *
 * 实现要点：
 *   - 仅使用 Host 半（动态 Client 半需要审批，且部署审批策略为 never 时会自动拒绝）；
 *   - 全部浏览器端 UI（PC 审批面板、手机门禁、模式切换弹窗）通过 webServer.tapIndex
 *     注入 /dsh-mobile/api/boot.js 实现，门禁页为独立路由 /dsh-mobile/gate.html；
 *   - Web 服务器只绑定 127.0.0.1（--host 0.0.0.0 被官方有意禁止），因此插件通过
 *     subprocess 派生一个 node 网关代理进程监听 0.0.0.0:<proxyPort>，把请求转发到
 *     主服务器并改写 Host/Origin 以通过 /api 信任围栏；未批准设备被代理 302 到门禁页；
 *   - 设备审批、策略、模式选择通过 fs 持久化到 $DSH_HOME/dsh-mobile/state.json；
 *   - LAN/VPN 地址枚举通过 subprocess 调用 powershell / ipconfig / tailscale /
 *     zerotier-cli（尽力而为，失败时优雅降级）。
 */

// ════════════════════════════════════════════════════════════════════════
// 内置资源：
//   BOOT_JS       —— 注入到每个 GUI 页面的运行时（PC 审批面板 / 手机门禁 / 模式弹窗 / QR）
//   GATE_HTML     —— 独立门禁页（未批准设备的落地页）
//   PROXY_SRC     —— 网关代理子进程（node -e 源码）
//   CRYPTO_POLYFILL —— crypto.randomUUID 补丁：手机/平板经 http://<LAN-IP> 访问属
//                     非安全上下文，crypto.randomUUID 不可用，产品多个界面
//                     （Agent 预设 / 模型设置 / 插件列表等）会直接崩溃；
//                     该补丁同步注入 <head> 顶部，先于任何产品脚本执行。
// ════════════════════════════════════════════════════════════════════════

const CRYPTO_POLYFILL = `<script>(function(){if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID==="function")return;var p=function(){var s="",r,i;for(i=0;i<36;i++){if(i===8||i===13||i===18||i===23){s+="-";continue}r=Math.floor(Math.random()*16);if(i===14)r=4;if(i===19)r=(r&3)|8;s+=r.toString(16)}return s};try{if(typeof crypto==="undefined"||!crypto){if(typeof window!=="undefined")window.crypto={}}if(crypto)crypto.randomUUID=p}catch(e){try{Object.defineProperty(window,"crypto",{configurable:true,value:{randomUUID:p}})}catch(e2){}}window.dshmUuidPoly=p})()<\/script>`

const BOOT_JS = `
(function () {
'use strict'
/* 防御性补丁：若非安全上下文导致 crypto.randomUUID 缺失（<head> 内联补丁
   未能先行注入时兜底），恢复产品功能。 */
if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID !== 'function') {
  try {
    crypto.randomUUID = function () {
      var s = ''
      for (var i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) { s += '-'; continue }
        var r = Math.floor(Math.random() * 16)
        if (i === 14) r = 4
        if (i === 19) r = (r & 3) | 8
        s += r.toString(16)
      }
      return s
    }
  } catch (e) {}
}
var API = '/dsh-mobile/api'
var DEV = 'dshm_dev'
var MODE = 'dshm_mode'
var MUTE = 'dshm_mute'
var HOST = 'dshm_host'
var BYPASS = 'dshm_wan_bypass'

function cookie(name) {
  var m = document.cookie.split('; ')
  for (var i = 0; i < m.length; i++) {
    var p = m[i].split('=')
    if (p[0] === name) { try { return decodeURIComponent(p.slice(1).join('=')) } catch (e) { return '' } }
  }
  return ''
}
function setCookie(name, value, days) {
  var d = new Date()
  d.setTime(d.getTime() + days * 86400000)
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; expires=' + d.toUTCString()
}
function uuid() {
  var s = ''
  for (var i = 0; i < 32; i++) {
    var r = Math.floor(Math.random() * 16)
    if (i === 12) r = 4
    if (i === 16) r = (r & 3) | 8
    s += r.toString(16)
  }
  return s
}
function deviceId() {
  var id = ''
  try { id = localStorage.getItem(DEV) || '' } catch (e) {}
  if (!id) id = cookie(DEV)
  if (!id) { id = uuid(); try { localStorage.setItem(DEV, id) } catch (e) {} }
  setCookie(DEV, id, 365)
  return id
}
function isMobile() {
  var ua = navigator.userAgent
  return ua.indexOf('Android') >= 0 || ua.indexOf('iPhone') >= 0 || ua.indexOf('iPad') >= 0 ||
    ua.indexOf('iPod') >= 0 || ua.indexOf('Mobile') >= 0 ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 860)
}
function apiGet(path) {
  return fetch(API + path, { headers: { 'x-dshm-admin': '1' } })
    .then(function (r) { return r.json().catch(function () { return null }) })
    .catch(function () { return null })
}
function apiPost(path, body) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dshm-admin': '1' },
    body: JSON.stringify(body || {}),
  }).then(function (r) { return r.json().catch(function () { return null }) })
    .catch(function () { return null })
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}
function el(tag, cls, html) {
  var n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}
function toast(msg) {
  var t = el('div', 'dshm-toast', esc(msg))
  document.body.appendChild(t)
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t) }, 3200)
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast('已复制：' + text) }, function () { fallbackCopy(text) })
  } else fallbackCopy(text)
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); toast('已复制：' + text) } catch (e) { toast('复制失败，请手动输入：' + text) }
  document.body.removeChild(ta)
}
function firstOf(a) { return a && a.length ? a[0] : null }
function modeLabel(m) { return m === 'lan' ? '局域网' : (m === 'vpn' ? 'VPN' : '公网直连') }

var CSS = [
  /* 全部颜色走 DSH 主题 token（--dsw-alias-*），自动跟随浅色/深色主题与
     第三方皮肤（如 dsh-deep-whale 深海女仆工坊覆盖同一套变量）；括号内为
     变量缺失时的回退值。 */
  '.dshm-gate,.dshm-wanblock{position:fixed;inset:0;z-index:2147483647;background:var(--dsw-alias-bg-base,#0f1420);color:var(--dsw-alias-label-primary,#e6ebf4);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.dshm-gate-inner{max-width:420px;width:calc(100% - 48px);text-align:center}',
  '.dshm-gate .dshm-logo{width:64px;height:64px;line-height:64px;margin:0 auto 16px;border-radius:16px;background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:700;font-size:24px}',
  '.dshm-gate h2{margin:0 0 8px;font-size:20px}',
  '.dshm-gate p{margin:6px 0;color:var(--dsw-alias-label-secondary,#9aa7bd);font-size:14px;line-height:1.6}',
  '.dshm-gate .dshm-spinner{width:34px;height:34px;margin:18px auto;border:3px solid var(--dsw-alias-border-l2,#2a3450);border-top-color:var(--dsw-alias-state-business-primary,#2563eb);border-radius:50%;animation:dshmspin 0.9s linear infinite}',
  '@keyframes dshmspin{to{transform:rotate(360deg)}}',
  '.dshm-gate input{width:100%;box-sizing:border-box;padding:12px 14px;margin:10px 0;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#2a3450);background:var(--dsw-alias-bg-layer-1,#0f1420);color:var(--dsw-alias-label-primary,#e6ebf4);font-size:16px}',
  '.dshm-gate .dshm-btn{display:block;width:100%;box-sizing:border-box;padding:13px;margin:8px 0;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:16px;font-weight:600}',
  '.dshm-gate .dshm-btn.ghost{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-secondary,#9aa7bd)}',
  '.dshm-gate .dshm-err{color:var(--dsw-alias-state-error-primary,#f87171)}',
  '.dshm-badge{position:fixed;left:12px;bottom:12px;z-index:2147482900;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary-inverted,#fff);font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 2px 8px rgba(0,0,0,0.35));cursor:pointer}',
  '.dshm-badge.lan{background:var(--dsw-alias-state-success-primary,#16a34a)}.dshm-badge.vpn{background:var(--dsw-alias-state-business-primary,#2563eb)}.dshm-badge.wan{background:var(--dsw-alias-state-warn-primary,#ea580c)}',
  /* 侧边栏徽章（v35）：贴在会话侧边栏底缘、设置齿轮按钮正下方，
     与侧边栏图标一致的紧凑样式 */
  '.dshm-badge-rail{position:absolute;left:50%;transform:translateX(-50%);bottom:2px;width:40px;padding:1px 2px;border:0;border-radius:5px;font-size:8px;font-weight:600;line-height:1.2;text-align:center;color:var(--dsw-alias-label-primary-inverted,#fff);background:var(--dsw-alias-state-success-primary,#16a34a);cursor:pointer;font-family:system-ui,sans-serif;box-sizing:border-box}',
  '.dshm-badge-rail.vpn{background:var(--dsw-alias-state-business-primary,#2563eb)}.dshm-badge-rail.wan{background:var(--dsw-alias-state-warn-primary,#ea580c)}',
  '.dshm-popup{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:var(--dsw-alias-bg-layer-2,#171e2e);color:var(--dsw-alias-label-primary,#e6ebf4);border-top:1px solid var(--dsw-alias-border-l2,#2a3450);border-radius:16px 16px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 -6px 30px rgba(0,0,0,0.5))}',
  '.dshm-popup h3{margin:0 0 8px;font-size:17px}',
  '.dshm-popup p{margin:0 0 14px;color:var(--dsw-alias-label-secondary,#9aa7bd);font-size:14px;line-height:1.6}',
  '.dshm-popup .dshm-btn{display:block;width:100%;box-sizing:border-box;padding:13px;margin:8px 0 0;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:15px;font-weight:600}',
  '.dshm-popup .dshm-btn.ghost{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#cbd5e1)}',
  '.dshm-popup .dshm-btn.plain{background:transparent;color:var(--dsw-alias-label-tertiary,#64748b)}',
  '.dshm-fab{position:fixed;right:18px;bottom:18px;z-index:2147482800;width:52px;height:52px;border:0;border-radius:50%;background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:22px;cursor:pointer;box-shadow:var(--dsw-shadow-lv3,0 4px 14px rgba(0,0,0,0.35))}',
  '.dshm-fab-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;line-height:18px;padding:0 4px;border-radius:9px;background:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:11px;font-weight:700}',
  '.dshm-panel{position:fixed;right:18px;bottom:80px;z-index:2147482800;width:min(400px,calc(100vw - 36px));max-height:calc(100vh - 120px);overflow:auto;background:var(--dsw-alias-bg-layer-2,#171e2e);color:var(--dsw-alias-label-primary,#e6ebf4);border:1px solid var(--dsw-alias-border-l2,#2a3450);border-radius:14px;padding:16px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:var(--dsw-shadow-lv3,0 8px 30px rgba(0,0,0,0.5))}',
  '.dshm-panel h3{margin:0 0 10px;font-size:15px}',
  '.dshm-panel h4{margin:14px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary,#9aa7bd);font-weight:600}',
  '.dshm-panel .row{display:flex;align-items:center;gap:8px;margin:4px 0;flex-wrap:wrap}',
  '.dshm-panel .url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-layer-1,#0f1420);border:1px solid var(--dsw-alias-border-l2,#2a3450);border-radius:8px;padding:7px 10px;color:var(--dsw-alias-state-business-primary,#93c5fd)}',
  '.dshm-panel .btn{border:0;border-radius:8px;padding:7px 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#cbd5e1);cursor:pointer;font-size:12px}',
  '.dshm-panel .btn.primary{background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff)}',
  '.dshm-panel .btn.danger{background:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-label-primary-inverted,#fff)}',
  '.dshm-panel .btn:disabled{opacity:0.5;cursor:default}',
  '.dshm-panel .warn{background:var(--dsw-alias-state-warn-tertiary,#3a2a10);border:1px solid var(--dsw-alias-state-warn-secondary,#6b4a15);color:var(--dsw-alias-state-warn-label,#fbbf24);border-radius:8px;padding:8px 10px;margin:6px 0;line-height:1.5}',
  '.dshm-panel .ok{color:var(--dsw-alias-state-success-primary,#4ade80)}',
  '.dshm-panel .bad{color:var(--dsw-alias-state-error-primary,#f87171)}',
  '.dshm-panel .dev{border:1px solid var(--dsw-alias-border-l2,#2a3450);border-radius:10px;padding:8px 10px;margin:6px 0}',
  '.dshm-panel .dev .meta{color:var(--dsw-alias-label-tertiary,#94a3b8);font-size:11px;margin-top:2px}',
  '.dshm-panel label{display:flex;align-items:center;gap:8px;margin:6px 0;color:var(--dsw-alias-label-primary,#cbd5e1)}',
  '.dshm-panel input[type=number]{width:90px;background:var(--dsw-alias-bg-layer-1,#0f1420);border:1px solid var(--dsw-alias-border-l2,#2a3450);color:var(--dsw-alias-label-primary,#e6ebf4);border-radius:8px;padding:6px 8px}',
  '.dshm-panel .qr{text-align:center;margin:8px 0}',
  '.dshm-panel .qr canvas{width:180px;height:180px;background:#fff;border-radius:10px;padding:6px}',
  '.dshm-panel .dshm-qrbox{border:1px solid var(--dsw-alias-state-business-primary,#2563eb);border-radius:10px;padding:8px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-active,rgba(37,99,235,0.08))}',
  '.dshm-panel .dshm-qrbox-off{border-color:var(--dsw-alias-border-l2,#2a3450);background:transparent}',
  '.dshm-panel .dshm-qrph{width:180px;height:180px;margin:0 auto;background:var(--dsw-alias-bg-layer-1,#0f1420);border:1px dashed var(--dsw-alias-border-l2,#2a3450);border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#64748b);font-size:12px;line-height:1.6}',
  '.dshm-panel .muted{color:var(--dsw-alias-label-tertiary,#64748b);font-size:11px;line-height:1.5}',
  '.dshm-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;background:var(--dsw-alias-bg-overlay,#0f1420);color:var(--dsw-alias-label-primary,#e6ebf4);border:1px solid var(--dsw-alias-border-l2,#2a3450);padding:10px 16px;border-radius:10px;font-size:13px;font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 4px 14px rgba(0,0,0,0.4))}',
  /* 域名直连 3080 导致 GUI 空白的提示横幅（boot.js 检测到 #root 无内容时显示） */
  '.dshm-warn-banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:var(--dsw-alias-state-warn-primary,#ea580c);color:#fff;padding:10px 16px;font-size:13px;line-height:1.6;font-family:system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3)}',
  /* 三方插件（dsh-balance-plugin）弹窗层级提到最大（配合 boot.js 的 DOM 迁移，
     确保 iOS 上不被任何元素遮挡） */
  '.bmon-overlay{z-index:2147483647!important;width:100vw!important;height:100vh;height:100dvh!important;transform:translateZ(0)!important}',
  /* 模型消耗明细表格：窄容器内横向滚动——表格列宽由内容决定（如模型名、
     金额），在手机上会被内容撑出弹窗范围（实测 .bmon-table 516px > 容器
     344px）；约束容器宽度并让表格在内部横向滚动，列宽保持可读 */
  '.bmon-u-modelbody{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}',
  '.bmon-u-table-scroll{max-width:100%;-webkit-overflow-scrolling:touch}',
  /* 移动端适配（与产品窄屏断点 1024px 一致） */
  '@media (max-width:1023px){',
  '.dshm-fab{right:14px;bottom:calc(14px + env(safe-area-inset-bottom))}',
  '.dshm-panel{right:10px;left:10px;bottom:74px;width:auto;max-height:calc(100dvh - 110px)}',
  /* 移动端字体整体调小一档，避免在手机屏幕上显得偏大 */
  '.dshm-panel{font-size:12px}.dshm-panel h3{font-size:14px}.dshm-panel .btn{font-size:11px}',
  '.dshm-popup{font-size:13px}.dshm-popup h3{font-size:15px}.dshm-popup p{font-size:13px}.dshm-popup .dshm-btn{font-size:14px}',
  '.dshm-gate h2{font-size:18px}.dshm-gate p{font-size:13px}.dshm-gate input{font-size:14px}.dshm-gate .dshm-btn{font-size:14px}',
  '.dshm-toast{font-size:12px}',
  /* 网络模式徽章：移到顶部状态栏（居中），避开左右两侧按钮区；缩小半透明减少遮挡 */
  '.dshm-badge{left:50%;transform:translateX(-50%);top:calc(6px + env(safe-area-inset-top));bottom:auto;font-size:10px;padding:4px 10px;opacity:0.85;line-height:1.4}',
  '.dshm-popup{padding-left:16px;padding-right:16px}',
  '.dshm-gate-inner{width:calc(100% - 32px)}',
  /* 输入框行：工具区（命令/访问模式/余额/用量/三方插件）与操作区（模型选择/
     token/发送）强制分行（flex-wrap 保底）；行与子元素均可收缩，发送按钮、
     token 计数等不再把整行推出屏幕外 */
  '[data-dshm-row]{display:flex!important;flex-wrap:wrap!important;gap:6px 8px;max-width:100%;min-width:0;box-sizing:border-box}',
  '[data-dshm-tools]{flex:1 1 100%;display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;overflow-x:auto;scrollbar-width:none}',
  /* 权限（访问模式）等下拉菜单从工具区弹出（absolute 定位，side=top 向上），
     而 tools 是 overflow:auto 滚动容器（高仅一行 28px），菜单完全超出其边界
     被裁剪——手机上看不到也点不到（elementFromPoint 命中底下的输入卡片）。
     菜单打开期间（tools 内有 [role=menu]）放开裁剪，关闭后自动恢复滚动。 */
  '[data-dshm-tools]:has([role="menu"]){overflow:visible!important}',
  '[data-dshm-trailing]{flex:1 1 100%;display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;max-width:100%}',
  '[data-dshm-tools] button{flex:none}',
  /* trailing 内：直接按钮与含按钮的容器（如上下文用量指示器 span>button）
     不收缩；纯文本容器（token 计数等）可收缩并省略号截断；整体不做
     overflow:hidden，避免裁剪模型选择 / 上下文展开的下拉面板 */
  '[data-dshm-trailing]>*{flex-shrink:1;min-width:0}',
  '[data-dshm-trailing]>button,[data-dshm-trailing]>span:has(button){flex:none}',
  '[data-dshm-trailing]>span:not(:has(button)){white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
  /* 皮肤（dsh-deep-whale 等）角色层：窄屏左侧角色隐藏；右侧角色缩小并移到
     左下角（点击穿透），避免遮挡右上角余额/用量等状态区域 */
  'body[data-dsh-maid-atelier] [data-maid-character="left"]{opacity:0!important;pointer-events:none!important}',
  'body[data-dsh-maid-atelier] [data-maid-character="right"]{right:auto!important;left:6px;bottom:0;top:auto;transform:scale(0.6);transform-origin:bottom left;opacity:0.5;pointer-events:none!important}',
  /* 皮肤被禁用（data-dsh-maid-atelier 属性被移除）后，残留的装饰元素以默认样式
     占据页面并拦截点击，兜底隐藏（JS 侧已同步移除这些元素） */
  'body:not([data-dsh-maid-atelier]) [data-skin-chrome],body:not([data-dsh-maid-atelier]) [data-maid-character]{display:none!important}',
  /* 皮肤装饰条在窄屏隐藏：top-trim（顶部 76px 装饰图）会盖住顶栏余额/用量，
     bottom-trim 会遮输入区 */
  'body[data-dsh-maid-atelier] [data-skin-chrome=top-trim],body[data-dsh-maid-atelier] [data-skin-chrome=bottom-trim]{display:none!important}',
  /* iOS Safari 合成层问题：filter / will-change / contain 等属性会把元素提升为
     合成层并绘制在所有 z-index 之上（安卓 Chrome 正常），导致 iPhone 上所有弹窗
     被角色图盖住。三重处理：① 角色元素去掉 filter；② 舞台去掉 contain 与
     will-change；③ 任何浮层（门禁 / 弹窗 / 对话框 / 菜单 / 列表）出现时直接隐藏
     舞台——visibility:hidden 不参与绘制，无论合成层如何排序都不会遮挡 */
  'body[data-dsh-maid-atelier] [data-maid-character]{filter:none!important}',
  'body[data-dsh-maid-atelier] [data-skin-chrome=character-stage]{contain:none!important;will-change:auto!important}',
  'body:has(.dshm-gate,.dshm-wanblock,.dshm-popup,[role="dialog"],[role="listbox"],[role="menu"]) [data-skin-chrome=character-stage]{visibility:hidden!important}',
  /* 产品设置模态：手机上全屏 + 纵向布局——导航变顶部横向滚动条、内容占满
     下方；面板默认 flex row（188px 侧导航），必须改为 column，否则内容列
     在窄屏永远拿不到宽度。dialog 背景是产品毛玻璃半透明（浅色主题 68%
     不透明），全屏后对话背景会透出（视觉上像被对话背景遮盖），v22 起
     强制为不透明主题底色；presentation 覆盖层 z-index 提到最大 */
  '[role="presentation"]{z-index:2147483647!important}',
  '[role="presentation"]>[role="dialog"]{width:100vw!important;max-width:100vw!important;height:100dvh!important;max-height:100dvh!important;border-radius:0!important;flex-direction:column!important}',
  /* dialog 背景：产品默认是半透明毛玻璃（浅色 68% 不透明），且皮肤会把
     --dsw-alias-bg-base 在部分作用域定义为 transparent，var() 会解析成透明。
     因此直接用静态双主题色（浅色近白 / 深色深蓝黑），保证完全不透出对话背景 */
  'body:not([data-ds-dark-theme]) [role="presentation"]>[role="dialog"]{background:#f8faff!important}',
  'body[data-ds-dark-theme] [role="presentation"]>[role="dialog"]{background:#0d193b!important}',
  '[role="presentation"]>[role="dialog"]>:first-child{flex:none;width:100%;max-width:100%;flex-direction:row;padding:8px 12px;gap:6px;align-items:center;overflow:hidden;box-sizing:border-box}',
  '[role="presentation"]>[role="dialog"]>:first-child>:first-child{display:none}',
  '[role="presentation"]>[role="dialog"]>:first-child>:last-child{flex-direction:row;overflow-x:auto;scrollbar-width:none;gap:4px;flex:1;min-width:0}',
  '[role="presentation"]>[role="dialog"]>:last-child{flex:1;min-height:0}',
  /* 输入框行：模型选择按钮压缩（隐藏推理等级、截断模型名），发送按钮收窄，
     防止 trailing 区溢出屏幕；token 环保留在发送按钮旁 */
  'button[aria-label*="选择模型"]{max-width:112px!important;min-width:0;flex-shrink:1;padding-left:8px;padding-right:6px;overflow:hidden}',
  'button[aria-label*="选择模型"]>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  'button[aria-label*="选择模型"]>span:nth-child(2){display:none}',
  'button[aria-label="发送消息"]{width:40px!important;height:40px!important;flex:none}',
  '}'
].join('')
function injectStyle() {
  if (document.getElementById('dshm-style')) return
  var st = document.createElement('style')
  st.id = 'dshm-style'
  st.textContent = CSS
  document.head.appendChild(st)
}

/* ───────────── QR 编码器（字节模式，ECC-L，版本 1-6） ───────────── */
var dshmQR = (function () {
  var CAP = [19, 34, 55, 80, 108, 136]
  var ECC = [7, 10, 15, 20, 26, 18]
  var ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]]
  var exp = new Array(512)
  var log = new Array(256)
  ;(function () {
    var x = 1
    for (var i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D }
    for (var i = 255; i < 512; i++) exp[i] = exp[i - 255]
  })()
  function mul(a, b) { return a === 0 || b === 0 ? 0 : exp[log[a] + log[b]] }
  function rsGen(degree) {
    var g = [1]
    for (var i = 0; i < degree; i++) {
      var next = new Array(g.length + 1)
      for (var j = 0; j < next.length; j++) next[j] = 0
      for (var j = 0; j < g.length; j++) {
        next[j] = next[j] ^ mul(g[j], 1)
        next[j + 1] = next[j + 1] ^ mul(g[j], exp[i])
      }
      g = next
    }
    return g
  }
  function rsEncode(data, degree) {
    var gen = rsGen(degree)
    var rem = new Array(degree)
    for (var i = 0; i < degree; i++) rem[i] = 0
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0]
      for (var j = 0; j < degree - 1; j++) rem[j] = rem[j + 1]
      rem[degree - 1] = 0
      if (factor !== 0) for (var j = 0; j < degree; j++) rem[j] = rem[j] ^ mul(gen[j + 1], factor)
    }
    return rem
  }
  function bch15(d) {
    var g = 0x537
    var msg = d << 10
    var rem = msg
    for (var i = 14; i >= 10; i--) if (rem & (1 << i)) rem = rem ^ (g << (i - 10))
    return (msg | rem) ^ 0x5412
  }
  function maskFn(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0
      case 1: return r % 2 === 0
      case 2: return c % 3 === 0
      case 3: return (r + c) % 3 === 0
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
      case 5: return ((r * c) % 2 + (r * c) % 3) === 0
      case 6: return (((r * c) % 2 + (r * c) % 3) % 2) === 0
      case 7: return (((r + c) % 2 + (r * c) % 3) % 2) === 0
    }
    return false
  }
  function baseMatrix(version) {
    var size = 17 + version * 4
    var m = []
    var isFunc = []
    for (var r = 0; r < size; r++) {
      m.push(new Array(size))
      isFunc.push(new Array(size))
      for (var c = 0; c < size; c++) { m[r][c] = -1; isFunc[r][c] = false }
    }
    function set(r, c, v, f) { m[r][c] = v; if (f) isFunc[r][c] = true }
    function finder(r0, c0) {
      for (var r = -1; r < 8; r++) for (var c = -1; c < 8; c++) {
        var rr = r0 + r, cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
        var inner = r >= 0 && r < 7 && c >= 0 && c < 7
        var dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        set(rr, cc, dark ? 1 : 0, true)
      }
    }
    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)
    for (var i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0 ? 1 : 0, true); set(6, i, i % 2 === 0 ? 1 : 0, true) }
    var pos = ALIGN[version - 1]
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var r0 = pos[a], c0 = pos[b]
      if (m[r0][c0] !== -1) continue
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        set(r0 + dr, c0 + dc, (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0, true)
      }
    }
    set(size - 8, 8, 1, true)
    var fmt = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
      [8, size - 1], [8, size - 2], [8, size - 3], [8, size - 4], [8, size - 5], [8, size - 6], [8, size - 7], [8, size - 8],
      [size - 8, 8], [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8], [size - 3, 8], [size - 2, 8], [size - 1, 8]]
    for (var i = 0; i < fmt.length; i++) set(fmt[i][0], fmt[i][1], 0, true)
    return { m: m, isFunc: isFunc, size: size }
  }
  function placeData(m, size, bits) {
    var bi = 0
    var upward = true
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = col - 1
      for (var i = 0; i < size; i++) {
        var row = upward ? size - 1 - i : i
        for (var k = 0; k < 2; k++) {
          var c = col - k
          if (m[row][c] === -1) { m[row][c] = bi < bits.length ? bits[bi] : 0; bi++ }
        }
      }
      upward = !upward
    }
  }
  function placeFormat(m, size, bits) {
    var topLeft = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
    var topRight = [[8, size - 1], [8, size - 2], [8, size - 3], [8, size - 4], [8, size - 5], [8, size - 6], [8, size - 7], [8, size - 8]]
    var bottomLeft = [[size - 8, 8], [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8], [size - 3, 8], [size - 2, 8], [size - 1, 8]]
    for (var i = 0; i < 15; i++) m[topLeft[i][0]][topLeft[i][1]] = (bits >> (14 - i)) & 1
    for (var i = 0; i < 8; i++) m[topRight[i][0]][topRight[i][1]] = (bits >> (7 - i)) & 1
    for (var i = 0; i < 8; i++) m[bottomLeft[i][0]][bottomLeft[i][1]] = (bits >> (7 + i)) & 1
  }
  function penalty(m, size) {
    var score = 0
    for (var r = 0; r < size; r++) {
      var run = 1
      for (var c = 1; c <= size; c++) {
        if (c < size && m[r][c] === m[r][c - 1]) run++
        else { if (run >= 5) score += 3 + (run - 5); run = 1 }
      }
    }
    for (var c = 0; c < size; c++) {
      var run = 1
      for (var r = 1; r <= size; r++) {
        if (r < size && m[r][c] === m[r - 1][c]) run++
        else { if (run >= 5) score += 3 + (run - 5); run = 1 }
      }
    }
    for (var r = 0; r < size - 1; r++) for (var c = 0; c < size - 1; c++) {
      var v = m[r][c]
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
    }
    var pat = [1, 0, 1, 1, 1, 0, 1]
    function patCheck(get, r, c) {
      var found = 0
      var ok = true
      for (var i = 0; i < 7; i++) if (get(r, c + i + 2) !== pat[i]) { ok = false; break }
      if (ok && get(r, c) === 0 && get(r, c + 1) === 0 && get(r, c + 9) === 0 && get(r, c + 10) === 0) found++
      var ok2 = true
      for (var i = 0; i < 7; i++) if (get(r, c + i + 2) !== pat[6 - i]) { ok2 = false; break }
      if (ok2 && get(r, c) === 0 && get(r, c + 1) === 0 && get(r, c + 9) === 0 && get(r, c + 10) === 0) found++
      return found * 40
    }
    for (var r = 0; r < size; r++) for (var c = 0; c <= size - 11; c++) {
      score += patCheck(function (rr, cc) { return m[rr][cc] }, r, c)
    }
    for (var c = 0; c < size; c++) for (var r = 0; r <= size - 11; r++) {
      score += patCheck(function (rr, cc) { return m[cc][rr] }, c, r)
    }
    var dark = 0
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) if (m[r][c] === 1) dark++
    score += Math.floor(Math.abs(dark / (size * size) - 0.5) * 20) * 10
    return score
  }
  function bytesOf(text) {
    var bytes = []
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i)
      if (c < 0x80) bytes.push(c)
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)) }
      else { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)) }
    }
    return bytes
  }
  function qrMatrix(text) {
    var bytes = bytesOf(text)
    var version = 0
    for (var v = 0; v < CAP.length; v++) {
      if (12 + bytes.length * 8 <= CAP[v] * 8) { version = v + 1; break }
    }
    if (!version) return null
    var capacity = CAP[version - 1]
    var bits = []
    function push(v, n) { for (var i = n - 1; i >= 0; i--) bits.push((v >> i) & 1) }
    push(4, 4)
    push(bytes.length, 8)
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8)
    while (bits.length % 8 !== 0) bits.push(0)
    var data = []
    for (var i = 0; i < bits.length; i += 8) data.push(bits[i] * 128 + bits[i + 1] * 64 + bits[i + 2] * 32 + bits[i + 3] * 16 + bits[i + 4] * 8 + bits[i + 5] * 4 + bits[i + 6] * 2 + bits[i + 7])
    var pad = 0xEC
    while (data.length < capacity) { data.push(pad); pad = pad === 0xEC ? 0x11 : 0xEC }
    var degree = ECC[version - 1]
    var blocks = version === 6 ? [data.slice(0, 68), data.slice(68)] : [data]
    var codewords = []
    var eccAll = []
    for (var b = 0; b < blocks.length; b++) {
      var ecc = rsEncode(blocks[b], degree)
      codewords.push(blocks[b])
      eccAll.push(ecc)
    }
    var final = []
    var maxLen = 0
    for (var b = 0; b < codewords.length; b++) if (codewords[b].length > maxLen) maxLen = codewords[b].length
    for (var i = 0; i < maxLen; i++) for (var b = 0; b < codewords.length; b++) if (i < codewords[b].length) final.push(codewords[b][i])
    for (var i = 0; i < degree; i++) for (var b = 0; b < eccAll.length; b++) final.push(eccAll[b][i])
    var allBits = []
    for (var i = 0; i < final.length; i++) for (var n = 7; n >= 0; n--) allBits.push((final[i] >> n) & 1)
    var base = baseMatrix(version)
    var best = null
    for (var mask = 0; mask < 8; mask++) {
      var m = []
      for (var r = 0; r < base.size; r++) m.push(base.m[r].slice())
      placeData(m, base.size, allBits)
      for (var r = 0; r < base.size; r++) {
        for (var c = 0; c < base.size; c++) {
          if (!base.isFunc[r][c]) m[r][c] = m[r][c] ^ (maskFn(mask, r, c) ? 1 : 0)
        }
      }
      placeFormat(m, base.size, bch15((1 << 3) | mask))
      var p = penalty(m, base.size)
      if (best === null || p < best.p) best = { m: m, p: p, version: version, mask: mask }
    }
    return best
  }
  function render(canvas, text) {
    var q = qrMatrix(text)
    if (!q) return false
    var size = q.m.length
    var scale = 4
    var quiet = 4
    var dim = (size + quiet * 2) * scale
    canvas.width = dim
    canvas.height = dim
    var g = canvas.getContext('2d')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, dim, dim)
    g.fillStyle = '#000000'
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
      if (q.m[r][c] === 1) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
    }
    return true
  }
  return { matrix: qrMatrix, render: render, bch15: bch15 }
})()

/* ───────────── 手机端流程 ───────────── */
function showGate(s) {
  var st = s.device ? s.device.status : 'pending'
  var ov = el('div', 'dshm-gate')
  var inner = el('div', 'dshm-gate-inner')
  ov.appendChild(inner)
  document.body.appendChild(ov)
  function paint() {
    var html = '<div class="dshm-logo">DSH</div><h2>等待 PC 端批准</h2>'
    if (st === 'pending') {
      html += '<div class="dshm-spinner"></div>'
      html += '<p>设备「' + esc(s.device ? s.device.name : '') + '」已提交审批请求。</p>'
      html += '<p>请在 PC 端 DeepSeek Harness 页面点击右下角「📱」按钮，在「移动端访问」面板中批准该设备。</p>'
    } else if (st === 'rejected') {
      html += '<p class="dshm-err">该设备的访问申请已被 PC 端拒绝。</p>'
      html += '<button class="dshm-btn" id="dshm-again">重新申请</button>'
    } else {
      html += '<p class="dshm-err">该设备的访问权限已被撤销。</p>'
      html += '<button class="dshm-btn" id="dshm-again">重新申请</button>'
    }
    inner.innerHTML = html
    var again = inner.querySelector('#dshm-again')
    if (again) again.onclick = function () {
      apiPost('/register', { deviceId: deviceId(), name: (s.device && s.device.name) || '手机设备', hostname: location.hostname })
        .then(function () { st = 'pending'; paint() })
    }
  }
  paint()
  var timer = setInterval(function () {
    apiGet('/state?device=' + encodeURIComponent(deviceId())).then(function (s2) {
      if (!s2 || !s2.ok) return
      var st2 = s2.device ? s2.device.status : ''
      if (st2 === 'approved') { clearInterval(timer); location.reload() }
      else if (st2 !== st) { st = st2; paint() }
    })
  }, 3000)
}
function showWanBlock(s) {
  var ov = el('div', 'dshm-wanblock')
  var inner = el('div', 'dshm-gate-inner')
  ov.appendChild(inner)
  document.body.appendChild(ov)
  var vpnUrl = firstOf(s.urls.vpn)
  inner.innerHTML =
    '<div class="dshm-logo">DSH</div>' +
    '<h2>公网直连已被禁止</h2>' +
    '<p>当前通过公网直接访问，管理员已开启「公网直连限制」策略。</p>' +
    '<p>请先连接 Tailscale / ZeroTier 等 VPN，再通过 VPN 地址访问本机。</p>' +
    (vpnUrl ? '<a class="dshm-btn" style="text-decoration:none;display:block" href="' + esc(vpnUrl) + '">打开 VPN 访问地址</a>' : '') +
    '<button class="dshm-btn ghost" id="dshm-continue">仍然继续（不推荐）</button>'
  var cont = inner.querySelector('#dshm-continue')
  if (cont) cont.onclick = function () {
    try { localStorage.setItem(BYPASS, '1') } catch (e) {}
    ov.parentNode.removeChild(ov)
  }
}
function maybeModePopup(s) {
  var mode = s.access.mode
  var prev = null
  try { prev = localStorage.getItem(MODE) } catch (e) {}
  if (!prev) {
    try { localStorage.setItem(MODE, mode) } catch (e) {}
    if (mode === 'wan') showWanNotice(s)
    return
  }
  if (prev === mode) return
  var muted = null
  try { muted = localStorage.getItem(MUTE) } catch (e) {}
  if (muted === mode) { try { localStorage.setItem(MODE, mode) } catch (e) {} return }
  showModePopup(s, prev, mode)
}
function showWanNotice(s) {
  var vpnUrl = firstOf(s.urls.vpn)
  var pop = el('div', 'dshm-popup')
  pop.innerHTML =
    '<h3>外网访问提示</h3>' +
    '<p>当前通过公网直接访问 DeepSeek Harness。建议使用 Tailscale / ZeroTier 等 VPN 访问，以加密传输并隐藏服务端口。</p>' +
    (vpnUrl ? '<button class="dshm-btn" id="dshm-wan-vpn">切换到 VPN 地址</button>' : '') +
    '<button class="dshm-btn ghost" id="dshm-wan-ok">知道了</button>'
  document.body.appendChild(pop)
  var v = pop.querySelector('#dshm-wan-vpn')
  if (v) v.onclick = function () { location.href = vpnUrl }
  pop.querySelector('#dshm-wan-ok').onclick = function () { pop.parentNode.removeChild(pop) }
}
function showModePopup(s, prev, cur) {
  var target = null
  if (cur === 'wan') target = { url: firstOf(s.urls.vpn), label: 'VPN 安全访问' }
  else if (cur === 'lan') target = { url: firstOf(s.urls.lan), label: '局域网直连' }
  else if (prev === 'lan') target = { url: firstOf(s.urls.lan), label: '局域网直连' }
  if (target && target.url) {
    try {
      var sameOrigin = new URL(target.url, location.href).origin === location.origin
      if (sameOrigin) target = null
    } catch (e) {}
  }
  var pop = el('div', 'dshm-popup')
  pop.innerHTML =
    '<h3>网络环境变化</h3>' +
    '<p>检测到访问方式从「' + modeLabel(prev) + '」变为「' + modeLabel(cur) + '」。是否切换到更适合的访问方式？</p>' +
    (target ? '<button class="dshm-btn" id="dshm-switch">切换到' + esc(target.label) + '</button>' : '') +
    '<button class="dshm-btn ghost" id="dshm-stay">保持当前连接</button>' +
    '<button class="dshm-btn plain" id="dshm-mute">不再提醒</button>'
  document.body.appendChild(pop)
  function done(choice) {
    try { localStorage.setItem(MODE, cur) } catch (e) {}
    if (choice === 'mute') try { localStorage.setItem(MUTE, cur) } catch (e) {}
    apiPost('/ack', { deviceId: deviceId(), mode: cur, choice: choice })
    pop.parentNode.removeChild(pop)
  }
  if (target) pop.querySelector('#dshm-switch').onclick = function () { done('switch'); location.href = target.url }
  pop.querySelector('#dshm-stay').onclick = function () { done('stay') }
  pop.querySelector('#dshm-mute').onclick = function () { done('mute') }
}
function showBadge(s) {
  var mode = s.access.mode
  /* 徽章集成到会话侧边栏（rail）底部、设置齿轮按钮下方（v35）：
     绝对定位贴在 rail 底缘。rail 由 React 异步挂载，boot 执行时可能尚未
     渲染——500ms 间隔重试最多 10 次（5 秒），仍不存在才回退 fixed 徽章。 */
  var attempts = 0
  function tryRail() {
    var rail = document.querySelector('.q61U_G_sidebarCol')
    if (rail) {
      if (rail.style.position !== 'relative') rail.style.position = 'relative'
      var b = el('button', 'dshm-badge-rail ' + mode, modeLabel(mode))
      b.type = 'button'
      b.title = '网络模式：' + modeLabel(mode)
      b.onclick = function () {
        if (mode === 'wan') toast('公网直连：流量未加密，建议连接 VPN 后切换到 VPN 地址')
        else if (mode === 'vpn') toast('VPN 访问：连接已通过 Tailscale / ZeroTier 加密')
        else toast('局域网访问：本机与手机处于同一局域网')
        /* 点击后暂时淡出，避免长时间遮挡操作区域；4 秒后恢复 */
        b.style.transition = 'opacity 0.3s ease'
        b.style.opacity = '0'
        setTimeout(function () { b.style.opacity = '' }, 4000)
      }
      rail.appendChild(b)
      return
    }
    if (attempts++ < 10) setTimeout(tryRail, 500)
    else fallbackFixed()
  }
  function fallbackFixed() {
    var fb = el('div', 'dshm-badge ' + mode, modeLabel(mode))
    fb.onclick = function () {
      if (mode === 'wan') toast('公网直连：流量未加密，建议连接 VPN 后切换到 VPN 地址')
      else if (mode === 'vpn') toast('VPN 访问：连接已通过 Tailscale / ZeroTier 加密')
      else toast('局域网访问：本机与手机处于同一局域网')
    }
    document.body.appendChild(fb)
    if (window.matchMedia && window.matchMedia('(max-width:1023px)').matches) {
      badgeAvoid(fb)
      var bTimer = setInterval(function () {
        if (!fb.parentNode) { clearInterval(bTimer); return }
        if (!badgeClear(fb)) badgeAvoid(fb)
      }, 900)
      window.addEventListener('resize', function () { if (fb.parentNode) badgeAvoid(fb) })
    }
  }
  tryRail()
}
/* 网络模式徽章智能避让（窄屏）：徽章默认顶部居中，但产品顶栏中间的文字
   元素（会话模式标签等）恰好在同一区域，会与徽章重叠。检测：对徽章矩形内
   5 个采样点取 elementsFromPoint 元素栈——若栈顶不是徽章自身（被更高层覆盖）
   或徽章之下存在带直接文本的可见元素（文字被徽章盖住），判为重叠；然后按
   候选位置依次尝试（顶栏下方一行/两行、左/右/底部），取第一个干净位置。
   产品 DOM 异步渲染与路由切换会改变顶栏，由调用方轮询重检。 */
var BADGE_POS = [
  null, /* 0：CSS 默认位置（窄屏顶部居中） */
  'top:calc(92px + env(safe-area-inset-top));left:50%;transform:translateX(-50%)',
  'top:calc(124px + env(safe-area-inset-top));left:50%;transform:translateX(-50%)',
  'top:calc(92px + env(safe-area-inset-top));left:12px;transform:none',
  'top:calc(92px + env(safe-area-inset-top));right:12px;transform:none',
  'top:auto;bottom:calc(84px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%)',
  'top:auto;bottom:calc(84px + env(safe-area-inset-bottom));left:12px;transform:none'
]
function badgeTexty(e) {
  if (e === document.body || e === document.documentElement) return false
  var cs = window.getComputedStyle(e)
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
  for (var i = 0; i < e.childNodes.length; i++) {
    var n = e.childNodes[i]
    if (n.nodeType === 3 && n.textContent.replace(/\s/g, '')) return true
  }
  return false
}
function badgeClear(b) {
  var r = b.getBoundingClientRect()
  if (!r.width || !r.height) return false
  /* 采样点向内缩 25%：徽章是 border-radius:999px 的胶囊，边缘 3px 处可能落在
     圆角弧形外，elementsFromPoint 不命中圆角外像素会误判「徽章缺失」 */
  var pts = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + r.width * 0.25, r.top + r.height * 0.25],
    [r.right - r.width * 0.25, r.top + r.height * 0.25],
    [r.left + r.width * 0.25, r.bottom - r.height * 0.25],
    [r.right - r.width * 0.25, r.bottom - r.height * 0.25]
  ]
  for (var i = 0; i < pts.length; i++) {
    var stack = document.elementsFromPoint(pts[i][0], pts[i][1])
    var idx = -1
    for (var j = 0; j < stack.length; j++) {
      if (stack[j] === b) { idx = j; break }
    }
    if (idx < 0) return false /* 徽章不在该点：被更高层覆盖或不可见 */
    for (var k = idx + 1; k < stack.length; k++) {
      /* 只对顶栏条带（视口顶部 100px 内）的文字避让——内容区满屏都是文字，
         若一律避让将永远找不到干净位置 */
      var e = stack[k]
      if (e.getBoundingClientRect().top < 100 && badgeTexty(e)) return false
    }
  }
  return true
}
function badgePlace(b, i) {
  b.style.cssText = BADGE_POS[i] || ''
}
function badgeAvoid(b) {
  if (!window.matchMedia || !window.matchMedia('(max-width:1023px)').matches) {
    badgePlace(b, 0)
    return 0
  }
  for (var i = 0; i < BADGE_POS.length; i++) {
    badgePlace(b, i)
    if (badgeClear(b)) return i
  }
  badgePlace(b, 0)
  return 0
}
/* 运行时标记输入框行容器（产品类名为构建哈希，不能用于注入 CSS；
   结构：textarea → grow → scroll → card(column) → 第 3 子元素为按钮行 row，
   row 的第 1 子元素为工具区、最后子元素为操作区）。GUI 异步挂载且发送消息后
   可能重建输入框 DOM，标记会丢失，因此轮询重打标（setAttribute 幂等）。 */
function markInputRow() {
  try {
    var ta = document.querySelector('textarea')
    if (ta) {
      var card = ta.parentElement && ta.parentElement.parentElement && ta.parentElement.parentElement.parentElement
      if (card && card.children && card.children.length >= 3) {
        var row = card.children[2]
        if (row) {
          row.setAttribute('data-dshm-row', '1')
          if (row.firstElementChild) row.firstElementChild.setAttribute('data-dshm-tools', '1')
          if (row.lastElementChild) row.lastElementChild.setAttribute('data-dshm-trailing', '1')
          return true
        }
      }
    }
    /* 兜底：通过发送按钮反查行容器（主路径因产品 DOM 变化失效时生效） */
    var send = document.querySelector('button[aria-label="发送消息"]')
    if (send) {
      var p = send.parentElement
      if (p) {
        var row2 = p.children && p.children.length >= 2 ? p : p.parentElement
        if (row2) {
          row2.setAttribute('data-dshm-row', '1')
          if (row2 !== p) p.setAttribute('data-dshm-trailing', '1')
          if (row2.firstElementChild && row2.firstElementChild !== p) row2.firstElementChild.setAttribute('data-dshm-tools', '1')
          return true
        }
      }
    }
    return false
  } catch (e) { return false }
}
setInterval(markInputRow, 1000)
/* 轨迹视图隐藏消息发送框（v37）：统计页的「轨迹」tab 激活（role=tab 且
   aria-selected=true，文本为「轨迹」）时隐藏整个输入区（composerSeat），
   切回「对话」恢复。上溯按类名部分匹配 composerSeat（抗构建哈希），
   恢复时清空 display 回到产品原值。 */
function syncTraceComposer() {
  var traceTab = document.querySelector('[role="tab"][aria-selected="true"]')
  var traceActive = false
  if (traceTab) traceActive = /轨迹/.test(traceTab.textContent || '')
  var ta = document.querySelector('textarea')
  if (!ta) return
  var seat = null
  var p = ta.parentElement
  while (p && p !== document.body) {
    if (((p.className || '').toString()).indexOf('composerSeat') >= 0) { seat = p; break }
    p = p.parentElement
  }
  if (!seat) return
  if (traceActive && seat.style.display !== 'none') seat.style.display = 'none'
  else if (!traceActive && seat.style.display === 'none') seat.style.display = ''
}
setInterval(syncTraceComposer, 400)
/* 三方插件弹窗定位补偿：dsh-balance-plugin 的 .bmon-overlay 内联渲染在输入栏内
   （无 portal），祖先链上有滚动容器（scrollBody overflow:auto）。Chrome 的
   fixed 始终相对视口，但 iOS Safari 会把 fixed 相对滚动祖先定位，导致弹窗只
   覆盖滚动容器区域（顶部/侧边栏露出、无法关闭）。处理：不移动 DOM（避免破坏
   React 卸载），检测到弹窗未覆盖视口时用负偏移补偿（top/left = -滚动容器在
   视口中的位置），把弹窗拉回视口全屏；translateZ(0) 合成层在多数 iOS 版本上
   可让 fixed 直接恢复视口定位，本补偿作为兜底。 */
function fixBalanceOverlayPosition() {
  var ov = document.querySelector('.bmon-overlay')
  if (!ov) return
  /* ① 解除祖先劫持：backdrop-filter/filter/will-change/contain 置 none；
     祖先链上的层叠上下文（z-index 非 auto，如产品输入行的 z:2）会把弹窗的
     根层叠级别压到其 z 值，低于产品侧边栏/顶栏——弹窗被覆盖。弹窗打开期间
     把这些 z-index 临时提升到最大（实测 z:auto 消除上下文会在 PC 上因 DOM
     顺序反而被会话列表盖住，提升到最大是跨平台最稳的），关闭后恢复。
     transform 不动（产品布局依赖它）；若剩余 transform 劫持，由 ②/③ 补偿。 */
  var p = ov.parentElement
  while (p && p !== document.body) {
    var cs = getComputedStyle(p)
    var prop = null
    if (cs.backdropFilter && cs.backdropFilter !== 'none') prop = 'backdropFilter'
    else if (cs.filter && cs.filter !== 'none') prop = 'filter'
    else if (cs.willChange && cs.willChange !== 'auto') prop = 'willChange'
    else if (cs.contain && cs.contain !== 'none') prop = 'contain'
    if (prop) {
      if (!p.hasAttribute('data-dshm-bf')) {
        p.setAttribute('data-dshm-bf-prop', prop)
        p.setAttribute('data-dshm-bf', p.style[prop] || cs[prop] || 'none')
      }
      p.style[prop] = 'none'
    }
    if (cs.zIndex && cs.zIndex !== 'auto') {
      if (!p.hasAttribute('data-dshm-zi')) p.setAttribute('data-dshm-zi', cs.zIndex)
      p.style.zIndex = '2147483647'
    }
    p = p.parentElement
  }
  /* ② 渲染级校验（v33.2）：用 elementFromPoint 采样视口四角，验证弹窗是否
     真的渲染覆盖视口。iOS Safari 的 fixed 被滚动容器劫持渲染时，弹窗只覆盖
     滚动容器区域（露出侧边栏/会话列表——「弹窗被对话列表侧边框覆盖」），
     且 getBoundingClientRect 可能报告视口坐标导致纯 rect 检测误判已覆盖；
     四角采样直接暴露真实渲染。弹窗真覆盖四角 → 保持现状（fixed 正常的
     PC/安卓/iOS 零干预）；否则清除残留偏移、重读 rect（= 劫持基点位置，
     inset:0 无偏移）、取负拉到视口原点，并补 100vw/100dvh 尺寸。 */
  var vw = window.innerWidth || 1
  var vh = window.innerHeight || 1
  var corners = [[2, 2], [vw - 3, 2], [2, vh - 3], [vw - 3, vh - 3]]
  var covered = true
  for (var ci = 0; ci < corners.length; ci++) {
    var topEl = document.elementFromPoint(corners[ci][0], corners[ci][1])
    if (!topEl || !ov.contains(topEl)) { covered = false; break }
  }
  if (covered) return
  ov.style.top = ''
  ov.style.left = ''
  var r2 = ov.getBoundingClientRect()
  ov.setAttribute('data-dshm-fix', '1')
  ov.style.top = (-r2.top) + 'px'
  ov.style.left = (-r2.left) + 'px'
  ov.style.width = '100vw'
  ov.style.height = '100dvh'
}
function restoreBalanceAncestors() {
  var els = document.querySelectorAll('[data-dshm-bf],[data-dshm-zi]')
  for (var i = 0; i < els.length; i++) {
    var e = els[i]
    var prop = e.getAttribute('data-dshm-bf-prop')
    if (prop) {
      e.style[prop] = e.getAttribute('data-dshm-bf')
      e.removeAttribute('data-dshm-bf')
      e.removeAttribute('data-dshm-bf-prop')
    }
    var z = e.getAttribute('data-dshm-zi')
    if (z != null) {
      e.style.zIndex = z
      e.removeAttribute('data-dshm-zi')
    }
  }
}
/* 弹窗迁移到 #root（v34/v36）——与产品设置弹窗同为 body 直下层叠：输入栏内的
   fixed 在 iOS Safari 上会被滚动容器/backdrop-filter 劫持渲染（安卓正常、
   iPhone 被对话列表侧边框覆盖），迁移到 React 根容器 #root 后 fixed 恢复视口
   定位、z-index 直达根层叠。v36：① 迁移**仅限 iOS**——PC/安卓的 v33 渲染级
   校验已足够，迁移会让 React 卸载 removeChild 失败、树损坏（输入栏按钮消失，
   实测复现）；② 点击捕获阶段先把迁移节点移回原父（记录在 dshmMovedOrigin），
   React 卸载时 removeChild 才能命中；弹窗未关闭（卡片内交互）则 200ms 轮询
   重新迁移，微小闪烁可接受。React 事件委托挂在 #root，迁移后交互不受影响。 */
var dshmMovedOrigin = null
function migrateBalanceOverlay() {
  var ov = document.querySelector('.bmon-overlay')
  if (!ov) return
  var ua = navigator.userAgent || ''
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh|Mac OS X/.test(ua) && navigator.maxTouchPoints > 1)
  if (!isIOS) return
  var root = document.getElementById('root') || document.body
  if (ov.parentElement === root) return
  if (!ov.hasAttribute('data-dshm-moved')) dshmMovedOrigin = ov.parentElement
  ov.setAttribute('data-dshm-moved', '1')
  root.appendChild(ov)
}
/* 点击落在迁移后的弹窗内（遮罩关闭 / 卡片内交互）时先把节点移回原父，
   避免 React 卸载 removeChild 抛 NotFoundError 损坏 React 树 */
document.addEventListener('click', function (e) {
  var moved = document.querySelector('.bmon-overlay[data-dshm-moved]')
  if (!moved || !moved.contains(e.target)) return
  if (dshmMovedOrigin && dshmMovedOrigin !== moved.parentElement) {
    dshmMovedOrigin.appendChild(moved)
    moved.removeAttribute('data-dshm-moved')
    dshmMovedOrigin = null
  }
}, true)
function cleanupMovedOverlay() {
  var opened = !!document.querySelector('.bmon-ibar-on')
  var moved = document.querySelector('.bmon-overlay[data-dshm-moved]')
  if (!opened && moved && moved.parentNode) moved.parentNode.removeChild(moved)
}
setInterval(function () {
  migrateBalanceOverlay()
  cleanupMovedOverlay()
  var ov = document.querySelector('.bmon-overlay')
  if (ov) fixBalanceOverlayPosition()
  else restoreBalanceAncestors()
}, 200)
function restoreCurrent(s) {
  /* 手机与 PC 共用同一工作区：PC 浏览器把「当前会话」选择（localStorage
     dsh.sessions.current）上报给插件，手机端（无该状态）自动恢复并刷新，
     打开与 PC 相同的会话；sessionStorage 标记防止恢复后再次刷新循环。 */
  try {
    if (sessionStorage.getItem('dshm_restored')) return
    var cur = localStorage.getItem('dsh.sessions.current')
    if (cur && cur !== '{}') return
    var raw = s.observedCurrent && s.observedCurrent.raw
    if (!raw || raw === '{}') return
    sessionStorage.setItem('dshm_restored', '1')
    localStorage.setItem('dsh.sessions.current', raw)
    location.reload()
  } catch (e) {}
}
function mobileFlow(s) {
  var bypass = ''
  try { bypass = localStorage.getItem(BYPASS) || '' } catch (e) {}
  if (s.policy.requireVpnForWan && s.access.type === 'wan' && bypass !== '1') { showWanBlock(s); return }
  var st = s.device ? s.device.status : ''
  if (st === '') {
    apiPost('/register', { deviceId: deviceId(), name: '手机设备', hostname: location.hostname }).then(function (r) {
      if (r && r.ok) showGate(Object.assign({}, s, { device: { status: r.status || 'pending', name: '手机设备' } }))
      else showGate(s)
    })
    return
  }
  if (st === 'pending' || st === 'rejected' || st === 'revoked') { showGate(s); return }
  restoreCurrent(s)
  maybeModePopup(s)
  showBadge(s)
}

/* ───────────── PC 端管理面板 ───────────── */
function pcFlow(s) {
  var fab = el('button', 'dshm-fab', '📱')
  var badge = el('span', 'dshm-fab-badge')
  badge.style.display = 'none'
  fab.appendChild(badge)
  fab.title = '移动端访问'
  document.body.appendChild(fab)
  var panel = el('div', 'dshm-panel')
  panel.style.display = 'none'
  document.body.appendChild(panel)
  fab.onclick = function () {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
    if (panel.style.display === 'block') refresh()
  }
  function refresh() {
    apiGet('/state?device=' + encodeURIComponent(deviceId())).then(function (s2) {
      if (!s2 || !s2.ok) { panel.innerHTML = '<h3>移动端访问</h3><p class="muted">插件未运行或服务不可用。</p>'; return }
      var pending = s2.pendingCount || 0
      badge.style.display = pending > 0 ? 'block' : 'none'
      badge.textContent = String(pending)
      // 正在编辑输入框（如网关端口）时跳过本次重建，避免焦点丢失、键盘闪退
      var ae = document.activeElement
      if (ae && panel.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      try {
        renderPanel(s2, panel, refresh)
      } catch (err) {
        panel.innerHTML = '<h3>移动端访问</h3><div class="warn">面板渲染出错：' + esc(String(err && err.message || err)) + '</div>' +
          '<p class="muted">请强制刷新页面（Ctrl+F5）后重试；若仍出现，把本提示反馈给开发者。</p>'
      }
    })
  }
  /* PC 端把「当前会话」选择上报给插件（手机端据此恢复同一会话） */
  function reportCurrent() {
    var raw = ''
    try { raw = localStorage.getItem('dsh.sessions.current') || '' } catch (e) {}
    if (!raw || raw === '{}') return
    apiPost('/report-current', { raw: raw })
  }
  reportCurrent()
  setInterval(reportCurrent, 10000)
  try {
    renderPanel(s, panel, refresh)
  } catch (err) {
    panel.innerHTML = '<h3>移动端访问</h3><div class="warn">面板渲染出错：' + esc(String(err && err.message || err)) + '</div>'
  }
  setInterval(refresh, 5000)
  refresh()
}
function urlRow(url, label) {
  return '<div class="row"><span class="url" title="' + esc(url) + '">' + esc(url) + '</span>' +
    '<button class="btn" data-copy="' + esc(url) + '">' + label + '</button></div>'
}
function renderPanel(s, panel, refresh) {
  var bindHostWarn = s.server.host !== '0.0.0.0'
    ? '<div class="warn">Web 服务器当前仅绑定 127.0.0.1，手机无法直接访问 GUI。请使用下方「移动端网关」，或自行配置隧道（Tailscale serve / 反向代理）。</div>'
    : '<div class="ok">Web 服务器监听所有网卡。</div>'
  var proxyHtml = s.proxy.running
    ? '<div class="row"><span class="ok">网关运行中</span><span class="muted">pid ' + s.proxy.pid + ' · 端口 ' + s.proxy.port + '</span><button class="btn danger" id="dshm-proxy-stop">停止</button></div>'
    : '<div class="row"><span class="bad">网关未运行</span><button class="btn primary" id="dshm-proxy-start">启动网关</button></div>' +
      (s.proxy.error ? '<div class="warn">' + esc(s.proxy.error) + '</div>' : '')
  var qrHtml = ''
  if (s.proxy.running && s.urls.proxy.length) {
    var qUrl = s.urls.proxy[0]
    qrHtml = '<div class="dshm-qrbox">' +
      '<h4>手机扫码访问（首次需 PC 批准）</h4>' +
      '<div class="qr"><canvas id="dshm-qr"></canvas></div>' +
      '<div class="row"><span class="url">' + esc(qUrl) + '</span><button class="btn" data-copy="' + esc(qUrl) + '">复制</button></div>' +
      '<p class="muted">手机与 PC 需在同一局域网；Windows 防火墙需放行端口 ' + s.proxy.port + '。</p>' +
      '</div>'
  } else {
    qrHtml = '<div class="dshm-qrbox dshm-qrbox-off">' +
      '<h4>手机扫码访问（首次需 PC 批准）</h4>' +
      '<div class="qr"><div class="dshm-qrph">启动网关后<br/>生成二维码</div></div>' +
      '<p class="muted">点击下方「启动网关」，二维码会显示在这里，手机扫码即可访问（首次需在 PC 批准）。</p>' +
      '</div>'
  }
  var lanHtml = s.urls.lan.length
    ? s.urls.lan.map(function (u) { return urlRow(u, '复制') }).join('')
    : '<p class="muted">未检测到局域网地址（可稍后刷新，或在设置中手动指定）。</p>'
  var vpnHtml = ''
  if (s.urls.vpn.length) vpnHtml = s.urls.vpn.map(function (u) { return urlRow(u, '复制') }).join('')
  if (s.vpn.tailscaleHost) vpnHtml += '<p class="muted">提示：在 PC 上运行 tailscale serve 3080 后，可通过 https://' + esc(s.vpn.tailscaleHost) + '/ 从任何已登录 Tailscale 的设备访问。</p>'
  if (!vpnHtml) vpnHtml = '<p class="muted">未检测到 Tailscale / ZeroTier（VPN 地址在安装对应客户端后自动出现）。</p>'
  var devHtml = ''
  var devices = s.devices || []
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i]
    var statusTxt = d.status === 'approved' ? '<span class="ok">已批准</span>'
      : d.status === 'pending' ? '<span class="bad">待审批</span>'
      : d.status === 'rejected' ? '<span class="bad">已拒绝</span>'
      : '<span class="bad">已撤销</span>'
    var actions = ''
    if (d.status === 'pending') actions = '<button class="btn primary" data-op="approve" data-id="' + esc(d.id) + '">批准</button><button class="btn" data-op="reject" data-id="' + esc(d.id) + '">拒绝</button>'
    if (d.status === 'approved') actions = '<button class="btn" data-op="revoke" data-id="' + esc(d.id) + '">撤销</button><button class="btn danger" data-op="revoke-forget" data-id="' + esc(d.id) + '">取消授权并删除</button>'
    if (d.status === 'rejected' || d.status === 'revoked') actions = '<button class="btn" data-op="approve" data-id="' + esc(d.id) + '">恢复</button><button class="btn danger" data-op="forget" data-id="' + esc(d.id) + '">删除</button>'
    devHtml += '<div class="dev"><div class="row">' + statusTxt + '<b>' + esc(d.name) + '</b></div>' +
      '<div class="meta">' + esc(d.id) + ' · ' + esc(d.ip || '') + ' · ' + esc((d.lastSeenAt || '').replace('T', ' ').slice(0, 19)) + '</div>' +
      '<div class="row">' + actions + '</div></div>'
  }
  if (!devHtml) devHtml = '<p class="muted">暂无设备记录。</p>'
  panel.innerHTML =
    '<h3>移动端访问</h3>' +
    '<p class="muted">服务端口 ' + s.server.port + ' · 访问来源 ' + esc(s.access.host || s.access.ip || '') + '（' + modeLabel(s.access.mode) + '）</p>' +
    qrHtml +
    bindHostWarn +
    '<h4>移动端网关（局域网直连）</h4>' + proxyHtml +
    '<h4>局域网地址</h4>' + lanHtml +
    '<h4>VPN 地址（外网安全访问）</h4>' + vpnHtml +
    '<h4>设备审批</h4>' + devHtml +
    '<h4>安全策略</h4>' +
    '<label><input type="checkbox" id="dshm-pol-vpn"' + (s.policy.requireVpnForWan ? ' checked' : '') + '> 禁止公网直连（外网必须通过 VPN 访问）</label>' +
    '<div class="row"><span class="muted">网关端口</span><input type="number" id="dshm-pol-port" value="' + s.proxy.port + '" min="1" max="65535"><button class="btn primary" id="dshm-pol-save">保存策略</button></div>' +
    '<p class="muted">boot v2 · 手机端自动禁用第三方皮肤 · 开发/使用说明见文档站「DSH 指南 → 第十七章 移动端访问插件」。</p>'
  var qrCanvas = panel.querySelector('#dshm-qr')
  if (qrCanvas) {
    try {
      var qrOk = dshmQR.render(qrCanvas, s.urls.proxy[0])
      if (!qrOk) throw new Error('二维码生成失败')
    } catch (err) {
      qrCanvas.outerHTML = '<div class="warn">二维码生成失败：' + esc(String(err && err.message || err)) + '，请直接复制上方地址。</div>'
    }
  }
  var copies = panel.querySelectorAll('[data-copy]')
  for (var i = 0; i < copies.length; i++) {
    ;(function (btn) { btn.onclick = function () { copyText(btn.getAttribute('data-copy')) } })(copies[i])
  }
  var ops = panel.querySelectorAll('[data-op]')
  for (var i = 0; i < ops.length; i++) {
    ;(function (btn) {
      btn.onclick = function () {
        var op = btn.getAttribute('data-op')
        if (op === 'revoke-forget' && !window.confirm('取消授权并删除该设备记录？该设备将需要重新申请访问。')) return
        apiPost('/admin', { op: op, deviceId: btn.getAttribute('data-id') }).then(refresh)
      }
    })(ops[i])
  }
  var ps = panel.querySelector('#dshm-proxy-start')
  if (ps) ps.onclick = function () { apiPost('/admin', { op: 'proxy', action: 'start' }).then(refresh) }
  var pe = panel.querySelector('#dshm-proxy-stop')
  if (pe) pe.onclick = function () { apiPost('/admin', { op: 'proxy', action: 'stop' }).then(refresh) }
  var save = panel.querySelector('#dshm-pol-save')
  if (save) save.onclick = function () {
    var chk = panel.querySelector('#dshm-pol-vpn')
    var port = panel.querySelector('#dshm-pol-port')
    apiPost('/admin', { op: 'policy', policy: { requireVpnForWan: !!(chk && chk.checked), proxyPort: Number(port ? port.value : s.proxy.port) } }).then(refresh)
  }
}

/* 窄屏禁用第三方皮肤：皮肤（如 dsh-deep-whale）的全部样式挂在
   body[data-dsh-maid-atelier] 下，移除该属性即回退到产品默认主题，
   彻底避免皮肤装饰层在手机上遮挡弹窗/状态栏/输入区。
   皮肤注入的装饰元素（角色大图/装饰条/舞台）在 CSS 失效后仍以默认样式
   占据页面并拦截点击，必须一并移除；皮肤插件可能在 boot.js 之后才激活
   并重新注入，因此同时用 MutationObserver（属性变化立即处理）与轮询兜底。 */
function disableSkinOnMobile() {
  if (window.innerWidth >= 1024) return
  var b = document.body
  if (b && b.hasAttribute('data-dsh-maid-atelier')) b.removeAttribute('data-dsh-maid-atelier')
  var els = document.querySelectorAll('[data-skin-chrome], [data-maid-character]')
  for (var i = 0; i < els.length; i++) {
    var e = els[i]
    if (e.parentNode) e.parentNode.removeChild(e)
  }
}
try {
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function () { disableSkinOnMobile() })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-maid-atelier'], subtree: true })
  }
} catch (e) {}
setInterval(disableSkinOnMobile, 800)

/* ───────────── 启动 ───────────── */
function main() {
  disableSkinOnMobile()
  try { setCookie(HOST, location.hostname, 1) } catch (e) {}
  injectStyle()
  apiGet('/state?device=' + encodeURIComponent(deviceId())).then(function (s) {
    if (!s || !s.ok) return
    if (isMobile()) mobileFlow(s)
    else pcFlow(s)
  })
}
try { main() } catch (e) { /* 静默失败：不影响 GUI 本身 */ }
/* 域名直连 3080 时，DSH 的 /api 信任围栏会拒绝非回环 Host，GUI（React）加载
   失败只剩空白页（本插件的接口不校验 Host，徽章仍会显示）。5 秒后 #root 仍
   无内容则显示醒目提示，说明原因与正确配置（tailscale serve 应指向网关代理
   3081，由代理改写 Host 通过围栏）。门禁/拦截页存在时不提示。 */
setTimeout(function () {
  try {
    var rootEl = document.getElementById('root')
    if (rootEl && rootEl.children.length === 0 && !document.querySelector('.dshm-gate, .dshm-wanblock, .dshm-warn-banner')) {
      var warn = el('div', 'dshm-warn-banner')
      warn.innerHTML = '<b>页面未加载：</b>当前经域名直连主服务器（3080），DSH 的 /api 信任围栏会拒绝非回环来源，导致 GUI 空白。<br>请改用 <b>tailscale serve 3081</b>（插件网关代理，自动改写 Host 通过围栏），或为 DSH 配置受信域名。'
      document.body.appendChild(warn)
    }
  } catch (e) {}
}, 5000)
})()
`

const GATE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>DeepSeek Harness 移动端</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1420;color:#e6ebf4;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:420px;width:calc(100% - 48px);background:#171e2e;border:1px solid #2a3450;border-radius:16px;padding:28px 24px;box-sizing:border-box;text-align:center}
.logo{width:64px;height:64px;line-height:64px;margin:0 auto 14px;border-radius:16px;background:#2563eb;color:#fff;font-weight:700;font-size:24px}
h1{font-size:18px;margin:0 0 6px}
.sub{color:#9aa7bd;font-size:13px;margin:0 0 18px}
.spinner{width:34px;height:34px;margin:18px auto;border:3px solid #2a3450;border-top-color:#2563eb;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
input{width:100%;box-sizing:border-box;padding:12px 14px;margin:10px 0;border-radius:10px;border:1px solid #2a3450;background:#0f1420;color:#e6ebf4;font-size:16px}
button{display:block;width:100%;box-sizing:border-box;padding:13px;margin:8px 0;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:16px;font-weight:600}
button.ghost{background:#1c2740;color:#9aa7bd}
.err{color:#f87171;font-size:14px;line-height:1.6;margin:8px 0}
.info{color:#9aa7bd;font-size:14px;line-height:1.6;margin:8px 0}
a.link{display:block;color:#93c5fd;word-break:break-all;font-size:14px;margin:8px 0}
@media (prefers-color-scheme: light) {
body{background:#eef2fa;color:#1c2740}
.card{background:#fff;border-color:#d8e1f0;box-shadow:0 12px 36px rgba(28,39,64,.12)}
.logo{background:#526aa8}
.sub,.info{color:#5b6b8c}
.err{color:#c23a52}
input{background:#fff;border-color:#d8e1f0;color:#1c2740}
button{background:#526aa8}
button.ghost{background:#e8edf7;color:#5b6b8c}
a.link{color:#2563eb}
}
</style>
</head>
<body>
<div class="card">
<div class="logo">DSH</div>
<h1>DeepSeek Harness 移动端</h1>
<p class="sub">移动设备访问需先获得 PC 端批准</p>
<div id="view"></div>
</div>
<script>
(function () {
'use strict'
var API = '/dsh-mobile/api'
var DEV = 'dshm_dev'
function cookie(name) {
  var m = document.cookie.split('; ')
  for (var i = 0; i < m.length; i++) {
    var p = m[i].split('=')
    if (p[0] === name) { try { return decodeURIComponent(p.slice(1).join('=')) } catch (e) { return '' } }
  }
  return ''
}
function setCookie(name, value) {
  var d = new Date()
  d.setTime(d.getTime() + 365 * 86400000)
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; expires=' + d.toUTCString()
}
function uuid() {
  var s = ''
  for (var i = 0; i < 32; i++) {
    var r = Math.floor(Math.random() * 16)
    if (i === 12) r = 4
    if (i === 16) r = (r & 3) | 8
    s += r.toString(16)
  }
  return s
}
function deviceId() {
  var id = cookie(DEV)
  if (!id) { id = uuid(); setCookie(DEV, id) }
  return id
}
function get(path) {
  return fetch(API + path).then(function (r) { return r.json().catch(function () { return null }) }).catch(function () { return null })
}
function post(path, body) {
  return fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json().catch(function () { return null }) }).catch(function () { return null })
}
var view = document.getElementById('view')
var status = 'pending'
var registered = false
function paint() {
  var h = ''
  if (status === 'ask-name') {
    h = '<input id="dev-name" placeholder="给设备起个名字，如：我的手机" maxlength="32" value="我的手机" />' +
      '<button id="dev-ok">申请访问</button>'
  } else if (status === 'pending') {
    h = '<div class="spinner"></div><p class="info">设备「' + esc(deviceName()) + '」已提交审批请求，等待 PC 端批准…</p><p class="info">请在 PC 端 DeepSeek Harness 页面点击右下角「📱」按钮并批准该设备。</p>'
  } else if (status === 'approved') {
    h = '<p class="info">已批准，正在进入…</p>'
  } else if (status === 'rejected') {
    h = '<p class="err">该设备的访问申请已被 PC 端拒绝。</p><button class="ghost" id="dev-again">重新申请</button>'
  } else if (status === 'revoked') {
    h = '<p class="err">该设备的访问权限已被 PC 端撤销。</p><button class="ghost" id="dev-again">重新申请</button>'
  } else if (status === 'wan-blocked') {
    h = '<p class="err">公网直连已被管理员禁止，请连接 Tailscale / ZeroTier 等 VPN 后访问。</p>' +
      (vpnUrl() ? '<a class="link" href="' + esc(vpnUrl()) + '">' + esc(vpnUrl()) + '</a>' : '') +
      '<button id="dev-refresh">我已连接 VPN，重新检测</button>'
  }
  view.innerHTML = h
  var ok = document.getElementById('dev-ok')
  if (ok) ok.onclick = function () {
    var name = document.getElementById('dev-name').value || '我的手机'
    try { localStorage.setItem('dshm_name', name) } catch (e) {}
    post('/register', { deviceId: deviceId(), name: name, hostname: location.hostname }).then(function () {
      registered = true
      status = 'pending'
      paint()
    })
  }
  var again = document.getElementById('dev-again')
  if (again) again.onclick = function () {
    post('/register', { deviceId: deviceId(), name: deviceName(), hostname: location.hostname }).then(function (r) {
      status = r && r.status ? r.status : 'pending'
      paint()
    })
  }
  var refresh = document.getElementById('dev-refresh')
  if (refresh) refresh.onclick = function () { poll() }
}
function deviceName() {
  var n = ''
  try { n = localStorage.getItem('dshm_name') || '' } catch (e) {}
  return n || '我的手机'
}
function vpnUrl() {
  var u = null
  try { u = localStorage.getItem('dshm_vpnurl') || '' } catch (e) {}
  return u || null
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}
function poll() {
  get('/state?device=' + encodeURIComponent(deviceId())).then(function (s) {
    if (!s || !s.ok) return
    try { localStorage.setItem('dshm_vpnurl', (s.urls && s.urls.vpn && s.urls.vpn[0]) || '') } catch (e) {}
    var st = s.device ? s.device.status : ''
    var ns
    if (!registered && st === '') ns = 'ask-name'
    else if (s.policy && s.policy.requireVpnForWan && s.access && s.access.type === 'wan') ns = 'wan-blocked'
    else if (st === 'approved') ns = 'approved'
    else ns = st || 'pending'
    // 状态未变化时不重建 DOM：避免输入设备名时输入框被销毁、键盘闪退
    if (ns === status) return
    status = ns
    paint()
    if (status === 'approved') window.location.href = '/'
  })
}
setInterval(poll, 2500)
poll()
})()
</script>
</body>
</html>
`

const PROXY_SRC = `
var http = require('http')
// node -e 模式下额外参数从 process.argv[1] 开始（-e 代码本身不在 argv 中）
var mainPort = Number(process.argv[1])
var proxyPort = Number(process.argv[2])
var MAIN = 'http://127.0.0.1:' + mainPort
function forward(req, res, upgradeSocket, upgradeHead) {
  var headers = {}
  for (var k in req.headers) headers[k] = req.headers[k]
  headers['host'] = '127.0.0.1:' + mainPort
  if (headers['origin']) headers['origin'] = 'http://127.0.0.1:' + mainPort
  /* v1.0.2：透传原始 Host 与来源 IP——主服务器只能识别 127.0.0.1（回环）
     无法区分真实访问方式；带 x-dshm-forwarded-host / x-dshm-real-ip 后，
     插件按原始 Host 归类（域名 → vpn，局域网 IP → lan），手机断开 Wi-Fi
     走蜂窝 + Tailscale 域名时正确显示 VPN 而非局域网 */
  headers['x-dshm-forwarded-host'] = req.headers['host'] || ''
  headers['x-dshm-real-ip'] = req.socket.remoteAddress || ''
  if (upgradeSocket) {
    /* WebSocket 升级转发：http.request 不会自动补升级头，必须显式设置，
       否则主服务器把升级请求当普通 GET（永远没有 101，握手挂起） */
    headers['connection'] = 'Upgrade'
    headers['upgrade'] = 'websocket'
  } else {
    delete headers['connection']
    delete headers['keep-alive']
    delete headers['transfer-encoding']
    delete headers['content-length']
    delete headers['upgrade']
  }
  var preq = http.request(MAIN + req.url, { method: req.method, headers: headers, agent: false }, function (pres) {
    if (res) {
      res.writeHead(pres.statusCode || 502, pres.headers)
      pres.pipe(res)
    }
  })
  preq.on('error', function () {
    if (res && !res.headersSent) { res.writeHead(502); res.end('gateway unavailable') }
    else if (res) res.end()
  })
  if (upgradeSocket) {
    preq.on('upgrade', function (pres, psocket, phead) {
      /* 必须把上游 101 Switching Protocols 响应头手动写回客户端，
         否则浏览器收不到握手响应（Parse Error），WS 永远无法建立。
         注意：本文件 PROXY_SRC 是模板字符串，这里必须写 \\r\\n（双反斜杠），
         模板求值后才保持字面 \\r\\n 转义序列，node -e 执行时再解析为 CRLF。 */
      var lines = ['HTTP/1.1 101 Switching Protocols']
      var hh = pres.headers
      for (var k in hh) {
        var v = hh[k]
        if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) lines.push(k + ': ' + v[i]) }
        else lines.push(k + ': ' + v)
      }
      upgradeSocket.write(lines.join('\\r\\n') + '\\r\\n\\r\\n')
      if (upgradeHead && upgradeHead.length) psocket.write(upgradeHead)
      if (phead && phead.length) upgradeSocket.write(phead)
      psocket.on('error', function () {})
      upgradeSocket.on('error', function () {})
      psocket.pipe(upgradeSocket)
      upgradeSocket.pipe(psocket)
    })
    // 必须 end() 发出请求头，服务器才会回 101 Upgrade；否则 WebSocket 握手永远挂起
    preq.end()
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') preq.end()
  else req.pipe(preq)
}
function gate(req, cb) {
  var g = http.get(MAIN + '/dsh-mobile/api/gate?path=' + encodeURIComponent(req.url || '/'), {
    headers: {
      'x-dshm-real-ip': req.socket.remoteAddress || '',
      'x-dshm-forwarded-host': req.headers.host || '',
      cookie: req.headers.cookie || ''
    }
  }, function (gres) {
    var body = ''
    gres.on('data', function (d) { body += d })
    gres.on('end', function () {
      var j = null
      try { j = JSON.parse(body) } catch (e) {}
      cb(j && j.ok ? j : null)
    })
  })
  g.on('error', function () { cb(null) })
}
var server = http.createServer(function (req, res) {
  var path = req.url || '/'
  if (path.indexOf('/dsh-mobile/') === 0) return forward(req, res)
  gate(req, function (j) {
    if (j && j.allow) return forward(req, res)
    res.writeHead(302, { location: '/dsh-mobile/gate.html' })
    res.end()
  })
})
server.on('upgrade', function (req, socket, head) {
  var path = req.url || '/'
  if (path.indexOf('/dsh-mobile/') === 0) return forward(req, null, socket, head)
  gate(req, function (j) {
    if (j && j.allow) return forward(req, null, socket, head)
    socket.end()
  })
})
server.listen(proxyPort, '0.0.0.0', function () {
  console.log('dsh-mobile proxy listening on 0.0.0.0:' + proxyPort + ' -> ' + MAIN)
})
server.on('error', function (e) {
  console.error('dsh-mobile proxy error: ' + e.message)
  process.exit(1)
})
`

// ════════════════════════════════════════════════════════════════════════
// 插件主体
// ════════════════════════════════════════════════════════════════════════

return {
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    const fs = ctx.get('fs')
    const sub = ctx.get('subprocess')
    const timer = ctx.get('timer')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const processRef = typeof process !== 'undefined' ? process : undefined

    // ────────────────────────── 状态 ──────────────────────────
    const DEFAULT_POLICY = { requireVpnForWan: false, proxyPort: 3081, vpnSubnets: ['100.64.0.0/10'], vpnHosts: [], lanIps: [] }
    const state = { devices: {}, policy: Object.assign({}, DEFAULT_POLICY) }
    const netCache = { at: 0, data: null }
    let persistPath = ''
    let persistChain = Promise.resolve()
    let proxyHandle = null
    let proxyError = ''
    let observedCurrent = { raw: '', at: 0 }
    const mainPort = webServer.port

    // ────────────────────── 基础工具函数 ──────────────────────
    function socketIp(req) { const r = req.socket.remoteAddress || ''; return r.indexOf('::ffff:') === 0 ? r.slice(7) : r }
    function isLocalPeer(ip) { return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' }
    function realIp(req) {
      const s = socketIp(req)
      const f = req.headers['x-dshm-real-ip']
      if (isLocalPeer(s) && typeof f === 'string' && f) return f.indexOf('::ffff:') === 0 ? f.slice(7) : f
      return s
    }
    function forwardedHost(req) {
      const s = socketIp(req)
      const f = req.headers['x-dshm-forwarded-host']
      if (isLocalPeer(s) && typeof f === 'string' && f) return f
      return String(req.headers['host'] || '')
    }
    function readCookies(req) {
      const h = req.headers['cookie'] || ''
      const out = {}
      h.split(';').forEach(p => {
        const i = p.indexOf('=')
        if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()) } catch (e) {} }
      })
      return out
    }
    function ipv4Int(ip) {
      const p = String(ip).split('.')
      if (p.length !== 4) return null
      const n = []
      for (let i = 0; i < 4; i++) { const v = Number(p[i]); if (!Number.isInteger(v) || v < 0 || v > 255) return null; n.push(v) }
      return ((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3]
    }
    function inCidr(int, cidr) {
      const s = String(cidr).split('/')
      if (s.length !== 2) return false
      const base = ipv4Int(s[0])
      const bits = Number(s[1])
      if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
      const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0)
      return (int & mask) === (base & mask)
    }
    function isPrivateIp(ip) {
      const n = ipv4Int(ip)
      if (n === null) return false
      return inCidr(n, '10.0.0.0/8') || inCidr(n, '172.16.0.0/12') || inCidr(n, '192.168.0.0/16') || inCidr(n, '169.254.0.0/16')
    }
    function classifyHost(host) {
      const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      if (!h) return 'unknown'
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return 'loopback'
      const n = ipv4Int(h)
      if (n !== null) {
        if (inCidr(n, '100.64.0.0/10')) return 'vpn'
        if (netCache.data && netCache.data.vpn.indexOf(h) >= 0) return 'vpn'
        for (let i = 0; i < state.policy.vpnSubnets.length; i++) if (inCidr(n, state.policy.vpnSubnets[i])) return 'vpn'
        if (isPrivateIp(h)) return 'lan'
        return 'wan'
      }
      if (h.endsWith('.ts.net')) return 'vpn'
      for (let i = 0; i < state.policy.vpnHosts.length; i++) { const v = state.policy.vpnHosts[i].toLowerCase(); if (h === v || h.endsWith('.' + v)) return 'vpn' }
      return 'wan'
    }
    function modeOf(type) { if (type === 'vpn') return 'vpn'; if (type === 'lan' || type === 'loopback') return 'lan'; return 'wan' }
    function accessOf(req) {
      const ip = realIp(req)
      const host = forwardedHost(req)
      const hn = String(host).split(':')[0]
      const type = classifyHost(hn || ip)
      return { ip, host, type, mode: modeOf(type) }
    }
    function deviceOf(req) { const id = readCookies(req)['dshm_dev'] || ''; return id && state.devices[id] ? state.devices[id] : null }
    function nowIso() { return new Date().toISOString() }
    function sendJson(res, status, obj) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    function sendText(res, status, type, text) {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(text)
    }
    function readJsonBody(req, maxBytes) {
      return new Promise(resolve => {
        let size = 0
        const chunks = []
        req.on('data', c => {
          size += c.length
          if (size > maxBytes) { req.destroy(); resolve(null); return }
          chunks.push(c.toString('utf8'))
        })
        req.on('end', () => { try { resolve(JSON.parse(chunks.join(''))) } catch (e) { resolve(null) } })
        req.on('error', () => resolve(null))
      })
    }
    function adminAllowed(req) {
      if (req.headers['x-dshm-admin'] !== '1') return false
      const acc = accessOf(req)
      if (acc.type === 'wan') return false
      const origin = req.headers['origin']
      if (origin) {
        const oh = String(origin).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
        if (oh && oh !== String(req.headers['host'] || '').toLowerCase()) return false
      }
      return true
    }
    function workdir() {
      if (processRef) return processRef.cwd()
      const sp = sandboxPolicy
      return sp && sp.workspaceRoot ? sp.workspaceRoot : '.'
    }

    // ────────────────────── 持久化 ──────────────────────
    // 动态插件沙箱没有 process 全局，DSH_HOME 通过子进程探测（缓存）。
    let homeCache = ''
    async function dshHome() {
      if (homeCache) return homeCache
      if (processRef && processRef.env) {
        if (processRef.env.DSH_HOME) { homeCache = processRef.env.DSH_HOME; return homeCache }
        const home = processRef.env.USERPROFILE || processRef.env.HOME
        if (home) { homeCache = home + '/.dsh'; return homeCache }
      }
      if (sub) {
        const r = await runCollect(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
          'if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE + "\\.dsh" } else { "" }'], 4000)
        const v = String(r.stdout || '').trim()
        if (v) { homeCache = v; return v }
      }
      return ''
    }
    function persist() {
      if (!fs || !persistPath) return
      persistChain = persistChain.then(async () => {
        try {
          const target = await fs.resolve(persistPath)
          // 宿主挂载的是 fs-sandbox（默认围栏在工作区）；插件作为宿主进程内可信代码，
          // 用 danger-full-access 策略写入自己的状态文件（$DSH_HOME/dsh-mobile/state.json）。
          await fs.writeText(target, JSON.stringify({ v: 1, devices: state.devices, policy: state.policy }), undefined, undefined, { mode: 'danger-full-access' })
        } catch (e) {}
      })
    }
    async function loadPersisted() {
      const home = await dshHome()
      if (!home || !fs) return
      persistPath = home + '/dsh-mobile/state.json'
      try {
        const target = await fs.resolve(persistPath)
        const info = await fs.stat(target)
        if (!info) return
        const text = await fs.readText(target)
        const data = JSON.parse(text)
        if (data && typeof data === 'object') {
          if (data.devices && typeof data.devices === 'object') Object.assign(state.devices, data.devices)
          if (data.policy && typeof data.policy === 'object') Object.assign(state.policy, DEFAULT_POLICY, data.policy)
        }
      } catch (e) {}
    }

    // ────────────────────── 网络枚举 ──────────────────────
    async function runCollect(argv, timeoutMs) {
      if (!sub) return { stdout: '', error: 'no-subprocess' }
      try {
        const exe = await sub.resolveExecutable(argv[0])
        const handle = sub.spawn({
          argv: [exe].concat(argv.slice(1)),
          cwd: workdir(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 8192 } },
          graceMs: 1500,
        })
        let outcome = null
        if (timer) outcome = await Promise.race([handle.done, timer.timeout(timeoutMs)])
        else if (typeof setTimeout !== 'undefined') outcome = await Promise.race([handle.done, new Promise(r => setTimeout(r, timeoutMs, null))])
        else outcome = await handle.done
        if (!outcome) { handle.terminate(); return { stdout: '', error: 'timeout' } }
        const reader = handle.collected.stdout
        let text = ''
        if (reader) { let off = 0; for (;;) { const r = reader.readFrom(off); text += r.text; off = r.nextOffset; if (!r.text.length) break } }
        return { stdout: text, code: outcome.exitCode }
      } catch (e) { return { stdout: '', error: String(e) } }
    }
    function extractIps(text) {
      const out = []
      const tokens = String(text || '').split(/[^0-9.]+/)
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (ipv4Int(t) !== null && out.indexOf(t) < 0) out.push(t)
      }
      return out
    }
    let platformCache = ''
    async function detectPlatform() {
      if (platformCache) return platformCache
      if (processRef && processRef.platform) { platformCache = processRef.platform; return platformCache }
      if (sub) {
        const pw = await sub.resolveExecutable('powershell.exe').catch(() => '')
        if (pw) { platformCache = 'win32'; return platformCache }
        const hi = await sub.resolveExecutable('hostname').catch(() => '')
        if (hi) { platformCache = 'posix'; return platformCache }
      }
      platformCache = 'unknown'
      return platformCache
    }
    async function enumerateNetworks() {
      const nowMs = Date.now()
      if (netCache.data && nowMs - netCache.at < 60000) return netCache.data
      const data = { lan: [], vpn: [], tailscaleIp: '', tailscaleHost: '', zerotier: [] }
      const isWin = (await detectPlatform()) === 'win32'
      if (isWin) {
        const r = await runCollect(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
          "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress) -join ' '"], 6000)
        for (const ip of extractIps(r.stdout)) if (isPrivateIp(ip) && data.lan.indexOf(ip) < 0) data.lan.push(ip)
        if (!data.lan.length) {
          const r2 = await runCollect(['ipconfig'], 4000)
          const gateways = []
          for (const line of String(r2.stdout).split(/\r?\n/)) {
            const low = line.toLowerCase()
            if (low.indexOf('gateway') >= 0 || low.indexOf('网关') >= 0) {
              for (const g of extractIps(line)) if (gateways.indexOf(g) < 0) gateways.push(g)
            }
          }
          for (const ip of extractIps(r2.stdout)) {
            if (isPrivateIp(ip) && gateways.indexOf(ip) < 0 && data.lan.indexOf(ip) < 0) data.lan.push(ip)
          }
        }
      } else {
        const r = await runCollect(['hostname', '-I'], 3000)
        for (const ip of extractIps(r.stdout)) if (isPrivateIp(ip) && data.lan.indexOf(ip) < 0) data.lan.push(ip)
        if (!data.lan.length) {
          const r2 = await runCollect(['ifconfig'], 4000)
          for (const ip of extractIps(r2.stdout)) if (isPrivateIp(ip) && data.lan.indexOf(ip) < 0) data.lan.push(ip)
        }
      }
      for (const ip of state.policy.lanIps) if (ip && data.lan.indexOf(ip) < 0) data.lan.push(ip)
      const ts = await runCollect(['tailscale', 'ip', '-4'], 3000)
      const tsIps = extractIps(ts.stdout)
      if (tsIps.length) { data.tailscaleIp = tsIps[0]; data.vpn.push(tsIps[0]) }
      const tss = await runCollect(['tailscale', 'status', '--json'], 3000)
      try { const j = JSON.parse(tss.stdout); if (j && j.Self && j.Self.DNSName) data.tailscaleHost = String(j.Self.DNSName).replace(/\.$/, '') } catch (e) {}
      const zt = await runCollect(['zerotier-cli', 'listnetworks', '-j'], 3000)
      try {
        const arr = JSON.parse(zt.stdout)
        if (Array.isArray(arr)) {
          for (const nw of arr) {
            const aa = nw && nw.assignedAddresses
            if (Array.isArray(aa)) {
              for (const a of aa) {
                const ip = String(a).split('/')[0]
                if (ip && ipv4Int(ip) !== null && data.vpn.indexOf(ip) < 0) { data.vpn.push(ip); data.zerotier.push(ip) }
              }
            }
          }
        }
      } catch (e) {}
      data.lan = data.lan.filter(ip => data.vpn.indexOf(ip) < 0)
      netCache.at = Date.now()
      netCache.data = data
      return data
    }
    async function urlsOf() {
      const net = await enumerateNetworks()
      const proxyPort = String(state.policy.proxyPort || mainPort)
      /* LAN/VPN 地址一律走网关代理端口 proxyPort（主服务只绑 127.0.0.1，
         局域网 / Tailscale 等外部来源都无法直连 3080，必须经由 0.0.0.0
         的代理转发）；tailscale 域名用 https serve（443）保留。 */
      const lan = net.lan.map(ip => 'http://' + ip + ':' + proxyPort)
      const vpn = []
      if (net.tailscaleIp) vpn.push('http://' + net.tailscaleIp + ':' + proxyPort)
      if (net.tailscaleHost) vpn.push('https://' + net.tailscaleHost + '/')
      for (const ip of net.zerotier) vpn.push('http://' + ip + ':' + proxyPort)
      const proxy = net.lan.map(ip => 'http://' + ip + ':' + proxyPort)
      return { lan, vpn, proxy }
    }

    // ────────────────────── 网关代理子进程 ──────────────────────
    function stopProxy() {
      if (proxyHandle) { proxyHandle.terminate(); proxyHandle = null }
      proxyError = ''
    }
    async function startProxy() {
      if (proxyHandle) return { ok: true, pid: proxyHandle.pid }
      if (!sub) return { ok: false, error: 'subprocess 服务不可用' }
      let nodePath = ''
      if (processRef && processRef.execPath) nodePath = processRef.execPath
      if (!nodePath) nodePath = await sub.resolveExecutable('node').catch(() => '')
      if (!nodePath) return { ok: false, error: '未找到 node 可执行文件' }
      try {
        const handle = sub.spawn({
          argv: [nodePath, '-e', PROXY_SRC, String(mainPort), String(state.policy.proxyPort)],
          cwd: workdir(),
          stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
          graceMs: 3000,
        })
        proxyHandle = handle
        proxyError = ''
        handle.done.then(
          o => { if (proxyHandle === handle) { proxyHandle = null; proxyError = '网关进程退出 (code=' + o.exitCode + ', signal=' + o.signal + ')' } },
          e => { if (proxyHandle === handle) { proxyHandle = null; proxyError = '网关进程启动失败: ' + String(e) } },
        )
        return { ok: true, pid: handle.pid }
      } catch (e) { return { ok: false, error: String(e) } }
    }

    // ────────────────────── 请求处理 ──────────────────────
    // 注意：动态插件沙箱不提供 URL 全局，这里手工解析 pathname。
    function pathnameOf(req) {
      const raw = req.url || '/'
      const q = raw.indexOf('?')
      return q >= 0 ? raw.slice(0, q) : raw
    }
    function dispatch(req, res, base) {
      const path = pathnameOf(req)
      const suffix = path.slice(base.length)
      if (req.method === 'GET' && suffix === '/state') return handleState(req, res)
      if (req.method === 'POST' && suffix === '/register') return handleRegister(req, res)
      if (req.method === 'POST' && suffix === '/ack') return handleAck(req, res)
      if (req.method === 'POST' && suffix === '/report-current') return handleReportCurrent(req, res)
      if (req.method === 'GET' && suffix === '/gate') return handleGate(req, res)
      if (req.method === 'POST' && suffix === '/admin') return handleAdmin(req, res)
      if (req.method === 'GET' && suffix === '/boot.js') return sendText(res, 200, 'application/javascript; charset=utf-8', BOOT_JS)
      sendJson(res, 404, { ok: false, error: 'not-found' })
    }
    function gatePageHandler(req, res) {
      const path = pathnameOf(req)
      if (req.method === 'GET' && path === '/dsh-mobile/gate.html') return sendText(res, 200, 'text/html; charset=utf-8', GATE_HTML)
      sendJson(res, 404, { ok: false, error: 'not-found' })
    }
    async function statePayload(req) {
      const acc = accessOf(req)
      const device = deviceOf(req)
      const urls = await urlsOf()
      const net = netCache.data || { tailscaleIp: '', tailscaleHost: '' }
      return {
        ok: true,
        server: { host: webServer.host, port: mainPort },
        access: { type: acc.type, mode: acc.mode, ip: acc.ip, host: acc.host },
        urls,
        vpn: { tailscaleIp: net.tailscaleIp, tailscaleHost: net.tailscaleHost },
        policy: { requireVpnForWan: !!state.policy.requireVpnForWan },
        proxy: { running: !!proxyHandle, pid: proxyHandle ? proxyHandle.pid : -1, port: state.policy.proxyPort, error: proxyError },
        device: device ? { status: device.status, name: device.name, mode: device.mode || '' } : null,
        observedCurrent: { raw: observedCurrent.raw, at: observedCurrent.at },
        pendingCount: Object.keys(state.devices).filter(k => state.devices[k].status === 'pending').length,
        debug: { persistPath, processAvailable: !!processRef, subprocessAvailable: !!sub, fsAvailable: !!fs, dshHome: await dshHome() },
      }
    }
    async function handleState(req, res) {
      const payload = await statePayload(req)
      if (req.headers['x-dshm-admin'] === '1' && accessOf(req).type !== 'wan') {
        payload.devices = Object.keys(state.devices)
          .map(k => Object.assign({ id: k }, state.devices[k]))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      }
      sendJson(res, 200, payload)
    }
    async function handleRegister(req, res) {
      const body = await readJsonBody(req, 4096)
      if (!body) return sendJson(res, 400, { ok: false, error: 'bad-json' })
      const id = String(body.deviceId || '')
      const name = String(body.name || '').trim().slice(0, 32)
      const hostname = String(body.hostname || '').slice(0, 253)
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'bad-device-id' })
      const acc = accessOf(req)
      const existing = state.devices[id]
      if (existing) {
        existing.name = name || existing.name
        existing.lastSeenAt = nowIso()
        existing.mode = acc.mode
        if (existing.status === 'rejected' || existing.status === 'revoked') existing.status = 'pending'
        persist()
        return sendJson(res, 200, { ok: true, status: existing.status, device: { id, name: existing.name, status: existing.status } })
      }
      const autoApprove = acc.type === 'loopback' && (/^localhost$/i.test(hostname) || /^127\./.test(hostname) || !hostname)
      const device = { id, name: name || '未命名设备', status: autoApprove ? 'approved' : 'pending', createdAt: nowIso(), lastSeenAt: nowIso(), mode: acc.mode, ip: acc.ip }
      state.devices[id] = device
      persist()
      sendJson(res, 200, { ok: true, status: device.status, device: { id, name: device.name, status: device.status } })
    }
    async function handleAck(req, res) {
      const body = await readJsonBody(req, 2048)
      const id = String((body && body.deviceId) || '')
      const mode = String((body && body.mode) || '')
      const choice = String((body && body.choice) || 'stay')
      const d = state.devices[id]
      if (d) {
        if (mode) d.mode = mode
        if (choice === 'mute') d.muted = mode
        else if (choice === 'stay') d.muted = ''
        persist()
      }
      sendJson(res, 200, { ok: true })
    }
    async function handleReportCurrent(req, res) {
      // PC 浏览器上报「当前会话」选择（localStorage 原文），供手机端恢复同一工作区。
      if (!adminAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const body = await readJsonBody(req, 4096)
      const raw = String((body && body.raw) || '')
      if (raw.length > 2048) return sendJson(res, 400, { ok: false, error: 'too-long' })
      observedCurrent = { raw, at: Date.now() }
      sendJson(res, 200, { ok: true })
    }
    async function handleGate(req, res) {
      const s = socketIp(req)
      if (!isLocalPeer(s)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const acc = accessOf(req)
      const device = deviceOf(req)
      if (state.policy.requireVpnForWan && acc.type === 'wan') {
        return sendJson(res, 200, { ok: true, allow: false, reason: 'wan-blocked', mode: acc.mode })
      }
      if (!device || device.status === 'pending') {
        return sendJson(res, 200, { ok: true, allow: false, reason: 'pending', mode: acc.mode, deviceName: device ? device.name : '' })
      }
      if (device.status === 'approved') return sendJson(res, 200, { ok: true, allow: true, reason: 'approved', mode: acc.mode })
      return sendJson(res, 200, { ok: true, allow: false, reason: device.status, mode: acc.mode })
    }
    async function handleAdmin(req, res) {
      if (!adminAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const body = await readJsonBody(req, 8192)
      if (!body) return sendJson(res, 400, { ok: false, error: 'bad-json' })
      const op = String(body.op || '')
      if (op === 'approve' || op === 'reject' || op === 'revoke' || op === 'forget' || op === 'revoke-forget') {
        const id = String(body.deviceId || '')
        const d = state.devices[id]
        if (!d) return sendJson(res, 404, { ok: false, error: 'no-device' })
        if (op === 'approve') { d.status = 'approved'; d.approvedAt = nowIso(); d.muted = '' }
        if (op === 'reject') d.status = 'rejected'
        if (op === 'revoke') d.status = 'revoked'
        // 取消授权并删除记录：直接移除设备，授权立即失效，设备需重新申请
        if (op === 'forget' || op === 'revoke-forget') delete state.devices[id]
        persist()
        return sendJson(res, 200, { ok: true })
      }
      if (op === 'policy') {
        const p = body.policy || {}
        if (typeof p.requireVpnForWan === 'boolean') state.policy.requireVpnForWan = p.requireVpnForWan
        const port = Number(p.proxyPort)
        if (Number.isInteger(port) && port > 0 && port < 65536) state.policy.proxyPort = port
        if (Array.isArray(p.vpnSubnets)) state.policy.vpnSubnets = p.vpnSubnets.map(String).filter(s => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)).slice(0, 20)
        if (Array.isArray(p.vpnHosts)) state.policy.vpnHosts = p.vpnHosts.map(String).filter(s => s.length > 0 && s.length <= 200).slice(0, 20)
        if (Array.isArray(p.lanIps)) state.policy.lanIps = p.lanIps.map(String).filter(s => ipv4Int(s) !== null).slice(0, 20)
        netCache.at = 0
        persist()
        return sendJson(res, 200, { ok: true })
      }
      if (op === 'proxy') {
        const action = String(body.action || '')
        if (action === 'start') { const r = await startProxy(); return sendJson(res, 200, { ok: r.ok, error: r.error, pid: r.pid }) }
        if (action === 'stop') { stopProxy(); return sendJson(res, 200, { ok: true }) }
      }
      sendJson(res, 400, { ok: false, error: 'bad-op' })
    }

    // ────────────────────── 注册到运行时 ──────────────────────
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-mobile/api',
      handler: (req, res) => { void dispatch(req, res, '/dsh-mobile/api') },
    }), 'dsh-mobile api routes')
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-mobile',
      handler: gatePageHandler,
    }), 'dsh-mobile gate page')
    ctx.effect(() => webServer.tapIndex(html => {
      let out = html
      // crypto.randomUUID 补丁注入 <head> 顶部（同步执行，先于任何产品脚本）
      if (out.indexOf('dshmUuidPoly') < 0) {
        const headAt = out.toLowerCase().indexOf('<head>')
        if (headAt >= 0) {
          const hEnd = headAt + 6
          out = out.slice(0, hEnd) + CRYPTO_POLYFILL + out.slice(hEnd)
        } else {
          out = CRYPTO_POLYFILL + out
        }
      }
      const tag = '<script src="/dsh-mobile/api/boot.js" defer></script>'
      if (out.indexOf('/dsh-mobile/api/boot.js') >= 0) return out
      const at = out.toLowerCase().indexOf('</body>')
      if (at >= 0) return out.slice(0, at) + tag + out.slice(at)
      return out + tag
    }), 'dsh-mobile index tap')
    ctx.effect(() => () => { stopProxy() }, 'dsh-mobile proxy teardown')

    void loadPersisted()
  },
}
