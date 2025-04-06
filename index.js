const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');

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
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static('attached_assets'));
app.use('/uploads', express.static('uploads', { maxAge: '1h' }));

app.post('/sendMessage', upload.single('image'), async (req, res) => {
    try {
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

            fs.unlink(req.file.path, () => {});
        }

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