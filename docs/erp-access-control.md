# OpenMAIC ERP 权限验证说明

## 目标

这套逻辑用于限制 OpenMAIC 只能被“已经登录 ERP 且具备指定权限”的用户访问。

设计目标有两个：

1. 尽量少改 OpenMAIC 业务代码，方便后续继续同步上游仓库。
2. 不在 OpenMAIC 内部重新实现一套完整登录系统，而是复用 ERP 已有登录态和权限体系。

## 涉及文件

- `middleware.ts`
- `lib/shared/erp-auth.ts`
- `app/api/access-code/status/route.ts`
- `training/src/components/TrainingShell.tsx`

## 总体原理

整体思路是：

1. 用户先在 ERP 中登录。
2. 用户从 Training 页面打开 OpenMAIC。
3. Training 把 ERP 当前登录态中的 `token` 和 `ip` 作为一次性引导参数带给 OpenMAIC。
4. OpenMAIC 中间件拿这个 `token` 去请求 ERP 的 `/api/auth/currentUser`。
5. ERP 返回当前用户信息和权限信息。
6. OpenMAIC 判断该用户是否具备指定权限。
7. 如果通过，OpenMAIC 给浏览器写入自己的短期签名 cookie。
8. 后续访问 OpenMAIC 直接依赖这个 cookie 放行，不再每次请求 ERP。

可以理解为：

- ERP 负责证明“你是谁、你有没有权限”
- OpenMAIC 负责在验证通过后发放“本站通行证”

## 请求链路

### 1. Training 打开 OpenMAIC

`training/src/components/TrainingShell.tsx` 在构建 OpenMAIC 地址时，会附加：

- `erp_token`
- `erp_ip`

这两个值来自浏览器本地存储中的 ERP 登录信息。

示例：

```text
http://localhost:3000/classroom/abc123?erp_token=...&erp_ip=...
```

这一步只用于首次引导认证。

### 2. OpenMAIC 中间件接管入口请求

`middleware.ts` 会在每次请求进入时优先判断是否开启 ERP 认证模式。

判断方式：

- 如果没有配置 `ERP_AUTH_BASE_URL`，则不启用 ERP 认证
- 如果配置了 `ERP_AUTH_BASE_URL`，则进入 ERP 认证模式

## ERP 认证模式的执行顺序

### 1. 优先检查 OpenMAIC 本地 cookie

中间件先读取 `openmaic_erp_access`。

如果这个 cookie：

- 存在
- 签名合法
- 没有过期

则直接放行请求。

这意味着用户首次验证成功之后，后续访问 OpenMAIC 不需要每次都回 ERP 校验。

### 2. 没有 cookie 时，尝试使用引导参数认证

如果没有有效 cookie，中间件会检查 URL 中是否存在：

- `erp_token`
- `erp_ip`

如果存在 `erp_token`，OpenMAIC 会向 ERP 发起请求：

```text
GET {ERP_AUTH_BASE_URL}/api/auth/currentUser
Authorization: Bearer <erp_token>
ip: <erp_ip>
```

这个接口由 ERP 负责解析 token，并返回当前登录用户信息。

### 3. 权限判断

OpenMAIC 不直接信任“只要登录就能进”，而是继续校验权限。

默认检查的权限是：

- `route = trainingCourse`
- `function = view-course`

这两个值也可以通过环境变量修改：

- `ERP_AUTH_PERMISSION_ROUTE`
- `ERP_AUTH_PERMISSION_FUNCTION`

权限判断在 `lib/shared/erp-auth.ts` 中实现。

当前兼容以下几种 ERP 用户权限结构：

### 结构 1：权限数组

```json
{
  "permissions": [
    { "route": "trainingCourse", "function": "view-course" }
  ]
}
```

### 结构 2：权限 map

```json
{
  "permissions": {
    "trainingCourse": ["view-course", "edit-course"]
  }
}
```

### 结构 3：permissionScopes

```json
{
  "permissionScopes": {
    "trainingCourse": {
      "view-course": [{ "id": 1 }]
    }
  }
}
```

只要任一结构命中目标权限，就允许进入。

