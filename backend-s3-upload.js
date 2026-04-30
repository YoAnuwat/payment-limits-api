const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 5);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const PAYMENT_LIMITS_KEY = process.env.CURRENT_PAYMENT_LIMITS_KEY || 'paymentLimitsCTM.json';
const PAYMENT_LIMITS_UPLOAD_PREFIX = process.env.PAYMENT_LIMITS_UPLOAD_PREFIX || 'payment-limits';
const STORAGE_MODE = (process.env.STORAGE_MODE || 'auto').toLowerCase();
const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '.local-storage');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

// ===== MULTI-USER CONFIGURATION =====
// Format: USERS=user1:password1,user2:password2 or use legacy ADMIN_USERNAME/ADMIN_PASSWORD
function parseUsers() {
  const users = new Map();
  
  // Parse USERS env variable (format: user1:pass1,user2:pass2)
  const usersEnv = process.env.USERS || '';
  if (usersEnv) {
    usersEnv.split(',').forEach(pair => {
      const [username, password] = pair.split(':').map(s => s.trim());
      if (username && password) {
        users.set(username, password);
      }
    });
  }
  
  // Fallback to legacy single admin user
  if (users.size === 0) {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    users.set(adminUser, adminPass);
  }
  
  return users;
}

const validUsers = parseUsers();

// ===== CACHE CONFIGURATION =====
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);
const CACHE_KEY = 'payment_limits_cache';
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

// Redis client (optional - falls back to in-memory if not configured)
let redis = null;
let useRedis = false;

if (REDIS_URL) {
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      lazyConnect: true
    });
    redis.on('error', (err) => {
      console.error('Redis error:', err.message);
      useRedis = false;
    });
    redis.on('connect', () => {
      console.log('Redis connected');
      useRedis = true;
    });
  } catch (err) {
    console.error('Redis init error:', err.message);
  }
}

// In-memory fallback cache
const memoryCache = {
  data: null,
  expiresAt: 0
};

// Cache stats
const cacheStats = {
  hits: 0,
  misses: 0,
  redisHits: 0,
  redisMisses: 0,
  memoryHits: 0,
  memoryMisses: 0
};

async function getCachedData() {
  // Try Redis first
  if (useRedis && redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        cacheStats.hits++;
        cacheStats.redisHits++;
        return JSON.parse(cached);
      }
      cacheStats.misses++;
      cacheStats.redisMisses++;
      return null;
    } catch (err) {
      console.error('Redis get error:', err.message);
    }
  }
  
  // Fallback to memory cache
  if (memoryCache.data && Date.now() < memoryCache.expiresAt) {
    cacheStats.hits++;
    cacheStats.memoryHits++;
    return memoryCache.data;
  }
  cacheStats.misses++;
  cacheStats.memoryMisses++;
  return null;
}

async function setCachedData(data) {
  // Set in Redis
  if (useRedis && redis) {
    try {
      await redis.setex(CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(data));
    } catch (err) {
      console.error('Redis set error:', err.message);
    }
  }
  
  // Always set in memory as fallback
  memoryCache.data = data;
  memoryCache.expiresAt = Date.now() + (CACHE_TTL_SECONDS * 1000);
}

async function clearCache() {
  // Clear Redis
  if (useRedis && redis) {
    try {
      await redis.del(CACHE_KEY);
    } catch (err) {
      console.error('Redis del error:', err.message);
    }
  }
  
  // Clear memory
  memoryCache.data = null;
  memoryCache.expiresAt = 0;
}

// ===== RATE LIMITING CONFIGURATION =====
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60) * 1000;
const RATE_LIMIT_MAX_PUBLIC = Number(process.env.RATE_LIMIT_MAX_PUBLIC || 100); // 100 req/min for public
const RATE_LIMIT_MAX_API = Number(process.env.RATE_LIMIT_MAX_API || 30); // 30 req/min for API
const RATE_LIMIT_MAX_LOGIN = Number(process.env.RATE_LIMIT_MAX_LOGIN || 5); // 5 req/min for login

// Rate limiter for public endpoints (generous)
const publicLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_PUBLIC,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown'
});

