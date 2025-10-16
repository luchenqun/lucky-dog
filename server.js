require('dotenv').config();

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_NAME = process.env.DB_NAME || 'lucky.db';
const API_TOKEN = process.env.API_TOKEN || '';
const DB_PATH = path.join(__dirname, 'data', DB_NAME);
const INDEX_PATH = path.join(__dirname, 'index.html');
const STARTUP_TIME_FILE = path.join(__dirname, '.startup_time');

let startupTime = Date.now(); // 默认为当前时间

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

fastify.log.info(
  {
    env: {
      PORT,
      HOST,
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      DB_NAME,
      API_TOKEN: API_TOKEN ? '***' : 'NOT SET',
    },
  },
  'Loaded environment configuration',
);

// Token验证中间件 - 只对POST请求验证
fastify.addHook('preHandler', async (request, reply) => {
  // 只验证POST请求
  if (request.method === 'POST') {
    if (!API_TOKEN) {
      fastify.log.warn('API_TOKEN not set, POST requests will be rejected');
      reply.code(401).send({ error: 'API token required but not configured' });
      return;
    }

    const token = request.headers['authorization'] || request.headers['x-api-token'];
    console.log('token', token);

    if (!token) {
      fastify.log.warn(`POST ${request.url} rejected: No token provided`);
      reply.code(401).send({ error: 'API token required' });
      return;
    }

    // 支持 Bearer token 和直接token
    const actualToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    console.log('actualToken', actualToken, 'API_TOKEN', API_TOKEN);

    if (actualToken !== API_TOKEN) {
      fastify.log.warn(`POST ${request.url} rejected: Invalid token`);
      reply.code(403).send({ error: 'Invalid API token' });
      return;
    }

    fastify.log.info(`POST ${request.url} authorized`);
  }
});

const db = new Database(DB_PATH);

// 数据库表结构由 db.js 模块管理

const countStmt = db.prepare('SELECT COUNT(*) AS count FROM records');
const getStmt = db.prepare('SELECT id, pwd, status FROM records WHERE id = ?');
const randomStmt = db.prepare('SELECT id, pwd, status FROM records ORDER BY RANDOM() LIMIT 1');
const getByPwdStmt = db.prepare('SELECT id, pwd, status FROM records WHERE pwd = ?');

const STATUS = {
  UNCHECK: 0,
  CHECKING: 1,
  CHECKED: 2,
};

let shuttingDown = false;
let passwordFound = false; // 全局标记，密码是否已找到

// 客户端活动记录 Map<clientId, lastActiveTime>
const activeClients = new Map();

const encrypt = require('./encrypt.json');

fastify.get('/', async (_request, reply) => {
  const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
  reply.type('text/html').send(html);
});

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.get('/count', async () => {
  const { count } = countStmt.get();
  return { count };
});

fastify.get('/records/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    reply.code(400);
    return { error: 'id must be a positive integer' };
  }
  const record = getStmt.get(id);
  if (!record) {
    reply.code(404);
    return { error: 'record not found' };
  }
  return {
    id: record.id,
    pwd: record.pwd,
    status: record.status,
  };
});

fastify.get('/records/random', async () => {
  const record = randomStmt.get();
  if (!record) {
    return { error: 'no data' };
  }
  return {
    id: record.id,
    pwd: record.pwd,
    status: record.status,
  };
});

fastify.get('/records/by-pwd/:pwd', async (request, reply) => {
  const { pwd } = request.params;
  if (typeof pwd !== 'string' || !pwd) {
    reply.code(400);
    return { error: 'pwd must be a non-empty string' };
  }

  const record = getByPwdStmt.get(pwd);
  if (!record) {
    reply.code(404);
    return { error: 'record not found' };
  }

  return {
    id: record.id,
    pwd: record.pwd,
    status: record.status,
  };
});

