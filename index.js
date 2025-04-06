const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 5000;

// Environment variables
const APP_ID = process.env.APP_ID || 'cli_a76cdc37ebf9900c';
const APP_SECRET = process.env.APP_SECRET || 'oRXRWCjyt5EUKx5RNGltmeSOODjaxe7b';
const OPEN_CHAT_ID = process.env.OPEN_CHAT_ID || 'oc_a19d2b2771fecbc58d1bf440550d942f';
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbx5fV54P_VOYSBTozPPBOe7w0FCM4pN_yfPYkXMbsL4_GQ4Rn8omVp_N9ve2D-c75gk/exec';

// Token management
const tokenManager = {
    token: null,
    expiryTime: null,
    async ensure() {
        if (!this.token || Date.now() >= this.expiryTime) {
            try {
                const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
                    app_id: APP_ID,
                    app_secret: APP_SECRET
                });

                if (response.data?.code !== 0) {
                    throw new Error(response.data?.msg || 'Failed to get token');
                }

                this.token = response.data.tenant_access_token;
                this.expiryTime = Date.now() + (response.data.expire * 1000) - 30000;
                return true;
            } catch (error) {
                console.error('Token error:', error.message);
                return false;
            }
        }
        return true;
    }
};

// Configure multer
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
}).single('image');

app.use(express.static('attached_assets'));
app.use('/uploads', express.static('uploads', { maxAge: '1h' }));

// Rate limiting
const rateLimit = {
    windowMs: 60000,
    maxRequests: 30,
    current: new Map()
};

// Routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/form', (req, res) => {
    res.sendFile(path.join(__dirname, 'attached_assets', 'index.html'));
});

app.post('/sendMessage', async (req, res) => {
    upload(req, res, async (err) => {
        try {
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ error: `Upload error: ${err.message}` });
            } else if (err) {
                return res.status(400).json({ error: err.message });
            }

            // Validate required fields
            if (!req.body.message?.trim()) {
                return res.status(400).json({ error: 'Message is required' });
            }

            // Rate limiting
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

            const messageText = formatMessage(req.body);
            const headers = {
                'Authorization': `Bearer ${tokenManager.token}`,
                'Content-Type': 'application/json'
            };

            // Send text message
            await axios.post(
                'https://open.feishu.cn/open-apis/message/v3/send',
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: 'text',
                    content: { text: messageText }
                },
                { headers }
            );

            // Handle image if present
            if (req.file) {
                try {
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

                    if (imageResponse.data?.code === 0) {
                        await axios.post(
                            'https://open.feishu.cn/open-apis/message/v3/send',
                            {
                                open_chat_id: OPEN_CHAT_ID,
                                msg_type: 'image',
                                content: { image_key: imageResponse.data.data.image_key }
                            },
                            { headers }
                        );
                    }
                } finally {
                    // Clean up uploaded file
                    fs.unlink(req.file.path, (err) => {
                        if (err) console.error('File cleanup error:', err);
                    });
                }
            }

            // Log to Google Sheets
            try {
                const sheetsData = {
                    timestamp: new Date().toISOString(),
                    userEmail: req.body.userEmail,
                    alias: req.body.alias || 'Anonymous',
                    replyTo: req.body.reply_to,
                    videoId: req.body.video_id,
                    queue: req.body.queue,
                    link: req.body.link,
                    message: req.body.message,
                    hasImage: !!req.file
                };

                await axios({
                    method: 'post',
                    url: SHEETS_URL,
                    data: new URLSearchParams(sheetsData).toString(),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
            } catch (error) {
                console.error('Google Sheets logging error:', error.response?.data || error.message);
                // Don't fail the request if sheets logging fails
            }

            res.status(200).json({ message: 'Message sent successfully!' });
        } catch (error) {
            console.error('Error:', error);
            res.status(error.response?.status || 500).json({
                error: error.response?.data?.msg || error.message || 'Failed to send message'
            });
        }
    });
});

// Helper function to format message
function formatMessage(body) {
    let text = `${body.alias || 'Anonymous'}${body.reply_to ? ` → @${body.reply_to}` : ''}: ${body.message}`;
    if (body.link) text += `\nLink: ${body.link}`;
    if (body.video_id) text += `\nVideo ID: ${body.video_id}`;
    if (body.queue) text += `\nQueue: ${body.queue}`;
    return text;
}

// Cleanup old files periodically
setInterval(async () => {
    try {
        const files = await fs.promises.readdir('uploads');
        const now = Date.now();

        for (const file of files) {
            try {
                const filePath = path.join('uploads', file);
                const stats = await fs.promises.stat(filePath);
                if (now - stats.mtime.getTime() > 3600000) {
                    await fs.promises.unlink(filePath);
                }
            } catch (error) {
                console.error('File cleanup error:', error);
            }
        }
    } catch (error) {
        console.error('Directory cleanup error:', error);
    }
}, 3600000);

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
    tokenManager.ensure();
});