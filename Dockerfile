FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Set environment variable to use HTTP mode
ENV USE_HTTP=true
ENV PORT=3000

# Start the server
CMD ["npm", "start"]
