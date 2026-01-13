import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  isInitializeRequest,
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
const AUTH_BASE_URL = new URL(SERVER_URL).origin;

// 🔐 Your secret password
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "changeme";

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// OAuth storage
const pendingAuths = new Map<string, { codeChallenge: string; redirectUri: string; expiresAt: number }>();
const validTokens = new Set<string>();

// Streamable HTTP transport storage - keyed by sessionId
const streamableTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Define the tools
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
          description: "A detailed description of the image to generate.",
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
    description: "Edit an existing image using AI. Provide the base64 image and instructions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        image_base64: {
          type: "string",
          description: "The base64-encoded image to edit.",
        },
        edit_prompt: {
          type: "string",
          description: "Instructions for how to edit the image.",
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

    const imagePart = result.response.candidates?.[0]?.content?.parts?.[0];
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

    for (const part of result.response.candidates?.[0]?.content?.parts || []) {
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
async function editImage(imageBase64: string, editPrompt: string): Promise<{ image_base64: string; mime_type: string }> {
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

  for (const part of result.response.candidates?.[0]?.content?.parts || []) {
    if ("inlineData" in part && part.inlineData) {
      return {
        image_base64: part.inlineData.data,
        mime_type: part.inlineData.mimeType,
      };
    }
  }
  throw new Error("Image editing failed");
}

// Create MCP Server instance
function createMCPServer(): Server {
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
        console.log(`🎨 Generating image: "${prompt.substring(0, 50)}..."`);
        const result = await generateImage(prompt, aspect_ratio, style);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }],
        };
      }

      if (name === "edit_image") {
        const { image_base64, edit_prompt } = args as any;
        console.log(`✏️ Editing image: "${edit_prompt.substring(0, 50)}..."`);
        const result = await editImage(image_base64, edit_prompt);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }],
        };
      }

      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    } catch (error: any) {
      console.error(`Error in ${name}:`, error.message);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// Auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${AUTH_BASE_URL}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  const token = authHeader.substring(7);
  if (!validTokens.has(token)) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${AUTH_BASE_URL}/.well-known/oauth-protected-resource"`
    );
    return res.status(403).json({ error: "Invalid token" });
  }
  next();
}

// HTTP server with Streamable HTTP transport
function startHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ============================================
  // OAuth 2.0 Discovery
  // ============================================
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: SERVER_URL,
      authorization_servers: [AUTH_BASE_URL],
      scopes_supported: ["mcp:tools"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.json({
      issuer: AUTH_BASE_URL,
      authorization_endpoint: `${AUTH_BASE_URL}/authorize`,
      token_endpoint: `${AUTH_BASE_URL}/token`,
      registration_endpoint: `${AUTH_BASE_URL}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // OAuth registration
  app.post("/register", (req, res) => {
    const clientId = crypto.randomUUID();
    res.status(201).json({
      client_id: clientId,
      client_secret: "",
      redirect_uris: req.body.redirect_uris || [],
    });
  });

  // OAuth authorize (login page)
  app.get("/authorize", (req, res) => {
    const { response_type, redirect_uri, code_challenge, state } = req.query;

    if (response_type !== "code") {
      return res.status(400).send("Invalid response_type");
    }

    const authId = crypto.randomUUID();
    pendingAuths.set(authId, {
      codeChallenge: code_challenge as string,
      redirectUri: redirect_uri as string,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Gemini Imagen - Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
          .container { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 400px; width: 90%; }
          h1 { margin: 0 0 8px 0; color: #333; }
          p { color: #666; margin: 0 0 24px 0; }
          input[type="password"] { width: 100%; padding: 14px; font-size: 16px; border: 2px solid #e0e0e0; border-radius: 8px; box-sizing: border-box; margin-bottom: 16px; }
          button { width: 100%; padding: 14px; font-size: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
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

  // Handle login
  app.post("/authorize/submit", (req, res) => {
    const { auth_id, password, state } = req.body;

    if (password !== AUTH_PASSWORD) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fee;">
        <div style="background:white;padding:40px;border-radius:16px;text-align:center;">
        <h1 style="color:#e53e3e;">❌ Wrong Password</h1>
        <a href="javascript:history.back()">Try Again</a>
        </div></body></html>
      `);
    }

    const pending = pendingAuths.get(auth_id);
    if (!pending || Date.now() > pending.expiresAt) {
      return res.status(400).send("Authorization expired. Please try again.");
    }

    const code = crypto.randomUUID();
    pendingAuths.set(code, pending);
    pendingAuths.delete(auth_id);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    console.log("✅ User authenticated");
    res.redirect(redirectUrl.toString());
  });

  // Token endpoint
  app.post("/token", (req, res) => {
    const { grant_type, code, code_verifier } = req.body;

    if (grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const pending = pendingAuths.get(code);
    if (!pending) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    if (pending.codeChallenge) {
      const hash = crypto.createHash("sha256").update(code_verifier || "").digest("base64url");
      if (hash !== pending.codeChallenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid code_verifier" });
      }
    }

    const accessToken = crypto.randomUUID();
    validTokens.add(accessToken);
    pendingAuths.delete(code);

    console.log("✅ Token issued");
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 86400,
    });

    setTimeout(() => validTokens.delete(accessToken), 86400 * 1000);
  });

  // ============================================
  // Health check
  // ============================================
  app.get("/health", (req, res) => {
    res.json({ status: "ok", server: "gemini-imagen-mcp", secured: true });
  });

  // ============================================
  // MCP Streamable HTTP Endpoint
  // ============================================
  const isInitializeBody = (body: unknown): boolean => {
    if (!body) return false;
    if (Array.isArray(body)) {
      return body.some((message) => isInitializeRequest(message as any));
    }
    return isInitializeRequest(body as any);
  };

  const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`📨 MCP POST${sessionId ? ` session ${sessionId}` : ""}`);

    try {
      if (sessionId && streamableTransports[sessionId]) {
        const transport = streamableTransports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (!sessionId && isInitializeBody(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableTransports[newSessionId] = transport;
            console.log(`✅ MCP session initialized: ${newSessionId}`);
          },
        });

        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid && streamableTransports[sid]) {
            delete streamableTransports[sid];
            console.log(`🔌 MCP session closed: ${sid}`);
          }
        };

        const server = createMCPServer();
        await server.connect(transport);

        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }
    } catch (error: any) {
      console.error(`❌ Error handling MCP POST: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !streamableTransports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    try {
      await streamableTransports[sessionId].handleRequest(req, res);
    } catch (error: any) {
      console.error(`❌ Error handling MCP GET: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !streamableTransports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    try {
      await streamableTransports[sessionId].handleRequest(req, res);
    } catch (error: any) {
      console.error(`❌ Error handling MCP DELETE: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  app.post("/", authMiddleware, mcpPostHandler);
  app.get("/", authMiddleware, mcpGetHandler);
  app.delete("/", authMiddleware, mcpDeleteHandler);

  app.listen(PORT, () => {
    console.log(`🚀 Gemini Imagen MCP Server running on port ${PORT}`);
    console.log(`🔐 OAuth 2.0 + Streamable HTTP transport enabled`);
    console.log(`   Server URL: ${SERVER_URL}`);
    console.log(`   Health: ${SERVER_URL}/health`);
  });
}

// Main
async function main() {
  if (USE_HTTP) {
    startHttpServer();
  } else {
    const transport = new StdioServerTransport();
    const server = createMCPServer();
    await server.connect(transport);
    console.error("Gemini Imagen MCP server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
