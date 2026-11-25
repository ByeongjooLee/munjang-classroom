FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.cjs index.html editor.html ./
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=3817 STUDIO_DATA=/data
USER node
EXPOSE 3817
CMD ["node","server.cjs"]
