const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const cors = require('cors');
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
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

// ===== CACHE CONFIGURATION =====
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 60) * 1000; // default 60 seconds
const cache = {
  data: null,
  expiresAt: 0,
  hits: 0,
  misses: 0
};

function getCachedData() {
  if (cache.data && Date.now() < cache.expiresAt) {
    cache.hits++;
    return cache.data;
  }
  cache.misses++;
  return null;
}

function setCachedData(data) {
  cache.data = data;
  cache.expiresAt = Date.now() + CACHE_TTL_MS;
}

function clearCache() {
  cache.data = null;
  cache.expiresAt = 0;
}

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
app.get('/paymentLimitsCTM.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  
  // Check cache first
  const cached = getCachedData();
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  
  res.setHeader('X-Cache', 'MISS');
  try {
    const data = await getObject(PAYMENT_LIMITS_KEY);
    const jsonData = JSON.parse(data.toString());
    setCachedData(jsonData); // Save to cache
    res.json(jsonData);
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      const emptyData = { paymentLimits: {} };
      setCachedData(emptyData);
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

    clearCache(); // Clear cache when data changes
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
    clearCache(); // Clear cache when data changes
    return { location: `postgres://payment_limits`, key, bucket: 'postgres' };
  }

  const outputPath = path.join(LOCAL_STORAGE_DIR, key);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const dataBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  await fs.promises.writeFile(outputPath, dataBuffer);

  clearCache(); // Clear cache when data changes
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

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomUUID();
    sessions.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });
    return res.json({ token, username });
  }
  res.status(401).json({ error: 'Username หรือ Password ไม่ถูกต้อง' });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  const storage = useS3 ? 's3' : usePostgres ? 'postgres' : 'local';
  const cacheActive = cache.data !== null && Date.now() < cache.expiresAt;
  const cacheTtlRemaining = cacheActive ? Math.round((cache.expiresAt - Date.now()) / 1000) : 0;
  
  res.json({
    status: 'ok',
    service: 'payment-limits-s3-backend',
    storage,
    cache: {
      enabled: true,
      ttlSeconds: CACHE_TTL_MS / 1000,
      active: cacheActive,
      ttlRemaining: cacheTtlRemaining,
      hits: cache.hits,
      misses: cache.misses,
      hitRate: cache.hits + cache.misses > 0 
        ? Math.round((cache.hits / (cache.hits + cache.misses)) * 100) + '%'
        : '0%'
    }
  });
});

// Clear cache endpoint (requires auth)
app.post('/api/clear-cache', requireAuth, (req, res) => {
  clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

// Endpoint สำหรับอัพโหลด JSON file
app.post('/api/upload-payment-limits', requireAuth, upload.single('file'), async (req, res) => {
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
app.post('/api/update-payment-limits', requireAuth, async (req, res) => {
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
app.get('/api/get-payment-limits', requireAuth, async (req, res) => {
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
