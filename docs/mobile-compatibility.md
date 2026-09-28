# 手机兼容目标与验收矩阵

## 范围

覆盖近五年常见手机的尺寸和系统差异，以 iOS 15、Android 11 代际作为基础兼容目标。核心聊天、中文输入、会话管理、上下文编辑和附件操作保持可用；旧浏览器允许视觉效果降级，不要求具备新系统独有的安装、分享或后台能力。

这是开发与验收目标，不是逐机型真机认证。Node 逻辑测试、CSS 编译测试和构建成功，均不能替代真实手机的浏览器渲染、软键盘、文件选择器或 PWA 验收。

## 浏览器与构建

- JS/CSS 构建目标：Safari 15、Chrome 87。Chrome 87 是明确选择的旧内核基线，**不是** Android 11 必然附带的版本，也不意味着建议用户保留有安全问题的旧浏览器。
- Android 系统、Chrome 和 WebView 可独立升级。验收必须记录三者的实际版本；Chrome 通过不能代表某个应用内 WebView 已通过。
- JavaScript 按需补齐 `Array.at`、`findLast`、`findLastIndex`、`Object.hasOwn`、`structuredClone`。主页面和 Monaco 工作线程有独立全局环境，两处都需先加载补丁。
- UUID 优先使用原生 `crypto.randomUUID`，旧浏览器使用 `crypto.getRandomValues` 生成标准 v4 ID，不用弱随机或时间戳替代。
- `color-mix`、动态视口高度、依赖 `:has` 的布局必须保留旧浏览器回退；新浏览器仍使用原有增强效果。
- 不根据 User-Agent 手机名称切换样式；视口、触摸能力及 API 能力决定实际路径。不能禁止缩放来掩盖布局问题。

## 代表尺寸

以下苹果尺寸是 CSS 逻辑屏幕参考，不是固定可用网页高度；浏览器地址栏、显示缩放、软键盘与安装模式会改变实际视口。安卓档位是测试设计，不是厂商逐型号的固定 CSS 尺寸。

| 代表设备／用例 | 竖屏参考宽×高（CSS px） |
|---|---:|
| 窄屏压力用例（非近五年机型声明） | 320×568 |
| 窄屏安卓测试档位 | 360×800 |
| iPhone SE 第三代 | 375×667 |
| iPhone 13 mini | 375×812 |
| iPhone 13 | 390×844 |
| iPhone 15 | 393×852 |
| iPhone 16 Pro | 402×874 |
| 宽屏安卓测试档位 | 412×915 |
| iPhone 14 Pro Max | 430×932 |
| iPhone 16 Pro Max | 440×956 |

实际高度以 `visualViewport.height` 为先，无该 API 时使用 `innerHeight`；缩放期间不把放大后的视口强行当成新的页面布局宽度。桌面布局不因该矩阵改变。

## 系统和机型抽样

表中的安卓／鸿蒙版本是官方发布规格，不代表某台设备当前已安装的版本。每类至少选一个真实设备，再覆盖旧版本与更新后的浏览器；无需每款机型遍历所有不可能的系统组合。

| 类型 | 代表样本 | 原始系统代际／验收关注点 |
|---|---|---|
| 苹果小屏与普通屏 | SE 3、13 mini、13、15 | Safari 15 旧能力边界；短屏、刘海和灵动岛；可安装版本内的新旧系统抽样 |
| 苹果大屏 | 16 Pro／Pro Max | 横屏、安全区、安装后运行、放大字号 |
| 较早安卓 | Galaxy S21／A52 5G（2021） | Android 11；实际 Chrome、三星浏览器与应用内 WebView 分开记录 |
| 小米 | Xiaomi 12、14 | Android 12／14，MIUI／HyperOS；输入法、文件选择及浏览器差异 |
| 大屏安卓 | Galaxy S25 Ultra | Android 15／One UI 7 发布代际；大屏横屏和手势区域 |
| 旧版鸿蒙 | Mate 60、Pura 70 | HarmonyOS 4.0／4.2 发布规格；华为浏览器单独验证 |
| 纯鸿蒙 | 实际使用 HarmonyOS 5／NEXT 的设备 | 不等同 Android WebView；页面、安装、下载和项目使用到的 PWA 能力分别验证 |

## 真机验收项目

1. 登录、会话切换与长消息滚动；头部、输入区、弹窗底部按钮始终可达。
2. 中文输入法组合输入、回车换行、键盘弹出／收回、横竖屏切换；不误发送、不丢草稿。
3. 375px 矮屏与 360px 窄屏，系统大字号及页面缩放；表格和长代码仅在自己的内容区域滚动。
4. 浅色／深色主题切换，旧内核不出现透明底上的不可读文字、失效遮罩或没有高度约束的弹窗。
5. 附件选择、粘贴、上传及产物保存；系统文件选择器取消后可再次操作。
6. 浏览器后退、页面后台／恢复；独立安装模式与普通标签页分别验收。鸿蒙安装入口及后台能力不得由 Chrome 结果推定。

记录机型、OS、浏览器/内核版本、实际 CSS 视口、字号/缩放设置和运行模式。存在无法现场验证的组合时标为待真机验证，不以源码测试结果代替。

## 资料

- [Apple SE 3 规格](https://support.apple.com/en-gb/111866)
- [Playwright 设备参考数据（仅数据来源，不作为本项目浏览器测试依赖）](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json)
- [三星 S21 发布规格](https://news.samsung.com/global/make-every-day-epic-with-samsung-galaxy-s21-and-galaxy-s21plus)
- [Xiaomi 12 规格](https://www.mi.com/uk/product/xiaomi-12/specs/)、[Xiaomi 14 规格](https://www.mi.com/hk/product/xiaomi-14/specs/)
- [三星 S25 发布规格](https://news.samsung.com/global/samsung-galaxy-s25-series-sets-the-standard-of-ai-phone-as-a-true-ai-companion)
- [Mate 60 规格](https://consumer.huawei.com/cn/phones/mate60/specs/)、[Pura 70 规格](https://consumer.huawei.com/cn/phones/pura70/specs/)
- [MDN 浏览器能力数据](https://github.com/mdn/browser-compat-data)
- [Chrome 键盘视口行为](https://developer.chrome.com/blog/viewport-resize-behavior)、[Android WebView](https://developer.chrome.com/docs/webview)
