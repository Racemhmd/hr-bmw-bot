FROM node:20-alpine

# Dépendances système pour Baileys
RUN apk add --no-cache python3 make g++ cairo-dev pango-dev

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY chatbot_baileys.js .
COPY neon_auth_state.js .
COPY web_upload.js .

# Variables d'environnement
ENV NODE_ENV=production
ENV USE_NEON_AUTH=true
ENV PORT=3000

EXPOSE 3000

CMD ["node", "chatbot_baileys.js"]
