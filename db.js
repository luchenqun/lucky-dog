const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const BATCH_SIZE = 10_000;

const STATUS = {
  UNCHECK: 0,
  CHECKING: 1,
  CHECKED: 2,
};

const CREATE_RECORDS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pwd TEXT NOT NULL UNIQUE,
    status INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// 数据库连接缓存
const dbConnections = new Map();

/**
 * 获取或创建数据库连接
 * @param {string} dbName - 数据库文件名
 * @returns {Database} 数据库连接实例
 */
function getDbConnection(dbName) {
  if (!dbConnections.has(dbName)) {
    const dataDir = path.join(__dirname, 'data');
    // 确保 data 目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, dbName);
    const db = new Database(dbPath);

    // 确保表结构存在
    db.exec(CREATE_RECORDS_TABLE_SQL);

    dbConnections.set(dbName, db);
    console.log(`数据库连接已创建: ${dbName}`);
  }

  return dbConnections.get(dbName);
}

/**
 * 插入密码数据到数据库
 * @param {string} dbName - 数据库文件名
 * @param {string[]} passwords - 密码数组
 * @param {Object} options - 可选配置
 * @param {number} options.batchSize - 批处理大小，默认10000
 * @param {boolean} options.showProgress - 是否显示进度，默认true
 * @returns {number} 成功插入的记录数
 */
function insertToDb(dbName, passwords, options = {}) {
  const { batchSize = BATCH_SIZE, showProgress = true } = options;

  if (!dbName || typeof dbName !== 'string') {
    throw new Error('数据库名称必须是非空字符串');
  }

  if (!Array.isArray(passwords)) {
    throw new Error('密码数据必须是数组');
  }

  if (passwords.length === 0) {
    console.log('没有数据需要插入');
    return 0;
  }

  const db = getDbConnection(dbName);

  // 预编译语句
  const insertStmt = db.prepare('INSERT OR IGNORE INTO records (pwd, status) VALUES (?, ?)');
  const insertMany = db.transaction((batch) => {
    let insertedCount = 0;
    for (const password of batch) {
      if (typeof password === 'string' && password.trim()) {
        const result = insertStmt.run(password.trim(), STATUS.UNCHECK);
        if (result.changes > 0) {
          insertedCount++;
        }
      }
    }
    return insertedCount;
  });

  let totalInserted = 0;
  let processed = 0;

  if (showProgress) {
    console.log(`开始插入 ${passwords.length.toLocaleString()} 条记录到 ${dbName}`);
  }

  try {
    while (processed < passwords.length) {
      const batch = passwords.slice(processed, processed + batchSize);
      const insertedInBatch = insertMany(batch);

      totalInserted += insertedInBatch;
      processed += batch.length;

      // 显示进度
      if (showProgress && (processed % 1000000 === 0 || processed === passwords.length)) {
        console.log(`已处理 ${processed.toLocaleString()}/${passwords.length.toLocaleString()} 条记录，成功插入 ${totalInserted.toLocaleString()} 条`);
      }
    }

    if (showProgress) {
      console.log(`插入完成: ${totalInserted.toLocaleString()} 条记录成功插入到 ${dbName}`);
    }

    return totalInserted;
  } catch (error) {
    console.error(`数据库插入失败 (${dbName}):`, error);
    throw error;
  }
}

/**
 * 获取数据库中的记录数量
 * @param {string} dbName - 数据库文件名
 * @returns {number} 记录数量
 */
function getRecordCount(dbName) {
  const db = getDbConnection(dbName);
  const countStmt = db.prepare('SELECT COUNT(*) AS count FROM records');
  const result = countStmt.get();
  return result.count;
}

/**
 * 关闭指定数据库连接
 * @param {string} dbName - 数据库文件名
 */
function closeDb(dbName) {
  if (dbConnections.has(dbName)) {
    try {
      const db = dbConnections.get(dbName);
      db.close();
      dbConnections.delete(dbName);
      console.log(`数据库连接已关闭: ${dbName}`);
    } catch (error) {
      console.error(`关闭数据库连接时出错 (${dbName}):`, error);
    }
  }
}

/**
 * 关闭所有数据库连接
 */
function closeAllDbs() {
  const dbNames = Array.from(dbConnections.keys());
  for (const dbName of dbNames) {
    closeDb(dbName);
  }
}

/**
 * 清空数据库中的所有记录
 * @param {string} dbName - 数据库文件名
 * @returns {number} 删除的记录数
 */
function clearDb(dbName) {
  const db = getDbConnection(dbName);
  const deleteStmt = db.prepare('DELETE FROM records');
  const result = deleteStmt.run();
  console.log(`已清空数据库 ${dbName}，删除了 ${result.changes} 条记录`);
  return result.changes;
}

module.exports = {
  insertToDb,
  getRecordCount,
  closeDb,
  closeAllDbs,
  clearDb,
  STATUS,
};