// Rate limiter for API endpoints (moderate)
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_API,
  message: { error: 'Too many API requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown'
});

// Rate limiter for login (strict - prevent brute force)
const loginLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_LOGIN,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown'
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES }
});

function hasRealValue(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return !/^your_/i.test(trimmed);
}

const hasAwsConfig =
  hasRealValue(process.env.AWS_ACCESS_KEY_ID) &&
  hasRealValue(process.env.AWS_SECRET_ACCESS_KEY) &&
  hasRealValue(process.env.S3_BUCKET_NAME);

const hasDatabaseUrl = hasRealValue(process.env.DATABASE_URL);

let useS3 = false;
let usePostgres = false;

if (STORAGE_MODE === 's3') {
  if (!hasAwsConfig) {
    throw new Error('STORAGE_MODE=s3 requires valid AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME');
  }
  useS3 = true;
} else if (STORAGE_MODE === 'postgres') {
  if (!hasDatabaseUrl) {
    throw new Error('STORAGE_MODE=postgres requires valid DATABASE_URL');
  }
  usePostgres = true;
} else if (STORAGE_MODE === 'local') {
  useS3 = false;
  usePostgres = false;
} else {
  // auto: postgres > s3 > local
  if (hasDatabaseUrl) {
    usePostgres = true;
  } else {
    useS3 = hasAwsConfig;
  }
}

let s3 = null;
let pool = null;

