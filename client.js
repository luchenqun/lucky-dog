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

console.log(`Client started: ${CLIENT_ID}`);
console.log(`CPU cores: ${CPU_COUNT}, using workers: ${MAX_WORKERS}`);
console.log(`Server URL: ${SERVER_URL}`);

// Core decryption functions from lucky.js
function deriveKeyFromPassword(password, iterations = 1) {
  let key = Buffer.from(password, 'utf8');
  for (let i = 0; i < iterations; i++) {
    key = crypto.createHash('sha512').update(key).digest();
  }
  return key.subarray(0, 32);
}

function decryptMasterKey(encryptedMasterKey, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
    decipher.setAutoPadding(false);

    let decrypted = decipher.update(encryptedMasterKey);
    const final = decipher.final();
    decrypted = Buffer.concat([decrypted, final]);

    return decrypted.subarray(0, 32);
  } catch (error) {
    return null;
  }
}

function decryptPrivateKey(encryptedPrivateKey, masterKey, publicKeyBytes) {
  try {
    const iv = crypto.createHash('sha256').update(crypto.createHash('sha256').update(publicKeyBytes).digest()).digest().subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, iv);

    let decrypted = decipher.update(encryptedPrivateKey);
    const final = decipher.final();
    decrypted = Buffer.concat([decrypted, final]);

    return decrypted.subarray(0, 32);
  } catch (error) {
    return null;
  }
}

function validatePrivateKey(privateKey, expectedPublicKey) {
  try {
    const publicKey = secp256k1.publicKeyCreate(privateKey, false);
    return Buffer.compare(publicKey, expectedPublicKey) === 0;
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

  console.log(`Worker ${workerIndex} processing ${passwords.length} passwords`);

  const encryptedMasterKeyBuffer = Buffer.from(encrypt.mkey, 'hex');
  const encryptedPrivateKeyBuffer = Buffer.from(encrypt.encrypted_privkey, 'hex');
  const publicKeyBuffer = Buffer.from(encrypt.pubkey, 'hex');

  let found = false;
  let checkedCount = 0;

  for (const password of passwords) {
    if (found) break;

    try {
      // Try different iteration counts
      for (const iterations of [1, 10, 100, 1000, 10000]) {
        const key = deriveKeyFromPassword(password, iterations);
        const masterKey = decryptMasterKey(encryptedMasterKeyBuffer, key);

        if (masterKey) {
          const privateKey = decryptPrivateKey(encryptedPrivateKeyBuffer, masterKey, publicKeyBuffer);

          if (privateKey && validatePrivateKey(privateKey, publicKeyBuffer)) {
            console.log(`PASSWORD FOUND! Worker ${workerIndex}: ${password} (iterations: ${iterations})`);
            found = true;
            parentPort.postMessage({
              success: true,
              password,
              iterations,
              checkedCount: checkedCount + 1,
            });
            break;
          }
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

          if (result.success) {
            console.log('Password successfully reported to server');
            return true;
          }
        } catch (error) {
          console.error(`Failed to report password (retry ${retryCount + 1}/${maxRetries}):`, error.message);
        }

        retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
      }

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
              iterations: result.value.iterations,
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

      // If password was found before, continue reporting
      if (this.foundPassword) {
        setInterval(() => {
          this.reportFoundPassword(this.foundPassword);
        }, 30000); // Report every 30 seconds
      }

      while (this.running) {
        try {
          // Request work
          console.log('Requesting new work...');
          const workRequest = await this.requestWork();

          if (!workRequest || !workRequest.success) {
            if (workRequest && workRequest.message) {
              console.log(`Info: ${workRequest.message}`);
            }
            console.log('Waiting 10 seconds before retry...');
            await new Promise((resolve) => setTimeout(resolve, 10000));
            continue;
          }

          const { passwords, encrypt, batchId } = workRequest;
          console.log(`Received ${passwords.length} passwords to check`);

          // Process passwords
          const result = await this.processPasswords(passwords, encrypt, batchId);

          if (result.success) {
            // Password found!
            this.foundPassword = result.password;
            console.log(`*** PASSWORD FOUND: ${result.password} ***`);

            // Save to local file
            await this.saveFoundPassword(result.password);

            // Report to server
            await this.submitResult(batchId, true, result.password, passwords);
            await this.reportFoundPassword(result.password);

            // Set up continuous reporting
            setInterval(() => {
              this.reportFoundPassword(result.password);
            }, 30000);

            console.log('Continuing work in case other clients are also searching...');
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
