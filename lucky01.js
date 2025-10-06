const path = require('path');
const { insertToDb, closeDb } = require('./db');

const scriptName = path.basename(__filename, '.js'); // 根据脚本文件名生成数据库名 lucky01.db
const dbName = `${scriptName}.db`;

// 提供的密码
const originPasswords = [
  'ljy951018',
  'Ljy951018',
  'zq940923',
  'Jy7433258',
  'qwe3344521',
  'Jay973188',
  'Zq940923',
  'L657395Zq', // 这里有个不是首字母大写
  'L657395jy',
  'Ljy657395',
  'Ljy5201314',
  'Qwe147258369',
];

let totalInserted = 0;

function main() {
  const specialItems = ['l*Zq', 'L*Zq']; // 用户提供了有个不是首字母大写的

  let items = originPasswords.map((pwd) => pwd.toLowerCase()); // 转换为小写
  items = items.map((pwd) => pwd.replace(/(\d+)/g, '*')); // 把连起来的数字用*代替
  items = [...new Set(items)]; //去重复
  // 密码一般习惯第一个字母大写
  items = [...items, ...items.map((pwd) => pwd.charAt(0).toUpperCase() + pwd.slice(1)), ...specialItems];
  items = [...new Set(items)].sort(); // 再去重，防止重复
  console.log(items);

  const minDigits = 5; // 有些有3个字母，填充5个数字字符，一共8位
  // 矿工回忆大概是9位密码，最少有2个字母，我们填充7个数字字符，一共至少9位。如果填充8位，则现有计算资源不够了
  // 填充7位，大概需要411天
  // 填充8位，大概需要4110天
  const maxDigits = 7;

  // 先预估一下总数量
  let estimateTotal = 0;
  let actualTotal = 0;
  for (let digits = minDigits; digits <= maxDigits; digits++) {
    const minNum = 0;
    const maxNum = parseInt('9'.repeat(digits));
    estimateTotal += maxNum - minNum + 1;
  }
  estimateTotal = estimateTotal * items.length;

  let passwords = [];
  for (const item of items) {
    console.log('\n\n开始生成', item);
    console.time(`生成${item}耗时`);
    for (let digits = minDigits; digits <= maxDigits; digits++) {
      const minNum = 0;
      const maxNum = parseInt('9'.repeat(digits));
      for (let num = minNum; num <= maxNum; num++) {
        const numStr = num.toString().padStart(digits, '0');
        const password = item.replace('*', numStr);
        passwords.push(password);
      }
    }
    actualTotal += passwords.length;
    console.timeEnd(`生成${item}耗时`);

    console.time(`插入${passwords.length}条密码到数据库耗时`);
    const inserted = insertToDb(dbName, passwords);
    totalInserted += inserted;
    console.timeEnd(`插入${passwords.length}条密码到数据库耗时`);

    passwords = [];
  }

  console.log('\n预估总数量', estimateTotal, '条密码');
  console.log('实际总计生成', actualTotal, '条密码');
  console.log('实际插入到数据库', totalInserted, '条密码记录');

  // 关闭数据库连接
  closeDb(dbName);
}

main();
