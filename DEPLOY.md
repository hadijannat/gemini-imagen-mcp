# Gemini Imagen MCP Server - Deployment Guide

This MCP server enables Google Imagen 3.0 image generation in Claude Cowork.

## Prerequisites

1. A Google Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. A GitHub account
3. An account on Railway, Render, or Fly.io

---

## Option A: Deploy to Railway (Easiest)

### Step 1: Push to GitHub

```bash
# Initialize git and push to GitHub
git init
git add .
git commit -m "Initial commit"
gh repo create gemini-imagen-mcp --public --source=. --push
```

Or create a repo manually on GitHub and push.

### Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `gemini-imagen-mcp` repository
4. Railway will auto-detect the Dockerfile
5. Go to **Variables** tab and add:
   - `GEMINI_API_KEY` = your API key
6. Railway will deploy automatically
7. Go to **Settings** → **Networking** → **Generate Domain**
8. Copy your URL (e.g., `https://gemini-imagen-mcp-production.up.railway.app`)

---

## Option B: Deploy to Render

### Step 1: Push to GitHub (same as above)

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign in
2. Click **"New"** → **"Web Service"**
3. Connect your GitHub repo
4. Render will auto-detect the Dockerfile
5. Add environment variable:
   - `GEMINI_API_KEY` = your API key
6. Click **"Create Web Service"**
7. Copy your URL (e.g., `https://gemini-imagen-mcp.onrender.com`)

---

## Option C: Deploy to Fly.io

### Step 1: Install Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### Step 2: Deploy

```bash
fly launch --name gemini-imagen-mcp
fly secrets set GEMINI_API_KEY=your_api_key_here
fly deploy
```

Your URL will be: `https://gemini-imagen-mcp.fly.dev`

---

## Add to Claude Cowork

Once deployed, add the connector in Claude Desktop:

1. Go to **Settings** → **Connectors**
2. Click **"Add custom connector"**
3. Fill in:
   - **Name**: `gemini` (or any name you prefer)
   - **Remote MCP server URL**: Your deployed URL (e.g., `https://gemini-imagen-mcp-production.up.railway.app`)
4. Click **"Add"**

---

## Available Tools

Once connected, you'll have access to:

### `generate_image`
Generate images from text descriptions.

**Parameters:**
- `prompt` (required): Detailed description of the image
- `aspect_ratio` (optional): "1:1", "16:9", "9:16", "4:3", "3:4"
- `style` (optional): "photorealistic", "artistic", "cartoon", "sketch", "3d-render"

### `edit_image`
Edit existing images with instructions.

**Parameters:**
- `image_base64` (required): Base64-encoded image
- `edit_prompt` (required): Instructions for editing

---

## Testing

After deployment, test the health endpoint:

```bash
curl https://your-deployed-url.com/health
```

Should return: `{"status":"ok","server":"gemini-imagen-mcp"}`

---

## Troubleshooting

**"Invalid API key"**: Verify your GEMINI_API_KEY is correct in environment variables.

**"Model not found"**: The server automatically falls back to gemini-2.0-flash-exp if imagen-3.0 is unavailable for your account.

**Connection refused in Cowork**: Ensure your server is running and the URL is correct. Check the /health endpoint first.