if (useS3) {
  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-southeast-1'
  });
  s3 = new AWS.S3();
} else if (usePostgres) {
  const isInternal = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isInternal ? false : { rejectUnauthorized: false }
  });
} else {
  fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

async function initDb() {
  if (!usePostgres) return;
  // Support row-based table structure: id, payment_method, min_amount, max_amount, updated_at
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_limits (
      id SERIAL PRIMARY KEY,
      payment_method TEXT UNIQUE NOT NULL,
      min_amount NUMERIC DEFAULT 0,
      max_amount NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add columns if they don't exist (for legacy tables)
  await pool.query(`
    ALTER TABLE payment_limits
      ADD COLUMN IF NOT EXISTS payment_method TEXT,
      ADD COLUMN IF NOT EXISTS min_amount NUMERIC DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_amount NUMERIC DEFAULT 0
  `).catch(() => {});
  // Create unique index on payment_method for upsert
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS payment_limits_method_unique ON payment_limits (payment_method)
  `).catch(() => {});
}

// Public JSON endpoint — no auth, open CORS (replaces CloudFront)
app.get('/paymentLimitsCTM.json', publicLimiter, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  
  // Check cache first
  const cached = await getCachedData();
  if (cached) {
    res.setHeader('X-Cache', useRedis ? 'HIT (Redis)' : 'HIT (Memory)');
    return res.json(cached);
  }
  
  res.setHeader('X-Cache', 'MISS');
  try {
    const data = await getObject(PAYMENT_LIMITS_KEY);
    const jsonData = JSON.parse(data.toString());
    await setCachedData(jsonData); // Save to cache
    res.json(jsonData);
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      const emptyData = { paymentLimits: {} };
      await setCachedData(emptyData);
      return res.json(emptyData);
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Middleware
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isJsonFile(file) {
  if (!file || !file.originalname) {
    return false;
  }
  return file.originalname.toLowerCase().endsWith('.json');
}

function parseJsonOrThrow(buffer) {
  const raw = buffer.toString();
  return JSON.parse(raw);
}

function sanitizeFileName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function uploadObject({ key, body, contentType = 'application/json' }) {
  if (useS3) {
    const result = await s3.upload({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
      ACL: 'private'
    }).promise();

    await clearCache(); // Clear cache when data changes
    return {
      location: result.Location,
      key: result.Key,
      bucket: result.Bucket
    };
  }

  if (usePostgres) {
    const dataStr = Buffer.isBuffer(body) ? body.toString() : String(body);
    const jsonData = JSON.parse(dataStr);
    const paymentLimits = jsonData.paymentLimits || {};

    // Get existing payment methods
    const existingResult = await pool.query('SELECT payment_method FROM payment_limits');
    const existingMethods = new Set(existingResult.rows.map(r => r.payment_method));
    const newMethods = new Set(Object.keys(paymentLimits));

    // Delete removed methods
    for (const method of existingMethods) {
      if (!newMethods.has(method)) {
        await pool.query('DELETE FROM payment_limits WHERE payment_method = $1', [method]);
      }
    }

    // Upsert each payment method as a row
    for (const [method, limits] of Object.entries(paymentLimits)) {
      const min = limits.min || 0;
      const max = limits.max || 0;
      await pool.query(
        `INSERT INTO payment_limits (payment_method, min_amount, max_amount, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (payment_method) DO UPDATE SET min_amount = $2, max_amount = $3, updated_at = NOW()`,
        [method, min, max]
      );
    }
    await clearCache(); // Clear cache when data changes
    return { location: `postgres://payment_limits`, key, bucket: 'postgres' };
  }

  const outputPath = path.join(LOCAL_STORAGE_DIR, key);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const dataBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  await fs.promises.writeFile(outputPath, dataBuffer);

  await clearCache(); // Clear cache when data changes
  return {
    location: `file://${outputPath}`,
    key,
    bucket: 'local'
  };
}

async function getObject(key) {
  if (useS3) {
    const result = await s3.getObject({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key
    }).promise();
    return result.Body;
  }

  if (usePostgres) {
    // Read from row-based table and convert to JSON format
    const result = await pool.query(
      'SELECT payment_method, min_amount, max_amount FROM payment_limits WHERE payment_method IS NOT NULL ORDER BY payment_method'
    );
    
    if (result.rows.length === 0) {
      const err = new Error('NoSuchKey');
      err.code = 'NoSuchKey';
      throw err;
    }

    // Convert rows to JSON format: { paymentLimits: { method: { min, max }, ... } }
    const paymentLimits = {};
    for (const row of result.rows) {
      paymentLimits[row.payment_method] = {
        min: Number(row.min_amount) || 0,
        max: Number(row.max_amount) || 0
      };
    }

    const jsonData = { paymentLimits };
    return Buffer.from(JSON.stringify(jsonData, null, 2));
  }

  const inputPath = path.join(LOCAL_STORAGE_DIR, key);
  try {
    return await fs.promises.readFile(inputPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.code = 'NoSuchKey';
      throw noSuchKeyError;
    }
    throw error;
  }
}

function validatePaymentLimitsData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'ข้อมูลต้องเป็น JSON object';
  }

  if (!data.paymentLimits || typeof data.paymentLimits !== 'object') {
    return 'โครงสร้างข้อมูลไม่ถูกต้อง: ไม่พบ paymentLimits';
  }

  return null;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  const session = sessions.get(token);
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
  req.username = session.username;
  next();
}

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  
  // Check if user exists and password matches
  if (username && validUsers.has(username) && validUsers.get(username) === password) {
    const token = crypto.randomUUID();
    sessions.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });
    return res.json({ token, username });
  }
  res.status(401).json({ error: 'Username หรือ Password ไม่ถูกต้อง' });
});

app.post('/api/logout', apiLimiter, (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ success: true });
});

