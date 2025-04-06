const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const fs = require("fs");

const app = express();
const port = 5000; // Recommended port for development

// Environment variables (recommended)
const APP_ID = process.env.APP_ID || "cli_a76cdc37ebf9900c";
const APP_SECRET = process.env.APP_SECRET || "oRXRWCjyt5EUKx5RNGltmeSOODjaxe7b";
const OPEN_CHAT_ID =
    process.env.OPEN_CHAT_ID || "oc_a19d2b2771fecbc58d1bf440550d942f";

let tenantAccessToken = null;
let tokenExpiryTime = null;

// Function to get tenant access token
async function getTenantAccessToken() {
    try {
        const response = await axios.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            {
                app_id: APP_ID,
                app_secret: APP_SECRET,
            },
        );

        if (response.data && response.data.tenant_access_token) {
            tenantAccessToken = response.data.tenant_access_token;
            tokenExpiryTime = Date.now() + response.data.expire * 1000 - 30000; // 30s buffer
            console.log(
                "Token renewed successfully. Expires at:",
                new Date(tokenExpiryTime),
            );
            return true;
        }
        console.error("Failed to retrieve token:", response.data);
        return false;
    } catch (error) {
        console.error(
            "Error obtaining token:",
            error.response?.data || error.message,
        );
        return false;
    }
}

// Middleware to ensure valid token
async function ensureValidToken() {
    if (!tenantAccessToken || Date.now() >= tokenExpiryTime) {
        await getTenantAccessToken();
    }
}

const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static("attached_assets"));
app.use("/uploads", express.static("uploads"));

// Endpoint to check if the bot is alive
app.get("/", (req, res) => res.send("Bot is alive!"));

app.post("/sendMessage", upload.single("image"), async (req, res) => {
    try {
        await ensureValidToken();

        const { alias, message, video_id, link } = req.body;
        const senderAlias = alias || "Anonymous";

        let messageText = `${senderAlias}${req.body.reply_to && req.body.reply_to.trim() ? ` → @${req.body.reply_to}` : ""}: ${message}`;
        if (link) messageText += `\nLink: ${link}`;
        if (video_id) messageText += `\nVideo ID: ${video_id}`;
        if (req.body.queue && req.body.queue.trim())
            messageText += `\nQueue: ${req.body.queue}`;

        let messagePayload;

        if (req.file) {
            // Upload image first
            const formData = new FormData();
            formData.append("image_type", "message");
            formData.append("image", fs.createReadStream(req.file.path), {
                filename: req.file.originalname || "image.png",
                contentType: req.file.mimetype || "image/png",
            });

            const imageResponse = await axios.post(
                "https://open.feishu.cn/open-apis/im/v1/images",
                formData,
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        ...formData.getHeaders(),
                    },
                },
            );

            const imageKey = imageResponse.data.data.image_key;

            messagePayload = {
                open_chat_id: OPEN_CHAT_ID,
                msg_type: "image",
                content: {
                    image_key: imageKey,
                },
            };

            // Send text message first
            await axios.post(
                "https://open.feishu.cn/open-apis/message/v3/send",
                {
                    open_chat_id: OPEN_CHAT_ID,
                    msg_type: "text",
                    content: {
                        text: messageText,
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${tenantAccessToken}`,
                        "Content-Type": "application/json",
                    },
                },
            );

            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
        } else {
            messagePayload = {
                open_chat_id: OPEN_CHAT_ID,
                msg_type: "text",
                content: {
                    text: messageText,
                },
            };
        }

        const response = await axios.post(
            "https://open.feishu.cn/open-apis/message/v3/send",
            messagePayload,
            {
                headers: {
                    Authorization: `Bearer ${tenantAccessToken}`,
                    "Content-Type": "application/json",
                },
            },
        );

        res.status(200).json({
            message: "Message sent successfully!",
            data: response.data,
        });
    } catch (error) {
        console.error("Full error details:", {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message,
            config: error.config?.data,
        });

        if (error.response?.status === 401) {
            await getTenantAccessToken();
            return res.status(401).json({
                error: "Token expired",
                message: "Please try again",
            });
        }

        res.status(500).json({
            error: "Failed to send message",
            details: error.response?.data || error.message,
        });
    }
});

// Start the server
app.listen(port, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
    getTenantAccessToken();
});
