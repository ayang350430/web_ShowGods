# goods 管理系统技术文档

## 1. 项目概述

`goods` 是一个前后端分离的后台管理系统，主要面向小红书笔记阅读/曝光下单、账户余额、消费流水、退款审核、权限管理和数据分析场景。

项目包含两个核心应用：

- 后端服务：`el_node`，基于 Node.js、Express 和 MySQL。
- 前端应用：`webEL`，基于 Vue 3、Vite、Vben Admin、Element Plus。

当前仓库还包含数据库导出文件：

- `database/goosd_admin.sql`

## 2. 技术栈

### 2.1 后端

| 类型 | 技术 |
| --- | --- |
| 运行环境 | Node.js |
| Web 框架 | Express 5 |
| 数据库 | MySQL 8 |
| 数据库驱动 | mysql2 |
| 密码加密 | bcryptjs |
| 安全中间件 | helmet |
| 跨域 | cors |
| 日志 | morgan、自定义 requestLogger |
| 测试 | Jest、Supertest |
| 开发热更新 | nodemon |

### 2.2 前端

| 类型 | 技术 |
| --- | --- |
| 框架 | Vue 3 |
| 构建工具 | Vite |
| 管理后台基础 | Vue Vben Admin |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 路由 | Vue Router |
| 类型检查 | vue-tsc |
| 包管理 | pnpm |

## 3. 项目目录

```text
goosd_admin/
├── database/
│   └── goosd_admin.sql              # MySQL 数据库导出文件
├── el_node/                         # 后端服务
│   ├── src/
│   │   ├── app.js                   # Express 应用入口
│   │   ├── server.js                # HTTP 服务启动入口
│   │   ├── config/                  # 数据库连接和初始化
│   │   ├── controllers/             # 控制器
│   │   ├── middlewares/             # 中间件
│   │   ├── routes/                  # 路由定义
│   │   ├── services/                # 业务服务
│   │   ├── utils/                   # 工具方法
│   │   └── __tests__/               # 后端测试
│   ├── .env.example                 # 后端环境变量模板
│   └── package.json
├── webEL/                           # 前端应用
│   ├── src/
│   │   ├── api/                     # 接口封装
│   │   ├── layouts/                 # 布局
│   │   ├── router/                  # 路由
│   │   ├── store/                   # 状态管理
│   │   └── views/                   # 页面模块
│   ├── vite.config.ts
│   └── package.json
└── docs/
    └── technical-documentation.md
```

## 4. 后端设计

### 4.1 启动入口

后端入口文件：

- `el_node/src/server.js`
- `el_node/src/app.js`

`app.js` 负责注册 Express 中间件、路由、错误处理和请求日志。`server.js` 负责初始化数据库并启动 HTTP 服务。

### 4.2 后端脚本

在 `el_node` 目录执行：

```bash
npm run dev
npm start
npm test -- --runInBand
```

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 使用 nodemon 启动开发服务 |
| `npm start` | 使用 node 启动生产服务 |
| `npm test -- --runInBand` | 运行后端测试 |

### 4.3 环境变量

模板文件：`el_node/.env.example`

```env
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5777
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=goosd_admin
DB_USER=goosd_admin
DB_PASSWORD=goosd_admin_dev
XHS_API_BASE_URL=http://192.168.31.134:9101
XHS_API_TOKEN=xhs-api-123456789
XHS_API_TIMEOUT_MS=10000
SEED_DEMO_DATA=false
BATCH_CHECK_CONCURRENCY=30
```

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端监听端口 |
| `CORS_ORIGIN` | 允许访问后端的前端地址 |
| `DB_HOST` / `DB_PORT` | MySQL 地址和端口 |
| `DB_NAME` | 数据库名称 |
| `DB_USER` / `DB_PASSWORD` | 数据库账号和密码 |
| `XHS_API_BASE_URL` | 外部小红书服务地址 |
| `XHS_API_TOKEN` | 外部接口 Token |
| `XHS_API_TIMEOUT_MS` | 外部接口超时时间 |
| `SEED_DEMO_DATA` | 是否初始化演示数据 |
| `BATCH_CHECK_CONCURRENCY` | 批量检测并发数，最高 100 |

