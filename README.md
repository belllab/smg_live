# SMG 网页直播观看增强

在浏览器端为 SMG 视频直播页面提供更顺畅的观看体验，并对部分浏览器环境做兼容性优化。

# 说明

26.08.21 ---> 去掉了接口返回M3U8地址，可能出于业务需求，保留体育新闻回看。

26.09.08 ---> 地址由火山（volc-stream）改为腾讯（tencent-vods），回看（timeshift）和直播（token）改为两套路径，封堵升级测试（有概率）。

26.09.09 ---> 已恢复火山源（volc-stream），后续是否彻底切换腾讯源（tencent-vods），未知，仅做记录。

26.09.13 ---> 修复「看一会儿就中断且不再恢复」。同一条地址上其实挂着两套期限：地址参数（如 `volcTime`）与 token 里 JWT 的 `exp`，视频服务器按较早的那个拒绝请求，而脚本原先只解析后者，于是地址实际失效后仍被判定为可用并反复复用（服务器返回 403）。现在改为取两者中较早的时间淘汰缓存，并在到期前主动重新取源。

同一轮还一并修掉了几处会让「自动换源」白做的问题：

- **断流判定**原先只认 `mediaError.code === 4`，但 hls.js 在网络中断时不会写入该字段，只表现为画面不再前进；现在两种信号都看，并能区分「画面停滞」与用户主动暂停。另外补了一条「一直未能起播」的通道——重建后新地址同样不可播时 `currentTime` 会永远停在 0，此前没有任何判据能发现。
- **恢复不再有次数上限**。原先失败 3 次就本场直播永久放弃，现在是逐次拉长的退避（15s → 30s → 60s → … 上限 5 分钟），画面一恢复推进就立即归零。
- **换源结果真的会被用上**。自动取到的地址只写入回看缓存，而页面在重建时会把同一条已失效的地址回填进直播缓存；两条都解析不出期限时，页面那条因为写入更晚反而胜出，于是「换源」变成空转。现在按「有真实期限 > 脚本取到的 > 页面回填的」择优（`betterBase`）。
- 切频道后会清理上一个频道残留的冷却与失败计数（此前最坏要等 10 分钟才能重新自动取源）；回看重启会恢复到中断前的进度。

自动换源目前只对 **10 频道**生效（`AUTO_ACQUIRE_CHANNELS`）——取到的是往期节目的回看源，其它频道当直播源注入会播出错内容。要照看别的频道，把频道号加进这个常量即可。

> ⚠️ 这一版改动较多，且只能在真实站点上验证。建议先看控制台里 `[SMGTV]` 前缀的日志确认实际走的是哪条路径。

# 安装

1. 浏览器安装 [Tampermonkey](https://tampermonkey.net/) 扩展（**推荐**）
2. 点击下方链接安装脚本

| 正式版 (GitHub 源)                                                                           |
|---------------------------------------------------------------------------------------------|
| [安装](https://raw.githubusercontent.com/Popukok/smg_live/refs/heads/main/smg_fivestar.user.js)  |

3. 打开 [SMG 直播页面](https://live.kankanews.com/huikan?id=10)，选择频道即可观看

# 兼容性

支持**最新版** Chrome、Firefox、Safari，脚本管理器推荐使用 [Tampermonkey](https://tampermonkey.net/)。

> ⚠️ 由于两款插件存在技术差异，基于 Tampermonkey（油猴）开发的脚本，在 Violentmonkey（暴力猴）上可能存在兼容性问题，**建议使用油猴插件**。

### Safari（macOS / iOS）

- **macOS Safari**：使用 [Tampermonkey](https://tampermonkey.net/) 或免费的 [Userscripts App](https://apps.apple.com/app/userscripts/id1463198887) 加载脚本
- **iOS / iPadOS Safari**（需 iOS 15+）：安装 [Userscripts App](https://apps.apple.com/app/userscripts/id1463198887) 或 Tampermonkey，在「设置 → Safari → 扩展」中启用并允许访问 `kankanews.com`，导入脚本即可
- iPhone 全屏使用 iOS 原生视频全屏；CSS 全屏已适配动态视口（dvh/dvw）与安全区域（刘海 / Home 指示条）

> ⚠️ 若自行修改过脚本，建议在管理器中**关闭自动更新**，避免被上游版本覆盖本地改动。

# 移动端

在支持用户脚本的移动浏览器中均可使用（Android 端此类浏览器通常内置 Violentmonkey，请一并留意上方兼容性提示）：

- **Kiwi Browser**、**Chrome**、**Edge**：安装体验与桌面端最接近
- **Firefox for Android**：支持扩展与脚本
- **X浏览器**：轻量、支持用户脚本
- **iPhone / iPad**：直接使用 Safari + Userscripts App 或 Tampermonkey，无需更换浏览器

# 苹果设备使用说明

**macOS Safari**（二选一）：
- Userscripts（免费开源，推荐）：App Store 安装 → Safari 设置 → 扩展中启用 → 打开 Userscripts App 设定脚本目录 → 将 `smg_fivestar.user.js` 放入该目录
- Tampermonkey：App Store 安装 → Safari 设置 → 扩展中启用并允许访问网站 → 导入脚本

**iPhone / iPad（需 iOS 15+）**：
1. App Store 安装 Userscripts（免费）或 Tampermonkey
2. 设置 → Safari → 扩展 → 启用并允许访问 `kankanews.com`
3. 将 `smg_fivestar.user.js` 放入 Userscripts 的脚本目录（或经分享菜单导入）
4. 打开 [SMG 直播页面](https://live.kankanews.com/huikan?id=10) 选择频道即可

本仓库内容仅供学习交流。
