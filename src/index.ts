import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import express from "express";
import cors from "cors";

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);
const USE_HTTP = process.env.USE_HTTP === "true";

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
    // Build the full prompt with style if provided
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

    // Use Gemini's imagen model
    const model = genAI.getGenerativeModel({ model: "imagen-3.0-generate-001" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: {
        // @ts-ignore - Imagen specific config
        responseModalities: ["image"],
        imagenConfig: {
          aspectRatio: aspectRatio,
        },
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

    throw new Error("No image was generated in the response");
  } catch (error: any) {
    // Fallback to gemini-2.0-flash for image generation if imagen model fails
    console.log("Trying fallback model gemini-2.0-flash-exp...");

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{ text: `Generate an image: ${prompt}` }]
      }],
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
          {
            inlineData: {
              mimeType: "image/png",
              data: imageBase64,
            },
          },
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

  throw new Error("Image editing failed - no image returned");
}

// Create MCP server
const server = new Server(
  {
    name: "gemini-imagen",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "generate_image": {
        const { prompt, aspect_ratio, style } = args as {
          prompt: string;
          aspect_ratio?: string;
          style?: string;
        };

        console.log(`Generating image with prompt: "${prompt.substring(0, 50)}..."`);

        const result = await generateImage(prompt, aspect_ratio, style);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Image generated successfully",
                image_base64: result.image_base64,
                mime_type: result.mime_type,
              }),
            },
          ],
        };
      }

      case "edit_image": {
        const { image_base64, edit_prompt } = args as {
          image_base64: string;
          edit_prompt: string;
        };

        console.log(`Editing image with prompt: "${edit_prompt.substring(0, 50)}..."`);

        const result = await editImage(image_base64, edit_prompt);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Image edited successfully",
                image_base64: result.image_base64,
                mime_type: result.mime_type,
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error: any) {
    console.error(`Error in ${name}:`, error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: error.message || "An error occurred",
          }),
        },
      ],
      isError: true,
    };
  }
});

// HTTP server for remote MCP connections
function startHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", server: "gemini-imagen-mcp" });
  });

  // MCP-compatible endpoints
  app.get("/mcp/tools", async (req, res) => {
    res.json({ tools: TOOLS });
  });

  app.post("/mcp/call", async (req, res) => {
    const { name, arguments: args } = req.body;

    try {
      switch (name) {
        case "generate_image": {
          const { prompt, aspect_ratio, style } = args;
          const result = await generateImage(prompt, aspect_ratio, style);
          res.json({
            success: true,
            message: "Image generated successfully",
            image_base64: result.image_base64,
            mime_type: result.mime_type,
          });
          break;
        }

        case "edit_image": {
          const { image_base64, edit_prompt } = args;
          const result = await editImage(image_base64, edit_prompt);
          res.json({
            success: true,
            message: "Image edited successfully",
            image_base64: result.image_base64,
            mime_type: result.mime_type,
          });
          break;
        }

        default:
          res.status(400).json({ error: `Unknown tool: ${name}` });
      }
    } catch (error: any) {
      console.error("Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 Gemini Imagen MCP Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Tools list: http://localhost:${PORT}/mcp/tools`);
  });
}

// Main entry point
async function main() {
  if (USE_HTTP) {
    // Run as HTTP server for remote connections
    startHttpServer();
  } else {
    // Run as stdio MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Gemini Imagen MCP server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
