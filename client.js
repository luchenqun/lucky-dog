const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Client configuration
const CLIENT_ID = `client-${os.hostname()}-${Date.now()}`;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const CPU_COUNT = os.cpus().length;
const MAX_WORKERS = Math.min(CPU_COUNT, parseInt(process.env.MAX_WORKERS || CPU_COUNT));

// console.log(`Client started: ${CLIENT_ID}`);
// console.log(`CPU cores: ${CPU_COUNT}, using workers: ${MAX_WORKERS}`);
// console.log(`Server URL: ${SERVER_URL}`);

// Core decryption functions from whale.js
function deriveKeyFromPassword(password, salt, iterations) {
  const vKeyData = Buffer.from(password, 'utf8');
  const vSalt = Buffer.from(salt, 'hex');
  let data = Buffer.concat([vKeyData, vSalt]);

  for (let i = 0; i < iterations; i++) {
    data = crypto.createHash('sha512').update(data).digest();
  }

  const derivedKey = data.slice(0, 32); // 前32字节作为密钥
  const iv = data.slice(32, 48); // 后16字节作为IV

  return { derivedKey, iv };
}

function decryptMasterKey(derivedKey, iv, encryptedKey) {
  try {
    const encryptedKeyBytes = Buffer.from(encryptedKey, 'hex');
    const cipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
    cipher.setAutoPadding(false);

    const decryptedMaster = Buffer.concat([cipher.update(encryptedKeyBytes), cipher.final()]);

    return decryptedMaster.slice(0, 32); // 只取前32字节
  } catch (error) {
    return null;
  }
}

function doublesha256(bytestring) {
  const firstHash = crypto.createHash('sha256').update(bytestring).digest();
  return crypto.createHash('sha256').update(firstHash).digest();
}

function decryptPrivateKey(masterKey, publicKeyBuf, encryptedPrivkey) {
  try {
    // 使用原始公钥的双重SHA256作为IV（2011年格式）
    const ivFull = doublesha256(publicKeyBuf);
    const iv = ivFull.slice(0, 16); // 只取前16字节作为IV

    // 使用AES-256-CBC解密私钥
    const encryptedPrivkeyBytes = Buffer.from(encryptedPrivkey, 'hex');
    const cipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);
    cipher.setAutoPadding(false);

    const decryptedPrivkey = Buffer.concat([cipher.update(encryptedPrivkeyBytes), cipher.final()]);

    return decryptedPrivkey.slice(0, 32); // 只取前32字节
  } catch (error) {
    return null;
  }
}

function validatePrivateKey(privateKey, expectedPublicKey) {
  try {
    // 检查私钥是否有效
    if (!secp256k1.privateKeyVerify(privateKey)) {
      return false;
    }

    // 使用secp256k1生成公钥，生成非压缩公钥（65字节，2011年格式）
    let generatedPublicKeyBuf = Buffer.alloc(65);
    secp256k1.publicKeyCreate(privateKey, false, generatedPublicKeyBuf);

    // 比较生成的公钥和期望的公钥
    return generatedPublicKeyBuf.equals(expectedPublicKey);
  } catch (error) {
    return false;
  }
}

