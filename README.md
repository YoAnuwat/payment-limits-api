# Payment Limits Management System

ระบบจัดการ Payment Limits พร้อม Dashboard UI ในตัว

## Features

- จัดการ Payment Limits (เพิ่ม, แก้ไข, ลบ)
- ระบบ Login/Logout
- รองรับ Local Storage หรือ AWS S3
- Dashboard UI ในตัว (ไม่ต้องติดตั้ง Frontend แยก)

## Project Structure

```
payment-limits/
├── backend-s3-upload.js    # Main server (Express.js)
├── public/
│   ├── index.html          # หน้า Login
│   └── dashboard.html      # หน้า Dashboard จัดการ Payment Limits
├── .local-storage/         # โฟลเดอร์เก็บข้อมูล (Local mode)
│   └── paymentLimitsCTM.json
├── .env                    # Environment variables
├── .env.example            # ตัวอย่าง Environment variables
├── package.json            # Dependencies
├── render.yaml             # Config สำหรับ Deploy บน Render
├── railway.toml            # Config สำหรับ Deploy บน Railway
└── README.md
```

## การติดตั้ง

### 1. ติดตั้ง Dependencies

```bash
npm install
```

### 2. ตั้งค่า Environment Variables

```bash
cp .env.example .env
```

แก้ไขไฟล์ `.env`:

```env
# Storage Mode: local หรือ s3 หรือ auto
STORAGE_MODE=local
LOCAL_STORAGE_DIR=.local-storage

# ถ้าใช้ S3 (optional)
# AWS_ACCESS_KEY_ID=your_access_key
# AWS_SECRET_ACCESS_KEY=your_secret_key
# AWS_REGION=ap-southeast-1
# S3_BUCKET_NAME=your-bucket-name

# Payment Limits Config
CURRENT_PAYMENT_LIMITS_KEY=paymentLimitsCTM.json
MAX_UPLOAD_SIZE_MB=5

# Admin Credentials
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme123

# Server
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### 3. รันเซิร์ฟเวอร์

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

### 4. เข้าใช้งาน

เปิด Browser ไปที่ `http://localhost:3001`

Login ด้วย:
- Username: `admin` (หรือตามที่ตั้งใน .env)
- Password: `changeme123` (หรือตามที่ตั้งใน .env)

## API Endpoints

### Authentication

#### POST /api/login
Login เข้าสู่ระบบ

```bash
curl -X POST http://localhost:3001/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme123"}'
```

**Response:**
```json
{
  "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "username": "admin"
}
```

#### POST /api/logout
Logout ออกจากระบบ

```bash
curl -X POST http://localhost:3001/api/logout \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Payment Limits

#### GET /api/get-payment-limits
ดึงข้อมูล Payment Limits ทั้งหมด

```bash
curl http://localhost:3001/api/get-payment-limits \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "paymentLimits": {
      "p2p": { "min": 100, "max": 200000 },
      "qr": { "min": 1, "max": 50000 }
    }
  }
}
```

#### POST /api/update-payment-limits
อัพเดท Payment Limits (เพิ่ม/แก้ไข/ลบ)

```bash
curl -X POST http://localhost:3001/api/update-payment-limits \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "data": {
      "paymentLimits": {
        "p2p": { "min": 100, "max": 200000 },
        "qr": { "min": 1, "max": 50000 },
        "newType": { "min": 500, "max": 100000 }
      }
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "อัพเดทข้อมูลสำเร็จ",
  "data": {
    "location": "file://.local-storage/paymentLimitsCTM.json",
    "key": "paymentLimitsCTM.json",
    "bucket": "local",
    "lastModified": "2026-04-28T13:30:00.000Z"
  }
}
```

### Health Check

#### GET /health
ตรวจสอบสถานะ Server

```bash
curl http://localhost:3001/health
```

**Response:**
```json
{
  "status": "ok",
  "service": "payment-limits-s3-backend",
  "storage": "local"
}
```

## Storage Modes

| Mode | คำอธิบาย |
|------|----------|
| `local` | เก็บข้อมูลในโฟลเดอร์ `.local-storage` |
| `s3` | เก็บข้อมูลใน AWS S3 (ต้องตั้งค่า AWS credentials) |
| `auto` | ใช้ S3 ถ้ามี AWS credentials, ไม่งั้นใช้ local |

## Deployment

### ใช้ PM2 (Production)

```bash
npm install -g pm2
pm2 start backend-s3-upload.js --name payment-limits-api
pm2 save
pm2 startup
```

### Docker (Optional)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

## Troubleshooting

| ปัญหา | วิธีแก้ |
|-------|--------|
| Connection refused | ตรวจสอบว่า Server รันอยู่ และ PORT ถูกต้อง |
| 401 Unauthorized | Token หมดอายุ หรือไม่ถูกต้อง ให้ Login ใหม่ |
| CORS error | เพิ่ม URL ใน `ALLOWED_ORIGINS` |

## License

MIT
