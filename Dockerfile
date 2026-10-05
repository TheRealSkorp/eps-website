FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production \
    DATA_DIR=/data \
    TRUST_PROXY=1
# Mount a persistent volume at /data in your host's settings: it holds data.json and uploads/.
# (No VOLUME instruction here: Railway rejects Dockerfiles that contain one.)
EXPOSE 3000
CMD ["node", "server.js"]