### 4.4 路由模块

后端统一挂载路径：`/api`

| 路由模块 | 路径 | 说明 |
| --- | --- | --- |
| 健康检查 | `/api/health` | 服务健康检测 |
| 登录注册 | `/api/auth` | 登录、注册、刷新、退出 |
| 菜单 | `/api/menu` | 前端菜单数据 |
| 用户 | `/api/user` | 用户信息、个人中心、通知 |
| 天气 | `/api/weather` | 今日天气 |
| 下单 | `/api/v1/orders` | 批量下单、记录、消费、退款 |
| 分析 | `/api/v1/dashboard` | 首页和分析页统计 |
| 管理面板 | `/api/v1/admin/dashboard` | 管理员数据概览 |
| 权限管理 | `/api/v1/admin/permissions` | 用户角色、状态、折扣 |

### 4.5 核心业务服务

| 文件 | 说明 |
| --- | --- |
| `auth.service.js` | 登录、注册、账号校验 |
| `batchOrder.service.js` | 批量下单、校验、订单记录、消费、退款 |
| `dashboard.service.js` | 分析页、首页汇总指标 |
| `adminPermission.service.js` | 权限管理、用户停用、价格配置 |
| `userProfile.service.js` | 个人中心、通知、用户概况 |
| `permission.service.js` | 菜单和权限数据 |
| `weather.service.js` | 天气接口 |

## 5. 数据库设计

### 5.1 数据库文件

当前数据库导出文件：

```text
database/goosd_admin.sql
```

恢复数据库示例：

```bash
mysql -h127.0.0.1 -P3306 -uroot -p < database/goosd_admin.sql
```

如果使用项目默认账号：

```bash
mysql -h127.0.0.1 -P3306 -ugoosd_admin -pgoosd_admin_dev < database/goosd_admin.sql
```

### 5.2 主要数据表

| 表名 | 说明 |
| --- | --- |
| `users` | 用户账号 |
| `roles` | 角色 |
| `user_roles` | 用户角色关系 |
| `balance_accounts` | 用户余额账户 |
| `account_records` | 消费和退款流水 |
| `order_batches` | 下单批次 |
| `orders` | 订单明细 |
| `system_configs` | 系统配置和价格配置 |
| `note_basic_cache` | 笔记信息缓存 |
| `batch_link_check_records` | 批量检测记录 |
| `batch_problem_link_records` | 问题链接记录 |

### 5.3 订单状态

| 状态 | 说明 |
| --- | --- |
| `running` | 处理中 |
| `completed` | 成功 |
| `failed` | 失败 |
| `manual_review` | 人工处理 |
| `repair_review` | 补单/审核 |
| `refund_requested` | 已申请退款 |
| `refund_calculating` | 退款计算中 |
| `refund_approved` | 退款通过 |
| `refund_rejected` | 退款拒绝 |
| `stopping` | 停止中 |

### 5.4 资金流水

`account_records` 用于记录账户余额变化。

| 类型 | 方向 | 说明 |
| --- | --- | --- |
| `order_charge` | `debit` | 下单扣费 |
| `refund` | `credit` | 退款入账 |

每条流水包含：

- 下单数量
- 原始单价
- 折扣率
- 折后单价
- 实际支付金额
- 退款金额
- 变更前余额
- 变更后余额

## 6. 前端设计

### 6.1 前端脚本

