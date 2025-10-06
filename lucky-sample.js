const path = require('path');
const crypto = require('crypto');
const { insertToDb, closeDb } = require('./db');

const scriptName = path.basename(__filename, '.js'); // 根据脚本文件名生成数据库名
const dbName = `${scriptName}.db`;

let totalInserted = 0;

function generateRandomAsciiLetters(length = 10) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    const idx = crypto.randomInt(0, alphabet.length);
    result += alphabet[idx];
  }
  return result;
}

function main() {
  let passwords = [];
  const total = 5000;
  console.log('开始生成');
  console.time(`生成${total}条密码耗时`);
  for (let i = 0; i < total; i++) {
    const password = generateRandomAsciiLetters(10);
    passwords.push(password);
  }
  passwords.push('l00088zq'); // 插入正确密码，方便测试
  console.timeEnd(`生成${total}条密码耗时`);

  console.time(`插入${passwords.length}条密码到数据库耗时`);
  const inserted = insertToDb(dbName, passwords);
  totalInserted += inserted;
  console.timeEnd(`插入${passwords.length}条密码到数据库耗时`);

  console.log('实际总计生成', passwords.length, '条密码');
  console.log('实际插入到数据库', totalInserted, '条密码记录');

  // 关闭数据库连接
  closeDb(dbName);
}

main();
