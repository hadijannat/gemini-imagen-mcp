# Gemini Imagen MCP Server - Deployment Guide

This server lets you use Google Imagen 3.0 in Claude Code, protected by password authentication.

## How It Works

1. You add the connector in Claude with just the URL
2. When you first connect, a **login page** opens
3. You enter **your secret password**
4. Claude gets authorized - only you can use it!

---

## Step 1: Deploy to Railway

### Push to GitHub

```bash
cd gemini-imagen-mcp-server
git init
git add .
git commit -m "Initial commit"
gh repo create gemini-imagen-mcp --private --source=. --push
```

### Deploy on Railway

1. Go to [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Select your `gemini-imagen-mcp` repository
4. Go to **Variables** tab and add these 3 variables:

| Variable | Value |
|----------|-------|
| `GEMINI_API_KEY` | Your Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `AUTH_PASSWORD` | A secret password only you know (e.g., `MySecretPass123!`) |
| `SERVER_URL` | Your Railway URL (add after step 5) |

5. Go to **Settings** → **Networking** → **Generate Domain**
6. Copy your URL (e.g., `https://gemini-imagen-mcp-production.up.railway.app`)
7. Go back to **Variables** and set `SERVER_URL` to this URL

---

## Step 2: Add to Claude Code

Add the remote MCP server in Claude Code:

```bash
claude mcp add gemini https://your-app.up.railway.app
```

If you use a different MCP client, set the remote MCP URL to your Railway URL (no extra path).

---

## Step 3: Connect

1. Click on the new `gemini` connector
2. A browser window opens with a login page
3. Enter your `AUTH_PASSWORD`
4. Click **Connect**
5. Done! Claude can now generate images for you

---

## Environment Variables Summary

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Your Google Gemini API key |
| `AUTH_PASSWORD` | Yes | Your secret password for login |
| `SERVER_URL` | Yes | Your full Railway URL (including https://) |
| `USE_HTTP` | Auto | Set automatically by Dockerfile |
| `PORT` | Auto | Set automatically by Railway |

---

## Testing

Check if your server is running:
```bash
curl https://your-app.up.railway.app/health
```

Should return: `{"status":"ok","server":"gemini-imagen-mcp","secured":true}`

---

## Available Tools

Once connected, Claude can use:

### `generate_image`
- **prompt**: Description of the image to create
- **aspect_ratio**: "1:1", "16:9", "9:16", "4:3", "3:4"
- **style**: "photorealistic", "artistic", "cartoon", "sketch", "3d-render"

### `edit_image`
- **image_base64**: Base64 image to edit
- **edit_prompt**: Instructions for editing

---

## Troubleshooting

**"Cannot GET /authorize"**: Server needs redeployment with new code. Push updates to GitHub.

**Wrong password page**: Double-check your `AUTH_PASSWORD` in Railway variables.

**Token expired**: Tokens last 24 hours. Just reconnect from Claude.

**Connection refused**: Check that `SERVER_URL` matches your actual Railway URL exactly.

**Claude Code shows MCP transport errors**: Make sure you're using the base Railway URL and have redeployed this server. Claude Code expects Streamable HTTP.