在 `webEL` 目录执行：

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm preview
```

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发服务 |
| `pnpm build` | 生产构建 |
| `pnpm typecheck` | 类型检查 |
| `pnpm preview` | 预览构建结果 |

### 6.2 页面模块

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 分析页 | `webEL/src/views/dashboard/analytics/index.vue` | 统计指标、余额、订单趋势 |
| 工作台 | `webEL/src/views/dashboard/workspace/index.vue` | 工作台页面 |
| 批量下单 | `webEL/src/views/orders/batch/index.vue` | 批量输入、检测、提交 |
| 下单记录 | `webEL/src/views/orders/records/index.vue` | 批次和订单明细 |
| 消费记录 | `webEL/src/views/orders/consumption/index.vue` | 消费流水和退款申请 |
| 退款记录 | `webEL/src/views/orders/refunds/index.vue` | 退款审核和记录 |
| 权限管理 | `webEL/src/views/system/permissions/index.vue` | 用户角色、状态、价格 |
| 个人中心 | `webEL/src/views/_core/profile/index.vue` | 用户资料和账户数据 |

### 6.3 API 封装

前端接口集中在：

```text
webEL/src/api/core/
```

| 文件 | 说明 |
| --- | --- |
| `auth.ts` | 登录注册 |
| `dashboard.ts` | 分析页统计 |
| `menu.ts` | 菜单 |
| `order.ts` | 下单、记录、消费、退款 |
| `user.ts` | 用户资料、通知、权限 |

请求客户端在：

```text
webEL/src/api/request.ts
```

已支持全局请求加载提示，并允许部分轮询接口跳过加载提示。

## 7. 核心业务流程

### 7.1 登录注册流程

1. 用户通过手机号或账号登录。
2. 后端校验账号状态和密码。
3. 返回用户信息和权限数据。
4. 前端根据角色展示菜单。
5. 注册用户默认最低权限。

### 7.2 批量下单流程

1. 前端输入链接和数量。
2. 后端解析链接，短链接会转为笔记 ID。
3. 后端请求笔记信息接口并缓存。
4. 后端根据当前用户价格配置计算扣费。
5. 预校验通过后提交订单。
6. 后端创建订单批次和订单明细。
7. 外部下单成功后订单状态变为成功。
8. 下单扣费写入账户流水。
9. 前端下单记录显示批次和明细。

### 7.3 问题链接流程

1. 批量校验失败的链接会标记为问题链接。
2. 用户可一键删除问题链接并记录。
3. 问题链接批次会单独出现在下单记录中。
4. 问题链接支持复制。

### 7.4 退款流程

1. 用户在消费记录或订单明细中申请退款。
2. 订单进入退款中状态。
3. `super` 或 `admin` 审核退款。
4. 审核通过后生成退款流水。
5. 余额增加，退款记录显示退款后余额。
6. 审核拒绝后订单显示退款拒绝。

### 7.5 权限和价格流程

管理员可在权限管理中配置：

- 用户角色
- 用户启用/停用状态
- 阅读价格模式
- 曝光价格模式

价格模式支持：

- 默认价格
- 折扣价格
- 固定金额价格

下单扣费会按照当前用户的配置计算。

## 8. 接口概览

### 8.1 认证接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录 |
| `POST` | `/api/auth/register` | 注册 |
| `POST` | `/api/auth/logout` | 退出 |
| `POST` | `/api/auth/refresh` | 刷新 |
| `GET` | `/api/auth/codes` | 获取权限码 |

### 8.2 用户接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/user/info` | 当前用户信息 |
| `GET` | `/api/user/profile` | 个人中心数据 |
| `GET` | `/api/user/notifications` | 通知 |

