require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
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

fastify.get('/', async (_request, reply) => {
  const html = await fs.readFile(INDEX_PATH, 'utf8');
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

function handleShutdown(signal) {
  if (shuttingDown) {
    fastify.log.warn({ signal }, 'Shutdown already in progress; forcing exit.');
    process.exit(1);
  }
  shuttingDown = true;
  fastify.log.info({ signal }, 'Received shutdown signal. Closing services.');

  Promise.resolve()
    .then(() => fastify.close())
    .catch((error) => {
      fastify.log.error(error, 'Error while closing Fastify');
    })
    .finally(() => {
      try {
        db.close();
      } catch (error) {
        fastify.log.error(error, 'Error while closing database');
      }
      process.exit(0);
    });
}

async function main() {
  try {
    // 检查数据库文件是否存在
    try {
      await fs.access(DB_PATH);
    } catch (error) {
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
