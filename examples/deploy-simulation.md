# 部署演练文档：Web 应用部署至 Ubuntu 22.04 生产服务器

> **性质**：演练/Runbook 文档（无真实服务器，供有权限环境照此执行）
> **假设目标**：Ubuntu 22.04 LTS，公网 IP `203.0.113.10`（示例），域名 `app.example.com`
> **部署对象**：Node.js Web 应用（构建产物为静态文件 + 可选 Node 后端进程）
> **撰写日期**：2026-09-06

---

## 0. 前置检查清单

| 项 | 命令/方式 | 通过标准 |
|----|-----------|----------|
| SSH 可达 | `ssh deploy@203.0.113.10` | 免密登录成功（密钥已配置） |
|  sudo 权限 | `sudo -v` | 无密码或已缓存 |
| 端口开放 | 安全组/防火墙放行 80、443 | `sudo ufw status` 可见 |
| 域名解析 | `dig +short app.example.com` | 返回 203.0.113.10 |
| 本地构建通过 | `pnpm build`（或 npm run build） | 产物在 `dist/` |

---

## 1. 本地打包

```bash
# 在项目根目录执行
cd /path/to/project

# 安装依赖（锁定版本）
pnpm install --frozen-lockfile

# 生产构建
pnpm build

# 校验产物
ls -lh dist/
# 期望看到 index.html、assets/ 等

# 打版本包（带时间戳便于回滚）
VERSION=$(date +%Y%m%d-%H%M%S)
tar -czf "release-${VERSION}.tar.gz" -C dist .
echo "产物：release-${VERSION}.tar.gz"
sha256sum "release-${VERSION}.tar.gz" > "release-${VERSION}.sha256"
```

**要点**：产物与校验和一起传输，服务端落地后先验校再解压。

---

## 2. 传输到服务器

### 方式一：scp（单文件，简单场景）

```bash
scp release-${VERSION}.tar.gz release-${VERSION}.sha256 \
  deploy@203.0.113.10:/srv/app/releases/
```

### 方式二：rsync（推荐，支持断点续传 + 增量）

```bash
# 创建远端目录（首次）
ssh deploy@203.0.113.10 'mkdir -p /srv/app/releases'

# 同步产物（-avz：归档+详细+压缩；--progress 显示进度）
rsync -avz --progress \
  release-${VERSION}.tar.gz release-${VERSION}.sha256 \
  deploy@203.0.113.10:/srv/app/releases/
```

**目录约定**：
```
/srv/app/
├── releases/          # 各版本压缩包（保留最近 5 个）
│   ├── release-20260906-100000.tar.gz
│   └── ...
├── current -> /srv/app/releases/current   # 软链：当前线上版本解压目录
└── shared/            # 跨版本共享（.env、上传文件、日志）
    ├── .env
    └── logs/
```

---

## 3. 服务端解压与切换

```bash
ssh deploy@203.0.113.10 << 'EOF'
set -e
cd /srv/app/releases

# 1. 校验完整性
sha256sum -c release-20260906-100000.sha256

# 2. 解压到版本目录
mkdir -p v20260906-100000
tar -xzf release-20260906-100000.tar.gz -C v20260906-100000

# 3. 原子切换软链（秒级切换，可回滚）
ln -sfn /srv/app/releases/v20260906-100000 /srv/app/releases/current-new
mv -T /srv/app/releases/current-new /srv/app/current

echo "切换完成：$(readlink /srv/app/current)"
EOF
```

**回滚**：
```bash
# 软链指回上一个版本即可
ln -sfn /srv/app/releases/v20260905-153000 /srv/app/releases/current-new
mv -T /srv/app/releases/current-new /srv/app/current
```

**若含 Node 后端进程**（systemd 管理）：
```bash
sudo systemctl restart app.service
sudo systemctl status app.service --no-pager
journalctl -u app.service -n 50 --no-pager   # 查启动日志
```

---

## 4. Nginx 反向代理配置

创建站点配置 `/etc/nginx/sites-available/app`：

```nginx
# HTTP → HTTPS 强制跳转
server {
    listen 80;
    listen [::]:80;
    server_name app.example.com;

    # ACME 证书续期验证路径（certbot 需要）
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS 主站点
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name app.example.com;

    # 证书（第 5 步 certbot 会自动写入/更新这两行）
    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    # 安全头
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy strict-origin-when-cross-origin;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # gzip
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    # 静态资源：直接服务 + 长缓存（带 hash 的产物）
    location /assets/ {
        root /srv/app/current;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # index.html 不缓存（保证发版即时生效）
    location = /index.html {
        root /srv/app/current;
        add_header Cache-Control "no-cache";
    }

    # API 请求反代到 Node 后端（无后端则删除本块）
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # 其余路径：SPA fallback
    location / {
        root /srv/app/current;
        try_files $uri $uri/ /index.html;
    }
}
```

启用并重载：

```bash
sudo ln -sf /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app
sudo nginx -t                    # 配置语法校验（必须先看这步输出）
sudo systemctl reload nginx
```

---

## 5. HTTPS 证书（Let's Encrypt + certbot）

```bash
# 安装 certbot
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# 签发并自动写入 Nginx 配置（需 80 端口已可达且域名已解析）
sudo certbot --nginx -d app.example.com \
  --non-interactive --agree-tos -m ops@example.com --redirect

# 验证自动续期
sudo certbot renew --dry-run
systemctl list-timers | grep certbot   # 确认续期定时器存在
```

**验收**：浏览器访问 `https://app.example.com` 出现安全锁；`curl -sI https://app.example.com | grep -i strict-transport` 有输出。

---

## 6. 部署后验证清单

```bash
# 远端执行或本地执行均可
curl -fsS https://app.example.com/ > /dev/null && echo "✅ 首页 200"
curl -fsS https://app.example.com/api/health && echo " ✅ 后端健康"   # 有后端时
curl -sI https://app.example.com/assets/ | grep -i "cache-control"   # 静态缓存头
```

| 检查项 | 通过标准 |
|--------|----------|
| 首页 HTTPS 200 | `curl -fsS` 退出码 0 |
| HTTP 跳转 | `curl -sI http://...` 返回 301 且 Location 为 https |
| SPA 路由 | 直接访问 `/login` 等深链返回 200（非 404） |
| 证书有效 | 浏览器无警告；`echo \| openssl s_client -connect app.example.com:443 2>/dev/null \| openssl x509 -noout -dates` |
| 回滚可用 | 上一个版本目录存在且软链可切回 |

---

## 7. 日常运维速查

```bash
# 查日志
sudo tail -f /var/log/nginx/access.log
journalctl -u app.service -f          # 后端日志（如有）

# 清理旧版本（保留最近 5 个）
cd /srv/app/releases && ls -t | grep '^v' | tail -n +6 | xargs -r rm -rf

# 紧急回滚（一条命令）
ln -sfn "$(ls -dt /srv/app/releases/v* | sed -n 2p)" /srv/app/releases/current-new \
  && mv -T /srv/app/releases/current-new /srv/app/current
```

---

## 附：本演练与实际执行的差异说明

- 本文档中所有 `203.0.113.10` / `app.example.com` 均为 RFC 5737/示例占位，实际执行时替换为真实值
- 凭证应通过 SSH agent 或凭证管理器注入，**不要**写入脚本或文档
- 若项目为纯 DSH 插件（如任务看板），其分发方式是 `export_bundle` / 文件共享，不适用本文档流程；本文档面向独立 Web 应用