// Worker thread function
function createWorker(passwords, encrypt, workerIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        passwords,
        encrypt,
        workerIndex,
        isWorker: true,
      },
    });

    worker.on('message', (result) => {
      resolve(result);
    });

    worker.on('error', (error) => {
      console.error(`Worker ${workerIndex} error:`, error);
      reject(error);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker ${workerIndex} exited with code: ${code}`));
      }
    });
  });
}

// Worker thread code
if (!isMainThread && workerData && workerData.isWorker) {
  const { passwords, encrypt, workerIndex } = workerData;

  // console.log(`Worker ${workerIndex} processing ${passwords.length} passwords`);

  // Validate encrypt data
  if (!encrypt || !encrypt.encrypted_key || !encrypt.encrypted_privkey || !encrypt.uncompressed_public_key || !encrypt.salt || !encrypt.derivationiterations) {
    console.error(`Worker ${workerIndex} error: Invalid encrypt data`, encrypt);
    parentPort.postMessage({
      success: false,
      error: 'Invalid encrypt data',
      checkedCount: 0,
    });
    process.exit(1);
  }

  const publicKeyBuffer = Buffer.from(encrypt.uncompressed_public_key, 'hex');

  let found = false;
  let checkedCount = 0;

  for (const password of passwords) {
    if (found) break;

    try {
      // Use the correct parameters from encrypt data
      const { derivedKey, iv } = deriveKeyFromPassword(password, encrypt.salt, encrypt.derivationiterations);
      const masterKey = decryptMasterKey(derivedKey, iv, encrypt.encrypted_key);

      if (masterKey) {
        const privateKey = decryptPrivateKey(masterKey, publicKeyBuffer, encrypt.encrypted_privkey);

        if (privateKey && validatePrivateKey(privateKey, publicKeyBuffer)) {
          console.log(`PASSWORD FOUND! Worker ${workerIndex}: ${password}`);
          found = true;
          parentPort.postMessage({
            success: true,
            password,
            checkedCount: checkedCount + 1,
          });
          break;
        }
      }
    } catch (error) {
      // Continue to next password
    }

    checkedCount++;

    // Report progress every 1000 passwords
    if (checkedCount % 1000 === 0) {
      console.log(`Worker ${workerIndex} checked ${checkedCount}/${passwords.length} passwords`);
    }
  }

  if (!found) {
    parentPort.postMessage({
      success: false,
      checkedCount,
    });
  }

  process.exit(0);
}

// Main thread logic
if (isMainThread) {
  class PasswordClient {
    constructor() {
      this.running = true;
      this.foundPassword = null;
      this.foundPasswordFile = path.join(__dirname, `found_password_${CLIENT_ID}.txt`);
    }

    async makeRequest(endpoint, method = 'GET', body = null) {
      const options = { method, headers: { 'Content-Type': 'application/json' } };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(`${SERVER_URL}${endpoint}`, options);
      return response.json();
    }

    async requestWork() {
      try {
        const result = await this.makeRequest('/work/request', 'POST', {
          cpuCount: CPU_COUNT,
          clientId: CLIENT_ID,
        });

        return result;
      } catch (error) {
        console.error('Error requesting work:', error.message);
        return null;
      }
    }

    async submitResult(batchId, success, foundPassword = null, passwords = []) {
      try {
        const result = await this.makeRequest('/work/result', 'POST', {
          batchId,
          success,
          foundPassword,
          passwords,
          clientId: CLIENT_ID,
        });

        return result;
      } catch (error) {
        console.error('Error submitting result:', error.message);
        return null;
      }
    }

    async reportFoundPassword(password) {
      const maxRetries = 5;
      let retryCount = 0;

      while (retryCount < maxRetries) {
        try {
          const result = await this.makeRequest('/work/found', 'POST', {
            password,
            clientId: CLIENT_ID,
          });

          if (result && result.success) {
            console.log('Password successfully reported to server');
            return true; // 成功报告，不需要再重试
          }
        } catch (error) {
          console.error(`Failed to report password (retry ${retryCount + 1}/${maxRetries}):`, error.message);
        }

        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
        }
      }

      console.error('Failed to report password after all retries');
      return false;
    }

    async processPasswords(passwords, encrypt, batchId) {
      if (passwords.length === 0) {
        return { success: false, checkedPasswords: [] };
      }

      console.log(`Processing ${passwords.length} passwords with ${MAX_WORKERS} workers`);

      // Distribute passwords to workers
      const passwordsPerWorker = Math.ceil(passwords.length / MAX_WORKERS);
      const workerPromises = [];

      for (let i = 0; i < MAX_WORKERS; i++) {
        const start = i * passwordsPerWorker;
        const end = Math.min(start + passwordsPerWorker, passwords.length);
        const workerPasswords = passwords.slice(start, end);

        if (workerPasswords.length > 0) {
          workerPromises.push(createWorker(workerPasswords, encrypt, i));
        }
      }

      try {
        const results = await Promise.allSettled(workerPromises);

        // Check if any worker found the password
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.success) {
            return {
              success: true,
              password: result.value.password,
            };
          }
        }

        // No password found
        return {
          success: false,
          checkedPasswords: passwords,
        };
      } catch (error) {
        console.error('Error processing passwords:', error);
        return {
          success: false,
          checkedPasswords: passwords,
        };
      }
    }

    async saveFoundPassword(password) {
      const content = `Found password: ${password}\nTime: ${new Date().toISOString()}\nClient: ${CLIENT_ID}\n\n`;
      await fs.promises.appendFile(this.foundPasswordFile, content);
      console.log(`Password saved to: ${this.foundPasswordFile}`);
    }

    async run() {
      console.log('Client starting...');

      while (this.running) {
        try {
          // Request work
          console.log('Requesting new work...');
          const workRequest = await this.requestWork();

          if (!workRequest || !workRequest.success) {
            if (workRequest && workRequest.message) {
              console.log(`Info: ${workRequest.message}`);
            }

            // 如果服务器告知密码已找到，停止客户端
            if (workRequest && workRequest.passwordFound) {
              console.log('*** PASSWORD ALREADY FOUND BY ANOTHER CLIENT ***');
              console.log('Stopping client...');
              this.stop();
              return;
            }

            console.log('Waiting 10 seconds before retry...');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            continue;
          }

          const { passwords, encrypt, batchId } = workRequest;
          console.log(`Received ${passwords.length} passwords to check`);

          // Validate encrypt data
          if (
            !encrypt ||
            !encrypt.encrypted_key ||
            !encrypt.encrypted_privkey ||
            !encrypt.uncompressed_public_key ||
            !encrypt.salt ||
            !encrypt.derivationiterations
          ) {
            console.error('Invalid encrypt data received from server:', encrypt);
            console.log('Waiting 10 seconds before retry...');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            continue;
          }

          // Process passwords
          const result = await this.processPasswords(passwords, encrypt, batchId);

          if (result.success) {
            // Password found!
            this.foundPassword = result.password;
            console.log(`*** PASSWORD FOUND: ${result.password} ***`);

            // Save to local file
            await this.saveFoundPassword(result.password);

            // Report to server
            const submitResponse = await this.submitResult(batchId, true, result.password, passwords);

            // Check if server tells us to stop
            if (submitResponse && submitResponse.shouldStop) {
              console.log('Server confirmed password found, stopping client...');
              this.stop();
              return;
            }

            // Try to report the found password
            const reportSuccess = await this.reportFoundPassword(result.password);

            if (reportSuccess) {
              console.log('Password successfully reported, stopping client...');
              this.stop();
              return;
            } else {
              console.log('Failed to report password, will retry periodically...');
              // Set up periodic retry if initial report failed
              let reportCount = 0;
              const reportInterval = setInterval(async () => {
                const retrySuccess = await this.reportFoundPassword(result.password);
                reportCount++;

                if (retrySuccess || reportCount >= 3) {
                  clearInterval(reportInterval);
                  if (retrySuccess) {
                    console.log('Password finally reported successfully, stopping client...');
                  } else {
                    console.log('Failed to report password after multiple attempts, stopping client...');
                  }
                  this.stop();
                }
              }, 10000); // Retry every 10 seconds
            }
          } else {
            // No password found, report results
            console.log(`No password found, checked ${result.checkedPasswords.length} passwords`);
            await this.submitResult(batchId, false, null, result.checkedPasswords);
          }
        } catch (error) {
          console.error('Runtime error:', error);
          console.log('Waiting 10 seconds before retry...');
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
      }
    }

    stop() {
      console.log('Stopping client...');
      this.running = false;
    }
  }

  // Create and run client
  const client = new PasswordClient();

  // Graceful shutdown handling
  process.on('SIGINT', () => {
    console.log('\nReceived exit signal...');
    client.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nReceived termination signal...');
    client.stop();
    process.exit(0);
  });

  // Start running
  client.run().catch((error) => {
    console.error('Client failed to run:', error);
    process.exit(1);
  });
}
