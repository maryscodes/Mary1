const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Environment variables (recommended)
const APP_ID = process.env.APP_ID || 'cli_a76cdc37ebf9900c';
const APP_SECRET = process.env.APP_SECRET || 'oRXRWCjyt5EUKx5RNGltmeSOODjaxe7b';
const OPEN_CHAT_ID = process.env.OPEN_CHAT_ID || 'oc_a19d2b2771fecbc58d1bf440550d942f';

let tenantAccessToken = null;
let tokenExpiryTime = null;

// Correct function to get tenant access token
async function getTenantAccessToken() {
    try {
        const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            app_id: APP_ID,
            app_secret: APP_SECRET
        });

        if (response.data && response.data.tenant_access_token) {
            tenantAccessToken = response.data.tenant_access_token;
            tokenExpiryTime = Date.now() + (response.data.expire * 1000) - 30000; // 30s buffer
            console.log('Token renewed successfully. Expires at:', new Date(tokenExpiryTime));
            return true;
        }
        console.error('Failed to retrieve token:', response.data);
        return false;
    } catch (error) {
        console.error('Error obtaining token:', error.response?.data || error.message);
        return false;
    }
}

// Middleware to ensure valid token
async function ensureValidToken() {
    if (!tenantAccessToken || Date.now() >= tokenExpiryTime) {
        await getTenantAccessToken();
    }
}

app.use(express.json());
app.use(express.static('public'));

app.post('/sendMessage', async (req, res) => {
    try {
        await ensureValidToken();
        
        const { alias, message, video_id, link } = req.body;
        const senderAlias = alias || 'Anonymous';
        
        let messageText = `${senderAlias}: ${message}`;
        if (link) messageText += `\nLink: ${link}`;
        if (video_id) messageText += `\nVideo ID: ${video_id}`;

        const response = await axios.post(
            'https://open.feishu.cn/open-apis/message/v3/send', // Using v3 endpoint
            {
                open_chat_id: OPEN_CHAT_ID, // Changed to open_chat_id
                msg_type: 'text',
                content: {
                    text: messageText // No need to stringify for v4
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${tenantAccessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json({ 
            message: 'Message sent successfully!',
            data: response.data
        });
    } catch (error) {
        console.error('Full error details:', {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            config: error.config?.data // Shows the exact payload sent
        });
        
        if (error.response?.status === 401) {
            await getTenantAccessToken();
            return res.status(401).json({ 
                error: 'Token expired',
                message: 'Please try again'
            });
        }
        
        res.status(500).json({
            error: 'Failed to send message',
            details: error.response?.data || error.message
        });
    }
});

app.listen(port, () => {
    console.log(`App running on port ${port}`);
    getTenantAccessToken();
});