
const express = require('express');
const path = require('path');
const app = express();

// Serve static files from attached_assets
app.use(express.static('attached_assets'));
app.use(express.json());

// Handle form submission
app.post('/sendMessage', (req, res) => {
  console.log('Received message:', req.body);
  res.json({ success: true });
});

const port = 5000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
