import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);
const USE_HTTP = process.env.USE_HTTP === "true";
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// 🔐 Your secret password - only you should know this!
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "changeme";

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

if (USE_HTTP && AUTH_PASSWORD === "changeme") {
  console.warn("⚠️  WARNING: Using default password! Set AUTH_PASSWORD environment variable.");
}

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Store for OAuth state (in production, use Redis or a database)
const pendingAuths = new Map<string, { codeChallenge: string; redirectUri: string; expiresAt: number }>();
const validTokens = new Set<string>();

// Define the tools available
const TOOLS: Tool[] = [
  {
    name: "generate_image",
    description:
      "Generate an image using Google Imagen 3.0. Provide a detailed text prompt describing the image you want to create. Returns a base64-encoded image.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description:
            "A detailed description of the image to generate. Be specific about style, composition, colors, lighting, and subject matter.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description: "The aspect ratio of the generated image. Default is 1:1.",
        },
        style: {
          type: "string",
          enum: ["photorealistic", "artistic", "cartoon", "sketch", "3d-render"],
          description: "Optional style hint for the image generation.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit an existing image using Google Imagen 3.0. Provide the base64 image and instructions for editing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        image_base64: {
          type: "string",
          description: "The base64-encoded image to edit.",
        },
        edit_prompt: {
          type: "string",
          description:
            "Instructions for how to edit the image (e.g., 'remove the background', 'change the sky to sunset').",
        },
      },
      required: ["image_base64", "edit_prompt"],
    },
  },
];

// Image generation function
async function generateImage(
  prompt: string,
  aspectRatio: string = "1:1",
  style?: string
): Promise<{ image_base64: string; mime_type: string }> {
  try {
    let fullPrompt = prompt;
    if (style) {
      const styleMap: Record<string, string> = {
        photorealistic: "photorealistic, high detail, professional photography",
        artistic: "artistic, painterly, creative interpretation",
        cartoon: "cartoon style, animated, colorful",
        sketch: "pencil sketch, hand-drawn, artistic",
        "3d-render": "3D rendered, CGI, computer graphics",
      };
      fullPrompt = `${prompt}, ${styleMap[style] || style}`;
    }

    const model = genAI.getGenerativeModel({ model: "imagen-3.0-generate-001" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: {
        // @ts-ignore
        responseModalities: ["image"],
        imagenConfig: { aspectRatio },
      },
    });

    const response = result.response;
    const imagePart = response.candidates?.[0]?.content?.parts?.[0];

    if (imagePart && "inlineData" in imagePart && imagePart.inlineData) {
      return {
        image_base64: imagePart.inlineData.data,
        mime_type: imagePart.inlineData.mimeType,
      };
    }
    throw new Error("No image generated");
  } catch (error: any) {
    console.log("Trying fallback model...");
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: `Generate an image: ${prompt}` }] }],
      generationConfig: {
        // @ts-ignore
        responseModalities: ["image", "text"],
      },
    });

    const response = result.response;
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if ("inlineData" in part && part.inlineData) {
        return {
          image_base64: part.inlineData.data,
          mime_type: part.inlineData.mimeType,
        };
      }
    }
    throw new Error(`Image generation failed: ${error.message}`);
  }
}

// Image editing function
async function editImage(
  imageBase64: string,
  editPrompt: string
): Promise<{ image_base64: string; mime_type: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: imageBase64 } },
          { text: `Edit this image: ${editPrompt}. Return the edited image.` },
        ],
      },
    ],
    generationConfig: {
      // @ts-ignore
      responseModalities: ["image", "text"],
    },
  });

  const response = result.response;
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if ("inlineData" in part && part.inlineData) {
      return {
        image_base64: part.inlineData.data,
        mime_type: part.inlineData.mimeType,
      };
    }
  }
  throw new Error("Image editing failed");
}

// Create MCP server (for stdio mode)
const server = new Server(
  { name: "gemini-imagen", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "generate_image") {
      const { prompt, aspect_ratio, style } = args as any;
      const result = await generateImage(prompt, aspect_ratio, style);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }],
      };
    }

    if (name === "edit_image") {
      const { image_base64, edit_prompt } = args as any;
      const result = await editImage(image_base64, edit_prompt);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }],
      };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
      isError: true,
    };
  }
});

// 🔐 Authentication middleware for MCP endpoints
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.substring(7);
  if (!validTokens.has(token)) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }

  next();
}

