# OpenMAIC 部署运维说明

本文给运维人员使用，目标是把 OpenMAIC 独立部署起来，并接入 ERP。

## 1. 部署说明

- OpenMAIC 是独立部署的 Next.js 服务，不是 ERP 子应用
- 用户从 ERP 跳转进入 OpenMAIC
- OpenMAIC 会调用 ERP `/api/auth/currentUser` 做登录校验
- 课程数据会同步到 ERP 数据库表 `lesson_openmaic_courses`
- 课程 manifest 和资源文件会通过 ERP `/api/upload/file` 上传到 OSS `savvyuni-intl-erp`

## 2. 部署前准备

建议环境：

- Node.js 22
- pnpm 10
- Linux + Nginx

确认以下服务可用：

- OpenMAIC 服务器可以访问 ERP API
- ERP 的 OSS 上传配置可用
- 至少有一个可用的大模型 provider key

代码仓库信息：

- Repo: `https://github.com/SavvyUni/OpenMAIC`
- 部署分支: `master`

## 3. 代码部署

```bash
cd /srv
git clone -b master https://github.com/SavvyUni/OpenMAIC.git openmaic
cd /srv/openmaic
corepack enable
corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env.local
```

## 4. 环境变量配置

复制：

```bash
cp .env.example .env.local
```

然后重点修改 `.env.local` 里的这些配置。

### 4.1 必改项

```env
NODE_ENV=production
HOSTNAME=0.0.0.0
PORT=3000

OPENAI_API_KEY=sk-xxx
DEFAULT_MODEL=openai:gpt-5.5

ERP_API_BASE_URL=http://erp-api.internal:8000
ERP_AUTH_SECRET=replace-with-a-random-long-secret
ERP_AUTH_REDIRECT_URL=https://your-erp-domain/trainingcourse
ERP_AUTH_COOKIE_MAX_AGE_SECONDS=36000
```

说明：

- `OPENAI_API_KEY`
  - 至少配置一个可用模型的 key；如果不用 OpenAI，也可以改成你们实际 provider 对应的 key
- `DEFAULT_MODEL`
  - 默认模型，必须和实际已配置的 provider 对应上
- `ERP_API_BASE_URL`
  - ERP API 地址，OpenMAIC 会调用它做鉴权、同步课程、上传资源
- `ERP_AUTH_SECRET`
  - OpenMAIC 用来签名 ERP 会话 cookie，必须改成随机长字符串，建议至少 32 位
- `ERP_AUTH_REDIRECT_URL`
  - 用户未登录 OpenMAIC 时，重定向回 ERP 的地址
- `ERP_AUTH_COOKIE_MAX_AGE_SECONDS`
  - ERP 会话 cookie 有效期，默认保留 `36000`

### 4.2 按需配置

- 图片生成、视频生成、TTS、ASR 相关 provider 的 key
- 如果用了 `server-providers.yml`，也要同步检查里面的模型配置

## 5. 构建和启动

### 5.1 先本地启动验证

```bash
cd /srv/openmaic
pnpm build
pnpm start
```

默认监听：

- `0.0.0.0:3000`

### 5.2 systemd 启动

创建 `/etc/systemd/system/openmaic.service`：

```ini
[Unit]
Description=OpenMAIC
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/srv/openmaic
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable openmaic
sudo systemctl start openmaic
sudo systemctl status openmaic
```

## 6. Nginx 反向代理

```nginx
server {
    listen 80;
    server_name openmaic.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name openmaic.example.com;

    ssl_certificate     /etc/letsencrypt/live/openmaic.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openmaic.example.com/privkey.pem;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300;
    }
}
```

## 7. 上线后验证

### 7.1 服务是否正常

```bash
curl -I http://127.0.0.1:3000
systemctl status openmaic
```

### 7.2 ERP 跳转是否正常

从 ERP 的课节里点击“AI生成课程”，检查：

- 能跳到 OpenMAIC
- 地址栏中的 `erp_token` 会被清掉
- 未登录时会跳回 `ERP_AUTH_REDIRECT_URL`

### 7.3 是否写入 ERP

执行：

```sql
SELECT id, lessonId, openmaicId, name, manifestBucket, manifestKey, syncedAt
FROM lesson_openmaic_courses
ORDER BY id DESC
LIMIT 20;
```

确认：

- 有新记录
- `manifestBucket` / `manifestKey` 有值

### 7.4 是否上传到 OSS

检查 bucket `savvyuni-intl-erp` 下是否有：

- `openmaic/lesson-<lessonId>/<stageId>/manifest/classroom.json`
- `openmaic/lesson-<lessonId>/<stageId>/audio/...`
- `openmaic/lesson-<lessonId>/<stageId>/image/...`
- `openmaic/lesson-<lessonId>/<stageId>/video/...`

## 8. 常用命令

```bash
cd /srv/openmaic
pnpm install --frozen-lockfile
pnpm build
pnpm start
systemctl restart openmaic
systemctl status openmaic
journalctl -u openmaic -n 200 --no-pager
```

## 9. 常见问题

### 9.1 访问 OpenMAIC 直接跳回 ERP

优先检查：

- `ERP_API_BASE_URL`
- `ERP_AUTH_SECRET`
- `ERP_AUTH_REDIRECT_URL`
- ERP `/api/auth/currentUser` 是否可访问

### 9.2 课程生成后没写入 ERP

优先检查 OpenMAIC 日志里是否有：

- `/api/classroom` 报错
- `ERP manifest upload failed`
- `ERP lesson OpenMAIC sync failed`

### 9.3 OSS 只有 JSON 没有音频图片视频

优先检查：

- 对应 provider 是否真的生成成功
- ERP `/api/upload/file` 是否报错
- ERP OSS 权限是否正常
