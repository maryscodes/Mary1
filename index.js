const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 5000;

// Environment variables (recommended)
const APP_ID = process.env.APP_ID || 'cli_a76cdc37ebf9900c';
const APP_SECRET = process.env.APP_SECRET || 'oRXRWCjyt5EUKx5RNGltmeSOODjaxe7b';
const OPEN_CHAT_ID = process.env.OPEN_CHAT_ID || 'oc_a19d2b2771fecbc58d1bf440550d942f';

// Use a single token management system
let tokenManager = {
    token: null,
    expiryTime: null,
    async ensure() {
        if (!this.token || Date.now() >= this.expiryTime) {
            try {
                const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
                    app_id: APP_ID,
                    app_secret: APP_SECRET
                });

                if (response.data?.tenant_access_token) {
                    this.token = response.data.tenant_access_token;
                    this.expiryTime = Date.now() + (response.data.expire * 1000) - 30000;
                    return true;
                }
                return false;
            } catch (error) {
                console.error('Token error:', error.message);
                return false;
            }
        }
        return true;
    }
};

// Configure multer with file size limits
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 1,
        parts: 2,
        fieldSize: 512 * 1024, // 512KB limit for text fields
    },
    fileFilter: (req, file, cb) => {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
            return cb(new Error('Only image files are allowed!'));
        }
        cb(null, true);
    }
});

app.use(express.json({ limit: '1mb' }));
// Middleware to check login
const checkLogin = (req, res, next) => {
    if (req.path === '/' || req.path === '/login.html') {
        next();
    } else {
        next();  // In production, implement proper session check
    }
};

app.use(checkLogin);
app.use(express.static('attached_assets'));

// Routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/form', (req, res) => {
    res.sendFile(path.join(__dirname, 'attached_assets', 'index.html'));
});
app.use('/uploads', express.static('uploads', { maxAge: '1h' }));

// Rate limiting configuration
const rateLimit = {
    windowMs: 60000, // 1 minute
    maxRequests: 30,
    current: new Map()
};

// Message queue for throttling
const messageQueue = {
    queue: [],
    processing: false,
    batchSize: 5,
    batchTimeout: 2000,
    timer: null,

    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        
        try {
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0, this.batchSize);
                await Promise.all(batch.map(task => task().catch(console.error)));
                await new Promise(resolve => setTimeout(resolve, 200));
                
                // Force garbage collection between batches
                if (global.gc) global.gc();
            }
        } catch (error) {
            console.error('Batch processing error:', error);
        } finally {
            this.processing = false;
        }
    }
};

// Cleanup function to run periodically
setInterval(() => {
    // Clear rate limit data older than the window
    const now = Date.now();
    for (const [ip, times] of rateLimit.current.entries()) {
        const validTimes = times.filter(time => now - time < rateLimit.windowMs);
        if (validTimes.length === 0) {
            rateLimit.current.delete(ip);
        } else {
            rateLimit.current.set(ip, validTimes);
        }
    }
}, 60000);

async function logToGoogleSheets(data) {
    try {
        await axios.post('https://script.google.com/macros/s/AKfycbx5fV54P_VOYSBTozPPBOe7w0FCM4pN_yfPYkXMbsL4_GQ4Rn8omVp_N9ve2D-c75gk/exec', {
            timestamp: new Date().toISOString(),
            ...data
        });
    } catch (error) {
        console.error('Google Sheets logging error:', error);
    }
}

app.post('/sendMessage', upload.single('image'), async (req, res) => {
    try {
        // Rate limiting check
        const ip = req.ip;
        const now = Date.now();
        const userRequests = rateLimit.current.get(ip) || [];
        const validRequests = userRequests.filter(time => now - time < rateLimit.windowMs);
        
        if (validRequests.length >= rateLimit.maxRequests) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        
        validRequests.push(now);
        rateLimit.current.set(ip, validRequests);

        if (!(await tokenManager.ensure())) {
            return res.status(401).json({ error: 'Failed to obtain token' });
        }

        const { alias = 'Anonymous', message, video_id, link, reply_to, queue } = req.body;
        let messageText = `${alias}${reply_to?.trim() ? ` → @${reply_to}` : ''}: ${message}`;
        if (link) messageText += `\nLink: ${link}`;
        if (video_id) messageText += `\nVideo ID: ${video_id}`;
        if (queue?.trim()) messageText += `\nQueue: ${queue}`;

        const headers = {
            'Authorization': `Bearer ${tokenManager.token}`,
            'Content-Type': 'application/json'
        };

        // Queue the message sending
        messageQueue.queue.push(async () => {
            await axios.post(
                'https://open.feishu.cn/open-apis/message/v3/send',
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: 'text',
                    content: { text: messageText }
                },
                { headers }
            );
        });

        // Start processing queue if not already processing
        messageQueue.process();

        // Handle image if present
        if (req.file) {
            const formData = new FormData();
            formData.append('image_type', 'message');
            formData.append('image', fs.createReadStream(req.file.path));

            const imageResponse = await axios.post(
                'https://open.feishu.cn/open-apis/im/v1/images',
                formData,
                {
                    headers: {
                        'Authorization': `Bearer ${tokenManager.token}`,
                        ...formData.getHeaders()
                    }
                }
            );

            await axios.post(
                'https://open.feishu.cn/open-apis/message/v3/send',
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: 'image',
                    content: { image_key: imageResponse.data.data.image_key }
                },
                { headers }
            );

            // Cleanup uploaded file immediately after processing
            await fs.promises.unlink(req.file.path).catch(console.error);
            
            // Cleanup old files in uploads directory periodically
            const cleanupUploads = async () => {
                const files = await fs.promises.readdir('uploads');
                const now = Date.now();
                
                for (const file of files) {
                    try {
                        const filePath = `uploads/${file}`;
                        const stats = await fs.promises.stat(filePath);
                        // Remove files older than 1 hour
                        if (now - stats.mtime.getTime() > 3600000) {
                            await fs.promises.unlink(filePath);
                        }
                    } catch (error) {
                        console.error('Cleanup error:', error);
                    }
                }
            };
            
            // Schedule cleanup
            setTimeout(cleanupUploads, 0);
        }

        // Log to Google Sheets
        await logToGoogleSheets({
            timestamp: new Date().toISOString(),
            userEmail: req.body.userEmail,
            alias: req.body.alias || 'Anonymous',
            replyTo: req.body.reply_to,
            videoId: req.body.video_id,
            queue: req.body.queue,
            link: req.body.link,
            message: req.body.message,
            hasImage: !!req.file
        });

        res.status(200).json({ message: 'Message sent successfully!' });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
    tokenManager.ensure();
});