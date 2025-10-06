require('dotenv').config();

const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_NAME = process.env.DB_NAME || 'lucky.db';
const DB_PATH = path.join(__dirname, 'data', DB_NAME);
const INDEX_PATH = path.join(__dirname, 'index.html');

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
    },
  },
  'Loaded environment configuration',
);

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
      // 找到密码了！
      fastify.log.info(`🎉 密码找到了！客户端 ${clientId} 找到密码: ${foundPassword}`);

      // 保存结果到文件
      const resultFile = path.join(__dirname, 'found_password.txt');
      const result = `找到密码: ${foundPassword}\n时间: ${new Date().toISOString()}\n客户端: ${clientId}\n`;
      await fs.promises.appendFile(resultFile, result);

      // 可以选择停止所有工作或继续
      return {
        success: true,
        message: 'Password found! Great job!',
        shouldStop: true,
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
    fastify.log.info(`🎉🎉🎉 密码确认找到！客户端 ${clientId}: ${password}`);

    // 保存到文件
    const resultFile = path.join(__dirname, 'found_password.txt');
    const result = `确认找到密码: ${password}\n时间: ${new Date().toISOString()}\n客户端: ${clientId}\n重复确认: 是\n\n`;
    await fs.promises.appendFile(resultFile, result);

    return {
      success: true,
      message: 'Password confirmed and saved',
    };
  } catch (error) {
    fastify.log.error('保存找到的密码时出错:', error);
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
fastify.get('/work/stats', async (request, reply) => {
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

    return summary;
  } catch (error) {
    fastify.log.error('获取统计信息时出错:', error);
    reply.code(500);
    return { error: 'Internal server error' };
  }
});

// 定时任务：每10分钟自动重置超时状态
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
  10 * 60 * 1000,
); // 10分钟

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
