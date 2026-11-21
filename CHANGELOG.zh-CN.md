# 更新记录

Pilot Connector 是桌面端与手机之间的自建盲转发中继。它只按房间转发 WebSocket 帧：不存储消息，
也不持有端到端密钥。

**本项目不提供公共中继。** 要跨网络连到手机，请自己部署。

本文件手工维护：发版时在顶部加一条。更早的历史见
[Releases 页](https://github.com/yunjianmanbu/pilot-connector/releases) 与官网更新记录
（<https://pilot.medpilot.cc/zh.html>）。

英文版：[CHANGELOG.md](CHANGELOG.md)

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。每个版本都需要 Node.js >= 22.12。

## [0.2.3] - 2026-11-20

### 新增

- **L1 准入码与随机连接路径。** 安装脚本自动生成 `home:<随机>` 准入码与 `/c/<随机>` 路径，并打印
  整条连接串。
- 中继在创建房间之前校验准入码，码不对以 `4009` 拒绝；`/healthz` 暴露 `anonymous` 与 `rejected`
  计数。

### 变更

- `RELAY_ACCESS_STRICT` 默认为 `0`：只记录不带码的连接，不拦截。确认各端都升级后再改成 `1`，
  避免升级过程中把自己锁在门外。
- 转发路径、盲中继承诺与协议不变。

## [0.2.2] - 2026-11-19

### 新增

- 按来源限制连接数：默认同一地址最多 64 个并发连接，超过就拒绝升级
  （`MAX_CONNECTIONS_PER_IP`，设为 `0` 关闭限制）。
- 来源切断开关：`RELAY_BLOCK_IPS` 里列出的地址在握手阶段直接丢弃。
- `/healthz` 报告 `sources` 与 `blockedSources`，运营方可以直接看出哪个来源值得切断。

### 变更

- 压缩包里现在带 `LICENSE`、`NOTICE` 与 `RESPONSIBLE_USE.md`，`README.md` 里的链接指向包内副本，
  不再指向仓库根目录。
- 不存储消息、不托管密钥、协议不变。

## [0.2.1] - 2026-11-19

### 新增

- 按房间转发，不存储消息、不托管密钥。
- systemd 单元、nginx 反向代理示例与一行安装脚本。
- 每个压缩包都有配套的 `.sha256`。
