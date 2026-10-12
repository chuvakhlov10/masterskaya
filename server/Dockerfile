FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY yandex-storage-function ./yandex-storage-function
COPY yandex-function ./yandex-function
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/start-reserve.js"]
