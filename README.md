# pixiv-token-extension

Chrome / Edge 工具栏弹窗，使用当前浏览器已登录的 Pixiv 账号获取和刷新 App API 令牌。无后端、无构建依赖。

## 安装

1. 下载或克隆本仓库；使用 ZIP 时先解压。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启开发者模式，点击「加载已解压的扩展程序」，选择 **`extension` 文件夹**。
4. 在浏览器登录 Pixiv，点击扩展图标。

已有安装在扩展管理页点击「重新加载」即可。重载会清除当前凭据；重新打开弹窗后使用网页登录会话获取。

## 弹窗

- 首次打开时，没有凭据则自动从网页登录会话获取，不打开新网页或登录窗口。
- 两个 Token 用普通文本明文显示，自动换行、可选中，各有复制按钮。
- **重新获取**：重新使用当前网页登录账号完成后台授权。
- **刷新**：刷新当前账号的访问令牌，更新到期时间以及返回的新刷新凭据。
- 状态只显示一行；完整错误信息可悬停查看。
- 网页账号或登录 Cookie 变化时，后台自动移除旧凭据，防止账号混用。
- 弹窗关闭不取消后台请求，重新打开后可查看结果。
- 登录过期或需要验证时，不自动打开页面；自行在 Pixiv 网站处理后重新获取。

## 凭据与权限

读取 `www.pixiv.net` 的 `PHPSESSID`，仅用于识别当前账号和计算会话指纹；Cookie 原文不保存、不记录。授权请求由浏览器携带原有 Cookie，只访问 Pixiv 认证域名。

Token 和会话指纹仅存放在 `chrome.storage.session`，不持久化、不同步。扩展禁用、重载或浏览器退出后清除。弹窗明文和系统剪贴板不是凭据保险箱；不要共享调试端口或上传抓包。

不读取密码、不注入 Pixiv 页面、不加载远程脚本或统计服务。仅访问 `www.pixiv.net`、`app-api.pixiv.net`、`accounts.pixiv.net` 和 `oauth.secure.pixiv.net`。

## 验证

Chrome / Edge 120 以上；运行测试需要 Node.js 22 以上，无需安装依赖。

```sh
npm test
npm run check
```

真实浏览器和自动化验证见 [TESTING.md](TESTING.md)。

## 文件

| 文件 | 职责 |
| --- | --- |
| `extension/web-session.js` | 会话指纹、网页登录授权、精确请求回调关联 |
| `extension/oauth.js` | PKCE、令牌交换和响应校验 |
| `extension/controller.js` | 账号隔离、刷新、并发与过时响应处理 |
| `extension/background.js` | MV3 事件、会话存储、可信弹窗消息 |
| `extension/page.*` | 工具栏弹窗、普通文本显示和复制 |
| `tests/` | 使用虚构凭据的长期回归测试 |

## 限制

非 Pixiv 官方应用，依赖非公开移动端 OAuth 和网页登录接口。接口、风控或浏览器 Cookie 策略变化可能导致失效；不保证长期兼容。Edge、真实双账号切换及验证码场景尚未实测。

认证流程参考：[get-pixivpy-token](https://github.com/eggplants/get-pixivpy-token)、[Pixiv-Token-Fetcher](https://github.com/wlm3201/Pixiv-Token-Fetcher)。代码独立实现，未直接复制第三方扩展。
