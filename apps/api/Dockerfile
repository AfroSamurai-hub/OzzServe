# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Only copy production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Standard Cloud Run port
EXPOSE 8080
ENV PORT=8080

CMD ["npm", "start"]
