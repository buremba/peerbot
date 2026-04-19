FROM amacneil/dbmate:2.8

WORKDIR /app

# Copy all migrations
COPY db/migrations/ /app/db/migrations/

# dbmate configuration
ENV DBMATE_MIGRATIONS_DIR=/app/db/migrations
ENV DBMATE_NO_DUMP_SCHEMA=true
ENV DBMATE_WAIT=true
ENV DBMATE_WAIT_TIMEOUT=60s

# Run migrations on container start
CMD ["dbmate", "up"]