// HTTP server with OAuth 2.0 support
function startHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ============================================
  // OAuth 2.0 Discovery Endpoint
  // ============================================
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.json({
      issuer: SERVER_URL,
      authorization_endpoint: `${SERVER_URL}/authorize`,
      token_endpoint: `${SERVER_URL}/token`,
      registration_endpoint: `${SERVER_URL}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ============================================
  // OAuth 2.0 Dynamic Client Registration
  // ============================================
  app.post("/register", (req, res) => {
    // Accept any client registration (we validate via password at /authorize)
    const clientId = crypto.randomUUID();
    res.status(201).json({
      client_id: clientId,
      client_secret: "",
      redirect_uris: req.body.redirect_uris || [],
    });
  });

  // ============================================
  // OAuth 2.0 Authorization Endpoint
  // Shows a login form where you enter your password
  // ============================================
  app.get("/authorize", (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;

    if (response_type !== "code") {
      return res.status(400).send("Invalid response_type");
    }

    // Store the pending auth request
    const authId = crypto.randomUUID();
    pendingAuths.set(authId, {
      codeChallenge: code_challenge as string,
      redirectUri: redirect_uri as string,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Show login form
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Gemini Imagen - Login</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white; padding: 40px; border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 400px; width: 90%;
          }
          h1 { margin: 0 0 8px 0; color: #333; font-size: 24px; }
          p { color: #666; margin: 0 0 24px 0; }
          input[type="password"] {
            width: 100%; padding: 14px; font-size: 16px;
            border: 2px solid #e0e0e0; border-radius: 8px;
            box-sizing: border-box; margin-bottom: 16px;
          }
          input[type="password"]:focus {
            outline: none; border-color: #667eea;
          }
          button {
            width: 100%; padding: 14px; font-size: 16px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; border: none; border-radius: 8px;
            cursor: pointer; font-weight: 600;
          }
          button:hover { opacity: 0.9; }
          .error { color: #e53e3e; margin-top: 16px; display: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎨 Gemini Imagen</h1>
          <p>Enter your password to connect to Claude</p>
          <form method="POST" action="/authorize/submit">
            <input type="hidden" name="auth_id" value="${authId}">
            <input type="hidden" name="state" value="${state || ''}">
            <input type="password" name="password" placeholder="Your secret password" required autofocus>
            <button type="submit">Connect</button>
          </form>
        </div>
      </body>
      </html>
    `);
  });

  // Handle login form submission
  app.post("/authorize/submit", (req, res) => {
    const { auth_id, password, state } = req.body;

    // Verify password
    if (password !== AUTH_PASSWORD) {
      return res.status(401).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title>
        <style>
          body { font-family: sans-serif; display: flex; justify-content: center;
                 align-items: center; min-height: 100vh; background: #fee; }
          .error { background: white; padding: 40px; border-radius: 16px; text-align: center; }
          h1 { color: #e53e3e; }
          a { color: #667eea; }
        </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Wrong Password</h1>
            <p>Please try again.</p>
            <a href="javascript:history.back()">Go Back</a>
          </div>
        </body>
        </html>
      `);
    }

    // Get pending auth
    const pending = pendingAuths.get(auth_id);
    if (!pending || Date.now() > pending.expiresAt) {
      return res.status(400).send("Authorization request expired. Please try again.");
    }

    // Generate authorization code
    const code = crypto.randomUUID();
    pendingAuths.set(code, pending);
    pendingAuths.delete(auth_id);

    // Redirect back to Claude with the code
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    console.log(`✅ User authenticated, redirecting to Claude`);
    res.redirect(redirectUrl.toString());
  });

  // ============================================
  // OAuth 2.0 Token Endpoint
  // ============================================
  app.post("/token", (req, res) => {
    const { grant_type, code, code_verifier } = req.body;

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const pending = pendingAuths.get(code);
    if (!pending) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });
    }

    // Verify PKCE code_verifier
    if (pending.codeChallenge) {
      const hash = crypto.createHash("sha256").update(code_verifier || "").digest("base64url");
      if (hash !== pending.codeChallenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid code_verifier" });
      }
    }

    // Generate access token
    const accessToken = crypto.randomUUID();
    validTokens.add(accessToken);
    pendingAuths.delete(code);

    console.log(`✅ Token issued successfully`);
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400, // 24 hours
    });

    // Clean up expired tokens periodically
    setTimeout(() => validTokens.delete(accessToken), 86400 * 1000);
  });

  // ============================================
  // Health Check (no auth required)
  // ============================================
  app.get("/health", (req, res) => {
    res.json({ status: "ok", server: "gemini-imagen-mcp", secured: true });
  });

  // ============================================
  // MCP Endpoints (auth required)
  // ============================================
  app.get("/mcp/tools", authMiddleware, (req, res) => {
    res.json({ tools: TOOLS });
  });

  app.post("/mcp/call", authMiddleware, async (req, res) => {
    const { name, arguments: args } = req.body;

    try {
      if (name === "generate_image") {
        const { prompt, aspect_ratio, style } = args;
        const result = await generateImage(prompt, aspect_ratio, style);
        return res.json({ success: true, ...result });
      }

      if (name === "edit_image") {
        const { image_base64, edit_prompt } = args;
        const result = await editImage(image_base64, edit_prompt);
        return res.json({ success: true, ...result });
      }

      res.status(400).json({ error: `Unknown tool: ${name}` });
    } catch (error: any) {
      console.error("Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 Gemini Imagen MCP Server running on port ${PORT}`);
    console.log(`🔐 OAuth 2.0 authentication enabled`);
    console.log(`   Discovery: ${SERVER_URL}/.well-known/oauth-authorization-server`);
    console.log(`   Health: ${SERVER_URL}/health`);
  });
}

// Main
async function main() {
  if (USE_HTTP) {
    startHttpServer();
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Gemini Imagen MCP server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
