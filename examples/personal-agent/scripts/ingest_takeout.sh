#!/bin/bash

echo "Starting Google Takeout Ingestion (Skipping Calendar per user request)..."

echo "1/2: Ingesting Google Keep Notes..."
node ingest_keep.js

echo "2/2: Ingesting YouTube History..."
node ingest_youtube.js

echo "Takeout Ingestion Complete!"
