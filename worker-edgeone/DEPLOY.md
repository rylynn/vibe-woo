# 自托管同步服务部署手册（腾讯云 / TencentOS）

> 放在 `worker-edgeone/` 而不是 `docs/`：仓库的 `.gitignore` 忽略了整个
> `docs/`，放那儿不会进版本控制。

适用：域名还在备案，只能走「公网 IP + 非标端口」这台机器。
备案下来后切回 EdgeOne，只需改 `src-tauri/src/syncclient.rs` 的
`DEFAULT_SYNC_BASE_URL` 一行。

## 目标结构

```
/opt/vibe-woo/            代码（git clone，属 root，服务只读）
/var/lib/vibe-pet/        数据（属 vibe-pet，唯一可写）
/etc/vibe-pet/sync.env    环境变量（含 admin 口令，600 权限）
/opt/node-v18.20.4-.../   Node 18（不覆盖系统自带的旧版本）
```

服务以**专用用户 `vibe-pet`** 运行，不以 root 跑——万一服务被攻破，
拿到的也不是 root 权限。

---

## 1. 系统用户与目录

```bash
# 专用用户（不能登录，无 home 写权限需求）
sudo useradd -r -s /sbin/nologin vibe-pet

# 数据目录
sudo mkdir -p /var/lib/vibe-pet
sudo chown vibe-pet:vibe-pet /var/lib/vibe-pet
sudo chmod 750 /var/lib/vibe-pet

# 环境变量目录
sudo mkdir -p /etc/vibe-pet
```

## 2. 部署代码

```bash
sudo mkdir -p /opt
sudo git clone https://github.com/rylynn/vibe-woo.git /opt/vibe-woo
cd /opt/vibe-woo
```

> 已经在 `/root/vibe-woo` 跑着的，直接搬过去即可：
> `sudo mv /root/vibe-woo /opt/vibe-woo`
> 数据文件别一起搬——它应该去 `/var/lib/vibe-pet/`（见下一步）。

## 3. 数据文件归位

```bash
# 如果 /root/vibe-woo/worker-edgeone/.local-data.json 已有用户数据，搬过来
sudo mv /opt/vibe-woo/worker-edgeone/.local-data.json /var/lib/vibe-pet/sync.json 2>/dev/null || true
sudo chown vibe-pet:vibe-pet /var/lib/vibe-pet/sync.json
sudo chmod 640 /var/lib/vibe-pet/sync.json
```

## 4. 环境变量文件

```bash
sudo tee /etc/vibe-pet/sync.env > /dev/null <<'EOF'
# admin 数据看板口令（不设则 /api/admin/* 整体禁用）
ADMIN_USER=改成你的账号
ADMIN_PASS=改成你的强口令

# 数据文件：放系统目录，不跟代码走
SYNC_DATA_FILE=/var/lib/vibe-pet/sync.json

# 监听所有网卡（要能被外部访问）
SYNC_HOST=0.0.0.0

# 端口在 ExecStart 里指定，这里不重复
EOF

sudo chmod 600 /etc/vibe-pet/sync.env
sudo chown root:vibe-pet /etc/vibe-pet/sync.env
```

## 5. systemd unit

```bash
sudo tee /etc/systemd/system/vibe-pet-sync.service > /dev/null <<'EOF'
[Unit]
Description=Vibe Pet 同步服务
Documentation=file:/opt/vibe-woo/docs/deploy-selfhost.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vibe-pet
Group=vibe-pet
WorkingDirectory=/opt/vibe-woo
EnvironmentFile=/etc/vibe-pet/sync.env

# 绝对路径：systemd 不加载 bash 环境，写 `node` 会找不到
ExecStart=/opt/node-v18.20.4-linux-x64/bin/node worker-edgeone/local-dev.js 8787

Restart=always
RestartSec=5
# 禁用 systemd 默认的启动频率限制（10 秒内失败 5 次就彻底放弃）。
# 那个限制在「故障持续几分钟」时会让服务再也起不来，只能人工介入；
# 这里选择总是重试，代价是连续崩溃时会按 RestartSec 稳定地重试。
StartLimitIntervalSec=0

StandardOutput=journal
StandardError=journal
SyslogIdentifier=vibe-pet-sync

# ---- 安全加固 ----
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
# 全系统只读，只放开数据目录
ProtectSystem=strict
ReadWritePaths=/var/lib/vibe-pet
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now vibe-pet-sync
```