### 4. 认证成功后的处理

如果 ERP 登录和权限校验都通过：

1. OpenMAIC 生成一个自己的签名 token
2. 写入 `openmaic_erp_access` 这个 `httpOnly` cookie
3. 302 重定向到去掉 `erp_token` 和 `erp_ip` 的干净 URL

这样做的目的有两个：

- 避免 ERP token 长时间暴露在地址栏中
- 后续访问只依赖 OpenMAIC 本地 cookie，不重复请求 ERP

## Cookie 机制

`openmaic_erp_access` 不是数据库 session，也不是 JWT。

它是一个很轻量的签名 token，格式类似：

```text
timestamp.signature
```

其中：

- `timestamp` 是签发时间
- `signature` 是基于 `ERP_AUTH_SECRET` 的 HMAC-SHA256 签名

中间件每次校验 cookie 时，会：

1. 拆出时间戳和签名
2. 用同一个 `ERP_AUTH_SECRET` 重新计算签名
3. 比较签名是否一致
4. 检查是否超过有效期

默认有效期由 `ERP_AUTH_COOKIE_MAX_AGE_SECONDS` 控制，默认值为 `36000` 秒。

## 失败分支

### API 请求失败

如果访问的是 `/api/*`，且未通过 ERP 认证，则返回：

- HTTP `401`
- JSON 错误对象

### 页面请求失败

如果访问的是页面请求，且未通过 ERP 认证：

- 如果配置了 `ERP_AUTH_REDIRECT_URL`，则重定向过去
- 如果没有配置，则直接返回 `403 Forbidden`

## 与 ACCESS_CODE 的关系

原来的 `ACCESS_CODE` 是“共享口令”机制，只适合做站点级保护，不区分 ERP 用户身份。

当前逻辑是：

- 配置了 `ERP_AUTH_BASE_URL` 时，优先使用 ERP 权限认证
- 未配置 `ERP_AUTH_BASE_URL` 时，继续沿用原有 `ACCESS_CODE` 机制

这样做的目的，是尽量减少对原项目默认行为的影响。

## 环境变量

需要在 OpenMAIC 中配置的变量：

```env
ERP_AUTH_BASE_URL=http://localhost:8000
ERP_AUTH_SECRET=replace-with-a-random-secret
ERP_AUTH_REDIRECT_URL=http://localhost:3001/training/course
ERP_AUTH_PERMISSION_ROUTE=trainingCourse
ERP_AUTH_PERMISSION_FUNCTION=view-course
ERP_AUTH_COOKIE_MAX_AGE_SECONDS=36000
```

说明：

- `ERP_AUTH_BASE_URL`
  ERP API 服务根地址，用于请求 `/api/auth/currentUser`
- `ERP_AUTH_SECRET`
  OpenMAIC 本地 cookie 签名密钥
- `ERP_AUTH_REDIRECT_URL`
  页面请求认证失败时的跳转地址
- `ERP_AUTH_PERMISSION_ROUTE`
  要求的权限 route
- `ERP_AUTH_PERMISSION_FUNCTION`
  要求的权限 function
- `ERP_AUTH_COOKIE_MAX_AGE_SECONDS`
  OpenMAIC 本地认证 cookie 有效期

## 安全取舍

当前方案的特点是“改动小、上线快”，但也有一个明确取舍：

- 首次引导时，ERP token 会短暂出现在 URL 查询参数中

虽然 OpenMAIC 会在认证成功后立即 302 清掉它，但它仍然会短暂出现在：

- 浏览器地址栏
- 浏览器历史记录
- 可能的代理日志

如果后续需要更严格的安全方案，可以升级为：

- `postMessage` 引导
- 后端中转换票
- 一次性短票据机制

这些方案更安全，但改动也会明显更大。

## 为什么这样设计适合 fork 项目

因为主要改动集中在入口层，而不是侵入 OpenMAIC 核心业务模块：

- 页面组件基本不用改
- 教室/课程逻辑不用改
- 数据结构不用改
- 上游合并时只需要重点处理少数几个文件

这比较适合“长期需要 merge upstream”的 fork 场景。
