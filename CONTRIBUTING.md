# 贡献指南

感谢你愿意改 Pilot Connector。它处在你和别人的配对会话之间，任何改动都可能让本该端到端
加密的流量出现新的信任边界，所以我们对「改动是否可复核」的要求比普通 Node 服务更严：
**每个 PR 都要带一条能复现的验证命令和它的输出。**

## 这个仓库是什么

Pilot Connector 是 Pilot 手机连接的云端盲中继：桌面端与手机各自连到同一个房间，中继只按房间
转发 WebSocket 帧，不落盘、不解析内容、不持有端到端密钥。它不提供公共实例，
**要跨网络用手机连接，请自行部署一份**（见 [`README.md`](README.md)）。

同项目的其他组件（桌面客户端、Android 被控端、手机反控端）各自是独立仓库，
不在本仓库的 issue 里处理。

## 开发环境

- Node.js **22.12 或更高**（`package.json` 的 `engines` 字段）
- 只有一个运行时依赖 `ws`，其余用 Node 内置模块
- Windows / Linux / macOS 都能跑；部署脚本分别覆盖 systemd 与 PowerShell

```bash
npm install          # 装依赖（含 devDependencies 之外的 ws）
npm start            # node server.mjs，默认 127.0.0.1:8787
curl http://127.0.0.1:8787/healthz     # 健康检查
```

带自定义端口与路径：

```bash
PORT=8789 BIND=127.0.0.1 WS_PATH=/connector node server.mjs
```

## 提交前必须自测

本仓库没有自动化测试套件，验证方式是「起一个中继，用两个 WebSocket 客户端跑通房间流程」：

1. `npm start` 起中继，确认 `curl http://127.0.0.1:8787/healthz` 返回正常；
2. 用两个客户端分别以 host / phone 身份连到同一房间，互发一帧并确认另一侧收到；
3. 断开 host，确认手机连接仍在宽限期内保留（默认 30 秒），host 重连后帧继续可达；
4. 把上面三步的实际命令与输出贴进 PR 描述。

改动涉及安装脚本（`install.sh` / `install.ps1`）时，请在干净的容器或虚拟机里从零跑一遍，
并把脚本输出贴出来。

## 代码约定

1. **提交信息**：`type(scope): 摘要`，type 用 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。
   摘要写「做了什么」，不要写「修改了文件」。
2. **一次提交一件事**：顺手重构请单独成 commit，方便回退。
3. **不加新依赖**：除非在 PR 描述里说明为什么 `ws` 与内置模块做不到，并确认新依赖是
   MIT / Apache-2.0 / BSD 这类宽松协议。本项目不接受 GPL / AGPL 依赖。
4. **不记录内容**：中继不得新增任何会落盘或打印帧载荷、配对凭据、会话密钥的逻辑，
   日志只写连接数、房间数、错误码这类运行状态。
5. **不提交**：签名证书（`.jks` / `.keystore`）、任何密码文件、`.env`、`node_modules/`、
   构建产物、视频。这些都在 `.gitignore` 里，别用 `git add -f` 绕过去。
6. **路径不写死**：文档和脚本里不要出现个人机器路径（`C:\Users\你的名字\...`）。
   用 `%USERPROFILE%`、`$HOME`、`<你的工作区>` 或脚本自身位置推导。
7. **部署示例保持可复制**：`deploy/` 下的 systemd / nginx 片段要能直接套到一台空机器上，
   改端口或路径时同步改 `README.md` 里对应的说明。

## Pull Request 清单

- [ ] 说明改了什么、为什么改（贴现象或 issue 链接）
- [ ] 贴出本地验证命令与输出（见上一节）
- [ ] 涉及协议字段（`hello` / `pair.join` / 房间隔离）时，说明对旧版本客户端的影响
- [ ] 没有夹带无关文件（`git diff --stat` 自查）
- [ ] 没有新增个人机器路径、密钥、媒体文件
- [ ] 文档同步更新（改了行为就改 `README.md`）

## 报告安全问题

不要开公开 issue，走 [`SECURITY.md`](SECURITY.md) 里的私下渠道。

## 行为准则

参与即表示同意 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

## 许可

提交的代码默认以 [Apache License 2.0](LICENSE) 授权，保留 [`NOTICE`](NOTICE) 中的版权与商标声明。
