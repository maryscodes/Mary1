
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const fs = require("fs");

const app = express();
const port = 5000;

// Environment variables
const APP_ID = process.env.APP_ID || "cli_a76cdc37ebf9900c";
const APP_SECRET = process.env.APP_SECRET || "oRXRWCjyt5EUKx5RNGltmeSOODjaxe7b";
const OPEN_CHAT_ID = process.env.OPEN_CHAT_ID || "oc_a19d2b2771fecbc58d1bf440550d942f";

let tenantAccessToken = null;
let tokenExpiryTime = null;

// Memory efficient file storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

// Add file size limits and cleanup old files
const upload = multer({ 
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 1
    }
});

// Cleanup old files (older than 1 hour)
function cleanupOldFiles() {
    const uploadsDir = './uploads';
    if (!fs.existsSync(uploadsDir)) return;
    
    fs.readdir(uploadsDir, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = `${uploadsDir}/${file}`;
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 3600000) { // 1 hour
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}

// Run cleanup every hour
setInterval(cleanupOldFiles, 3600000);

async function getTenantAccessToken() {
    try {
        const response = await axios.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            { app_id: APP_ID, app_secret: APP_SECRET }
        );

        if (response.data?.tenant_access_token) {
            tenantAccessToken = response.data.tenant_access_token;
            tokenExpiryTime = Date.now() + response.data.expire * 1000 - 30000;
            return true;
        }
        return false;
    } catch (error) {
        console.error("Token error:", error.message);
        return false;
    }
}

async function ensureValidToken() {
    if (!tenantAccessToken || Date.now() >= tokenExpiryTime) {
        await getTenantAccessToken();
    }
}

// Add request size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.static("attached_assets", { maxAge: '1h' }));
app.use("/uploads", express.static("uploads", { maxAge: '1h' }));

app.get("/", (req, res) => res.send("Bot is alive!"));

app.post("/sendMessage", upload.single("image"), async (req, res) => {
    try {
        await ensureValidToken();

        const { alias = "Anonymous", message, video_id, link, reply_to, queue } = req.body;
        let messageText = `${alias}${reply_to?.trim() ? ` → @${reply_to}` : ""}: ${message}`;
        if (link) messageText += `\nLink: ${link}`;
        if (video_id) messageText += `\nVideo ID: ${video_id}`;
        if (queue?.trim()) messageText += `\nQueue: ${queue}`;

        if (req.file) {
            const formData = new FormData();
            formData.append("image_type", "message");
            formData.append("image", fs.createReadStream(req.file.path));

            const imageResponse = await axios.post(
                "https://open.feishu.cn/open-apis/im/v1/images",
                formData,
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        ...formData.getHeaders(),
                    },
                }
            );

            await axios.post(
                "https://open.feishu.cn/open-apis/message/v3/send",
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: "text",
                    content: { text: messageText }
                },
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            await axios.post(
                "https://open.feishu.cn/open-apis/message/v3/send",
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: "image",
                    content: { image_key: imageResponse.data.data.image_key }
                },
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            fs.unlink(req.file.path, () => {});
        } else {
            await axios.post(
                "https://open.feishu.cn/open-apis/message/v3/send",
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: "text",
                    content: { text: messageText }
                },
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );
        }

        res.status(200).json({ message: "Message sent successfully!" });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        
        if (error.response?.status === 401) {
            await getTenantAccessToken();
            return res.status(401).json({ error: 'Token expired', message: 'Please try again' });
        }
        
        res.status(500).json({
            error: 'Failed to send message',
            message: error.message
        });
    }
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
    getTenantAccessToken();
});