// 分发密码给客户端
fastify.post('/work/request', async (request, reply) => {
  const { cpuCount = 1, clientId } = request.body;

  if (!clientId) {
    reply.code(400);
    return { error: 'clientId is required' };
  }

  // 记录客户端活动时间
  activeClients.set(clientId, Date.now());

  // 如果密码已找到，停止分发新任务
  if (passwordFound) {
    return {
      success: false,
      message: 'Password already found, no more work needed',
      passwords: [],
      encrypt: null,
      passwordFound: true,
    };
  }

  // 计算批次大小，基于CPU核心数
  const batchSize = Math.max(100, cpuCount * 100);

  // 获取未检查的密码
  const getUncheckedStmt = db.prepare(`
    SELECT id, pwd FROM records 
    WHERE status = ? 
    ORDER BY id 
    LIMIT ?
  `);

  try {
    const passwords = getUncheckedStmt.all(STATUS.UNCHECK, batchSize);

    if (passwords.length === 0) {
      return {
        success: false,
        message: 'No more passwords to check',
        passwords: [],
        encrypt: null,
      };
    }

    // 更新状态为CHECKING - 动态生成SQL
    const ids = passwords.map((p) => p.id);
    const updateStatusStmt = db.prepare(`
      UPDATE records 
      SET status = ?, updated_at = strftime('%s', 'now') 
      WHERE id IN (${Array(ids.length).fill('?').join(',')})
    `);
    updateStatusStmt.run(STATUS.CHECKING, ...ids);

    fastify.log.info(`分发 ${passwords.length} 个密码给客户端 ${clientId}`);

    return {
      success: true,
      passwords: passwords.map((p) => p.pwd),
      encrypt,
      batchId: `${clientId}-${Date.now()}`,
      count: passwords.length,
    };
  } catch (error) {
    fastify.log.error('分发密码时出错:', error);
    console.error('分发密码时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 接收碰撞结果
fastify.post('/work/result', async (request, reply) => {
  const { batchId, success, foundPassword, passwords, clientId } = request.body;

  if (!batchId || !clientId) {
    reply.code(400);
    return { error: 'batchId and clientId are required' };
  }

  try {
    if (success && foundPassword) {
      // 找到密码了！设置全局标记
      passwordFound = true;

      fastify.log.info(`🎉 密码找到了！客户端 ${clientId} 找到密码: ${foundPassword}`);

      // 保存结果到文件
      const resultFile = path.join(__dirname, 'found_password.txt');
      const result = `找到密码: ${foundPassword}\n时间: ${new Date().toISOString()}\n客户端: ${clientId}\n`;
      await fs.promises.appendFile(resultFile, result);

      // 停止所有工作
      return {
        success: true,
        message: 'Password found! All work stopped!',
        shouldStop: true,
        passwordFound: true,
      };
    } else {
      // 没找到密码，标记这批密码为已检查
      if (passwords && passwords.length > 0) {
        const updateStmt = db.prepare(`
          UPDATE records 
          SET status = ?, updated_at = strftime('%s', 'now') 
          WHERE pwd = ?
        `);

        const updateMany = db.transaction((pwds) => {
          for (const pwd of pwds) {
            updateStmt.run(STATUS.CHECKED, pwd);
          }
        });

        updateMany(passwords);

        fastify.log.info(`客户端 ${clientId} 完成 ${passwords.length} 个密码检查`);
      }

      return {
        success: true,
        message: 'Results recorded',
      };
    }
  } catch (error) {
    fastify.log.error('处理碰撞结果时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 报告找到的密码（持续重试）
fastify.post('/work/found', async (request, reply) => {
  const { password, clientId } = request.body;

  if (!password || !clientId) {
    reply.code(400);
    return { error: 'password and clientId are required' };
  }

  try {
    // 设置全局标记
    passwordFound = true;

    fastify.log.info(`🎉🎉🎉 密码确认找到！客户端 ${clientId}: ${password}`);

    // 保存到文件
    const resultFile = path.join(__dirname, 'found_password.txt');
    const result = `确认找到密码: ${password}\n时间: ${new Date().toISOString()}\n客户端: ${clientId}\n重复确认: 是\n\n`;
    await fs.promises.appendFile(resultFile, result);

    return {
      success: true,
      message: 'Password confirmed and saved',
      passwordFound: true,
    };
  } catch (error) {
    fastify.log.error('保存找到的密码时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 重置密码找到状态 - 仅限样本数据库
fastify.post('/work/reset-found', async (request, reply) => {
  try {
    fastify.log.info('收到重置密码找到状态的请求');

    // 安全检查：只有使用样本数据库才允许重置
    if (DB_NAME !== 'lucky-sample.db') {
      fastify.log.warn(`拒绝重置请求：当前数据库 ${DB_NAME} 不是样本数据库`);
      reply.code(403);
      return {
        error: 'Reset is only allowed for sample database (lucky-sample.db)',
        currentDatabase: DB_NAME,
        allowed: false,
      };
    }

    const foundPasswordFile = path.join(__dirname, 'found_password.txt');
    let previouslyFound = false;

    if (fs.existsSync(foundPasswordFile)) {
      previouslyFound = true;
      // 备份原文件
      const backupFile = path.join(__dirname, `found_password_backup_${Date.now()}.txt`);
      await fs.promises.copyFile(foundPasswordFile, backupFile);
      await fs.promises.unlink(foundPasswordFile);
      fastify.log.info(`密码找到状态已重置，原文件备份为: ${backupFile}`);
    }

    // 重置全局状态
    passwordFound = false;
    fastify.log.info('全局密码找到状态已重置为false');

    // 将所有记录状态重置为UNCHECK
    const resetAllStmt = db.prepare(`
      UPDATE records 
      SET status = ?, updated_at = strftime('%s', 'now')
    `);

    const result = resetAllStmt.run(STATUS.UNCHECK);

    fastify.log.info(`已将 ${result.changes} 条记录状态重置为UNCHECK`);

    return {
      success: true,
      message: 'Password found status and all records reset, search can restart',
      previouslyFound,
      recordsReset: result.changes,
      database: DB_NAME,
    };
  } catch (error) {
    fastify.log.error('重置密码找到状态时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 重置超时的检查状态
fastify.post('/work/reset-timeout', async (request, reply) => {
  try {
    const resetStmt = db.prepare(`
      UPDATE records 
      SET status = ?, updated_at = strftime('%s', 'now')
      WHERE status = ? 
      AND updated_at < strftime('%s', 'now') - 3600
    `);

    const result = resetStmt.run(STATUS.UNCHECK, STATUS.CHECKING);

    if (result.changes > 0) {
      fastify.log.info(`重置了 ${result.changes} 个超时的检查状态`);
    }

    return {
      success: true,
      resetCount: result.changes,
      message: `Reset ${result.changes} timed out checking records`,
    };
  } catch (error) {
    fastify.log.error('重置超时状态时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 获取工作状态统计
let cacheStats = null;
let isUpdatingStats = false;

// 计算缓存时间（毫秒）
function calculateCacheTime(totalCount) {
  if (totalCount <= 10000) {
    return 0; // 1万条以下不缓存
  }

  const millionCount = Math.floor(totalCount / 1000000);
  const cacheMinutes = Math.min(millionCount, 60); // 最多缓存60分钟
  return cacheMinutes * 60 * 1000; // 转换为毫秒
}

// 格式化运行时长
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

  return parts.join(' ');
}

// 获取最近1小时内活跃的客户端信息
function getActiveClientsInfo() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const activeClientsList = [];

  // 清理过期的客户端记录，并收集活跃客户端信息
  for (const [clientId, lastActiveTime] of activeClients.entries()) {
    if (lastActiveTime < oneHourAgo) {
      activeClients.delete(clientId); // 删除超过1小时未活跃的客户端
    } else {
      activeClientsList.push({
        clientId,
        lastActiveTime,
        lastActiveDuration: Math.floor((Date.now() - lastActiveTime) / 1000), // 距离上次活跃的秒数
      });
    }
  }

  // 按最后活跃时间排序（最近的在前）
  activeClientsList.sort((a, b) => b.lastActiveTime - a.lastActiveTime);

  return {
    count: activeClientsList.length,
    clients: activeClientsList,
  };
}

fastify.get('/work/stats', async (request, reply) => {
  try {
    // 检查缓存是否有效
    if (cacheStats) {
      const cacheTime = calculateCacheTime(cacheStats.total);
      if (cacheTime > 0 && Date.now() - cacheStats.updated_at < cacheTime) {
        fastify.log.info(`返回缓存的统计信息 (总记录数: ${cacheStats.total.toLocaleString()})`);
        // 更新活跃客户端信息（实时数据，不缓存）
        const clientsInfo = getActiveClientsInfo();
        return {
          ...cacheStats,
          activeClients: clientsInfo.count,
          activeClientsList: clientsInfo.clients,
        };
      }
    }

    // 如果正在更新统计信息，直接返回缓存结果（如果有的话）
    if (isUpdatingStats) {
      fastify.log.info('统计信息正在更新中，返回缓存结果');
      return cacheStats || { error: 'Statistics are being updated, please try again later' };
    }

    // 设置更新标志
    isUpdatingStats = true;

    try {
      const statsStmt = db.prepare(`
        SELECT 
          status,
          COUNT(*) as count,
          COUNT(CASE WHEN updated_at < strftime('%s', 'now') - 3600 AND status = 1 THEN 1 END) as timeout_count
        FROM records 
        GROUP BY status
      `);

      const stats = statsStmt.all();
      const summary = {
        uncheck: 0,
        checking: 0,
        checked: 0,
        timeout: 0,
        total: 0,
      };

      for (const stat of stats) {
        summary.total += stat.count;
        if (stat.status === STATUS.UNCHECK) summary.uncheck = stat.count;
        if (stat.status === STATUS.CHECKING) {
          summary.checking = stat.count;
          summary.timeout = stat.timeout_count;
        }
        if (stat.status === STATUS.CHECKED) summary.checked = stat.count;
      }

      summary.progress = summary.total > 0 ? ((summary.checked / summary.total) * 100).toFixed(2) : 0;
      summary.passwordFound = passwordFound;
      summary.database = DB_NAME;
      summary.resetAllowed = DB_NAME === 'lucky-sample.db';
      summary.tokenRequired = !!API_TOKEN;

      // 添加活跃客户端信息
      const clientsInfo = getActiveClientsInfo();
      summary.activeClients = clientsInfo.count;
      summary.activeClientsList = clientsInfo.clients;

      summary.updated_at = Date.now(); // 添加更新时间戳

      // 计算系统运行时长（单位：秒）
      const uptime = Math.floor((Date.now() - startupTime) / 1000);
      summary.uptime = uptime;
      summary.uptimeFormatted = formatUptime(uptime); // 格式化的运行时长

      // 更新缓存
      cacheStats = summary;

      const cacheTime = calculateCacheTime(summary.total);
      if (cacheTime > 0) {
        const cacheMinutes = Math.floor(cacheTime / (60 * 1000));
        fastify.log.info(`统计信息已缓存 ${cacheMinutes} 分钟 (总记录数: ${summary.total.toLocaleString()})`);
      } else {
        fastify.log.info(`统计信息未缓存，实时更新 (总记录数: ${summary.total.toLocaleString()})`);
      }

      return summary;
    } finally {
      // 清除更新标志
      isUpdatingStats = false;
    }
  } catch (error) {
    fastify.log.error('获取统计信息时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 定时任务：每60分钟自动重置超时状态
setInterval(
  async () => {
    try {
      const resetStmt = db.prepare(`
      UPDATE records 
      SET status = ?, updated_at = strftime('%s', 'now')
      WHERE status = ? 
      AND updated_at < strftime('%s', 'now') - 3600
    `);

      const result = resetStmt.run(STATUS.UNCHECK, STATUS.CHECKING);

      if (result.changes > 0) {
        fastify.log.info(`自动重置了 ${result.changes} 个超时的检查状态`);
      }
    } catch (error) {
      fastify.log.error('自动重置超时状态时出错:', error);
    }
  },
  60 * 60 * 1000,
); // 60分钟

function handleShutdown(signal) {
  if (shuttingDown) {
    fastify.log.warn({ signal }, 'Shutdown already in progress; forcing exit.');
    process.exit(1);
  }
  shuttingDown = true;
  fastify.log.info({ signal }, 'Received shutdown signal. Closing services.');

  Promise.resolve()
    .then(() => {
      fastify.log.info('关闭Fastify');
      return fastify.close();
    })
    .catch((error) => {
      fastify.log.error(error, 'Error while closing Fastify');
    })
    .finally(() => {
      try {
        fastify.log.info('关闭数据库');
        console.time('关闭数据库耗时');
        db.close();
        console.timeEnd('关闭数据库耗时');
      } catch (error) {
        fastify.log.error(error, 'Error while closing database');
      }
      process.exit(0);
    });
}

async function main() {
  try {
    // 检查数据库文件是否存在
    console.log('encrypt', encrypt);
    if (!fs.existsSync(DB_PATH)) {
      fastify.log.error(`数据库文件不存在: ${DB_PATH}`);
      fastify.log.info('请先运行数据生成脚本创建数据库文件');
      process.exit(1);
    }

    // 读取或创建启动时间文件
    if (fs.existsSync(STARTUP_TIME_FILE)) {
      try {
        const fileContent = fs.readFileSync(STARTUP_TIME_FILE, 'utf-8').trim();
        const savedStartupTime = parseInt(fileContent, 10);
        if (Number.isInteger(savedStartupTime) && savedStartupTime > 0) {
          startupTime = savedStartupTime;
          const uptime = Math.floor((Date.now() - startupTime) / 1000);
          fastify.log.info(`从文件读取启动时间，系统已运行 ${formatUptime(uptime)}`);
        } else {
          startupTime = Date.now();
          fs.writeFileSync(STARTUP_TIME_FILE, String(startupTime));
          fastify.log.info('启动时间文件内容无效，已创建新的启动时间记录');
        }
      } catch (error) {
        startupTime = Date.now();
        fs.writeFileSync(STARTUP_TIME_FILE, String(startupTime));
        fastify.log.warn('读取启动时间文件失败，已创建新的启动时间记录');
      }
    } else {
      // 文件不存在，创建新的
      startupTime = Date.now();
      fs.writeFileSync(STARTUP_TIME_FILE, String(startupTime));
      fastify.log.info('创建启动时间文件');
    }

    // 检查密码是否已经找到
    const foundPasswordFile = path.join(__dirname, 'found_password.txt');
    if (fs.existsSync(foundPasswordFile)) {
      passwordFound = true;
      fastify.log.info('🎉 检测到密码已经找到，设置为已找到状态');
      console.log('🎉 Password already found! Check found_password.txt for details.');
    }

    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server listening on ${HOST}:${PORT}`);
  } catch (error) {
    fastify.log.error(error, 'Fatal error during startup');
    process.exit(1);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));

process.on('SIGTERM', () => handleShutdown('SIGTERM'));

main();