## 6. 验证

```bash
# 服务状态
sudo systemctl status vibe-pet-sync

# 本机连通性
curl -i http://127.0.0.1:8787/api/status
# 期望 200 + {"ok":true,...} + 响应头 X-Pet-Sync-Storage: file

# 外部连通性（换成本机公网 IP）—— 不通多半是安全组没放行
curl -i http://<公网IP>:8787/api/status
```

首次跑起来后，顺手做一次空库验收（会留下两个测试账号，只对新库做）：

```bash
cd /opt/vibe-woo && node scripts/test-remote.mjs http://<公网IP>:8787
```

## 7. 日志

```bash
sudo journalctl -u vibe-pet-sync -f          # 实时跟踪
sudo journalctl -u vibe-pet-sync --since today
sudo journalctl -u vibe-pet-sync -n 100      # 最近 100 行
```

想限制日志体积，在 `/etc/systemd/journald.conf` 设 `SystemMaxUse=200M`。

## 8. 自动备份

单机单文件、没有副本——机器或磁盘故障就是全部用户数据丢失。

```bash
sudo mkdir -p /var/lib/vibe-pet/backup
sudo crontab -e
```

加入（每天凌晨 4 点，保留 30 天）：

```
0 4 * * * cp /var/lib/vibe-pet/sync.json /var/lib/vibe-pet/backup/sync-$(date +\%F).json && find /var/lib/vibe-pet/backup -name 'sync-*.json' -mtime +30 -delete
```

> 只在本机备份挡不住机器故障。真要保险，再加一条 `rsync`/`rclone`
> 把当天备份推到对象存储（腾讯云 COS 有免费额度）。

## 9. 更新代码

```bash
cd /opt/vibe-woo
sudo git pull
sudo systemctl restart vibe-pet-sync
sudo journalctl -u vibe-pet-sync -n 20       # 确认起得来
```

## 10. 迁移到 EdgeOne（备案下来之后）

1. `src-tauri/src/syncclient.rs` 改 `DEFAULT_SYNC_BASE_URL`
2. 按 `worker-edgeone/README.md` 部署边缘函数、绑 KV
3. 导出这份数据（`sync.json`）导入新服务，或干脆让用户重新开户
4. 发一版 patch，老客户端自动升上来
5. 确认新服务无流量后：`sudo systemctl disable --now vibe-pet-sync`

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `status=217/USER` | `vibe-pet` 用户不存在，回到第 1 步 |
| `code=exited, status=203/EXEC` | `ExecStart` 的 node 路径写错，或没写绝对路径 |
| 启动后立刻 `status=1` | `journalctl -u vibe-pet-sync -n 50` 看具体报错；常见是数据文件权限不对（必须属 `vibe-pet`） |
| 本机通、外部不通 | 腾讯云安全组没放行 8787；或用了 80/443（未备案会被阻断） |
| `crypto is not defined` | Node 低于 18，或用了系统自带的旧 node |
| 数据不落盘 | `SYNC_DATA_FILE` 指向的目录对 `vibe-pet` 不可写；检查 `ReadWritePaths` 是否包含它 |

## 安全说明

- 服务以非 root 用户运行，文件系统只读（除数据目录外）。
- 明文 HTTP：会话 token 在链路上可被窃听。宠物应用无真实敏感数据，
  几个人用可接受；有域名后务必切 HTTPS。
- admin 口令只在 `/etc/vibe-pet/sync.env`（600 权限），不进代码仓库。
- 端口不要用 80/443——未备案会被云厂商阻断，且那样等于故意暴露。