### 8.3 订单接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/orders/batch/preview` | 批量下单预校验 |
| `POST` | `/api/v1/orders/batch/preview-silent` | 静默预校验 |
| `POST` | `/api/v1/orders/batch/submit` | 提交批量下单 |
| `GET` | `/api/v1/orders/batch/records` | 下单记录 |
| `GET` | `/api/v1/orders/batch/check-records` | 检测记录 |
| `GET` | `/api/v1/orders/batch/problem-links` | 问题链接记录 |
| `POST` | `/api/v1/orders/batch/problem-links` | 保存问题链接 |
| `GET` | `/api/v1/orders/consumption-records` | 消费记录 |
| `GET` | `/api/v1/orders/refund-records` | 退款记录 |
| `POST` | `/api/v1/orders/:orderId/refund-request` | 申请退款 |
| `POST` | `/api/v1/orders/:orderId/refund-review` | 审核退款 |

### 8.4 分析接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/dashboard/summary` | 分析页汇总 |
| `GET` | `/api/v1/dashboard/rankings` | 排行数据 |
| `GET` | `/api/v1/admin/dashboard/users-overview` | 管理端用户概览 |

### 8.5 权限接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/admin/permissions/users` | 用户权限列表 |
| `PUT` | `/api/v1/admin/permissions/users/:userId/roles` | 修改角色 |
| `PUT` | `/api/v1/admin/permissions/users/:userId/status` | 修改状态 |
| `PUT` | `/api/v1/admin/permissions/users/:userId/discounts` | 修改价格配置 |

## 9. 本地开发

### 9.1 数据库准备

1. 启动 MySQL。
2. 创建数据库和用户。
3. 导入 SQL 文件。

```bash
mysql -h127.0.0.1 -P3306 -uroot -p < database/goosd_admin.sql
```

### 9.2 后端启动

```bash
cd el_node
npm install
copy .env.example .env
npm run dev
```

默认后端地址：

```text
http://localhost:3000
```

### 9.3 前端启动

```bash
cd webEL
pnpm install
pnpm dev
```

默认前端地址：

```text
http://localhost:5777
```

## 10. 测试和质量检查

### 10.1 后端测试

```bash
cd el_node
npm test -- --runInBand
```

测试覆盖：

- 登录注册
- 权限管理
- 批量下单
- 退款
- 分析数据
- 数据库结构
- 天气接口
- 个人中心

### 10.2 前端类型检查

```bash
cd webEL
pnpm typecheck
```

## 11. 日志和运维

### 11.1 请求日志

后端使用自定义 `requestLogger` 记录每次请求：

```text
el_node/logs/request-YYYY-MM-DD.log
```

日志包含：

- 请求 ID
- 方法
- 路径
- 状态码
- 成功/失败
- 耗时
- IP
- User-Agent
- 用户 ID

### 11.2 日志保留策略

请求日志只保留最近 2 天：

- 今天
- 昨天

更早的 `request-YYYY-MM-DD.log` 会自动清理。

## 12. 部署建议

### 12.1 后端部署

生产环境建议：

```bash
cd el_node
npm install --omit=dev
npm start
```

建议使用进程管理工具：

- PM2
- Windows 服务
- Docker

### 12.2 前端部署

```bash
cd webEL
pnpm install
pnpm build
```

构建产物位于：

```text
webEL/dist
```

可部署到：

- Nginx
- IIS
- 静态资源服务器

### 12.3 反向代理建议

建议将前端和后端统一到同一域名下：

```text
https://example.com           -> 前端
https://example.com/api       -> 后端
```

这样可以减少跨域配置复杂度。

## 13. 安全注意事项

- `.env` 不应提交到 Git。
- 数据库密码应在生产环境单独配置。
- `XHS_API_TOKEN` 应作为密钥管理。
- 管理员接口应继续保持角色校验。
- 退款审核仅允许 `super` 和 `admin` 操作。
- 生产环境应使用 HTTPS。

## 14. 当前已知维护点

- 外部小红书接口不可用时，订单会失败并记录失败原因。
- 已扣费但失败的订单会自动退款。
- 批量下单记录会根据订单明细重新汇总成功、失败和处理中数量。
- 通知接口用于退款提醒，不应触发全局加载提示。
- 数据库结构由后端初始化逻辑和 SQL 备份共同维护。

