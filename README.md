# Lucky Dog - 分布式密码破解系统

一个基于Node.js的分布式Bitcoin钱包密码破解系统，使用secp256k1椭圆曲线加密算法进行密码验证。

## 系统概述

Lucky Dog是一个用于破解加密Bitcoin钱包的分布式系统，支持多客户端并发处理，通过暴力破解方式尝试大量密码组合来找到正确的钱包密码。

## 核心功能

- **分布式处理**: 支持多个客户端同时连接服务器进行密码破解任务分发
- **多线程优化**: 客户端使用多个Worker线程并行处理密码验证
- **实时监控**: Web界面实时显示破解进度和统计信息
- **智能分发**: 根据客户端CPU核心数动态分配密码批次大小
- **状态管理**: 自动处理超时任务重分配和进度恢复
- **安全验证**: 使用secp256k1椭圆曲线验证私钥有效性

## 系统架构

### 服务端 (server.js)
- 基于Fastify框架的HTTP API服务器
- SQLite数据库存储密码记录和状态
- 支持密码分发、结果收集、进度统计
- Web控制台界面监控破解进度

### 客户端 (client.js)
- 多线程密码验证客户端
- 自动请求服务器获取密码批次
- 使用Worker线程并行处理密码验证
- 找到密码后自动上报服务器

### 数据生成 (lucky-sample.js)
- 生成测试用密码数据库
- 创建随机密码记录用于测试

## 快速开始

### 环境配置

1. 安装依赖:
```bash
npm install
```

2. 配置环境变量（可选，创建.env文件）:
```bash
# 服务器配置
PORT=3000
HOST=127.0.0.1
DB_NAME=lucky-sample.db
API_TOKEN=your_secret_token

# 客户端配置
SERVER_URL=http://localhost:3000
CPU_USAGE_RATIO=0.75
MAX_WORKERS=4
```

### 运行系统

1. 生成测试数据:
```bash
node lucky-sample.js
```

2. 启动服务器:
```bash
npm run server
# 或
node server.js
```

3. 启动客户端:
```bash
npm start
# 或
node client.js
```

4. 访问Web监控界面:
```
http://localhost:3000
```

## API接口

### 服务器端点

- `GET /` - Web控制台主页
- `GET /health` - 健康检查
- `GET /count` - 获取密码总数
- `GET /work/stats` - 获取工作统计信息
- `POST /work/request` - 客户端请求密码批次
- `POST /work/result` - 提交密码验证结果
- `POST /work/found` - 报告找到的密码
- `POST /work/reset-found` - 重置密码找到状态（仅限样本数据库）

### 密码记录状态

- `0` - UNCHECK: 未检查
- `1` - CHECKING: 检查中
- `2` - CHECKED: 已检查

## 技术特性

### 密码学算法
- 使用PBKDF2-SHA512进行密钥派生
- AES-256-CBC加密解密钱包主密钥
- secp256k1椭圆曲线验证私钥有效性
- 双重SHA256哈希计算

### 性能优化
- 多Worker线程并行处理
- 智能CPU资源分配
- 数据库连接池优化
- 自动任务超时处理

### 监控功能
- 实时进度条显示
- 详细统计信息面板
- 自动刷新监控数据
- 密码找到状态通知

## 文件结构

```
lucky-dog/
├── server.js          # 服务器主程序
├── client.js          # 客户端主程序
├── db.js              # 数据库操作模块
├── lucky-sample.js    # 测试数据生成器
├── index.html         # Web监控界面
├── encrypt.json       # 加密钱包数据
├── package.json       # 项目配置
└── data/              # 数据库文件目录
    └── *.db          # SQLite数据库文件
```

## 注意事项

- 本系统仅用于学习研究和合法的密码恢复用途
- 请确保有合法权限使用此工具破解钱包密码
- 大规模密码破解需要大量计算资源和时间
- 生产环境建议配置API_TOKEN进行安全验证

## PM2 启动命令
```
pm2 start npm --name "lucky-dog-server" -- run server
pm2 start npm --name "lucky-dog" --no-autorestart -- run start
```