app.get('/health', publicLimiter, (req, res) => {
  const storage = useS3 ? 's3' : usePostgres ? 'postgres' : 'local';
  const memoryCacheActive = memoryCache.data !== null && Date.now() < memoryCache.expiresAt;
  const cacheTtlRemaining = memoryCacheActive ? Math.round((memoryCache.expiresAt - Date.now()) / 1000) : 0;
  
  res.json({
    status: 'ok',
    service: 'payment-limits-s3-backend',
    storage,
    cache: {
      enabled: true,
      type: useRedis ? 'redis' : 'memory',
      redisConnected: useRedis,
      ttlSeconds: CACHE_TTL_SECONDS,
      memoryActive: memoryCacheActive,
      ttlRemaining: cacheTtlRemaining,
      stats: {
        totalHits: cacheStats.hits,
        totalMisses: cacheStats.misses,
        redisHits: cacheStats.redisHits,
        redisMisses: cacheStats.redisMisses,
        memoryHits: cacheStats.memoryHits,
        memoryMisses: cacheStats.memoryMisses,
        hitRate: cacheStats.hits + cacheStats.misses > 0 
          ? Math.round((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) + '%'
          : '0%'
      }
    },
    rateLimit: {
      enabled: true,
      windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
      limits: {
        public: RATE_LIMIT_MAX_PUBLIC,
        api: RATE_LIMIT_MAX_API,
        login: RATE_LIMIT_MAX_LOGIN
      }
    }
  });
});

// Clear cache endpoint (requires auth)
app.post('/api/clear-cache', apiLimiter, requireAuth, async (req, res) => {
  await clearCache();
  res.json({ success: true, message: 'Cache cleared (Redis: ' + useRedis + ')' });
});

// Endpoint สำหรับอัพโหลด JSON file
app.post('/api/upload-payment-limits', apiLimiter, requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ไม่พบไฟล์ที่อัพโหลด' });
    }

    if (!isJsonFile(req.file)) {
      return res.status(400).json({ error: 'กรุณาอัพโหลดไฟล์ .json เท่านั้น' });
    }

    try {
      parseJsonOrThrow(req.file.buffer);
    } catch (error) {
      return res.status(400).json({ error: 'ไฟล์ JSON ไม่ถูกต้อง' });
    }
    const safeOriginalName = sanitizeFileName(req.file.originalname);
    const fileName = `${PAYMENT_LIMITS_UPLOAD_PREFIX}/${Date.now()}_${safeOriginalName}`;
    const result = await uploadObject({
      key: fileName,
      body: req.file.buffer,
      contentType: 'application/json'
    });

    res.json({
      success: true,
      message: 'อัพโหลดสำเร็จ',
      data: {
        location: result.location,
        key: result.key,
        bucket: result.bucket
      }
    });

  } catch (error) {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: `ไฟล์ใหญ่เกินไป (สูงสุด ${MAX_UPLOAD_SIZE_MB} MB)`
      });
    }
    console.error('Error uploading:', error);
    res.status(500).json({
      error: 'เกิดข้อผิดพลาดในการอัพโหลด',
      details: error.message
    });
  }
});

// Endpoint สำหรับอัพเดทไฟล์เดิม (เขียนทับ)
app.post('/api/update-payment-limits', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'ไม่พบข้อมูลที่จะอัพเดท' });
    }

    const validationError = validatePaymentLimitsData(data);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const fileName = PAYMENT_LIMITS_KEY;
    const result = await uploadObject({
      key: fileName,
      body: JSON.stringify(data, null, 2),
      contentType: 'application/json'
    });

    res.json({
      success: true,
      message: 'อัพเดทข้อมูลสำเร็จ',
      data: {
        location: result.location,
        key: result.key,
        bucket: result.bucket,
        lastModified: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error updating:', error);
    res.status(500).json({
      error: 'เกิดข้อผิดพลาดในการอัพเดท',
      details: error.message
    });
  }
});

// Endpoint สำหรับดึงข้อมูล
app.get('/api/get-payment-limits', apiLimiter, requireAuth, async (req, res) => {
  try {
    const data = await getObject(PAYMENT_LIMITS_KEY);
    const jsonData = parseJsonOrThrow(data);

    res.json({
      success: true,
      data: jsonData
    });

  } catch (error) {
    if (error.code === 'NoSuchKey') {
      return res.json({
        success: true,
        data: { paymentLimits: {} }
      });
    }
    console.error('Error getting data:', error);
    res.status(500).json({
      error: 'เกิดข้อผิดพลาดในการดึงข้อมูล',
      details: error.message
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `ไฟล์ใหญ่เกินไป (สูงสุด ${MAX_UPLOAD_SIZE_MB} MB)`
    });
  }

  if (error && error.message === 'Origin is not allowed by CORS') {
    return res.status(403).json({ error: 'CORS blocked: origin not allowed' });
  }

  return next(error);
});

const PORT = process.env.PORT || 3001;

async function start() {
  await initDb();
  app.listen(PORT, () => {
    const storage = useS3 ? 's3' : usePostgres ? 'postgres' : 'local';
    console.log(`Server is running on port ${PORT} (storage: ${storage})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
